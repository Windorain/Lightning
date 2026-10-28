/**
 * `adapters/inputFacts` —— **浏览器输入适配器**：只提取事实 + 执行平台同步动作
 * （适配器实现端口）。
 *
 * ## 这一层的边界
 *
 * 「浏览器适配器只进行**事实提取**与**平台同步动作**，例如默认行为控制、指针捕获和
 * 用户激活下的受限 API。平台动作根据纯路由策略提供的结果或预先派生策略执行；
 * 不以"薄适配器"为由丢掉必要同步契约，也**不在适配器查询对象并自行作领域决定**。」
 *
 * 三条由此确定的纪律：
 *  1. **只读事实**：`readKeyFact` / `readPointerFact` 把 DOM 事件翻成 `domain/input` 的值类型。
 *     它们可以读 `document.activeElement`（那是**事实来源**），但读到的结果只作为
 *     `targetEditable` 交给纯路由 —— **路由不查 DOM**。
 *  2. **只做同步动作**：`applyPlatformActions` 负责 `preventDefault` /
 *     `stopPropagation` / `setPointerCapture` / `releasePointerCapture`。
 *     它**不**决定"该不该捕获"（那是路由的输出 `captureAction`），也**不**查询
 *     场景对象（那是领域决定）。
 *  3. **API 可用性显式化**：`setPointerCapture` 在元素已脱离文档时会抛
 *     `InvalidStateError`；`requestFullscreen` 一类需要用户激活。
 *     缺失能力必须**可见**（返回结构化失败），不能 `catch {}` 后当成功。
 *
 * ## 为什么本模块**不**在 `domain`
 *
 * 它 import 了 DOM 类型（`KeyboardEvent`/`PointerEvent`/`HTMLElement`），
 * 且会调用浏览器 API。按分层导入规则 1/2，纯核心层不得有这些依赖
 * —— 由 `npm run test:arch` 的 `gate/core-no-dom-globals` 与
 * `gate/core-no-vue-three` 执行。放在 `adapters/` 正是"实现端口"的位置。
 *
 * ## 触屏 / 手写笔（「输入事件契约不只容纳鼠标字段」）
 *
 * `readPointerFact` 提取 `pressure` / `tiltX` / `tiltY` / `twist` / `width` / `height`
 * 与 `pointerType`；`readTrail` 用 `getCoalescedEvents()` 取**未丢失**的中间点。
 * 输入适配规则：「笔划等轨迹输入**不得默认丢点**」—— 故这里默认把合并点全取回。
 */

import {
  type KeyFact,
  type PointerFact,
  type PointerKind,
  type TrailPoint,
} from '@/domain/input'

// ─────────────────────────────────────────────────────────────────────────────
// 事实提取
// ─────────────────────────────────────────────────────────────────────────────

/** 可编辑元素判定（**事实**；不参与路由政策）。 */
export function isEditableElement(el: unknown): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLInputElement) return true
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLSelectElement) return true
  return el.isContentEditable
}

/**
 * 读一个键盘事件的**事实**。
 *
 * `token` 由接线层分配（单调），它是去重、单一挂载点判定与重放记录的键。
 * 注意本函数**不**判断"该不该处理"，也不 `preventDefault` —— 全是事实。
 */
export function readKeyFact(
  event: KeyboardEvent,
  token: number,
  opts: { readonly hitModalScopeId?: string | null } = {},
): KeyFact {
  return Object.freeze({
    token,
    kind: event.type === 'keyup' ? 'keyup' : 'keydown',
    // 单字符键统一小写：`KeyboardEvent.key` 在按下 Shift 时给大写，
    // 而快捷键表按"物理键"声明（`ctrl+shift+z` 而非 `ctrl+Z`）。
    key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    repeat: event.repeat,
    // `isComposing` 是标准字段；旧引擎缺省时退化为 `keyCode === 229`（IME 处理中）。
    composing: event.isComposing === true || (event as unknown as { keyCode?: number }).keyCode === 229,
    targetEditable: isEditableElement(event.target),
    hitModalScopeId: opts.hitModalScopeId ?? null,
    defaultPrevented: event.defaultPrevented,
  })
}

/** 指针事件类型 → 路由的类型。 */
export function pointerKindOf(event: PointerEvent | WheelEvent): PointerKind | null {
  switch (event.type) {
    case 'pointerdown':
      return 'down'
    case 'pointermove':
      return 'move'
    case 'pointerup':
      return 'up'
    case 'pointercancel':
      return 'cancel'
    case 'lostpointercapture':
      return 'capture-lost'
    case 'pointerenter':
      return 'enter'
    case 'pointerleave':
      return 'leave'
    case 'wheel':
      return 'wheel'
    default:
      return null
  }
}

