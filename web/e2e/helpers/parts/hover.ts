/**
 * 部件断言包 —— 悬停管线 helper（零替身五原则的部件轮落点）。
 *
 * 与多方块轮同一套原则（见 `helpers/multiblock/harness.ts` 文件头），本文件只新增
 * 部件轮需要的原语：
 *
 *  1. **入口挂载**：复用 `gotoWorkbench()`（完整 WorkbenchRoot）。部件 tooltip 与
 *     统计侧栏的 DOM 只在 **Wiki 工作区**（`WorkbenchRoot` 内嵌的 `EmbedPreview` =
 *     生产 EmbedViewport，含 `ToolTipBox` 与 `BlockStatsSidebar`）渲染，
 *     因此经生产 `WorkspaceTabs` 的 DOM click 切入 Wiki 工作区 —— 这就是生产用户
 *     查看嵌入预览的同一路径，不是测试壳。
 *  2. **DOM 事件注入**：`injectHoverAtCellLocal()` 把「格内局部坐标」经**视口实际
 *     相机**（公开观测 `ctx.viewports.get(rid).camera`，正交；`rid` 缺省为 Wiki 预览，
 *     可传 `r-viewport` 复用同一注入路径）投影到
 *     client 坐标，再在视口 DOM 元素上派发 `pointermove` —— 与 `viewportBinder`
 *     的生产监听（capture 阶段 `pointermove` → `ed.dispatch`）同一路径。
 *     投影与派发在**同一次 evaluate** 内完成，相机在两者之间不可能移动。
 *  3. **公开观测**：`window.__vm__` → `ctx.viewports.get(rid)` 的
 *     `camera/domElement/definition/contentGroup`（公开字段，与 `context/queries.ts`
 *     拾取链读的是同一份），加上 `ctx.region('r-wiki-preview').state.hover`
 *     （hoverHandler 写入的公开悬停状态，`viewportBlock.part` 即部件命中信息）
 *     与 DOM（`.wm-tooltip-box`）。
 *  4. **零替身**：无 Mock/Fake/Stub；投影数学（列主序矩阵乘法）在页面内对公开
 *     相机矩阵手工展开，等价于 three.js 的 `Vector3.project`，不 import 内部模块。
 */

import { expect, type Page } from '@playwright/test'
import { pollUntil, readContentMesh, gotoWorkbench, injectSceneDocumentOk } from '../multiblock'

/** Workbench Wiki 预览的视口 region id（`runtime/regionIds.ts` REGION.WIKI_PREVIEW）。 */
export const WIKI_REGION = 'r-wiki-preview'
/** Wiki 工作区 tab（`WorkspaceTabs.vue`，i18n zh 默认）。 */
export const WIKI_TAB_TEXT = 'Wiki 查看器'
/** Wiki 预览根容器（`WorkbenchRoot.vue` `.wb-wiki-embed`）。 */
export const WIKI_EMBED = '.wb-wiki-embed'
/** 视口 tooltip（`ToolTipBox.vue`，Teleport 到 body）。 */
export const TOOLTIP_BOX = '.wm-tooltip-box'

/**
 * Wiki 预览里**作用域化**的视口选择器。
 *
 * `.vc-viewport` 是**全文档**类名：工作台视口（`WorkbenchViewport`，
 * region `r-viewport`）与 Wiki 预览视口（`EmbedViewport`，region
 * `r-wiki-preview`）都用它。P6 之前只有前者会被 `v-show` 保活，
 * 后者按 `v-if` 挂卸；P6 把保活改成显式生命周期后两端的挂载语义一致，
 * 于是"取第一个"的含混必须消除 —— 判据要的是"Wiki 嵌入里的那个"。
 */
export const WIKI_VIEWPORT = `${WIKI_EMBED} .vc-viewport`

/**
 * 截取 **Wiki 预览视口**（P6 e2e 审计的 must-fix #1）。
 *
 * ## 为什么不能用 `page.locator('.vc-viewport').first()`
 *
 * `.first()` 有一个致命性质：**它从不在多重匹配时报错**，而是静默取
 * DOM 顺序第一个。此前就出过一次这样的事故：
 * `parts-outline-b1.spec.ts` 的 `.vc-viewport').first()` 在 `v-show` 保活下
 * 选到了 `display:none` 的工作台视口，`locator.screenshot()` 于是在
 * actionability 上等 → **180s 超时**。
 *
 * 作用域化之外还要**断言唯一性**：作用域内若仍有两个匹配，说明 Wiki 工作区里
 * 真出现了两个视口 —— 那是需要响亮报错的结构问题，不是"随便挑一个"。
 */
