/**
 * 视口相机**初始机位施加纪律** —— "每个视口、每份文档，一次"。
 *
 * ## 为什么需要它（用户实测缺陷的根因落点）
 *
 * 缺陷：**在工作台里第一次编辑一格说明（或第一次移动方块），视口机位被复位回
 * "装载后自动框选"的机位**，用户花时间调好的视角被丢弃。
 *
 * 运行期实测（探针 `zz-camera-rootcause.spec.ts`，读数见交付报告）：
 *
 * | 时刻 | 事实 |
 * |---|---|
 * | 装载后 | `cameras['r-viewport'].value` = fit 机位；`@ready` 第 1 次 |
 * | 第一次编辑 | `contentRefreshTick` 自增 ⇒ DRW `applyContentRefresh` ⇒ `materialLibrary`（`drw.textureCache`）**瞬时变 null** |
 * | 紧接着 | 视口模板的 `v-if="… && materialLibrary"` 变假 ⇒ `RenderEngineHost` **卸载 → 重挂** |
 * | 重挂后 | `@ready` 第 2 次 ⇒ `attachViewport` ⇒ `OPERATOR_INIT_VIEWPORT_CAMERA` ⇒ **重新 fit** |
 * | 第二次编辑 | 同一路径**不再变空** ⇒ 不再复位 |
 *
 * 即：**"重新施加初始机位"被绑在了"宿主被重新挂载"这一事件上**，而宿主重挂的
 * 触发面是**内容投影**（编辑/移动都算）。内容变化只应更新画面，**不得**重新框选
 * 用户已调整的机位。
 *
 * ## 根因核验
 *
 * 上表第 2–3 行的"宿主重挂"是**独立于机位修复**的另一处缺陷（SPEC §7.3/§7.4）：
 * 普通内容编辑不得销毁健康视口宿主。本次沿"内容提交 → 投影 → 宿主渲染条件"逐环读码 +
 * 真实入口实测，确认的链是：
 *
 * ```
 * ① Tooltip 提交          → 内核内容事务提交（`workbench-rna` / operator 写面）
 * ② `contentRefreshTick`++ → `runtime/main.ts:229-231`（`requestContentRefresh`）
 * ③ DRW 观察者             → `runtime/drwMeshPipeline.ts:466-471`（`applyContentRefresh`）
 * ④ 首次内容身份 `republish` → `presentation/contentSignal.ts:85-107`；`prev === null`
 *                             （装载路径**从未**建立基线）⇒ `diffContentIdentity` 判
 *                             `documentChanged`（`presentation/contentIdentity.ts:83-90`）
 * ⑤ 重建计划               → `planContentRebuild` 首分支 ⇒ `reloadResources: true`
 *                             （`presentation/contentIdentity.ts:114-117`）
 * ⑥ 资源处置               → `drwMeshPipeline.ts:577-581`：`textureCache.value = null`
 * ⑦ 宿主挂载条件           → 两个宿主的 `v-if` 含 `materialLibrary`（= 该 ref）
 *                             ⇒ 条件瞬假 ⇒ `RenderEngineHost` 卸载 → 重挂 ⇒ 新 canvas
 * ```
 *
 * 实测（真实工作台 + 生产 `OPERATOR_OPEN_SCENE`，修复前）：编辑后 `canvasRemovals=1`、
 * `viewportRemovals=1`、`bothAbsentFrames=2`、`currentIsSame=false`（画布原标记丢失）——
 * 与缺陷单据记录的"2 帧、512 ms 空窗"同形。
 *
 * **修复**：宿主的挂载条件只表达"有已解析场景"，不参与任何
 * 资源瞬时态；`materialLibrary` 作为宿主输入一并退出（贴图绑定归呈现会话，材质库只服务
 * 方块图标缓存）。判据 = `web/e2e/kernel-viewport-host-lifetime.spec.ts`（canvas 元素同一、
 * 无缺席帧、占位未出现、机位不变）。
 *
 * ⚠️ 本模块的纪律仍**必须**保留，理由与宿主重挂无关：它约束的是"**谁**可以施加初始机位"
 * （没有相机状态 / 换了文档），而不是"宿主有没有重挂"。文档替换（`replaceDoc`）即便
 * 不再触发重挂，也**仍然必须重新框选**新文档 —— 判据靠窄信号 `documentRevision`，
 * 与挂载次数无关。
 *
 * ## 纪律（本模块的唯一出口）
 *
 * 施加初始机位（自动框选）**只允许**在两种情况下发生：
 *
 *  1. 该视口**还没有**逻辑相机状态（`cameras[key].value === null`）；
 *  2. 或者**换了一份文档** —— 由**窄信号** `documentRevision` 表达。
 *
 * ### ⚠️ 为什么用 `documentRevision` 而不是 `contentRefreshTick`
 *
 * 两者都不是"事件"，但**语义不同**（`runtime/main.ts` 的写入者表已钉住）：
 *
 * | 信号 | 自增点 | 语义 |
 * |---|---|---|
 * | `documentRevision`（**窄**） | **仅** `replaceDoc(next, 'document')` | "**换了一份文档**" |
 * | `contentRefreshTick`（宽） | `replaceDoc` **与** `requestContentRefresh` | "内容**可能**变了" |
 *
 * 逐格说明编辑、移动方块走的是**内核投影**（`setDocument(next,'content-sync')`）
 * ⇒ 只推宽信号。若用宽信号做本判据，**每一次投影都会重新框选** ——
 * 那正是 `runtime/main.ts:182-196` 明文记载的"修前形态"，已被修过一次；
 * 本模块**不得**把它走回去。
 *
 * 同一个纪律在嵌入视口侧是 `EmbedViewport.vue` 的 `didInitCamera` +
 * `watch(getDocumentRevision)`（`shared/viewport/EmbedViewport.vue:151-165`）。
 * 本模块是它在**装配边**（宿主挂载路径）的对应物：判据只此一处，
 * 两个宿主（工作台 / 嵌入）共用同一条纪律，不各自在组件回调里记状态。
 *
 * ## 纯函数 + 台账
 *
 * 判定本身是纯函数（显式输入、不改输入、无 IO）；"某个 region 上次施加时是哪份文档"
 * 是**状态**，由 {@link createViewportCameraInitLedger} 持有，挂在该 Context 的
 * 视口管理器上（`runtime/viewportManager.ts`）。
 *
 * ## ⚠️ 台账**不随呈现卸载清除**（工作区往返 / Area 拆分往返两条判据先红）
 *
 * 旧实现把"忘记记号"绑在 `ViewportManager.unregister/reset`（呈现组件卸载）上，
 * 于是**更换承载**（工作区切走再切回）被误当成"这个视口从没框选过"：
 *
 * ```
 * unregister → forget ⇒ 重挂 claim(hasCameraState=true, last=null)=true
 *            ⇒ OPERATOR_INIT_VIEWPORT_CAMERA ⇒ fit 覆盖用户机位
 * ```
 *
 * 这与 SPEC §7.3-b③ 正好相反：「界面承载确需重新建立时，逻辑状态应在首次呈现前
 * **正确恢复**；不得以先重置再补回掩盖不必要的重建」。机位状态本来就跨组件存活
 * （`Main.cameras`，见 `runtime/mainCameras.ts`），呈现重建不该让它看起来像"没有状态"。
 *
 * 故记号的生命周期 = **Context**（region 是视口在该 Context 里的身份），
 * 只有两种情形会让它重新框选：
 *   1. 该视口**没有任何**逻辑相机状态（首装、装载路径 `resetAllViewportCameras` 归零）；
 *   2. **换了一份文档**（窄信号 `documentRevision`；此时即便机位键还留有上一份文档的值，
 *      也必须给新文档重新取景 —— 判据是"记号里的文档身份 ≠ 当前文档身份"，
 *      而不是"组件有没有被卸载过"）。
 *
 * 后者正是本台账存在的理由：`hasCameraState` 单独一条在"承载卸载期间换了文档"
 * （槽位已注销、`resetAllViewportCameras` 遍历不到该键）时会复用上一份文档的机位。
 * 判据见 `e2e/kernel-workspace-camera-roundtrip.spec.ts` 与
 * `e2e/kernel-area-split-roundtrip.spec.ts`。
 */

