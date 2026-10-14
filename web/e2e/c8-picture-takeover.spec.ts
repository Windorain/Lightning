/**
 * R1-β① C8 · **画面接管 + 拾取同批切换**（真实浏览器 / 真实工作台 UI / 生产装配 + 负对照）。
 *
 * ## 判据要回答的问题（#387 7298 第 5 项）
 *
 * "可见画面由**内核呈现根**产出、拾取走**内核链**"必须能从**真实入口**追到
 * **可观察结果**，而"测试直接调用新模块"不算。故本文件全部经生产入口：
 * `gotoWorkbench`（完整 `WorkbenchRoot`）→ 注入**真实信封夹具**（生产拖放同一 operator）
 * → 帧循环把内核文档喂给呈现会话 → 真实指针事件 → 读**公开观测面**。
 *
 * ## 两条**互相独立**的事实（为什么不是一条）
 *
 * | # | 事实 | 只证它会漏掉什么 |
 * |---|---|---|
 * | ① | 呈现根真的在场景树里（沿 `parent` 链可达 `Scene`），且 `contentGroup === presenterSurface.object3d` | 只证"对象建了" —— C7 的缺口正是**建了但没 `.add(`**（对象面绿、画面不存在） |
 * | ② | 场景里**没有**带 `userData.triangleMap` 的 legacy 网格 | 只证①的话，"legacy 网格仍与呈现根并存、仍被画"不会被发现 |
 *
 * ## 负对照（必须能抓"留了旁路"）
 *
 * 用**同一个** census 函数，注入"绘制交回 legacy `blockMesh`"的等价形态
 * （新建含 `userData.triangleMap` 的网格组并把结构层指向它）⇒ 判据①/②必须判红。
 *
 * ## 拾取的真实接管证据（同批交付的硬耦合）
 *
 * 拾取入口与画面**同批**切到内核链。若只切画面，legacy 网格上的 `triangleMap`
 * 消失会让点选**静默失效**（命中仍在、格解不出）。本文件的第二条用例走
 * **真实指针事件**（生产 `viewportBinder` 的 pointermove → `hoverHandler` →
 * `context/queries#pickEntityAtClient` → `composition/viewportPick`）读**公开悬停状态**
 * 与 **tooltip 文本**：必须解出方块 + 部件 + 部件 tooltip；且**同一时刻**场景里
 * 没有 legacy 解格网格 ⇒ 拾取不可能走旧路径（无旁路可走）。
 *
 * ## 层级声明（本判据证明到哪一层）
 *
 * | 层 | 覆盖 |
 * |---|---|
 * | 生产装配（真实外壳 + 真实信封 + 帧循环） | ✅ 主证据 |
 * | 场景树归属（`.add(` 真的发生） | ✅ 主证据 |
 * | legacy 网格在场性（0 命中） | ✅ 主证据 + 负对照 |
 * | 真实指针 → 内核拾取 → 悬停/部件/tooltip | ✅ 主证据（第二条用例） |
 * | 可见视口像素非空 | ✅ 旁证（截图 + 像素签名） |
 * | 逐像素与 legacy 链等价 | ❌ 不覆盖（由 P10d 的离屏覆盖率/包围盒判据承担） |
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  gotoWorkbench,
  injectSceneDocumentOk,
  readFixture,
  waitForViewportMounted,
  VIEWPORT_REGION,
  VIEWPORT_CANVAS,
  readPixelSignature,
  expectNotBlank,
} from './helpers/multiblock'
import {
  clearWikiHover,
  gotoWikiPreviewWithScene,
  probeHover,
  WIKI_REGION,
} from './helpers/parts/hover'
import {
  augmentFixtureGeometry,
  normalizeTextureBlobsForRender,
  quadCenter,
  readPartsFixture,
  type QuadCorners,
} from './helpers/parts'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'c8-picture')

/** 画面归属读数（与 `e2e/helpers/c8/probe.ts` 的 `PictureCensus` 同形）。 */
interface PictureCensus {
  hasSlot: boolean
  hasSurface: boolean
  contentGroupIsPresenterRoot: boolean
  presenterRootInScene: boolean
  presenterMeshes: number
  triangleMapInContentGroup: number
  triangleMapInScene: number
  meshesInScene: number
}

/**
 * 经 vite 转译加载浏览器侧探针（说明见 `helpers/c8/probe.ts` 文件头）。
 *
 * 探针要 `import * as THREE`（负对照要建 legacy 网格），而 `page.evaluate`
 * 的函数是**裸执行**的 ⇒ 必须走这一层。
 */
async function callProbe<T>(page: import('@playwright/test').Page, fn: string, regionId: string): Promise<T> {
  return (await page.evaluate(
    async ({ fn, regionId }) => {
      const mod = (await import('/e2e/helpers/c8/probe.ts')) as unknown as Record<string, (r: string) => unknown>
      return mod[fn]!(regionId)
    },
    { fn, regionId },
  )) as T
}

