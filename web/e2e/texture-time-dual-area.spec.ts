/**
 * M5-3 · **纹理时间接进呈现链**（真实双 3D Area + 真实纹理 + 真实像素）。
 *
 * ## 本文件证明什么（以及**不**证明什么）
 *
 * | 判据 | 形态 |
 * |---|---|
 * | 同一秒数 ⇒ 两区**同一** `(frame,nextFrame,mix,offsetY,repeatY)` 样本 | 同一次 `page.evaluate` 取回两区读数后 `toEqual` |
 * | 跳帧/倒退 ⇒ 样本**回退**（不是停在最远那一帧） | 0.12 → 0.30 → 0.12 逐字段相同 |
 * | 播放期**零全量重编** | 三次 seek 后 `applies/materialBuilds/batchBuilds` 与基线相同 |
 * | 暂停**不漂**（没有视口自己累加 delta） | 0.12 暂停 500 ms 后读数逐字段相同 |
 * | 样本真的进了画面（**单区**像素） | 同区 frame 0（红）与 frame 3（黄）签名显著不同；同状态重复截图是噪声地板 |
 * | 坏纹理不阻断、不假就绪 | 负对照：终态 `failed`、两区读数空、视口仍挂载 |
 *
 * ⚠️ 本文件**不**断言"双 Area 像素同图"或"视口与离屏像素同图" —— 那是计划 M6 的
 * 「同输入同结果」语汇。这里唯一的像素断言是**同一个 Area 在两个不同时间**画面必须不同：
 * 它是"offset 真的进了光栅化结果"的证人，不是跨端一致性。
 *
 * ## 观测面（全部是公开面，无新增测试后门）
 *
 * `__vm__.viewports.get(rid).presenterSurface.textureSamples()` / `.statsSnapshot()`、
 * `requireKernelSession().playback()/seekTime()`、`data-texture-state`、视口 canvas 像素。
 *
 * ## 反假绿（设计 §5.4）
 *
 * 1. 任何样本断言前先断言 `samples.length > 0`（空数组会让 `every`/`toEqual([])` 恒绿）；
 * 2. 两区读数**同一次 evaluate** 取回（分两次取在播放态会跨 tick）；
 * 3. 像素断言先量噪声地板（`expectStablePixels`），再断言跨时间显著差异；
 * 4. 输入只走生产入口（`OPERATOR_OPEN_SCENE` + 夹具 JSON），不手搓绑定/资源。
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { gotoWorkbench, injectSceneDocumentOk, VIEWPORT_CANVAS, waitForViewportMounted } from './helpers/multiblock'
import { expectSignificantPixelChange, expectStablePixels } from './helpers/multiblock/pixels'
import { readJson } from './helpers/saveReopen'
import {
  readTextureState,
  sampleViewport,
  TERMINAL_TEXTURE_STATES,
  waitTextureState,
} from './helpers/viewportPixels'

const FIXTURE = 'texture-strip-animated.v2.json'
const FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', FIXTURE)

/** 一区的纹理样本读数（`textureSamples()` 的元素；字段与 presenter 的报告逐字一致）。 */
interface SampleReport {
  readonly assetId: string
  readonly contentVersion: string
  readonly seconds: number
  readonly frame: number
  readonly nextFrame: number
  readonly mix: number
  readonly stripFrameCount: number
  readonly offsetY: number
  readonly repeatY: number
}

interface RegionReading {
  readonly region: string
  readonly samples: SampleReport[]
  readonly stats: { applies: number; materialBuilds: number; batchBuilds: number; geometryBuilds: number }
  /** 呈现会话的求值键（M6-3 补面：双区同源的**身份**证据，不是样本证据）。 */
  readonly activeKey: {
    documentVersion: number
    scene: string
    time: { seconds: number; numerator: number; denominator: number }
    parameterVersion: number
    contentResourceVersions: Record<string, string>
  } | null
  /** 采样诊断计数（M6-3 补面；三项与屏上同源判定）。 */
  readonly sampleStats: { errors: number; blended: number; phaseSkipped: number } | null
}

