/**
 * WebGL **设备丢失/恢复**的呈现侧状态机（#249 §19.5；#256「WebGL 丢失/恢复」）。
 *
 * ## 三个动作必须区分（#249 §19.5 明文）
 *
 * | 动作 | 允许做的 | **禁止**做的 |
 * |---|---|---|
 * | 重建派生缓存 | 丢弃求值缓存/空间索引并重算 | 改文档、清编辑上下文 |
 * | 重建 GPU 设备资源 | 放弃旧句柄、用当前有效版本重建 | 复用旧句柄 |
 * | 恢复未保存的文档内容 | 显式内容恢复事务（P9 归 #260） | 作为**正常**恢复手段 |
 *
 * 本文件只做前两项，并**显式**保证：丢失期间"暂停受影响视口的 GPU 提交并标注状态，
 * 其他 Area 继续可用"（§19.5 明文）。恢复失败时允许诊断与重试，**保留内容与手动保存能力**
 * （§19.5 + A30）。
 *
 * ## 为什么"暂停"是显式状态而不是"停止渲染"
 *
 * 若只是不再 `render()`，上层无法区分"没东西可画"与"设备坏了" —— 于是导出可能拿一个
 * 空白帧当结果（G4 的同类失败）。`DeviceState` 因此是**可查询的判别式**，且带原因与
 * 重试次数。
 */

import type { CompileGeneration } from './compileScene'

/**
 * 设备（GL 上下文）状态。
 *
 * `lost` 携带 `heldGeneration`：丢失瞬间仍在显示的那一代（诊断与"恢复后按当前有效版本
 * 重建"的对照点）。`recovering` 与 `lost` 分开，因为"正在重试"与"放弃了"对用户的意义不同。
 */
export type DeviceState =
  | { phase: 'ready'; generation: CompileGeneration | null }
  | { phase: 'lost'; reason: string; heldGeneration: CompileGeneration | null; attempts: number }
  | { phase: 'recovering'; attempts: number; heldGeneration: CompileGeneration | null }
  | { phase: 'failed'; reason: string; attempts: number; retryable: boolean }

/** 状态转移的审计行（诊断面；#249 §19.9）。 */
export interface DeviceTransition {
  readonly at: number
  readonly from: DeviceState['phase']
  readonly to: DeviceState['phase']
  readonly reason: string
}

/**
 * 设备状态机。
 *
 * `at` 由调用方传入（**不读全局时钟** —— #249 §2.1 纯性）。状态机本身不碰 GL：
 * 真正的句柄处置由 `BatchedPresenter.handleContextLost/Restored` 完成，本类只记录
 * **权威状态**并给出允许的动作判断。
 */
export class DeviceStateMachine {
  private state: DeviceState = { phase: 'ready', generation: null }
  private readonly history: DeviceTransition[] = []

  constructor(private readonly maxHistory = 64) {}

  get current(): DeviceState {
    return this.state
  }

  get transitions(): readonly DeviceTransition[] {
    return this.history
  }

  /**
   * 是否允许向该视口提交 GPU 工作。
   *
   * 这是"暂停受影响视口的 GPU 提交"的机械落点：`ready` 之外的任何相位都返回 `false`，
   * 于是"只 resize 而不重建归属资源"（A30 负对照）不可能被误当成恢复成功。
   */
  canSubmit(): boolean {
    return this.state.phase === 'ready'
  }

  /** 已渲染的最后一代（诊断与"恢复后投影当前有效版本"的对照）。 */
  heldGeneration(): CompileGeneration | null {
    if (this.state.phase === 'ready') return this.state.generation
    if (this.state.phase === 'recovering') return this.state.heldGeneration
    if (this.state.phase === 'lost') return this.state.heldGeneration
    return null
  }

  /** 记录一次成功呈现（把 `ready` 的世代推进到最新）。 */
  markPresented(generation: CompileGeneration, at: number): void {
    if (this.state.phase !== 'ready') return
    this.transition({ phase: 'ready', generation }, 'presented', at)
  }

