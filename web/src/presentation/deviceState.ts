/**
 * WebGL **设备丢失/恢复**的呈现侧状态机（「WebGL 丢失/恢复」）。
 *
 * ## 三个动作必须区分
 *
 * | 动作 | 允许做的 | **禁止**做的 |
 * |---|---|---|
 * | 重建派生缓存 | 丢弃求值缓存/空间索引并重算 | 改文档、清编辑上下文 |
 * | 重建 GPU 设备资源 | 放弃旧句柄、用当前有效版本重建 | 复用旧句柄 |
 * | 恢复未保存的文档内容 | 显式内容恢复事务 | 作为**正常**恢复手段 |
 *
 * 本文件只做前两项，并**显式**保证：丢失期间"暂停受影响视口的 GPU 提交并标注状态，
 * 其他 Area 继续可用"（恢复副本隔离的要求）。恢复失败时允许诊断与重试，**保留内容与手动保存能力**
 * （恢复副本隔离）。
 *
 * ## 为什么"暂停"是显式状态而不是"停止渲染"
 *
 * 若只是不再 `render()`，上层无法区分"没东西可画"与"设备坏了" —— 于是导出可能拿一个
 * 空白帧当结果（同类失败）。`DeviceState` 因此是**可查询的判别式**，且带原因与
 * 重试次数。
 *
 * ## 设备代次是**独立身份维度**
 *
 * 「设备代次：句柄属于哪一次有效设备生命周期？」与「内容/结构世代」**不是同一个空间**，
 * 契约明言这些维度不能互相代替。本文件此前把 `heldGeneration` 写成
 * `CompileGeneration`（`g:xxxxxxxx`）—— 那是**用结构世代冒充设备代次**。
 *
 * 现在：
 *  - `DeviceGeneration` 是 **number**（从 1 起，每次**恢复成功**严格 +1）；
 *  - 结构世代仍归 `presentation/compileScene#CompileGeneration` 与
 *    `PresenterSession.generation`（内容没变 ⇒ 恢复后回到同一值，那是正确的恢复行为）；
 *  - 两者**不共享类型、不共享字段、不互相赋值**。
 *
 * `DeviceState.heldGeneration` 因此只回答一件事：**丢失瞬间画面所在的那个设备代次**
 * （用于诊断与"恢复后按当前有效版本重建"的对照），它不再承载任何内容语义。
 */

/**
 * 设备代次：句柄属于第几次**有效设备生命周期**。
 *
 * 纯数字、与 `CompileGeneration`（形如 `g:6a97e491` 的字符串）不同空间；
 * 归属键把它作为独立段（见 `presentation/ownership#OwnershipEntry`），
 * 于是"旧设备的份额"与"新设备的份额"在账上可区分（§7.5:262）。
 */
export type DeviceGeneration = number

/**
 * 设备（GL 上下文）状态。
 *
 * `lost` 携带 `heldGeneration`：丢失瞬间仍在显示的那一代（诊断与"恢复后按当前有效版本
 * 重建"的对照点）。`recovering` 与 `lost` 分开，因为"正在重试"与"放弃了"对用户的意义不同。
 */
export type DeviceState =
  | { phase: 'ready'; generation: DeviceGeneration | null }
  | { phase: 'lost'; reason: string; heldGeneration: DeviceGeneration | null; attempts: number }
  | { phase: 'recovering'; attempts: number; heldGeneration: DeviceGeneration | null }
  | { phase: 'failed'; reason: string; attempts: number; retryable: boolean }

/** 状态转移的审计行（诊断面）。 */
export interface DeviceTransition {
  readonly at: number
  readonly from: DeviceState['phase']
  readonly to: DeviceState['phase']
  readonly reason: string
  /** 转移**之后**的有效设备代次（代次推进可逐行审计）。 */
  readonly deviceGeneration: DeviceGeneration
}

/**
 * 设备状态机。
 *
 * `at` 由调用方传入（**不读全局时钟** —— 纯性要求）。状态机本身不碰 GL：
 * 真正的句柄处置由 `BatchedPresenter.handleContextLost/Restored` 完成，本类只记录
 * **权威状态**并给出允许的动作判断。
 *
 * ## 代次只在这里推进（唯一权威）
 *
 * `deviceGeneration` 从 1 起；`markRestored()`（= 浏览器确认新上下文建立）把它 +1。
 * `markPresented()` **不**推进代次，只记录"本代次已成功呈现"。于是：
 *  - "只 resize 不重建"不会更新 `heldGeneration()`（仍是 null）—— 负对照可判；
 *  - 内容编辑**不**推进设备代次（两条轴互不代替）。
 */
export class DeviceStateMachine {
  private state: DeviceState = { phase: 'ready', generation: null }
  private readonly history: DeviceTransition[] = []
  /** 当前有效设备代次（第几次设备生命周期）—— 本类唯一推进点见 `markRestored`。 */
  private deviceGen: DeviceGeneration = 1