export async function screenshotWikiViewport(page: Page, path: string): Promise<void> {
  const vp = page.locator(WIKI_VIEWPORT)
  await expect(vp, 'Wiki 预览必须恰好有一个视口（不得靠 .first() 静默挑选）').toHaveCount(1)
  await vp.screenshot({ path })
}

// ---------------------------------------------------------------------------
// 入口：Workbench → 注入场景 → Wiki 工作区就绪
// ---------------------------------------------------------------------------

/**
 * 等 Wiki 预览视口 slot 装配完成（camera + definition + domElement）。
 * `requireMesh=true`（悬停用例）额外等内容 mesh 挂载；
 * `false`（统计/回归用例）不要求 mesh —— 手工 fixture 的 textureBlobs 是对象数组
 * 格式（渲染管线只认 string[]，multiblock README 开放项 4 的既有口径），网格构建
 * 会失败但**侧栏不受影响**（loadStatus 在 mesh 之前已 ok）。
 */
export async function waitWikiViewportReady(
  page: Page,
  timeout = 60_000,
  requireMesh = true,
): Promise<void> {
  // 作用域化（P6）：问的是"Wiki 嵌入里的 canvas"，不是"全文档第一个 canvas"
  await expect(page.locator(`${WIKI_VIEWPORT} canvas`)).toBeVisible({ timeout })
  await page.waitForFunction(
    (rid) => {
      const ctx = (window as any).__vm__
      const slot = ctx?.viewports?.get(rid)
      /**
       * P6：除"字段非空"外，还要求槽位**活着**。
       *
       * 旧实现卸载视口时只解绑监听，不清槽位 —— 于是 `camera`/`definition`/
       * `domElement` 都还指向已 dispose 的句柄，本等待会对**一个死视口**成立。
       * `runtime/viewportManager.ts` 现在在卸载时归零槽位，并导出判据
       * `isSlotLive`（= `camera` 与 `domElement` 同时非空）。
       * 这里就用那个判据的等价形式（页面内不能 import 模块，故内联同一条件）。
       */
      return !!slot?.camera?.value && !!slot?.definition?.value && !!slot?.domElement?.value
    },
    WIKI_REGION,
    { timeout },
  )
  if (!requireMesh) return
  await pollUntil(
    async () => {
      const mesh = await readContentMesh(page, WIKI_REGION)
      return mesh.present && mesh.meshes > 0 ? mesh : null
    },
    'Wiki 预览内容 mesh 挂载',
    timeout,
  )
}

/**
 * 等相机稳定（`OPERATOR_INIT_VIEWPORT_CAMERA` 在 loadStatus=ok 后异步执行一次；
 * 连续两次读数一致 = init 已落定，此后投影注入不会被相机移动偷换）。
 */
export async function waitWikiCameraStable(page: Page, timeout = 20_000): Promise<void> {
  const readCam = () =>
    page.evaluate((rid) => {
      const cam = (window as any).__vm__?.viewports?.get(rid)?.camera?.value
      return cam ? JSON.stringify([cam.position.toArray(), cam.zoom]) : null
    }, WIKI_REGION)
  const deadline = Date.now() + timeout
  let prev = await readCam()
  for (;;) {
    await page.waitForTimeout(250)
    const cur = await readCam()
    if (cur && cur === prev) return
    prev = cur
    if (Date.now() > deadline) throw new Error('Wiki 预览相机在 20s 内未稳定')
  }
}

/**
 * 完整前置：WorkbenchRoot → 注入场景（IO 接管）→ 切 Wiki 工作区（DOM click）→
 * 视口/相机就绪。返回注入结果（调用方通常已用 `injectSceneDocumentOk` 语义断言）。
 */
export async function gotoWikiPreviewWithScene(
  page: Page,
  json: unknown,
  fileName: string,
  options?: { requireMesh?: boolean },
): Promise<void> {
  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, json, fileName)
  await page.locator('.wt-tab', { hasText: WIKI_TAB_TEXT }).click()
  await waitWikiViewportReady(page, 60_000, options?.requireMesh ?? true)
  await waitWikiCameraStable(page)
}