const readCensus = (page: import('@playwright/test').Page, regionId: string): Promise<PictureCensus> =>
  callProbe<PictureCensus>(page, 'readPictureCensus', regionId)

/** slab 夹具的增强几何（与 `parts-hover-stats.spec.ts` 的同一构造，逐字搬移）。 */
function augmentedSingleboxFixture(): Record<string, unknown> {
  let f = readPartsFixture('parts-singlebox-mix.v2.json')
  const lowerSlabTop = [[0, 0.5, 0], [1, 0.5, 0], [1, 0.5, 1], [0, 0.5, 1]] as QuadCorners
  const fullTop = [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] as QuadCorners
  const fenceTop = [[0.375, 1, 0.375], [0.625, 1, 0.375], [0.625, 1, 0.625], [0.375, 1, 0.625]] as QuadCorners
  f = augmentFixtureGeometry(f, 1, [lowerSlabTop]) // 下半 slab
  f = augmentFixtureGeometry(f, 2, [fullTop]) // 上半 slab
  f = augmentFixtureGeometry(f, 3, [fullTop]) // 石头（满方块对照）
  f = augmentFixtureGeometry(f, 4, [fenceTop]) // 栅栏
  return normalizeTextureBlobsForRender(f)
}

test.describe('R1-β① C8 · 画面接管（真实工作台 / 真实信封 / 生产装配）', () => {
  // `@smoke`（P0 · #387 材质 blend 冻结失效）：本用例断言**视口真的挂出来了**
  // —— 正是 `buildMaterialLibrary` 抛 `Cannot add property blend, object is not extensible`
  // 时最先坏掉的那一环（`loadStructureAndResources: failed to build textureCache` ⇒ 60s 挂载超时）。
  test('画面生产者是内核呈现根：在场景树里、且场景内无 legacy 解格网格（含负对照）', { tag: '@smoke' }, async ({ page }, testInfo) => {
    const file = 'multiblock-ebf-2ch.json'
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await gotoWorkbench(page)
    const fx = readFixture(file)
    await injectSceneDocumentOk(page, fx.envelope, file)
    await waitForViewportMounted(page)
    // 帧循环几拍：内核文档 → 呈现会话 apply（按内容身份去重）
    await page.waitForTimeout(2000)

    const census = await readCensus(page, VIEWPORT_REGION)
    console.log('[C8·画面接管] ' + JSON.stringify({ file, ...census }))

    // ── 判据①：呈现根真的接管了结构层且在场景树里 ──
    expect(census.hasSlot, '工作台视口槽必须存在').toBe(true)
    expect(census.hasSurface, '视口必须装配呈现会话').toBe(true)
    expect(census.contentGroupIsPresenterRoot, '结构层必须**就是**呈现会话的根对象').toBe(true)
    expect(
      census.presenterRootInScene,
      '呈现根必须沿 parent 链可达 Scene —— C7 的缺口正是"对象建了但没 .add( 进场景树"',
    ).toBe(true)
    expect(census.presenterMeshes, '呈现根必须真的挂着批次网格（画面不是空的）').toBeGreaterThan(0)

    // ── 判据②：legacy 解格网格不再参与画面（任何位置都没有） ──
    expect(
      census.triangleMapInContentGroup,
      '结构层子树里不得再有 legacy 解格网格（userData.triangleMap 是旧路径的指纹）',
    ).toBe(0)
    expect(
      census.triangleMapInScene,
      '整棵主场景里不得再有 legacy 解格网格 —— 否则"谁画了这 24 个三角形"有两个答案',
    ).toBe(0)
    expect(census.meshesInScene, '反空洞真：场景里确实有网格（否则上一条是"扫了个空场景"）').toBeGreaterThan(0)

    // ── 画面取证：可见视口的像素（真实 UI 截图 + 非空签名） ──
    const vp = page.locator(VIEWPORT_CANVAS)
    await expect(vp, '工作台此刻必须恰好一个可见视口（不得靠 .first() 静默挑选）').toHaveCount(1)
    const png = await vp.screenshot()
    fs.writeFileSync(path.join(SHOT_DIR, `c8-picture-${testInfo.project.name}.png`), png)
    const sig = await readPixelSignature(page, png)
    expectNotBlank(sig, 'C8 工作台视口画面')

    // ── 负对照：注入 legacy 画面形态 ⇒ 同一 census 必须判红 ──
    const injected = await callProbe<boolean>(page, 'injectLegacyPicture', VIEWPORT_REGION)
    expect(injected, '负对照注入必须成功（取不到会话/场景 ⇒ 判红，而不是静默跳过）').toBe(true)
    const after = await readCensus(page, VIEWPORT_REGION)
    console.log('[C8·画面接管·负对照] ' + JSON.stringify(after))
    expect(
      after.contentGroupIsPresenterRoot,
      '负对照：结构层被改指 legacy 组 ⇒ 判据①必须判红（否则它无区分力）',
    ).toBe(false)
    expect(after.triangleMapInScene, '负对照：场景里必须出现 legacy 解格网格 ⇒ 判据②会判红').toBeGreaterThan(0)

    // 负对照的画面侧**如实记**（不作断言，理由见下）：注入的 legacy 网格是一个 3 顶点三角形，
    // 它可能落在视锥/遮挡关系之外 ⇒ 画面可以逐像素不变（本批实测 `meanAbs: 0`）。
    // 那条断言会变成"注入物体位置"的判据，而不是"画面生产者归属"的判据 ——
    // 归属的区分力由上面两条 census 判据承担，它们都已如实翻面。
    const pngAfter = await vp.screenshot()
    fs.writeFileSync(path.join(SHOT_DIR, `c8-negative-legacy-${testInfo.project.name}.png`), pngAfter)
    const sigAfter = await readPixelSignature(page, pngAfter)
    console.log(
      '[C8·画面接管] 负对照前后像素签名（诊断，不作判据）'
        + JSON.stringify({ before3: sig.slice(0, 3), after3: sigAfter.slice(0, 3) }),
    )
    console.log('[C8·画面接管] 画面像素签名（前 3 格，旁证）' + JSON.stringify(sig.slice(0, 3)))
  })

  // `@smoke`（P0 · #387）：本用例走的是 **`parts-singlebox-mix.v2.json` + wiki 内嵌预览** ——
  // 正是 P0 现场（内核材质条目**冻结且无 blend**）唯一会现形的那条真入口路径。
  test('拾取同批切到内核链：真实指针解出方块+部件+tooltip，而场景内无 legacy 解格网格', { tag: '@smoke' }, async ({ page }) => {
    // 真实入口：WorkbenchRoot → 注入真实信封（含几何增强）→ 经生产 tab 切 Wiki 工作区
    // （内嵌生产 `EmbedViewport`）。几何增强与 `parts-hover-stats.spec.ts` 同一构造，
    // 探针点（下半 slab 顶面中心）是那条已验收判据用过的**已知可命中**位置。
    await gotoWikiPreviewWithScene(page, augmentedSingleboxFixture(), 'parts-singlebox-mix.hover-augmented.json')
    await page.waitForTimeout(1000)

    const lowerSlabTop = [[0, 0.5, 0], [1, 0.5, 0], [1, 0.5, 1], [0, 0.5, 1]] as QuadCorners
    // 真实指针事件（生产 `viewportBinder` 的 pointermove 监听路径）⇒ 公开悬停状态 + tooltip
    const probe = await probeHover(page, { col: 0, row: 0, z: 0, ...quadCenter(lowerSlabTop) })
    console.log(
      '[C8·拾取接管] ' + JSON.stringify({ hover: probe.hover, tooltip: probe.tooltip, pointer: probe.pointer }),
    )
    expect(String(probe.hover.blockId), '真实指针悬停必须解出方块（拾取不得静默退化）').toBeTruthy()
    expect(String(probe.hover.blockId), '不得把"空气"当命中').not.toBe('air')
    expect(probe.hover.voxel, '悬停必须带格坐标（逐格拾取）').not.toBeNull()
    // 部件级：解出部件身份 ⇒「逐格 → 格内局部点 → 部件盒」这条链在生产上真的工作
    expect(probe.hover.part?.localId, '悬停必须解出部件身份（部件级拾取链未退化）').toBe('generic:0')
    expect(probe.tooltip, '部件 tooltip 必须真的显示（tooltip 链未静默失效）').toContain('Stone Slab')

    // **同批**画面判据：悬停成功的同时场景里没有 legacy 解格网格 ⇒ 拾取不可能走旧路径
    const census = await readCensus(page, WIKI_REGION)
    expect(census.hasSurface, 'Wiki 预览视口必须装配呈现会话').toBe(true)
    expect(census.contentGroupIsPresenterRoot, 'Wiki 预览的结构层必须就是呈现根').toBe(true)
    expect(
      census.triangleMapInScene,
      '悬停成功的同时场景里不得有 legacy 解格网格 —— 否则"拾取走内核链"这句话没有排他性',
    ).toBe(0)

    // 反向控制：移出视口 ⇒ 悬停状态必须清空（证明它真由拾取驱动，不是粘住的旧值）
    await clearWikiHover(page)
    await page.waitForTimeout(300)
    const cleared = await page.evaluate((rid) => {
      const hover = (window as any).__vm__?.region(rid)?.state.hover
      return hover?.viewportBlock?.value ?? null
    }, WIKI_REGION)
    expect(cleared, 'pointerleave 后悬停状态必须清空（否则上一条的"悬停"可能是粘住的旧值）').toBeNull()
  })
})
