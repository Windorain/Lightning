/**
 * 视口画布的**设备丢失/恢复**事件端口（SPEC §7.5 恢复链的生产接线）。
 *
 * ## 它替代的旧形态（设备语义缺席）
 *
 * 在此之前，画布上只有 `runtime/renderEngine` 的两个匿名监听：
 * `webglcontextlost ⇒ ev.preventDefault()`、`webglcontextrestored ⇒ onResize()`。
 * 它们表达的是"允许恢复"与"重算尺寸"，**不表达**设备语义：
 *  - 呈现会话（`PresenterSession`）不知道设备丢了 ⇒ 旧代次份额从不放弃、
 *    `pendingRebuild` 恒 false ⇒ 画面恢复完全依赖 three 的惰性重传；
 *  - 永久丢失没有状态、没有诊断、没有用户可见提示；
 *  - 监听是匿名闭包，拆解时无法注销。
 *
 * ## 本模块做什么（只做接线，不做判定）
 *
 * 1. 在**产品画布**上挂 `webglcontextlost` / `webglcontextrestored`，
 *    丢给呈现会话（放弃旧代次份额 / 恢复后强制重建）；
 * 2. 把设备相位落到**有界诊断记录器**（稳定码 + 视口/代次关联字段）；
 * 3. 把丢失/恢复写成**用户可见**的成句状态（`liveStatus`，`origin: 'device'`）；
 * 4. 返回**注销函数**：视口拆解/重挂时移除监听。
 *
 * ## 为什么状态与判定都不在这里
 *
 * "现在能不能提交 GPU 工作"由 `presentation/deviceState#DeviceStateMachine` 回答，
 * "旧份额怎么放弃"由 `PresenterSession`/`BatchedPresenter` 回答。本模块只把浏览器
 * 事件**搬**到那两个权威上，并补上诊断/提示 —— 搬家层不得长出自己的判据。
 */
import type { DiagnosticRecorder } from '@/application/diagnostics'
import type { DeviceState } from '@/presentation/deviceState'

/** 只看两个方法：浏览器 `EventTarget` 与测试里的替身都满足（不绑定 DOM 实现）。 */
export interface DeviceEventCanvas {
  addEventListener(type: string, listener: (ev: Event) => void, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, listener: (ev: Event) => void, options?: boolean | AddEventListenerOptions): void
}

/**
 * 被接线的呈现会话（结构子集）。
 *
 * 用结构类型而不是 import `PresenterSession`：本模块只要求这五个成员，
 * 于是单测可以用真实会话（它满足）而不需要真的 GL。
 */
export interface ViewportDeviceSession {
  handleContextLost(): number
  handleContextRestored(): void
  readonly deviceGeneration: number
  readonly devicePhase: DeviceState['phase']
  readonly pendingRebuild: boolean
}

// 用户可见文案与 `liveStatus.state` 标签**不在本模块**（诊断通道收口）：
// 它们由 `runtime/diagnosticProjection` 从 `device.*` 记录投影出来 —— 同一句话只有一个来源，
// 这里是**转译**（浏览器事件 → 会话/诊断），不是呈现。

export interface ViewportDeviceWiringOptions {
  readonly canvas: DeviceEventCanvas
  /** 视口 region id（诊断关联字段；双 Area 场景据此定位是谁丢了设备）。 */
  readonly viewportId: string
  readonly session: ViewportDeviceSession
  readonly diagnostics: DiagnosticRecorder
  /** 丢失时的附加处置（视口层放弃纹理等），返回被放弃的纹理数（诊断用）。 */
  readonly onLost?: (abandonedShares: number) => number
  /** 恢复时的附加处置（视口层重置纹理同步去重键等）。 */
  readonly onRestored?: () => void
}

/**
 * 把产品画布的设备事件接到呈现会话/诊断/底栏，返回**注销函数**。
 *
 * 注销函数是幂等的：重复调用不会重复摘除，也不会让已摘除的监听复活。
 */
export function attachViewportDeviceEvents(options: ViewportDeviceWiringOptions): () => void {
  const { canvas, viewportId, session, diagnostics, onLost, onRestored } = options
  let attached = true
  let lostEvents = 0

  const onContextLost = (ev: Event): void => {
    if (!attached) return
    // 恢复的必要条件（浏览器规范）：没有 preventDefault 就永远等不到 restored。
    // renderEngine 也做了一次（幂等）—— 恢复链自己不依赖"别人记得调"。
    ev.preventDefault()
    const generationBefore = session.deviceGeneration
    lostEvents += 1
    const abandoned = session.handleContextLost()
    const texturesAbandoned = onLost?.(abandoned) ?? 0
    // 用户可见提示由 C1 的 `device.lost` 记录**投影**出来（见 `runtime/diagnosticProjection`），
    // 本模块不再自己写 liveStatus —— 那是同一事实的第二个写点（收口）。
    diagnostics.record({
      channel: 'device',
      code: 'device.lost',
      params: {
        reason: 'webglcontextlost',
        abandoned,
        texturesAbandoned,
        lostEvents,
        pendingRebuild: session.pendingRebuild,
      },
      correlation: { viewportId, deviceGeneration: generationBefore },
    })
  }

  const onContextRestored = (): void => {
    if (!attached) return
    const wasPending = session.devicePhase !== 'ready'
    session.handleContextRestored()
    onRestored?.()
    if (!wasPending) return
    const generation = session.deviceGeneration
    // 同上：提示来自 `device.restored` 的投影。
    diagnostics.record({
      channel: 'device',
      code: 'device.restored',
      params: {
        reason: 'webglcontextrestored',
        rebuild: 'presenter-session',
        pendingRebuild: session.pendingRebuild,
      },
      correlation: { viewportId, deviceGeneration: generation },
    })
  }

  canvas.addEventListener('webglcontextlost', onContextLost, false)
  canvas.addEventListener('webglcontextrestored', onContextRestored, false)
  return () => {
    if (!attached) return
    attached = false
    canvas.removeEventListener('webglcontextlost', onContextLost, false)
    canvas.removeEventListener('webglcontextrestored', onContextRestored, false)
  }
}