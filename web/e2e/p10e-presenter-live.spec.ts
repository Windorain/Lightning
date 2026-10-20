/**
 * **P10e（#299）段② · 呈现链真实上线 + 逐格交互 + 逐像素一致**（真实浏览器 + 真实 WebGL）。
 *
 * ## 本文件补什么（与前两处判据的分工）
 *
 * | 判据面 | 环境 | 证什么 |
 * |---|---|---|
 * | `cellIdentity.test.ts` / `presenterSession.test.ts` | vitest（无 GL） | 格表的**正确性**、政策的**两向**、会话的**身份去重** |
 * | `presentation-gpu.spec.ts`（P10d D3c） | 真实 GL | `compileScene` → presenter 的**编译→呈现**段（输入是探针自造） |
 * | **本文件** | 真实 GL + **真实工作台入口** | 内核链在**生产装配**下真的画出像素，且**逐格拾取**可用 |
 *
 * ## 为什么必须有这一层（P10c/P10d 反复实测的缺口形态）
 *
 * 探针驱动的判据证明的是"**给对了输入就能画**"，而缺口恰恰是"**生产里没有那个输入**"
 * —— 一个只在探针里被调用的接线**仍然是那个缺口**。故本文件走真实产品入口：
 *
 * ```
 * gotoWorkbench（完整 WorkbenchRoot）
 *   → injectSceneDocumentOk（生产 OPERATOR_OPEN_SCENE）
 *     → 生产解析器 → 生产装配 → KernelSession.adoptDocument
 *       → 视口装配 useViewportRuntime（生产 composable）
 *         → PresenterSession（**本批新增的生产消费者**）
 * ```
 *
 * ## 探针为什么要走 vite 转译（一处实测的坑）
 *
 * `page.evaluate(fn)` 把函数序列化后**裸执行**——裸说明符 `three` 没有 import map
 * 可解析，实测 `Failed to resolve module specifier 'three'`（本批首跑 10 条全红）。
 * 故浏览器侧代码放在 `e2e/helpers/p10e/probe.ts`（vite root 内），
 * 经**静态绝对路径**动态 import —— 与产品代码同一台 dev server、同一份 three。
 *
 * ## 零替身
 *
 * 全程生产类实例；无 Mock/Stub；不经测试专用 URL 参数。
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  cloneInner,
  gotoWorkbench,
  injectSceneDocumentOk,
  readFixture,
  rewrap,
  waitForViewportMounted,
} from './helpers/multiblock'
import { expectNotBlank, readPixelSignature } from './helpers/multiblock/pixels'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'p10e-presenter')

/**
 * 一条**呈现失败**记录 —— 经既有诊断读面读到的**生产值**。
 *
 * 字段口径来自写入侧（`shared/viewport/useViewportRuntime#emitPresenterFailure`）：
 * `channel: 'effect'` + `code: 'effect.failed'` + `params.source === 'presenter'`
 * （`reason` / `detail` 恒在；去重超限时多带 `dropped: true`），
 * `correlation.objectId` 只在有对象身份时才出现（纹理类失败无对象身份）。
 */
interface PresenterFailure {
  readonly code: string
  readonly channel: string
  readonly reason: string
  readonly detail: string
  readonly dropped: boolean
  readonly objectId: string | null
}