import type { ViewportCameraState } from '@/runtime/viewportCamera'

/** 一次"是否施加初始机位"判定的全部输入。 */
export interface InitialCameraClaimInput {
  /** 当前文档身份（窄信号 `ctx.getDocumentRevision()`，**只**在换文档时变）。 */
  readonly documentRevision: number
  /** 本视口上次施加初始机位时的文档身份；`null` = 从未施加过。 */
  readonly lastAppliedDocumentRevision: number | null
  /** 该视口的逻辑相机**是否已有值**（`cameras[key].value !== null`）。 */
  readonly hasCameraState: boolean
}

/**
 * 该视口此刻**是否应当**施加初始机位（自动框选）。
 *
 * 两条充分条件（见模块头）：没有相机状态、或换了文档。其余一律**不动相机**。
 */
export function shouldApplyInitialViewportCamera(input: InitialCameraClaimInput): boolean {
  if (!input.hasCameraState) return true
  return input.lastAppliedDocumentRevision !== input.documentRevision
}

/**
 * 初始机位施加台账（**按 region 记**："这个视口上次是哪份文档时框选的"）。
 *
 * 为什么按键是 region 而不是 `cameraMainKey`：region 是视口的生命周期身份
 * （`ViewportManager` 的槽位键），而 `WIKI_PREVIEW → embed` 这类映射会让两个
 * 不同 region 共用一份相机状态 —— 但"谁还没框选过"必须按**视口**记。
 */