function pointerTypeOf(event: PointerEvent): 'mouse' | 'pen' | 'touch' {
  const t = event.pointerType
  return t === 'pen' || t === 'touch' ? t : 'mouse'
}

/**
 * 轨迹点（**不丢点**）。
 *
 * `getCoalescedEvents()` 返回被浏览器合并掉的中间点。默认**全部取回** ——
 * 输入适配规则明文「笔划等轨迹输入不得默认丢点」。
 * 该 API 不存在（部分引擎）时如实退化为单点，**不**伪造中间点。
 */
export function readTrail(event: PointerEvent): readonly TrailPoint[] {
  const out: TrailPoint[] = []
  const withCoalesced = event as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }
  if (typeof withCoalesced.getCoalescedEvents === 'function') {
    try {
      for (const e of withCoalesced.getCoalescedEvents()) {
        out.push({ x: e.clientX, y: e.clientY, timeStamp: e.timeStamp, fromCoalesced: true })
      }
    } catch {
      // 该 API 在某些引擎下仅对 trusted 事件可用；抛错时退化为单点（如实，不伪造）。
      out.length = 0
    }
  }
  out.push({ x: event.clientX, y: event.clientY, timeStamp: event.timeStamp, fromCoalesced: false })
  return Object.freeze(out)
}

/**
 * 读一个指针事件的**事实**。
 *
 * `hitRegionId` 是"该坐标命中的 Area"——由调用方经 `hitTest` **注入**，
 * 因为"哪些 rect 属于哪个 Area"是接线层的知识（Area 布局归装配层），
 * 不是本适配器能自行决定的领域事实。
 */
export function readPointerFact(
  event: PointerEvent | WheelEvent,
  token: number,
  opts: {
    readonly hitRegionId: string | null
    readonly captured: boolean
    /**
     * 事件目标落在哪个**已登记模态根**内（`null` = 背景/无模态）。
     *
     * 由接线层注入：只有它知道"当前模态的根元素是谁"（组件在 `openModalScope` 时
     * 提交根元素；见 `runtime/inputPort`）。适配器不猜"哪个 DOM 算模态"。
     */
    readonly hitModalScopeId?: string | null
  },
): PointerFact | null {
  const kind = pointerKindOf(event)
  if (kind === null) return null
  const isWheel = event.type === 'wheel'
  const pe = event as PointerEvent
  const fact: PointerFact = {
    token,
    kind,
    pointerId: isWheel ? -1 : pe.pointerId,
    pointerType: isWheel ? 'mouse' : pointerTypeOf(pe),
    button: isWheel ? -1 : (typeof pe.button === 'number' ? pe.button : -1),
    buttons: isWheel ? 0 : (typeof pe.buttons === 'number' ? pe.buttons : 0),
    clientX: event.clientX,
    clientY: event.clientY,
    isPrimary: isWheel ? true : pe.isPrimary !== false,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    hitRegionId: opts.hitRegionId,
    hitModalScopeId: opts.hitModalScopeId ?? null,
    captured: opts.captured,
    trail: isWheel ? Object.freeze([]) : readTrail(pe),
    ...(isWheel || pe.pressure === undefined ? {} : { pressure: pe.pressure }),
    ...(isWheel || pe.tiltX === undefined ? {} : { tiltX: pe.tiltX }),
    ...(isWheel || pe.tiltY === undefined ? {} : { tiltY: pe.tiltY }),
    ...(isWheel || pe.twist === undefined ? {} : { twist: pe.twist }),
    ...(isWheel || pe.width === undefined ? {} : { width: pe.width }),
    ...(isWheel || pe.height === undefined ? {} : { height: pe.height }),
  }
  return Object.freeze(fact)
}

// ─────────────────────────────────────────────────────────────────────────────
// 平台同步动作
// ─────────────────────────────────────────────────────────────────────────────

/** 平台动作的执行结果（失败**可见**；不 catch 后当成功）。 */
export interface PlatformActionResult {
  readonly attempted: readonly string[]
  readonly failures: readonly { readonly action: string; readonly error: string }[]
}

/**
 * 平台同步动作的**规格**（纯值，由路由产出）。
 *
 * 为什么这层用结构类型而不是 `RoutingDecision` 联合：
 * 键盘判定与指针判定的形状不同（指针多一个 `captureAction`），但它们落到平台上的
 * 动作只有这三个字段。用结构类型使适配器**只依赖它真正用到的东西** ——
 * 于是 `runtime/inputSession` 的 `PlatformActionRequest` 与
 * `domain/input` 的 `RoutingDecision` 都能直接传入，无需 cast。
 */