/** 呈现会话的公开观测面（经 `window.__vm__` 的 `vpSlot.presenterSurface`）。 */
interface PresenterObservation {
  readonly hasSurface: boolean
  readonly batchObjects: number
  readonly instanceCount: number
  readonly geometryBuilds: number
  readonly materialBuilds: number
  readonly missingRequiredTextures: number
  readonly generation: string | null
  readonly ledgerAcquire: number
  readonly ledgerRelease: number
  readonly ledgerActive: number
  readonly ledgerBalanced: number
  /**
   * 诊断读面是否**可用**（`ctx.getDiagnostics()` 在场且 `byCode` 可调）。
   *
   * ⚠️ 它必须与 `presenterFailures` 一起返回，否则本文件又回到同一种假绿：
   * 读面缺失时 `presenterFailures` 只能是空数组，而 `toEqual([])` 会把"读不到"
   * 静默当成"没有错误"（恒真）。分开成两个字段后，断言才能区分
   * "真的没有错误" 与 "根本读不到"。
   */
  readonly diagnosticsReadable: boolean
  /** 呈现失败记录（**生产值**：读面 = `ctx.getDiagnostics().byCode('effect.failed')`）。 */
  readonly presenterFailures: readonly PresenterFailure[]
  /**
   * 资源失败记录（**生产值**：读面 = `ctx.getDiagnostics()` 的 `resource.*` 族）。
   *
   * M8-5 把「必需贴图缺失」这条事实从 `effect.failed` 迁到了 `resource.*`
   * （S0-B D2/D7：借用 effect 通道的记录没有 assetId，与编译/注解失败混在一起）。
   * 本字段就是那条事实现在的读面 —— 判据跟着事实走，而不是跟着旧码走。
   */
  readonly resourceRecords: readonly { code: string; channel: string; params: Record<string, string | number | boolean> }[]
}

/**
 * 从**视口的呈现会话**读统计（经 `window.__vm__`，**不**经组件 ref）。
 *
 * ## 为什么经 `ctx.viewports` 而不是组件
 *
 * 会话挂在 `ViewportSlot` 上，而 slot 由 `ViewportManager` 持有 —— 它是 `Context`
 * 的一部分，**不依赖任何组件挂载**（#249 明文："Area 与编辑器实例的寿命不依赖
 * 组件挂载"）。经组件读会让"组件重挂 ⇒ 观测面丢失"，判据随 UI 结构调整假红。
 *
 * ## `ledgerBalanced` 为什么**不**在这里断言
 *
 * 会话**活跃**时账必然不平衡（acquire 2 / release 0）—— 那是"还没释放"，
 * 不是泄漏。A19 的判据是"**各自动 dispose 之后**账守恒"（e2e 侧的正确形态见
 * `presentation-gpu.spec.ts` 的 A19 组）。故本文件只读 acquire/active 作为
 * "真的持有了资源"的证据，**不**在活跃态断言守恒（那会是一条恒假的判据）。
 *
 * ## 呈现失败为什么读**诊断读面**（修的是本文件此前的假绿）
 *
 * 旧版这里返回 `presenterErrors: []`（手写空数组）⇒ `:187` 的
 * `toEqual([])` 与产品行为**无关**，恒真。生产里那条链的真实事实写在
 * `ctx.wm.diagnostics`（读面 `ctx.getDiagnostics()`，e2e 经 `__vm__` 取），
 * 写入形态见 `emitPresenterFailure`：`channel:'effect'` + `code:'effect.failed'`
 * + `params.source === 'presenter'`。故这里按**码 + source** 过滤读它 ——
 * 判据从此跟着产品行为走：有失败就非空，没失败才为空。
 */