export interface ViewportCameraInitLedger {
  /**
   * 取一次"施加初始机位"的许可：返回 `true` 表示调用方**应当**施加，
   * 并就地记下本次文档身份；返回 `false` 表示本视口在当前文档下已施加过。
   */
  claim(regionId: string, documentRevision: number, hasCameraState: boolean): boolean
  /** 当前记下的文档身份（诊断/判据面；未记录为 `null`）。 */
  appliedRevisionOf(regionId: string): number | null
  /**
   * 登记"首次框选**待做**"（回归修复）。
   *
   * 何时发生：fit 的输入**还没有几何**（内容组为空）——`fitCameraToGroup` 返回
   * `{ok:false, reason:'group has no geometry bounds'}`。这不是"空文档"，而是
   * "内容还没落地"（首帧呈现 apply 尚未发生）。
   *
   * `provisional` 是登记时**已写进**相机状态的那一份（`null` = 当时没有逻辑机位）。
   * 补做的判据是"相机**仍等于** `provisional`" ⇒ 用户没动过它（见 {@link takePendingFit}）。
   */
  markFitPending(
    regionId: string,
    documentRevision: number,
    provisional: ViewportCameraState | null,
  ): void
  /**
   * 内容首次落地时取走"待做"（**只一次**）。
   *
   * 返回：
   *  - `'fit'`：**应当**立刻再施加一次初始机位（相机仍是 `provisional`，用户没动过）；
   *  - `'user'`：用户已先动过相机 ⇒ **放弃**补偿（不抢机位，纪律优先）；
   *  - `'stale'`：等待期间换了文档 ⇒ 放弃（新文档会走自己的 claim）；
   *  - `null`：本来没有待做项（幂等）。
   */
  takePendingFit(
    regionId: string,
    documentRevision: number,
    current: ViewportCameraState | null,
  ): 'fit' | 'user' | 'stale' | null
  /** 记录"初始机位由 fit 得到"（`cameraInitState === 'fitted'`）。 */
  markFitted(regionId: string): void
  /** 记录"始终没有几何 ⇒ 用了定义缺省兜底"（`cameraInitState === 'fallback'`）。 */
  markFallback(regionId: string): void
  /** 初始机位的施加结果（只读读面；`null` = 该视口还没走过初始机位判定）。 */
  initStateOf(regionId: string): CameraInitState | null
  /** 当前待做项（诊断面；`null` = 没有）。 */
  pendingOf(regionId: string): PendingInitialFit | null
  /** 丢弃某个 region 的全部记录（视口**销毁**时用；卸载/换工作区**不**清，见模块头）。 */
  forget(regionId: string): void
}

