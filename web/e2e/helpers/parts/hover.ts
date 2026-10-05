/**
 * P2.5 部件断言包 —— 悬停管线 helper（零替身五原则的部件轮落点）。
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
 *     相机**（公开观测 `ctx.viewports.get('r-wiki-preview').camera`，正交）投影到
 *     client 坐标，再在视口 DOM 元素上派发 `pointermove` —— 与 `viewportBinder`
 *     的生产监听（capture 阶段 `pointermove` → `ed.dispatch`）同一路径。
 *     投影与派发在**同一次 evaluate** 内完成，相机在两者之间不可能移动。
 *  3. **公开观测**：`window.__vm__` → `ctx.viewports.get('r-wiki-preview')` 的
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
  await expect(page.locator(`${WIKI_EMBED} .vc-viewport canvas`)).toBeVisible({ timeout })
  await page.waitForFunction(
    (rid) => {
      const ctx = (window as any).__vm__
      const slot = ctx?.viewports?.get(rid)
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
    if (Date.now() > deadline) throw new Error('P2.5：Wiki 预览相机在 20s 内未稳定')
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
export async function injectHoverAtCellLocal(page: Page, pt: CellLocalPoint): Promise<InjectedPointer> {
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
    { rid: WIKI_REGION, pt },
  )
}

/** 移出视口（生产 `pointerleave` 路径 → hover.clearViewport()），清理两次探测之间的悬停态。 */
export async function clearWikiHover(page: Page): Promise<void> {
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
  }, WIKI_REGION)
}

// ---------------------------------------------------------------------------
// 公开观测：悬停状态与 tooltip DOM
// ---------------------------------------------------------------------------

export interface WikiHoverObservation {
  blockId: string
  voxel: { column: number; row: number; zSlice: number } | null
  /** 部件命中信息（P2.2 拾取链写入；null = 宿主格命中或无命中） */
  part: { localId: string; displayName: string; tooltip: string[] } | null
}

/** 读 Wiki 预览 region 的公开悬停状态（`hoverHandler` 写入；未悬停方块 ⇒ null）。 */
export async function readWikiHover(page: Page): Promise<WikiHoverObservation | null> {
  return await page.evaluate((rid) => {
    const hover = (window as any).__vm__?.region(rid)?.state.hover
    const vb = hover?.viewportBlock?.value ?? null
    if (!vb) return null
    return {
      blockId: vb.blockId,
      voxel: vb.voxel ?? null,
      part: vb.part ? { localId: vb.part.localId, displayName: vb.part.displayName, tooltip: [...vb.part.tooltip] } : null,
    }
  }, WIKI_REGION)
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

/**
 * 悬停探测一次：在格内局部点注入 pointermove，轮询直到公开悬停状态满足
 * `expectHover`（默认：有任何方块悬停），返回悬停状态 + tooltip 文本 + 注入坐标。
 * 拾取是 rAF 合并的（`createHoverPickScheduler`），必须轮询而非定长等待。
 */
export async function probeHover(
  page: Page,
  pt: CellLocalPoint,
  expectHover: (h: WikiHoverObservation | null) => boolean = (h) => h !== null,
  timeout = 10_000,
): Promise<{ hover: WikiHoverObservation; tooltip: string | null; pointer: InjectedPointer }> {
  const pointer = await injectHoverAtCellLocal(page, pt)
  const hover = await pollUntil(
    async () => {
      const h = await readWikiHover(page)
      return expectHover(h) ? h : null
    },
    `悬停状态落定（${JSON.stringify(pt)}）`,
    timeout,
    40,
  )
  // tooltip 渲染 + clamp 需要一拍
  const tooltip = await pollUntil(
    async () => (await readTooltipText(page)) ?? null,
    `tooltip DOM 出现（${JSON.stringify(pt)}）`,
    timeout,
    40,
  )
  return { hover: hover as WikiHoverObservation, tooltip, pointer }
}