async function readPresenterObservation(page: Page): Promise<PresenterObservation> {
  return await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const slots = ctx?.viewports
    const readView = ctx?.getDiagnostics?.()
    const diagnosticsReadable = readView !== undefined && typeof readView.byCode === 'function'
    const presenterFailures = diagnosticsReadable
      ? (readView.byCode('effect.failed') as any[])
          .filter((r) => r?.params?.source === 'presenter')
          .map((r) => ({
            code: String(r.code ?? ''),
            channel: String(r.channel ?? ''),
            reason: String(r.params.reason ?? ''),
            detail: String(r.params.detail ?? ''),
            dropped: r.params.dropped === true,
            objectId: typeof r.correlation?.objectId === 'string' ? r.correlation.objectId : null,
          }))
      : []
    const resourceRecords = diagnosticsReadable
      ? (readView.all() as any[])
          .filter((r) => String(r?.code ?? '').startsWith('resource.'))
          .map((r) => ({
            code: String(r.code ?? ''),
            channel: String(r.channel ?? ''),
            params: (r.params ?? {}) as Record<string, string | number | boolean>,
          }))
      : []
    const blank: any = {
      hasSurface: false, batchObjects: 0, instanceCount: 0, geometryBuilds: 0, materialBuilds: 0,
      missingRequiredTextures: 0, generation: null, ledgerAcquire: 0, ledgerRelease: 0,
      ledgerActive: 0, ledgerBalanced: 0, diagnosticsReadable, presenterFailures, resourceRecords,
    }
    if (slots === undefined) return blank
    const candidates: any[] = []
    const active = slots.active?.value
    if (active) candidates.push(active)
    for (const id of ['r-viewport', 'r-wiki-preview', 'r-workbench-viewport', 'r-embed']) {
      const s = slots.get?.(id)
      if (s) candidates.push(s)
    }
    const hit = candidates.find((s) => s?.presenterSurface != null)
    if (hit === undefined) return blank
    const st = hit.presenterSurface.statsSnapshot()
    const led = hit.presenterSurface.ledger()
    return {
      hasSurface: true,
      batchObjects: st.batchObjects,
      instanceCount: st.instanceCount,
      geometryBuilds: st.geometryBuilds,
      materialBuilds: st.materialBuilds,
      missingRequiredTextures: st.missingRequiredTextures,
      generation: st.generation ?? null,
      ledgerAcquire: led.acquireTotal,
      ledgerRelease: led.releaseTotal,
      ledgerActive: led.activeCount,
      ledgerBalanced: led.balanced === true ? 1 : 0,
      diagnosticsReadable,
      presenterFailures,
      resourceRecords,
    }
  }) as Promise<PresenterObservation>
}

/** 只取呈现失败（轮询用；与 `readPresenterObservation` 同一读面、同一过滤口径）。 */
async function readPresenterFailures(page: Page): Promise<readonly PresenterFailure[]> {
  return (await readPresenterObservation(page)).presenterFailures
}

/** 只取 `resource.*` 记录（轮询用；同上一个读面）。 */
async function readResourceRecords(
  page: Page,
): Promise<PresenterObservation['resourceRecords']> {
  return (await readPresenterObservation(page)).resourceRecords
}

/** 经 vite 转译加载浏览器侧探针（见文件头"探针为什么要走 vite 转译"）。 */
async function loadProbe(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await import('/e2e/helpers/p10e/probe.ts')
  })
}

type ProbeModule = {
  renderBothChainsOffscreen(): Promise<{
    presenter: { nonBackground: number; coverage: number; bbox: readonly number[] }
    legacy: { nonBackground: number; coverage: number; bbox: readonly number[] }
    negativeEmpty: boolean
    width: number
    height: number
    note: string
  }>
  pickCellsAcrossViewport(): {
    hits: number
    stale: number
    cells: readonly string[]
    sample: readonly { objectId: string; cell: string; quadIndex: number }[]
    note: string
  }
}

async function callProbe<T>(page: Page, fn: keyof ProbeModule): Promise<T> {
  return (await page.evaluate(
    async ({ fn }) => {
      const mod = (await import('/e2e/helpers/p10e/probe.ts')) as unknown as Record<string, () => unknown>
      return await mod[fn]!()
    },
    { fn: fn as string },
  )) as T
}

