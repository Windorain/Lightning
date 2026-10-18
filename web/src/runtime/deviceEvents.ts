/**
 * 视口画布的**设备丢失/恢复**事件端口（M8-3：SPEC §7.5 恢复链的生产接线）。
 *
 * ## 它替代的旧形态（S0-A D1/D2/D11）
 *
 * M8-3 之前，画布上只有 `runtime/renderEngine` 的两个匿名监听：
 * `webglcontextlost ⇒ ev.preventDefault()`、`webglcontextrestored ⇒ onResize()`。
 * 它们表达的是"允许恢复"与"重算尺寸"，**不表达**设备语义：
 *  - 呈现会话（`PresenterSession`）不知道设备丢了 ⇒ 旧代次份额从不放弃、
 *    `pendingRebuild` 恒 false ⇒ 画面恢复完全依赖 three 的惰性重传（S0-A D1）；
 *  - 永久丢失没有状态、没有诊断、没有用户可见提示（S0-A D2）；
 *  - 监听是匿名闭包，拆解时无法注销（S0-A D11）。
 *
 * ## 本模块做什么（只做接线，不做判定）
 *
 * 1. 在**产品画布**上挂 `webglcontextlost` / `webglcontextrestored`，
 *    丢给呈现会话（放弃旧代次份额 / 恢复后强制重建）；
 * 2. 把设备相位落到**有界诊断记录器**（稳定码 + 视口/代次关联字段，S4）；
 * 3. 把丢失/恢复写成**用户可见**的成句状态（`liveStatus`，`origin: 'device'`）；
 * 4. 返回**注销函数**：视口拆解/重挂时移除监听（D11 的落点）。
 *
 * ## 为什么状态与判定都不在这里
 *
 * "现在能不能提交 GPU 工作"由 `presentation/deviceState#DeviceStateMachine` 回答，
 * "旧份额怎么放弃"由 `PresenterSession`/`BatchedPresenter` 回答。本模块只把浏览器
 * 事件**搬**到那两个权威上，并补上诊断/提示 —— 搬家层不得长出自己的判据。
 */
import type { DiagnosticRecorder } from '@/application/diagnostics'
import type { DeviceState } from '@/presentation/deviceState'
import { LOG_LEVEL } from '@/logging/LogCenter'

/** 只看两个方法：浏览器 `EventTarget` 与测试里的替身都满足（不绑定 DOM 实现）。 */
export interface DeviceEventCanvas {
  addEventListener(type: string, listener: (ev: Event) => void, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, listener: (ev: Event) => void, options?: boolean | AddEventListenerOptions): void
}

/** 实时状态写面（`ctx.log` 的结构子集；只允许 `device` 渠道 —— 不抢纹理/拒绝的槽）。 */
export interface DeviceLiveStatusPort {
  setLiveStatus(message: string, level?: number, state?: string | null, origin?: 'device'): void
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

/** 丢失期的成句提示（**永久丢失**时它一直显示 —— 用户知道画面为什么停、内容没丢）。 */
export const DEVICE_LOST_MESSAGE =
  '显示设备已丢失：画面已暂停，内容与编辑状态未受影响；设备恢复后会自动重建画面。'
/** 恢复事件的成句提示（随后纹理链会把它覆盖为"加载中/就绪"）。 */
export const DEVICE_RESTORED_MESSAGE =
  '显示设备已恢复：正在按当前内容重建画面，内容与编辑状态未受影响。'
/** `liveStatus.state` 的机器可读标签（读面不解析文本）。 */
export const DEVICE_LOST_STATE = 'device-lost'
export const DEVICE_RESTORED_STATE = 'device-restored'

export interface ViewportDeviceWiringOptions {
  readonly canvas: DeviceEventCanvas
  /** 视口 region id（诊断关联字段；双 Area 场景据此定位是谁丢了设备）。 */
  readonly viewportId: string
  readonly session: ViewportDeviceSession
  readonly diagnostics: DiagnosticRecorder
  readonly liveStatus?: DeviceLiveStatusPort
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
  const { canvas, viewportId, session, diagnostics, liveStatus, onLost, onRestored } = options
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
    liveStatus?.setLiveStatus(DEVICE_LOST_MESSAGE, LOG_LEVEL.WARN, DEVICE_LOST_STATE, 'device')
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
    liveStatus?.setLiveStatus(DEVICE_RESTORED_MESSAGE, LOG_LEVEL.INFO, DEVICE_RESTORED_STATE, 'device')
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