// ---------------------------------------------------------------------------
// 投影注入：格内局部坐标 → client 坐标 → pointermove
// ---------------------------------------------------------------------------

/** 格内局部坐标探针点（col/row/z = cellGrid 下标；l* = 0–1 方块局部，可越界）。 */
export interface CellLocalPoint {
  col: number
  row: number
  z: number
  lx: number
  ly: number
  lz: number
}

export interface InjectedPointer {
  clientX: number
  clientY: number
  world: { x: number; y: number; z: number }
}

/**
 * 把格内局部点经视口当前正交相机投影到 client 坐标，并在视口 DOM 元素上派发
 * `pointermove`（生产 `viewportBinder` 监听路径）。返回实际注入的坐标供日志。
 *
 * 世界偏移与网格生成互逆（`structureGeometryUVs.ts`：ox = col - w/2，
 * oy = worldY - h/2，oz = z - d/2；worldY = h-1-row）。
 */
export async function injectHoverAtCellLocal(
  page: Page,
  pt: CellLocalPoint,
  rid: string = WIKI_REGION,
): Promise<InjectedPointer> {
  return await page.evaluate(
    ({ rid, pt }) => {
      const ctx = (window as any).__vm__
      const slot = ctx.viewports.get(rid)
      const cam = slot.camera.value
      const el = slot.domElement.value as HTMLElement
      const g = slot.definition.value.cellGrid as number[][][]
      const d = g.length
      const h = g[0]!.length
      const w = g[0]![0]!.length
      const worldY = h - 1 - pt.row
      const p = { x: pt.col - w / 2 + pt.lx, y: worldY - h / 2 + pt.ly, z: pt.z - d / 2 + pt.lz }
      // 列主序 4×4 矩阵 × 齐次向量（等价 three.js Matrix4.applyToVector3）
      const mul = (m: number[], v: [number, number, number, number]): [number, number, number, number] => [
        m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]! * v[3],
        m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]! * v[3],
        m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]! * v[3],
        m[3]! * v[0] + m[7]! * v[1] + m[11]! * v[2] + m[15]! * v[3],
      ]
      cam.updateMatrixWorld()
      const view = mul(cam.matrixWorldInverse.elements, [p.x, p.y, p.z, 1])
      const clip = mul(cam.projectionMatrix.elements, view)
      const ndc = { x: clip[0] / clip[3], y: clip[1] / clip[3] }
      const rect = el.getBoundingClientRect()
      const clientX = rect.left + ((ndc.x + 1) / 2) * rect.width
      const clientY = rect.top + ((1 - ndc.y) / 2) * rect.height
      el.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: 'mouse',
          isPrimary: true,
          clientX,
          clientY,
          button: 0,
          buttons: 0,
        }),
      )
      return { clientX, clientY, world: p }
    },
    { rid, pt },
  )
}

/**
 * 把格内局部点经视口当前正交相机投影到 **client 坐标**（不派发任何事件）。
 *
 * 与 {@link injectHoverAtCellLocal} 同一套投影数学（世界偏移与网格生成互逆：
 * `ox = col - w/2`、`oy = worldY - h/2`、`oz = z - d/2`；worldY = h-1-row），
 * 但**只算不派发** —— 供需要真实输入设备的判据（`page.mouse.click`，
 * 见 `kernel-click-pick.spec.ts`）在 Node 侧拿到坐标。
 *
 * ⚠️ 两者**不合并**：注入版把投影与派发放在同一次 evaluate 内，是为了保证
 * "相机在两者之间不可能移动"；若先取坐标再回 Node 派发，中间可能发生相机 fit。
 * 真实输入判据本身要求"鼠标真的移动/点击"，因此这里接受这一点，并在
 * 采样前后复核 hover 返回的 voxel（以拾取实际结果为准，不硬编码坐标）。
 */