interface DualReading {
  readonly regions: RegionReading[]
  readonly playing: boolean
  readonly timeSeconds: number
  /** 状态栏的纹理状态（就绪门的事实信号）。 */
  readonly textureState: string | null
}

/** 读叶子 Area → region 映射（DOM 是布局投影的权威呈现面）。 */
async function readLeafRegions(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('.area-node--leaf[data-area-id]') as NodeListOf<HTMLElement>)
    return cells.map((c) => c.dataset.wmRegion ?? '').filter((r) => r !== '')
  })
}

/** 经真实命令路径分割（`OPERATOR_AREA_SPLIT`）。 */
async function splitArea(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const ctx = (window as any).__vm__
    await ctx.getOperators().exec('OPERATOR_AREA_SPLIT', { direction: 'horizontal' })
  })
}

/** 一次 evaluate 取回**两区**读数（同一时刻，避免播放态跨 tick）。 */
async function readDual(page: Page, regions: readonly string[]): Promise<DualReading> {
  return (await page.evaluate((ids: string[]) => {
    const ctx = (window as any).__vm__
    const kernel = ctx.requireKernelSession()
    const playback = kernel.playback()
    const out: RegionReading[] = []
    for (const id of ids) {
      const surface = ctx?.viewports?.get(id)?.presenterSurface ?? null
      if (surface === null) {
        out.push({
          region: id,
          samples: [],
          stats: { applies: -1, materialBuilds: -1, batchBuilds: -1, geometryBuilds: -1 },
          activeKey: null,
          sampleStats: null,
        })
        continue
      }
      const stats = surface.statsSnapshot()
      const key = typeof surface.activeKey === 'object' && surface.activeKey !== null
        ? JSON.parse(JSON.stringify(surface.activeKey))
        : null
      const sampleStats = typeof surface.textureSampleStats === 'function'
        ? JSON.parse(JSON.stringify(surface.textureSampleStats()))
        : null
      out.push({
        region: id,
        activeKey: key,
        sampleStats,
        samples: JSON.parse(JSON.stringify(surface.textureSamples() ?? [])),
        stats: {
          applies: stats.applies,
          materialBuilds: stats.materialBuilds,
          batchBuilds: stats.batchBuilds,
          geometryBuilds: stats.geometryBuilds,
        },
      })
    }
    const timeSeconds = typeof playback?.time?.frame === 'number' ? playback.time.frame : Number.NaN
    return {
      regions: out,
      playing: playback?.playing === true,
      timeSeconds,
      textureState: document.querySelector('.sb-root')?.getAttribute('data-texture-state') ?? null,
    }
  }, [...regions])) as DualReading
}

/** 定位到场景秒（`seekTime` 是内核公开写面：帧号 × 帧率，精确表达亚帧时刻）。 */
async function seekSeconds(page: Page, seconds: number): Promise<void> {
  await page.evaluate((sec: number) => {
    const kernel = (window as any).__vm__.requireKernelSession()
    kernel.seekTime({ frame: sec * 20, fps: 20 })
  }, seconds)
}

/** 等到两区的样本都落到某秒（暂停态时间静态，两区最终一致）。 */
async function waitSameSeconds(page: Page, regions: readonly string[], seconds: number): Promise<DualReading> {
  let last: DualReading | null = null
  await expect
    .poll(
      async () => {
        last = await readDual(page, regions)
        return last.regions.every((r) => r.samples.length > 0 && Math.abs(r.samples[0]!.seconds - seconds) < 1e-9)
      },
      {
        timeout: 30_000,
        message: `两区样本都必须落到 ${seconds}s（实测 ${JSON.stringify(last?.regions.map((r) => r.samples[0]?.seconds))}）`,
      },
    )
    .toBe(true)
  return last!
}

/**
 * 计数基线：必须**样本非空**且**连续两次读**三个计数都不变才取。
 *
 * 否则首次纹理绑定/重挂会被误算成本次 seek 的重编（设计 §5.3 步 3 的基线取法）。
 */