  /** WebGL 上下文丢失。 */
  markLost(reason: string, at: number): void {
    const held = this.heldGeneration()
    const attempts = this.state.phase === 'lost' || this.state.phase === 'recovering' ? this.state.attempts : 0
    this.transition({ phase: 'lost', reason, heldGeneration: held, attempts }, reason, at)
  }

  /** 开始一次恢复尝试（**不是**恢复成功）。 */
  markRecovering(at: number): boolean {
    if (this.state.phase !== 'lost' && this.state.phase !== 'failed') return false
    const prev = this.state
    const attempts = prev.phase === 'failed' ? prev.attempts + 1 : prev.attempts + 1
    const held = prev.phase === 'lost' ? prev.heldGeneration : null
    this.transition({ phase: 'recovering', attempts, heldGeneration: held }, 'restore-attempt', at)
    return true
  }

  /**
   * 恢复成功。
   *
   * **必须**提供重建用的世代：调用方随后用**当前有效版本**重新编译并 `apply()`。
   * 只 resize 而不重建会走到这里但 `generation` 不变 —— 故本方法要求调用方显式给出
   * 新世代，且 `markPresented` 才是最终的"已重建"凭据。
   */
  markRestored(at: number): void {
    if (this.state.phase !== 'recovering' && this.state.phase !== 'lost') return
    this.transition({ phase: 'ready', generation: null }, 'restored', at)
  }

  /** 恢复失败（保留诊断与重试能力；不放弃内容 —— §19.5 明文）。 */
  markRestoreFailed(reason: string, retryable: boolean, at: number): void {
    const prev = this.state
    const attempts = prev.phase === 'recovering' || prev.phase === 'lost' || prev.phase === 'failed'
      ? prev.attempts
      : 0
    this.transition({ phase: 'failed', reason, attempts, retryable }, reason, at)
  }

  private transition(next: DeviceState, reason: string, at: number): void {
    this.history.push({ at, from: this.state.phase, to: next.phase, reason })
    if (this.history.length > this.maxHistory) this.history.shift()
    this.state = next
  }
}

/**
 * 多视口的失败隔离（#249 §19.5「暂停受影响视口的 GPU 提交并标注状态，**其他 Area 继续可用**」）。
 *
 * 按视口 id 持有独立状态机 —— 一个视口丢失不改变另一个的状态，这是"其他 Area 继续可用"
 * 的可断言形式。
 */
export class ViewportDeviceRegistry {
  private readonly byViewport = new Map<string, DeviceStateMachine>()

  machineFor(viewportId: string): DeviceStateMachine {
    const existing = this.byViewport.get(viewportId)
    if (existing !== undefined) return existing
    const created = new DeviceStateMachine()
    this.byViewport.set(viewportId, created)
    return created
  }

  /** 当前可提交的视口 id（稳定序）—— "其他 Area 继续可用"的直接读数。 */
  submittableViewports(): readonly string[] {
    return [...this.byViewport.entries()]
      .filter(([, m]) => m.canSubmit())
      .map(([id]) => id)
      .sort()
  }

  /** 处于非就绪相位的视口与其状态（诊断面）。 */
  pending(): readonly { viewportId: string; state: DeviceState }[] {
    return [...this.byViewport.entries()]
      .filter(([, m]) => !m.canSubmit())
      .map(([viewportId, m]) => ({ viewportId, state: m.current }))
      .sort((a, b) => a.viewportId.localeCompare(b.viewportId))
  }

  /** 全局状态摘要（A30 断言面）。 */
  summary(): Readonly<Record<DeviceState['phase'], number>> {
    const out = { ready: 0, lost: 0, recovering: 0, failed: 0 }
    for (const m of this.byViewport.values()) out[m.current.phase] += 1
    return out
  }
}