export async function projectCellLocal(
  page: Page,
  pt: CellLocalPoint,
  rid: string,
): Promise<InjectedPointer> {
  return await page.evaluate(
    ({ rid, pt }) => {
      const ctx = (window as any).__vm__
      const slot = ctx.viewports.get(rid)
      const cam = slot.camera.value
      const el = slot.domElement.value as HTMLElement
      const g = slot.definition.value.cellGrid as number[][][]
      const d = g.length
      const h = g[0]!.length
      const w = g[0]![0]!.length
      const worldY = h - 1 - pt.row
      const p = { x: pt.col - w / 2 + pt.lx, y: worldY - h / 2 + pt.ly, z: pt.z - d / 2 + pt.lz }
      const mul = (m: number[], v: [number, number, number, number]): [number, number, number, number] => [
        m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]! * v[3],
        m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]! * v[3],
        m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]! * v[3],
        m[3]! * v[0] + m[7]! * v[1] + m[11]! * v[2] + m[15]! * v[3],
      ]
      cam.updateMatrixWorld()
      const view = mul(cam.matrixWorldInverse.elements, [p.x, p.y, p.z, 1])
      const clip = mul(cam.projectionMatrix.elements, view)
      const ndc = { x: clip[0] / clip[3], y: clip[1] / clip[3] }
      const rect = el.getBoundingClientRect()
      return {
        clientX: rect.left + ((ndc.x + 1) / 2) * rect.width,
        clientY: rect.top + ((1 - ndc.y) / 2) * rect.height,
        world: p,
      }
    },
    { rid, pt },
  )
}

/**
 * 移出视口（生产 `pointerleave` 路径 → hover.clearViewport()），清理两次探测之间的悬停态。
 * `rid` 缺省为 Wiki 预览；工作台视口判据传 `r-viewport`。
 */
export async function clearWikiHover(page: Page, rid: string = WIKI_REGION): Promise<void> {
  await page.evaluate((rid) => {
    const el = (window as any).__vm__?.viewports?.get(rid)?.domElement?.value as HTMLElement | undefined
    el?.dispatchEvent(
      new PointerEvent('pointerleave', {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    )
  }, rid)
}

// ---------------------------------------------------------------------------
// 公开观测：悬停状态与 tooltip DOM
// ---------------------------------------------------------------------------

export interface WikiHoverObservation {
  blockId: string
  voxel: { column: number; row: number; zSlice: number } | null
  /** 部件命中信息（拾取链写入；null = 宿主格命中或无命中） */
  part: { localId: string; displayName: string; tooltip: string[] } | null
}

/**
 * 读 region 的公开悬停状态（`hoverHandler` 写入；未悬停方块 ⇒ null）。
 * `rid` 缺省为 Wiki 预览；工作台视口判据传 `r-viewport`。
 */
export async function readWikiHover(page: Page, rid: string = WIKI_REGION): Promise<WikiHoverObservation | null> {
  return await page.evaluate((rid) => {
    const hover = (window as any).__vm__?.region(rid)?.state.hover
    const vb = hover?.viewportBlock?.value ?? null
    if (!vb) return null
    return {
      blockId: vb.blockId,
      voxel: vb.voxel ?? null,
      part: vb.part ? { localId: vb.part.localId, displayName: vb.part.displayName, tooltip: [...vb.part.tooltip] } : null,
    }
  }, rid)
}

/** 读 tooltip DOM 文本（`.wm-tooltip-box`；未显示 ⇒ null）。 */
export async function readTooltipText(page: Page): Promise<string | null> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return null
    return (el.innerText ?? el.textContent ?? '').replace(/[ \t]+/g, ' ').trim()
  }, TOOLTIP_BOX)
}

/**
 * TooltipBox 文本的**格式无关压缩**（比对口径）。
 *
 * 为什么需要：TooltipBox 文本经 `renderTooltipHtml`（游戏风格式串 → HTML）渲染，
 * 串里的 `_..._` 会被当行内强调渲染成 `<em>` ⇒ 读回的文本**下划线消失**
 * （实测：行键兜底文案 `minecraft:stone_slab:0` 读回 `minecraft:stoneslab:0`）。
 * 因此"文案 = 某串"的判定只对字母数字与冒号比对，避免把渲染格式误判成内容差异。
 */
export function compactTooltipText(s: string): string {
  return s.replace(/[^A-Za-z0-9:]/g, '')
}