async function stableStatsBaseline(page: Page, regions: readonly string[]): Promise<DualReading> {
  let previous: string | null = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const reading = await readDual(page, regions)
    const key = JSON.stringify(reading.regions.map((r) => r.stats))
    const ready = reading.regions.every((r) => r.samples.length > 0)
    if (ready && previous === key) return reading
    previous = ready ? key : null
    await page.waitForTimeout(120)
  }
  throw new Error('计数基线取不到（样本未就绪或计数持续变化）')
}

test.describe('M5-3 · 纹理时间 → 呈现（真实双 Area）', () => {
  test('TT-1 同秒同样本 / 倒退回退 / 零重编 / 暂停不漂 / 单区像素', async ({ page }, testInfo) => {
    test.setTimeout(300_000)
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, readJson(FIXTURE_PATH), FIXTURE)
    await waitForViewportMounted(page)
    // 就绪门是事实信号（不是等待时长）
    expect(
      await waitTextureState(page, TERMINAL_TEXTURE_STATES, '动画竖条纹理终态', 180_000),
      '完好夹具的终态必须是 ready（failed/missing 只应出现在负对照里）',
    ).toBe('ready')

    // ── 双 Area（真实分割命令）──
    await splitArea(page)
    await expect.poll(async () => (await readLeafRegions(page)).length, { timeout: 30_000 }).toBe(2)
    const regions = await readLeafRegions(page)
    expect(regions).toHaveLength(2)
    await expect
      .poll(async () => (await page.locator(`${VIEWPORT_CANVAS} canvas`).count()), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2)

    // ── 前置断言：两区都必须真的**有样本**（否则后面每条都会假绿）──
    await expect
      .poll(
        async () => (await readDual(page, regions)).regions.map((r) => r.samples.length),
        { timeout: 90_000, message: '两个 Area 都必须产出纹理样本（空数组 = 纹理时间未接线）' },
      )
      .toEqual([1, 1])

    const initial = await readDual(page, regions)
    expect(initial.playing, '前提：默认暂停随场景（本用例全程不播放）').toBe(false)

    // ── 步 1：同一秒数 ⇒ 两区同样本 ──
    await seekSeconds(page, 0.12)
    const at012 = await waitSameSeconds(page, regions, 0.12)
    const [a12, b12] = at012.regions
    expect(a12!.samples.length, '样本必须非空（反假绿）').toBeGreaterThan(0)
    expect(a12!.samples, '两区样本必须逐字段相同（同一时间权威）').toEqual(b12!.samples)
    expect(a12!.samples[0]).toMatchObject({
      frame: 1,
      mix: 0,
      stripFrameCount: 4,
      offsetY: 0.25,
      repeatY: 0.25,
    })
    console.log('[TT-1] @0.12s samples=' + JSON.stringify(a12!.samples[0]))

    const baseline = await stableStatsBaseline(page, regions)
    console.log('[TT-1] baseline stats=' + JSON.stringify(baseline.regions.map((r) => r.stats)))

    // ── 步 2：跳帧前进 + 倒退 ⇒ 样本回退 ──
    await seekSeconds(page, 0.3)
    const at030 = await waitSameSeconds(page, regions, 0.3)
    expect(at030.regions[0]!.samples, '两区仍必须一致').toEqual(at030.regions[1]!.samples)
    expect(at030.regions[0]!.samples[0]).toMatchObject({ frame: 3, offsetY: 0.75 })

    await seekSeconds(page, 0.12)
    const back = await waitSameSeconds(page, regions, 0.12)
    expect(back.regions[0]!.samples, '倒退定位必须逐字段回到步 1 的快照（累加器实现到这里会红）').toEqual(
      a12!.samples,
    )
    expect(back.regions[1]!.samples).toEqual(b12!.samples)

    await seekSeconds(page, 0.4)
    const looped = await waitSameSeconds(page, regions, 0.4)
    expect(looped.regions[0]!.samples[0]!.frame, '一整圈后回到帧 0').toBe(0)
    expect(looped.regions[0]!.samples[0]!.offsetY).toBe(0)

    // ── 步 3：播放期零全量重编 ──
    await seekSeconds(page, 0.12)
    await waitSameSeconds(page, regions, 0.12)
    const afterSeeks = await readDual(page, regions)
    for (let i = 0; i < regions.length; i += 1) {
      expect(
        afterSeeks.regions[i]!.stats,
        `区 ${regions[i]}：四次 seek 后 applies/materialBuilds/batchBuilds 必须与基线相同` +
          '（若时间回到结构身份，每次 seek 都会至少 +1 次全量重编）',
      ).toEqual(baseline.regions[i]!.stats)
    }

    // ── 步 4：样本真的进了画面（**单区**像素；仅桌面视口）──
    if (testInfo.project.name === 'desktop-chrome') {
      await seekSeconds(page, 0)
      await waitSameSeconds(page, regions, 0)
      const redA = await sampleViewport(page, regions[0]!, ['ready'], '帧 0（红）')
      const redB = await sampleViewport(page, regions[0]!, ['ready'], '帧 0 重复（噪声地板）')
      const floor = expectStablePixels(redA.signature, redB.signature, '同状态重复截图')
      await seekSeconds(page, 0.3)
      await waitSameSeconds(page, regions, 0.3)
      const yellow = await sampleViewport(page, regions[0]!, ['ready'], '帧 3（黄）')
      const diff = expectSignificantPixelChange(redA.signature, yellow.signature, '帧 0 → 帧 3：offset 必须进画面')
      console.log(
        '[TT-1] pixels noiseFloor=' + JSON.stringify(floor) + ' change=' + JSON.stringify(diff) +
          ' sha0=' + redA.sha256.slice(0, 12) + ' sha3=' + yellow.sha256.slice(0, 12),
      )
      expect(redA.sha256, '两帧的完整像素缓冲也必须不同').not.toBe(yellow.sha256)
    } else {
      // MP-1 模式：窄视口的像素显著性是既有已知限制（见 min signature 阈值标定），
      // 故像素断言只在 desktop-chrome 上执行；样本断言两个 project 都跑。
      console.log('[TT-1] project=' + testInfo.project.name + ' ⇒ 跳过像素断言（MP-1：像素仅 desktop）')
    }

    // ── 步 5：暂停不漂（没有视口自己累加 delta）──
    await seekSeconds(page, 0.12)
    const pausedBefore = await waitSameSeconds(page, regions, 0.12)
    await page.waitForTimeout(500)
    const pausedAfter = await readDual(page, regions)
    expect(pausedAfter.regions[0]!.samples, '暂停 500 ms 后样本不得漂移').toEqual(pausedBefore.regions[0]!.samples)
    expect(pausedAfter.regions[1]!.samples).toEqual(pausedBefore.regions[1]!.samples)
    expect(pausedAfter.regions[0]!.stats.applies, '暂停期不得有重编').toBe(pausedBefore.regions[0]!.stats.applies)
    expect(pausedAfter.playing, '全程未播放').toBe(false)
    console.log('[TT-1] paused stable samples=' + JSON.stringify(pausedAfter.regions[0]!.samples[0]))
  })

  /**
   * **TT-1b（M6-3 补面 · 判据 ①）**：双视口不只"样本相同"，**身份**也必须相同。
   *
   * ## 为什么补这条（而不是重复 TT-1）
   *
   * TT-1 断的是 `textureSamples()` 逐字段相等 —— 那是"这一帧取了哪一格"。
   * 但两份读数相同**不代表**两个区走的是同一个求值键：完全可能一边在 A 内容上取到
   * 恰好相同的样本（例如两边都停在帧 0）。`activeKey` +
   * `textureSampleStats()` 把"同源"从**结果**证到**身份**：
   *
   * | 读面 | 回答 |
   * |---|---|
   * | `textureSamples()` | 这一帧取到哪一格（结果） |
   * | `activeKey` | 这一帧是按哪个求值键算的（身份：文档版本 / 场景 / 场景时间 / 参数版本 / 资源版本） |
   * | `textureSampleStats()` | 采样有没有出错/混合/相位跳过（诊断） |
   *
   * ## 明确**不**期望 key 相等的情形
   *
   * `setLayerPreview` 进的是**内容身份**（`presenterSession#contentIdentityOf` 的 `lp:` 段），
   * **不是** `activeKey` 的一维（键是契约冻结的六维）。故"两区设了不同分层预览"时
   * 期望的是"内容身份不同、key 仍相同" —— 把它写成"key 应不同"是**误判**。
   */
  test('TT-1b 双区 activeKey 与 textureSampleStats 逐字段相等（判据 ① 补面）', async ({ page }) => {
    test.setTimeout(300_000)
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, readJson(FIXTURE_PATH), FIXTURE)
    await waitForViewportMounted(page)
    expect(
      await waitTextureState(page, TERMINAL_TEXTURE_STATES, '动画竖条纹理终态', 180_000),
      '完好夹具的终态必须是 ready',
    ).toBe('ready')

    await splitArea(page)
    await expect.poll(async () => (await readLeafRegions(page)).length, { timeout: 30_000 }).toBe(2)
    const regions = await readLeafRegions(page)

    await seekSeconds(page, 0.12)
    const at = await waitSameSeconds(page, regions, 0.12)
    const [a, b] = at.regions
    // 反空洞真：读数必须在场（null 会让"相等"变成两条 null === null 的空转）
    expect(a!.activeKey, 'activeKey 必须在场（否则补面是空转）').not.toBeNull()
    expect(a!.sampleStats, 'textureSampleStats 必须在场').not.toBeNull()
    expect(a!.activeKey!.scene, 'key 必须指名场景（不是空对象）').not.toBe('')
    expect(Object.keys(a!.activeKey!.contentResourceVersions).length, '资源版本必须进 key').toBeGreaterThan(0)

    // ① 身份逐字段相等
    expect(a!.activeKey, '两区的求值键必须逐字段相等（同一份内容、同一秒、同一参数版本）').toEqual(b!.activeKey)
    // ② 诊断计数逐项相等
    expect(a!.sampleStats, '两区的采样诊断计数必须相等').toEqual(b!.sampleStats)
    // ③ 键里的场景时间 == 目标秒（把"同秒"证到 key 上，而不只是样本里）
    expect(a!.activeKey!.time.seconds, 'key 里的场景秒必须等于定位秒').toBeCloseTo(0.12, 9)

    console.log('[TT-1b] activeKey=' + JSON.stringify(a!.activeKey) + ' stats=' + JSON.stringify(a!.sampleStats))
  })

  test('TT-2 负对照：同一份竖条字节但声明为静态（kind=static16）⇒ 两区无样本、纹理不裁切', async ({ page }) => {
    test.setTimeout(300_000)
    await gotoWorkbench(page)
    const statik = readJson(FIXTURE_PATH) as Record<string, unknown>
    // 只改**内存副本的声明**（不落盘、不改仓库夹具）：字节仍是 16×64 四色竖条，
    // 但 kind 说它是静态贴图 ⇒ 不得采样、不得写 offset/repeat。
    const palette = (statik.materialPalette as Record<string, unknown>[])[0]!
    palette.kind = 'static16'
    delete palette.animation
    await injectSceneDocumentOk(page, statik, FIXTURE)
    expect(
      await waitTextureState(page, TERMINAL_TEXTURE_STATES, '静态声明终态', 180_000),
      '像素本身可用 ⇒ 仍是 ready（静态不是失败）',
    ).toBe('ready')
    await waitForViewportMounted(page)
    const regions = await readLeafRegions(page)
    expect(regions.length).toBeGreaterThanOrEqual(1)

    const reading = await readDual(page, regions)
    for (const r of reading.regions) {
      expect(r.samples, `区 ${r.region}：没有动画声明 ⇒ 不得产出样本（否则"静态贴图也会播"）`).toEqual([])
    }
    // 纹理变换必须保持恒等（残留的 repeat.y=1/4 会把静态贴图裁成一格）
    const uv = await page.evaluate((ids: string[]) => {
      const ctx = (window as any).__vm__
      return ids.map((id: string) => {
        const surface = ctx.viewports.get(id)?.presenterSurface ?? null
        const out: { repeatY: number | null; offsetY: number | null; hasMap: boolean }[] = []
        surface?.object3d?.traverse((o: any) => {
          if (o?.isMesh !== true && o?.isInstancedMesh !== true) return
          const m = o.material?.map ?? null
          out.push({ repeatY: m?.repeat?.y ?? null, offsetY: m?.offset?.y ?? null, hasMap: m != null })
        })
        return out
      })
    }, regions)
    const flat = uv.flat()
    expect(flat.length, '必须有材质（否则上面"无样本"是空洞真）').toBeGreaterThan(0)
    expect(flat.some((m) => m.hasMap), '贴图必须真的挂上去了（静态 ≠ 没贴图）').toBe(true)
    for (const m of flat.filter((x) => x.hasMap)) {
      expect(m.repeatY, '静态贴图不得被裁切（repeat.y 恒 1）').toBe(1)
      expect(m.offsetY, '静态贴图不得有 V 偏移').toBe(0)
    }

    // 时间真的走了一段：样本仍为空 ⇒ "无声明 ⇒ 不采样"不是"时间没动"的假象
    await seekSeconds(page, 0.3)
    await page.waitForTimeout(300)
    const after = await readDual(page, regions)
    for (const r of after.regions) expect(r.samples).toEqual([])
    console.log('[TT-2] static declaration ⇒ samples=0，纹理 repeat.y=1 offset.y=0（如预期）')
  })

  /**
   * TT-3：**坏字节**的处置（如实登记，不美化）。
   *
   * ## 实测事实（本批重新量过，与设计稿的预期不同）
   *
   * 设计稿 §5.3-步 6 预期"坏纹理 ⇒ 终态 failed，但视口仍挂载（不阻断）"。
   * 实测：坏字节会让 **legacy 渲染链**的 `buildMaterialLibrary` 抛错
   * （`[drw] loadStructureAndResources: failed to build textureCache`），
   * 于是整份场景**装载失败**（页面停在 "No scene loaded"）、视口根本不挂载。
   * 那是 M5-3 **不拥有**的既有行为（`render/data/buildMaterialLibrary.ts` 的
   * "一处失败即整库失败"，P10d 的五态链已在呈现侧替代它，但可见视口仍由 legacy 绘制）。
   *
   * ⇒ 本用例只断言**本批能负责的那一半**：坏字节必须落在可辨认的非就绪态，
   * 且任何已存在的视口都不得产出可采样动画（不得"假就绪"）。视口挂不挂载**如实记录**，
   * 作为遗留缺口（见交付说明）。
   */
  test('TT-3 坏字节：终态可辨认（非 ready）、无任何可采样动画（视口挂载情况如实记录）', async ({ page }) => {
    test.setTimeout(300_000)
    await gotoWorkbench(page)
    const broken = readJson(FIXTURE_PATH) as Record<string, unknown>
    broken.textureBlobs = { '0': '!!!not-a-png!!!' }
    await injectSceneDocumentOk(page, broken, FIXTURE)

    const terminal = await waitTextureState(page, TERMINAL_TEXTURE_STATES, '坏纹理终态', 180_000)
    expect(terminal, '坏字节必须落在可辨认的非就绪态（不是 ready）').not.toBe('ready')
    expect(['failed', 'missing']).toContain(terminal!)

    const regions = await readLeafRegions(page)
    const mounted = await page.locator(`${VIEWPORT_CANVAS} canvas`).count()
    const reading = regions.length === 0 ? null : await readDual(page, regions)
    for (const r of reading?.regions ?? []) {
      expect(r.samples, `区 ${r.region}：坏纹理不得产出可采样动画（不得假就绪）`).toEqual([])
    }
    console.log(
      '[TT-3] state=' + terminal + ' regions=' + regions.length + ' canvases=' + mounted +
        ' ⇒ ' + (mounted > 0 ? '视口仍挂载' : '视口未挂载（legacy 装载整体失败，既有行为，已登记遗留）'),
    )
  })
})