/**
 * **初始机位的施加结果**（`cameraInitState` 只读读面）。
 *
 * | 值 | 含义 |
 * |---|---|
 * | `pending` | fit 因**内容尚未落地**（内容组无几何）而推迟；等首个成功 apply 补做一次 |
 * | `fitted` | 初始机位是**框选结果**（正常情况） |
 * | `fallback` | 始终没有几何 ⇒ 用了定义缺省值（真的空文档才该出现） |
 * | `user` | 内容迟到前用户已动过相机 ⇒ **不补偿**（纪律：内容不得重置用户机位） |
 */
export type CameraInitState = 'pending' | 'fitted' | 'fallback' | 'user'

/** 一个"待做的首次框选"。 */
export interface PendingInitialFit {
  readonly documentRevision: number
  readonly provisional: ViewportCameraState | null
}

/** 两份逻辑机位是否**逐字段相同**（"用户动没动过"的判定口径）。 */
export function sameViewportCameraState(
  a: ViewportCameraState | null,
  b: ViewportCameraState | null,
): boolean {
  if (a === null || b === null) return a === b
  return (
    a.target.x === b.target.x &&
    a.target.y === b.target.y &&
    a.target.z === b.target.z &&
    a.yawDeg === b.yawDeg &&
    a.elevationDeg === b.elevationDeg &&
    a.distance === b.distance &&
    a.zoom === b.zoom
  )
}

export function createViewportCameraInitLedger(): ViewportCameraInitLedger {
  const applied = new Map<string, number>()
  const pending = new Map<string, PendingInitialFit>()
  const state = new Map<string, CameraInitState>()
  return {
    claim(regionId, documentRevision, hasCameraState) {
      const last = applied.get(regionId) ?? null
      if (!shouldApplyInitialViewportCamera({ documentRevision, lastAppliedDocumentRevision: last, hasCameraState })) {
        return false
      }
      applied.set(regionId, documentRevision)
      // 新的一次施加开始 ⇒ 上一轮的待做/结论不再有效（同一 region 换文档时尤其如此）。
      pending.delete(regionId)
      state.delete(regionId)
      return true
    },
    appliedRevisionOf(regionId) {
      return applied.get(regionId) ?? null
    },
    markFitPending(regionId, documentRevision, provisional) {
      pending.set(regionId, { documentRevision, provisional })
      state.set(regionId, 'pending')
    },
    takePendingFit(regionId, documentRevision, current) {
      const p = pending.get(regionId)
      if (p === undefined) return null
      pending.delete(regionId)
      if (p.documentRevision !== documentRevision) {
        state.delete(regionId)
        return 'stale'
      }
      if (!sameViewportCameraState(p.provisional, current)) {
        // 用户（或其它写者）已接管机位 ⇒ 不抢（SPEC §7.3-b③ 纪律）。
        state.set(regionId, 'user')
        return 'user'
      }
      return 'fit'
    },
    markFitted(regionId) {
      pending.delete(regionId)
      state.set(regionId, 'fitted')
    },
    markFallback(regionId) {
      pending.delete(regionId)
      state.set(regionId, 'fallback')
    },
    initStateOf(regionId) {
      return state.get(regionId) ?? null
    },
    pendingOf(regionId) {
      return pending.get(regionId) ?? null
    },
    forget(regionId) {
      applied.delete(regionId)
      pending.delete(regionId)
      state.delete(regionId)
    },
  }
}