/** 悬停观测的**缩写形式**（判定过程证据 / 超时信息用；不含业务语义）。 */
export function describeHoverObservation(h: WikiHoverObservation | null): string {
  if (!h) return 'null'
  const cell = h.voxel ? `${h.voxel.column},${h.voxel.row},${h.voxel.zSlice}` : '?'
  const part = h.part ? `part:${h.part.localId}` : 'host'
  return `${part}@${h.blockId}#${cell}`
}

/**
 * **悬停目标** —— `probeHover` 的**必需**入参。
 *
 * ## 为什么必须显式给（根因）
 *
 * 旧实现把"落定"定义成 `h !== null`（有任何方块悬停就算到）。可生产悬停态是
 * **粘住的**：`hoverHandler` 的拾取按帧合并（`createHoverPickScheduler`），
 * 上一次结果一直留在 `region.state.hover.viewportBlock` 上，直到下一次拾取写入。
 * 于是"注入 pointermove → 立刻轮询"首先读到的往往仍是**上一次**的观测：
 *
 *  - 同格**邻接部件**（`ae2:NORTH` / `ae2:UP` …）—— 目标其实是另一个部件；
 *  - 同格**宿主命中**（`part === null`）—— 目标其实是一个部件；
 *  - 增广几何边界上真实的其它命中（如 `ae2:UNKNOWN`）。
 *
 * 三者都满足 `h !== null` ⇒ 旧实现当场返回，调用方的"目标"断言随后间歇变红
 * （`parts-falsification.spec.ts` 定向性那一步——线缆探测紧跟在同格切换总线之后——
 * 实测既有这次误判，原先靠 retry 才绿）。
 *
 * ⇒ 目标只能在**调用点**声明：`{ localId }`（命中某个部件）或
 * `{ hostOnly: true }`（满方块格的既有语义：宿主命中且无部件）。
 * "任何悬停都算落定"不再是合法目标，也没有缺省值可以退化回去。
 */
export interface HoverTargetPart {
  /** 期望命中的部件 `localId`（与生产 `viewportBlock.part.localId` **逐字相等**）。 */
  localId: string
  hostOnly?: false
  /** 期望的**宿主方块** id（可选；给了就一并要求，如满方块格的 `minecraft:stone`）。 */
  blockId?: string
}

/** 满方块格目标：宿主格命中且**没有**部件（等价旧谓词 `h.part === null`）。 */
export interface HoverTargetHost {
  hostOnly: true
  localId?: never
  blockId?: string
}

export type HoverTarget = HoverTargetPart | HoverTargetHost

/** 判定过程证据（`probeHover` 返回值之一）：这次探测到底看到了什么、拒绝了几次。 */
export interface ProbeHoverTrace {
  /** 从注入到命中之间的观测序列（**相邻重复已合并**；首项可能是 `null`）。 */
  observations: string[]
  /** 目标出现前被拒绝的观测数（= 轮询轮数 - 1）。 */
  rejected: number
}

export interface ProbeHoverResult {
  hover: WikiHoverObservation
  tooltip: string | null
  pointer: InjectedPointer
  trace: ProbeHoverTrace
}

/** 目标的可打印形式（超时信息用）。 */
export function describeHoverTarget(t: HoverTarget): string {
  const host = t.blockId === undefined ? '' : `（宿主 ${t.blockId}）`
  return t.localId === undefined ? `host 命中（无部件）${host}` : `part:${t.localId}${host}`
}

/**
 * 运行时护栏：目标必须显式给出且二选一。
 *
 * 类型层已经挡掉"漏参数"与"两者都给"，这里挡的是 JS 调用方与 `as any`
 * —— 缺目标时**当场抛错**，不允许退化成"任何悬停"。
 */
function assertHoverTarget(t: HoverTarget): void {
  if (!t || typeof t !== 'object') {
    throw new Error('probeHover：必须显式声明悬停目标（{ localId } 或 { hostOnly: true }）')
  }
  const localId = (t as HoverTargetPart).localId
  const hasLocal = typeof localId === 'string' && localId.length > 0
  const hostOnly = (t as HoverTargetHost).hostOnly === true
  if (hasLocal && hostOnly) {
    throw new Error(`probeHover：悬停目标 localId（${String(localId)}）与 hostOnly 互斥，二选一`)
  }
  if (!hasLocal && !hostOnly) {
    throw new Error(
      'probeHover：必须显式声明悬停目标（{ localId } 或 { hostOnly: true }）——'
        + '"任何非空悬停都算落定"已删除：它会把邻接部件 / 同格宿主命中当成目标',
    )
  }
}