  constructor(private readonly maxHistory = 64) {}

  get current(): DeviceState {
    return this.state
  }

  get transitions(): readonly DeviceTransition[] {
    return this.history
  }

  /** 当前有效设备代次（`number`；与结构世代不同空间）。 */
  get deviceGeneration(): DeviceGeneration {
    return this.deviceGen
  }

  /**
   * 是否允许向该视口提交 GPU 工作。
   *
   * 这是"暂停受影响视口的 GPU 提交"的机械落点：`ready` 之外的任何相位都返回 `false`，
   * 于是"只 resize 而不重建归属资源"（负对照）不可能被误当成恢复成功。
   */
  canSubmit(): boolean {
    return this.state.phase === 'ready'
  }

  /**
   * 本代次**已呈现**的设备代次（`null` = 本代次尚未成功呈现）。
   *
   * 丢失期返回**丢失瞬间**的那一代（诊断对照）；恢复后、重建前返回 `null`。
   */
  heldGeneration(): DeviceGeneration | null {
    if (this.state.phase === 'ready') return this.state.generation
    if (this.state.phase === 'recovering') return this.state.heldGeneration
    if (this.state.phase === 'lost') return this.state.heldGeneration
    return null
  }

  /**
   * 记录一次成功呈现（把 `ready` 的"已呈现代次"推进到**当前设备代次**）。
   *
   * 它**不再**接受结构世代：设备代次由本机持有，调用方无法用
   * `CompileGeneration` 冒充（那正是旧口子）。
   */
  markPresented(at: number): void {
    if (this.state.phase !== 'ready') return
    this.transition({ phase: 'ready', generation: this.deviceGen }, 'presented', at)
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
    const attempts = prev.attempts + 1
    const held = prev.phase === 'lost' ? prev.heldGeneration : null
    this.transition({ phase: 'recovering', attempts, heldGeneration: held }, 'restore-attempt', at)
    return true
  }

  /**
   * 恢复成功（浏览器确认新上下文已建立）：**推进设备代次**。
   *
   * 推进的是"设备生命周期"这一维：旧代次句柄作废，此后创建的 GPU 资源属于新代次
   * （归属键按代次分段，见 `presentation/ownership`）。
   *
   * 它**不**声称"画面已重建"：`generation` 置 `null`，直到调用方用**当前有效版本**
   * 重新 `apply()` 并调用 `markPresented()`。只 resize 而不重建 ⇒ `heldGeneration()`
   * 仍为 `null`（负对照的判红读数）。
   */
  markRestored(at: number): void {
    if (this.state.phase !== 'lost' && this.state.phase !== 'recovering' && this.state.phase !== 'failed') return
    this.deviceGen += 1
    this.transition({ phase: 'ready', generation: null }, 'restored', at)
  }

  /** 恢复失败（保留诊断与重试能力；不放弃内容 —— 恢复副本隔离的要求）。 */
  markRestoreFailed(reason: string, retryable: boolean, at: number): void {
    const prev = this.state
    const attempts = prev.phase === 'recovering' || prev.phase === 'lost' || prev.phase === 'failed'
      ? prev.attempts
      : 0
    this.transition({ phase: 'failed', reason, attempts, retryable }, reason, at)
  }

  private transition(next: DeviceState, reason: string, at: number): void {
    this.history.push({ at, from: this.state.phase, to: next.phase, reason, deviceGeneration: this.deviceGen })
    if (this.history.length > this.maxHistory) this.history.shift()
    this.state = next
  }
}

/**
 * 多视口的失败隔离（「暂停受影响视口的 GPU 提交并标注状态，**其他 Area 继续可用**」）。
 *
 * 按视口 id 持有独立状态机 —— 一个视口丢失不改变另一个的状态，这是"其他 Area 继续可用"
 * 的可断言形式。
 *
 * ## 它是**生产**的设备相位索引
 *
 * 每个 `PresenterSession` 由装配边（`runtime/host#HostBase#createViewportPresenter`）
 * 从这里取一台机器并持有它（状态权威在机器上，本类只是按视口 id 的索引）。
 * 视口卸载时 `remove` —— 不让已拆解的视口继续出现在"可提交视口"读面里。
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

  /** 注销一个视口（视口拆解：它不再参与"其他 Area 继续可用"的读面）。 */
  remove(viewportId: string): void {
    this.byViewport.delete(viewportId)
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

  /** 全局状态摘要（断言面）。 */
  summary(): Readonly<Record<DeviceState['phase'], number>> {
    const out = { ready: 0, lost: 0, recovering: 0, failed: 0 }
    for (const m of this.byViewport.values()) out[m.current.phase] += 1
    return out
  }
}