test.describe('P10e 段② · 呈现链真实上线（生产装配 → PresenterSession）', () => {
  for (const file of ['multiblock-tier-only.json', 'multiblock-ebf-2ch.json'] as const) {
    test(`${file}：呈现会话在生产里产出批次、持有资源、无错误`, async ({ page }, testInfo) => {
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      await gotoWorkbench(page)
      const fx = readFixture(file)
      await injectSceneDocumentOk(page, fx.envelope, file)
      await waitForViewportMounted(page)
      // 给帧循环几拍以便 apply 生效
      await page.waitForTimeout(1500)

      const obs = await readPresenterObservation(page)
      console.log(`[P10e·presenter] ${file} ` + JSON.stringify(obs))

      // ① 生产里**真的**有呈现会话（不是"代码存在但没人 new"）
      expect(obs.hasSurface, `${file}: 视口必须装配了呈现会话（本批的全部理由）`).toBe(true)
      // ② 它**真的**画了（批次数 > 0；0 = 接线到了但没产出）
      expect(obs.batchObjects, `${file}: 呈现会话必须产出批次对象`).toBeGreaterThan(0)
      expect(obs.instanceCount, `${file}: 必须有实例`).toBeGreaterThan(0)
      // ③ 几何/材质真的被建（不是空批次）
      expect(obs.geometryBuilds, `${file}: 必须建了几何`).toBeGreaterThan(0)
      expect(obs.materialBuilds, `${file}: 必须建了材质`).toBeGreaterThan(0)
      // ④ 世代已建立（拾取映射的前提）
      expect(obs.generation, `${file}: 必须建立编译世代`).toBeTruthy()
      // ⑤ 活跃态**持有**资源（acquire > 0 且 active == acquire-release）
      expect(obs.ledgerAcquire, `${file}: 必须登记了归属资源`).toBeGreaterThan(0)
      expect(
        obs.ledgerActive,
        `${file}: 活跃资源数必须等于 acquire - release（账面自洽）`,
      ).toBe(obs.ledgerAcquire - obs.ledgerRelease)
      // ⑥ 呈现链不得有编译错误/跳过（内核内容必须被完整吃下）
      //
      // ⚠️ 这条断言此前是**恒真**的：读的是本文件手写的 `presenterErrors: []`。
      // 现在读的是生产诊断记录（`effect.failed` + `params.source==='presenter'`）；
      // 且先断言读面可用 —— 否则"读不到"会被静默当成"没有错误"。
      expect(
        obs.diagnosticsReadable,
        `${file}: 诊断读面必须可用（否则"没有失败"只说明没读到）`,
      ).toBe(true)
      expect(obs.presenterFailures, `${file}: 呈现链不得有错误`).toEqual([])

      // ⑦ 逐像素：视口画面非空（走既有判据，门限与其它 spec 同源）
      const png = await page.screenshot({ fullPage: false })
      const shot = path.join(SHOT_DIR, `${file.replace(/\.json$/, '')}-${testInfo.project.name}.png`)
      fs.writeFileSync(shot, png)
      const sig = await readPixelSignature(page, png)
      expectNotBlank(sig, `${file} 视口画面`)
    })
  }

  /**
   * **呈现失败的判据本身必须可红**（修 #391 的假绿）。
   *
   * 上一条 ⑥ 断言"干净文档 ⇒ 呈现失败记录为空"。一条**恒真**的空断言与它长得一模一样
   * （旧版就是手写 `presenterErrors: []`），故必须再给一次**正面对照**：
   * 真的注入一次呈现失败 ⇒ 同一读面必须报出那条记录。
   *
   * ## 注入什么、为什么（**走生产链**，不是直接调函数）
   *
   * 篡改副本的**内嵌纹理字节**（`textureBlobs[0]` 换成非图像），其余一字不改，
   * 经 `rewrap` 重建信封后仍走生产入口 `OPERATOR_OPEN_SCENE`。于是：
   *
   * ```
   * 内嵌字节坏 → composition/kernelTextureResources#textureResourcesOf 逐条解码 ⇒ state='failed'
   *   → presentation/textureBinding#bindTexture: required && failed ⇒ missingRequired=true
   *     → presenterSession#bindTextures 统计 missingRequired > 0
   *       → useViewportRuntime#syncPresenterTextures:
   *          presenterBundle.resources.reportOutcome(…)         // M8-5：事实的新家
   *            ⇒ resource.failed（逐条，带 assetId/locator）+ resource.degraded（missingRequired）
   * ```
   *
   * ⚠️ **M8-6 订正（本判据此前已红）**：M8-5（`fdf50f56`）把「必需贴图缺失」从
   * `effect.failed`（借用的过渡口径，S0-B D2/D7）迁到 `resource.*`，本文件仍按旧码读 ⇒
   * 正对照恒红。判据**跟着事实走**：现在读 `resource.*` 族，强度不降反升 ——
   * 除了「必须有记录」，还要求记录**点名那张资源**（D7：只有计数不可定位）。
   *
   * 选这条而不是"直接调 `applyKernelDocument`"的理由：**发射点在帧循环里**
   * （会话自己不写诊断），只有走真实文档加载 + 真实帧循环才证明"接线还在"。
   *
   * ## 负对照（同一页面、同一 `Context`，先读后注入）
   *
   * 注入前先读一次：读面可用且**零**记录。诊断是**只追加**的环形缓冲，
   * 故"注入前 0 条 → 注入后 ≥1 条且 reason 正确"不可能由测试自造 —— 报出这条记录的
   * 只能是产品代码。
   */
  test('**正对照**：注入一次呈现失败 ⇒ 诊断读面必须报出该记录（reason/source 正确）', async ({ page }) => {
    await gotoWorkbench(page)

    // ── ① 负对照（同页面、同 Context，注入之前）：读面可用 + 零记录 ──
    const before = await readPresenterObservation(page)
    expect(before.diagnosticsReadable, '诊断读面必须可用（否则"读不到"会被当成"没有失败"）').toBe(true)
    expect(
      before.presenterFailures,
      `未注入任何文档时不得有呈现失败记录（实测 ${JSON.stringify(before.presenterFailures)}）`,
    ).toEqual([])

    // ── ② 注入：只把第 0 条内嵌纹理的字节换成非图像（其余逐字不动）──
    const { envelope, inner } = readFixture('multiblock-tier-only.json')
    const tampered = cloneInner(inner)
    const blobs = tampered.textureBlobs as string[]
    expect(blobs.length, '该夹具必须带内嵌纹理字节（否则这条注入没有着力点）').toBeGreaterThan(0)
    const cleanBlob = blobs[0]!
    blobs[0] = Buffer.from('not-an-image', 'utf8').toString('base64')
    expect(blobs[0], '篡改必须真的换了字节').not.toBe(cleanBlob)

    const injected = await injectSceneDocumentOk(
      page,
      rewrap(envelope, tampered),
      'tampered-texture.json',
    )
    expect(injected.docLoaded, '坏一张贴图仍应能正常解析（否则红色来自解析失败，不是判据）').toBe(true)
    expect(injected.isMultiblock).toBe(true)
    await waitForViewportMounted(page)

    // ── ③ 判据：记录必须出现在诊断读面上（有界轮询，不靠固定 sleep 猜）──
    await expect
      .poll(async () => (await readResourceRecords(page)).length, {
        timeout: 30_000,
        message: '贴图坏掉后必须报出 resource.* 记录（读面 = getDiagnostics()）',
      })
      .toBeGreaterThan(0)

    const records = await readResourceRecords(page)
    console.log(`[P10e·资源失败] 注入坏贴图 ⇒ 记录 ${JSON.stringify(records)}`)

    // 逐资源：必须有 `resource.failed`，且**点名**（assetId / locator —— D7 的可定位要求）。
    const failed = records.filter((r) => r.code === 'resource.failed')
    expect(failed.length, `必须报出逐资源失败：实测 ${JSON.stringify(records)}`).toBeGreaterThan(0)
    expect(failed[0]!.channel, '必须落在 resource 通道（不借 effect 冒充）').toBe('resource')
    const named = failed.some((r) => String(r.params.assetId ?? '') !== '' || String(r.params.locator ?? '') !== '')
    expect(named, '失败记录必须点名失败的那一项资源（assetId/locator），只有计数不算可定位').toBe(true)

    // 汇总：`missingRequired > 0` 就是"必需贴图缺失"这条事实（M8-5 的迁移落点）。
    const degraded = records.filter((r) => r.code === 'resource.degraded')
    expect(degraded.length, '必须有降级汇总记录（否则"画面变平了但账上什么都没有"）').toBeGreaterThan(0)
    expect(
      Number(degraded[0]!.params.missingRequired),
      `missingRequired 必须是缺失计数（实测 ${JSON.stringify(degraded[0]!.params)}）`,
    ).toBeGreaterThan(0)

    // ── ④ 负对照第二半：**干净的**同一份夹具不得报出这条 reason ──
    // 先证明"呈现链真的在这份文档上跑过"（有批次），再断言它零记录 ——
    // 否则"没记录"可能只是"还没跑"。最后用③**同一个过滤 + 同一个 reason** 再判一次 0，
    // 使"③ 的红"有对照：同一判据在干净文档上恒为 0。
    await gotoWorkbench(page)
    const clean = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, clean.envelope, clean.file)
    await waitForViewportMounted(page)
    await page.waitForTimeout(1500)
    const cleanObs = await readPresenterObservation(page)
    expect(cleanObs.batchObjects, '干净夹具上呈现链必须真的产出批次（否则"零记录"没有意义）').toBeGreaterThan(0)
    expect(
      cleanObs.presenterFailures,
      `干净夹具不得报出呈现失败（实测 ${JSON.stringify(cleanObs.presenterFailures)}）`,
    ).toEqual([])
    // 只排**失败/降级**码：`resource.acquired` 是健康的"拿到了几个句柄"的记录（成功类），
    // 干净文档上有它是**正确**的 —— 把它算进负对照会让"有记录"与"有失败"混为一谈。
    const cleanFailures = cleanObs.resourceRecords.filter(
      (r) => r.code === 'resource.failed' || r.code === 'resource.degraded',
    )
    expect(
      cleanFailures,
      `③ 用的同一条判据（同一读面 + 同一失败码族）在干净夹具上必须为 0：实测 ${JSON.stringify(cleanFailures)}`,
    ).toEqual([])
  })

  test('**逐格拾取可用**（真实视口 + 多个屏幕位置 ⇒ 解出多个不同的格）', { tag: '@smoke' }, async ({ page }) => {
    await gotoWorkbench(page)
    const fx = readFixture('multiblock-lsc-overlap.json')
    await injectSceneDocumentOk(page, fx.envelope, 'multiblock-lsc-overlap.json')
    await waitForViewportMounted(page)
    await page.waitForTimeout(1500)
    await loadProbe(page)

    const picked = await callProbe<ProbeModule['pickCellsAcrossViewport'] extends never ? never : Awaited<ReturnType<ProbeModule['pickCellsAcrossViewport']>>>(
      page,
      'pickCellsAcrossViewport',
    )
    const unique = new Set(picked.cells)
    console.log(
      '[P10e·逐格拾取] ' +
        JSON.stringify({ note: picked.note, hits: picked.hits, stale: picked.stale, uniqueCells: unique.size, sample: picked.sample }),
    )

    expect(picked.note, '探针必须取到呈现会话与相机').toBe('ok')
    expect(picked.hits, '扫视口必须命中多次（否则判据没真的跑）').toBeGreaterThan(0)
    expect(picked.stale, 'A12：正常路径不得出现过期拾取').toBe(0)
    expect(
      unique.size,
      `不同屏幕位置必须解出不同的格（实测 ${unique.size} 个：${[...unique].slice(0, 6).join(' / ')}）—— ` +
        '只有一个格说明逐格层没起作用（任何点击都解到同一格）',
    ).toBeGreaterThan(1)
    // 每个样本都必须带对象身份（**格身份不取代对象身份**）
    for (const s of picked.sample) {
      expect(s.objectId, '拾取必须同时解出对象身份').toBeTruthy()
      expect(Number.isInteger(s.quadIndex), '面序号必须是整数').toBe(true)
    }
  })

  test('**负对照**：换一份夹具 ⇒ 拾取到的格集合不同（证明读的是真实内容）', async ({ page }) => {
    await gotoWorkbench(page)
    const a = readFixture('multiblock-tier-only.json')
    await injectSceneDocumentOk(page, a.envelope, 'multiblock-tier-only.json')
    await waitForViewportMounted(page)
    await page.waitForTimeout(1500)
    await loadProbe(page)
    const pa = await callProbe<ReturnType<ProbeModule['pickCellsAcrossViewport']>>(page, 'pickCellsAcrossViewport')

    const b = readFixture('multiblock-ebf-2ch.json')
    await injectSceneDocumentOk(page, b.envelope, 'multiblock-ebf-2ch.json')
    await waitForViewportMounted(page)
    await page.waitForTimeout(1500)
    const pb = await callProbe<ReturnType<ProbeModule['pickCellsAcrossViewport']>>(page, 'pickCellsAcrossViewport')

    expect(pa.note + pb.note, '两份都必须取到会话').toBe('okok')
    expect(pa.hits + pb.hits, '两份都必须命中过').toBeGreaterThan(0)
    const sa = [...new Set(pa.cells)].sort().join('|')
    const sb = [...new Set(pb.cells)].sort().join('|')
    expect(
      sa === sb,
      `两份夹具（1×3×1 vs 多列多变体）的格集合必须不同 —— 实测 A={${sa.slice(0, 90)}} B={${sb.slice(0, 90)}}`,
    ).toBe(false)
  })
})