export interface PlatformActionSpec {
  readonly preventDefault: boolean
  readonly stopPropagation?: boolean
  readonly captureAction?: 'none' | 'capture' | 'release'
}

/**
 * 按**纯路由的输出**执行平台同步动作。
 *
 * 为什么分成两个参数：`spec` 是路由的结论（该不该阻止默认行为、该不该捕获），
 * `event` 是平台对象。适配器只负责"把结论落到平台上"，
 * **不重新推导**结论 —— 这就是"平台动作根据纯路由策略提供的结果执行"（输入适配规则）。
 *
 * `captureTarget` 是捕获宿主（通常是视口的 DOM 元素）。`captureAction`：
 *  - `'capture'` ⇒ `setPointerCapture(pointerId)`；
 *  - `'release'` ⇒ `releasePointerCapture(pointerId)`（已释放时会抛 `NotFoundError`，
 *    视为**已满足**的前置条件而不是失败 —— 但只在错误名确为 `NotFoundError` 时）。
 */
export function applyPlatformActions(
  event: Event,
  spec: PlatformActionSpec,
  pointerId: number,
  captureTarget: Element | null,
): PlatformActionResult {
  const attempted: string[] = []
  const failures: { action: string; error: string }[] = []

  if (spec.preventDefault) {
    attempted.push('preventDefault')
    try {
      if (!event.cancelable) {
        failures.push({ action: 'preventDefault', error: 'notCancelable' })
      } else {
        event.preventDefault()
      }
    } catch (err) {
      failures.push({ action: 'preventDefault', error: String(err) })
    }
  }
  if (spec.stopPropagation === true) {
    attempted.push('stopPropagation')
    try {
      event.stopPropagation()
    } catch (err) {
      failures.push({ action: 'stopPropagation', error: String(err) })
    }
  }
  const captureAction = spec.captureAction ?? 'none'
  if (captureAction !== 'none' && pointerId >= 0) {
    const action = captureAction === 'capture' ? 'setPointerCapture' : 'releasePointerCapture'
    attempted.push(action)
    try {
      if (!captureTarget) {
        failures.push({ action, error: 'noCaptureTarget' })
      } else if (action === 'setPointerCapture') {
        captureTarget.setPointerCapture(pointerId)
      } else {
        captureTarget.releasePointerCapture(pointerId)
      }
    } catch (err) {
      const name = (err as { name?: string }).name
      // `releasePointerCapture` 对"本来就没捕获"的 pointer 抛 NotFoundError ——
      // 那是**幂等成功**，不是失败（否则每次 up 都产生一条假失败）。
      if (!(action === 'releasePointerCapture' && name === 'NotFoundError')) {
        failures.push({ action, error: name ?? String(err) })
      }
    }
  }
  return Object.freeze({ attempted: Object.freeze(attempted), failures: Object.freeze(failures) })
}

/** 该元素当前是否持有某 pointer 的捕获（**事实查询**，不做决定）。 */
export function hasPointerCapture(target: Element | null, pointerId: number): boolean {
  if (!target || pointerId < 0) return false
  try {
    return target.hasPointerCapture(pointerId)
  } catch {
    return false
  }
}

/**
 * 用户激活下的受限 API 探测（**事实**）。
 *
 * 输入适配规则点名"用户激活下的受限 API"。`showSaveFilePicker` 等只在安全上下文 +
 * 用户激活下可用；本函数如实报告**可用性事实**，由接线层决定是否呈现入口
 * （呈现决策归呈现层，不在这里）。
 */
export interface RestrictedApiAvailability {
  readonly secureContext: boolean
  readonly showSaveFilePicker: boolean
  readonly clipboardWrite: boolean
  readonly pointerCapture: boolean
}

export function readRestrictedApiAvailability(): RestrictedApiAvailability {
  const w = globalThis as unknown as {
    isSecureContext?: boolean
    showSaveFilePicker?: unknown
  }
  return Object.freeze({
    secureContext: w.isSecureContext === true,
    showSaveFilePicker: typeof w.showSaveFilePicker === 'function',
    clipboardWrite: typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function',
    // 指针捕获是 DOM 标准能力；缺失即说明宿主异常，必须可见而不是静默降级
    pointerCapture: typeof Element !== 'undefined' && typeof Element.prototype.setPointerCapture === 'function',
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 挂起 / 恢复（事实源：document.visibilityState）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 页面是否隐藏。
 *
 * 只读**事实**。政策（恢复不追赶、基线重置）在 `domain/input.applyVisibilityChange`。
 */
export function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** `performance.now()` 是**事实源**；把它注入纯函数，纯函数不自己读时钟。 */
export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}