/**
 * 一次观测是否**就是目标** —— 四个条件同时成立：
 *
 *  1. 仍有悬停（`h !== null`）；
 *  2. 部件身份符合目标（`localId` 逐字相等 / `hostOnly` 要求 `part === null`）；
 *  3. 给了 `blockId` 时宿主方块 id 也要相等；
 *  4. **命中的格 = 注入点所在的格**（`voxel = {column: pt.col, row: pt.row, zSlice: pt.z}`）。
 *
 * 第 4 条只用既有入参 `pt`（不新增 API），堵的是"上一次探测命中**另一格**、而部件
 * `localId` 恰好相同"—— `generic:0` 在多格复用（slab 与 fence 都是它），
 * 只比 localId 的话陈旧观测仍可能冒充成功。`row` 两处都是"文件行、顶部为 0"
 * （与 `injectHoverAtCellLocal` 的 `worldY = h - 1 - row` 同一口径）。
 */
function hoverMatchesTarget(
  h: WikiHoverObservation | null,
  pt: CellLocalPoint,
  t: HoverTarget,
): boolean {
  if (!h) return false
  const want = (t as HoverTargetPart).localId
  if (want !== undefined) {
    if (h.part?.localId !== want) return false
  } else if (h.part !== null) {
    return false
  }
  if (t.blockId !== undefined && h.blockId !== t.blockId) return false
  if (!h.voxel) return false
  return h.voxel.column === pt.col && h.voxel.row === pt.row && h.voxel.zSlice === pt.z
}

/**
 * 悬停探测一次：在格内局部点注入 pointermove，轮询到**目标**出现为止
 * （只认目标，不认"任何非空悬停"）。返回悬停状态 + tooltip 文本 + 注入坐标
 * + 判定过程证据（观测序列 / 拒绝计数）。
 *
 * 拾取是 rAF 合并的（`createHoverPickScheduler`），必须轮询而非定长等待；
 * 但轮询的**收敛判据是目标**，不是"有东西"。
 *
 * 超时（默认 10s，与修复前一致）时抛出的错误带上**实测观测序列**与拒绝计数，
 * 于是"一直读到邻接部件 / 宿主命中"这种形态在失败信息里直接看得见，不必靠 retry 撞。
 */
export async function probeHover(
  page: Page,
  pt: CellLocalPoint,
  target: HoverTarget,
  timeout = 10_000,
): Promise<ProbeHoverResult> {
  assertHoverTarget(target)
  const pointer = await injectHoverAtCellLocal(page, pt)
  const observations: string[] = []
  let rejected = 0
  const deadline = Date.now() + timeout
  for (;;) {
    const h = await readWikiHover(page)
    const seen = describeHoverObservation(h)
    if (observations[observations.length - 1] !== seen) observations.push(seen)
    if (hoverMatchesTarget(h, pt, target)) {
      // tooltip 渲染 + clamp 需要一拍。内容由 ToolTipBox 从**同一份**悬停态算出，
      // 因此目标落定后读到的文案即对应目标（不是上一次悬停的残留）。
      const tooltip = await pollUntil(
        async () => (await readTooltipText(page)) ?? null,
        `tooltip DOM 出现（目标 ${describeHoverTarget(target)}；${JSON.stringify(pt)}）`,
        timeout,
        40,
      )
      return { hover: h as WikiHoverObservation, tooltip, pointer, trace: { observations, rejected } }
    }
    rejected += 1
    if (Date.now() > deadline) {
      throw new Error(
        `probeHover：悬停目标未出现（${timeout}ms）—— 期望 ${describeHoverTarget(target)} `
          + `@格(col=${pt.col},row=${pt.row},z=${pt.z})；实测观测序列 = ${observations.join(' → ')}`
          + `（拒绝 ${rejected} 次）。\n`
          + '  只认"目标 + 同一格"为落定：邻接部件 / 同格其它部件 / 宿主命中（part=null）都不算命中。'
          + '旧口径"任何非空悬停"会在序列第一个非空项就返回（本次修的就是这个误判）。',
      )
    }
    await new Promise((r) => setTimeout(r, 40))
  }
}