test.describe('P10e 段② · **逐像素证据**：呈现链与 legacy 链在同一相机下结构性等价', () => {
  test('两份夹具：两路都非空、覆盖率接近、包围盒接近；负对照为空', async ({ page }, testInfo) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await gotoWorkbench(page)

    for (const file of ['multiblock-ebf-2ch.json', 'multiblock-tier-only.json'] as const) {
      const fx = readFixture(file)
      await injectSceneDocumentOk(page, fx.envelope, file)
      await waitForViewportMounted(page)
      await page.waitForTimeout(1500)
      await loadProbe(page)

      const m = await callProbe<Awaited<ReturnType<ProbeModule['renderBothChainsOffscreen']>>>(
        page,
        'renderBothChainsOffscreen',
      )
      const record = { file, project: testInfo.project.name, ...m }
      fs.writeFileSync(
        path.join(SHOT_DIR, `${file.replace(/\.json$/, '')}-${testInfo.project.name}-pixel.json`),
        `${JSON.stringify(record, null, 2)}\n`,
      )
      console.log(
        `[P10e·逐像素] ${file} ` +
          JSON.stringify({
            note: m.note,
            presenterCoverage: Number(m.presenter.coverage.toFixed(4)),
            legacyCoverage: Number(m.legacy.coverage.toFixed(4)),
            presenterBbox: m.presenter.bbox,
            legacyBbox: m.legacy.bbox,
            negativeEmpty: m.negativeEmpty,
          }),
      )

      // ① 前提：探针真的取到了两条链
      expect(m.note, `${file}: 探针必须取到呈现会话与 legacy 内容组`).toBe('ok')
      expect(m.width, '离屏目标必须有尺寸').toBeGreaterThan(0)
      // ② **两路都真的画了**（本判据的核心：呈现链不是空产出）
      expect(m.presenter.nonBackground, `${file}: 呈现链必须画出像素（本批的全部理由）`).toBeGreaterThan(0)
      expect(m.legacy.nonBackground, `${file}: legacy 链必须画出像素（前提）`).toBeGreaterThan(0)
      // ③ 覆盖率接近（同一份几何 + 同一相机 ⇒ 覆盖面积必然接近。
      //    门限 0.5×/2× 是**宽松**的：材质差异会改变边缘/透明像素，
      //    但不会改变 50% 的覆盖面积。）
      const ratio = m.presenter.coverage / m.legacy.coverage
      expect(
        ratio,
        `${file}: 两路覆盖率必须在同一量级（实测 ${ratio.toFixed(3)}：呈现 ${m.presenter.coverage.toFixed(4)} vs legacy ${m.legacy.coverage.toFixed(4)}）`,
      ).toBeGreaterThan(0.5)
      expect(ratio, `${file}: 覆盖率比不得反向偏离`).toBeLessThan(2)
      // ④ 包围盒接近（位置对得上；容差 20% 视图宽/高）
      for (let i = 0; i < 4; i++) {
        const tol = (i % 2 === 0 ? m.width : m.height) * 0.2
        expect(
          Math.abs(m.presenter.bbox[i]! - m.legacy.bbox[i]!),
          `${file}: 包围盒第 ${i} 维偏离过大（呈现 ${m.presenter.bbox} vs legacy ${m.legacy.bbox}）`,
        ).toBeLessThanOrEqual(tol)
      }
      // ⑤ **负对照**：不加任何对象 ⇒ 必须为空（证明"非空"不是恒真）
      expect(m.negativeEmpty, `${file}: 负对照（不加对象）必须为空`).toBe(true)
    }
  })
})
