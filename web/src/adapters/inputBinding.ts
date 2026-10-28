/**
 * `adapters/inputBinding` —— **DOM 事件到输入会话的绑定**：事实提取 + 平台同步动作 + 单一挂载点
 * （适配器实现端口）。
 *
 * ## 与 `runtime/inputSession` 的分工（分层判据）
 *
 * | 模块 | 层 | 职责 |
 * |---|---|---|
 * | `runtime/inputSession` | `runtime`（**纯核心**） | 判定谁收、产出命令、推进草稿状态 |
 * | **本模块** | `adapters` | 读 DOM 事件 → 事实；把路由结论落成平台动作 |
 *
 * 分开是**判据要求**，不是风格：`runtime` 被登记为 `corePurity`，
 * `gate/core-no-dom-globals` 拒绝其中任何 `document`/`window` 引用。
 * 更根本的理由是「平台动作根据**纯路由策略提供的结果**执行」——
 * 若同一模块既决定接收者又执行平台动作，这条边界就不存在，关于"两个 handler 各启动操作"的
 * 「两个 handler 各启动操作」也就无法被结构性阻止。
 *
 * ## 本模块替代的旧机制
 *
 * 旧实现有**两条** document 级 capture `keydown`：
 * `runtime/chromeBinder.ts`（壳层）与 `runtime/viewportBinder.ts`（视口），
 * 各自先问 `wikiInputShield.shouldSkipWorkbenchDocumentKeydown(event)`，
 * 再问 `util/browser.isEditingTarget(event.target)`，然后各自 `ed.dispatch(...)`。
 * 于是"同一按键被两条监听各判一次"是**结构性的**。本模块：
 *
 *  - 整个应用只挂**一条** `keydown`（capture）；
 *  - `claimExclusive(owner)` 让第二个挂载者**抛错**（结构防御，不是约定）；
 *  - 事实提取（含 `isEditingTarget` 的等价判定）只作为 `KeyFact.targetEditable` 交给
 *    纯路由 —— **语义层不再读 DOM**。
 */

import { applyPlatformActions, isEditableElement, isPageHidden, nowMs, readKeyFact, readPointerFact } from './inputFacts'
import type { InputSession, PlatformActionRequest } from '@/runtime/inputSession'
import type { InputEventResult } from '@/runtime/inputSession'
import type { TextDraftEffect } from '@/domain/textDraft'

// ─────────────────────────────────────────────────────────────────────────────
// 挂载点与配置
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 该坐标命中哪个 region（Area 布局知识由装配层提供）。
 *
 * 适配器**不**推导它：`elementFromPoint` 只给 DOM 元素，而"哪个 Area 拥有这个元素"
 * 是布局事实。故由调用方注入。
 */
export type HitTest = (clientX: number, clientY: number, target: EventTarget | null) => string | null

export interface InputBindingOptions {
  readonly session: InputSession
  readonly hitTest: HitTest
  /** 键盘/焦点/组合事件的挂载点（默认 `document`）。 */
  readonly keyTarget?: Document | HTMLElement
  /** 指针事件的挂载点（默认 `document`）。 */
  readonly pointerTarget?: Document | HTMLElement
  /**
   * **键盘事件归属根**（宿主子树边界；缺省 `undefined` = 不设边界）。
   *
   * 为什么需要它：Wiki 词条页是**宿主页面**，工作台只占其中一个挂载点
   * （`#wsr-workbench-app`）。document 级 capture 监听会把宿主页自己的搜索框
   * / 正文输入也送进工作台路由 —— 宿主输入框里按 Ctrl+S 会被工作台当成
   * "保存到 Wiki"（热键落在应用层），这是**越界**，不是"文本优先"能解决的：
   * 那个输入框根本不属于本工作台，`session.routing.textFocus` 也不会登记它。
   *
   * 判定按**事件 target 的真实归属**（不是 `textFocus` 状态），并维护一个
   * **最近键盘所有权**状态：
   *  - target 在任一给定根内 / 在当前**已登记模态根**内 ⇒ 始终归工作台；
   *  - target 是**宿主可编辑元素**（app 外 input/textarea/contenteditable）⇒ 始终不归；
   *  - target 是 `body`/`document`（没有具体元素）⇒ 看最近一次 pointerdown/focusin：
   *    工作台根内交互 ⇒ `workbench`；宿主根外交互 ⇒ `host`；
   *  - 其它宿主非可编辑元素 ⇒ 不归。
   *
   * **blur/focusout 不改变所有权**：app 输入框失焦到 body、菜单关闭移除节点后，
   * 最近所有权仍是工作台；宿主 input 失焦到 body 后仍是宿主，直到下一次工作台交互。
   * 初始状态：宿主 `activeElement` 是 body/app 根内 ⇒ 工作台；是宿主元素 ⇒ 宿主。
   *
   * 缺省不设边界，普通工作台/嵌入行为逐字不变。
   */
  readonly keyScopeRoots?: () => readonly (Element | null)[]
  /** 捕获宿主解析（缺省：事件 target 最近的 `.vc-viewport`）。 */
  readonly resolveCaptureElement?: (event: PointerEvent, regionId: string | null) => Element | null
  /**
   * 当前模态的**根元素**（`null` = 未登记）。
   *
   * 适配器用它把"事件目标是否在模态内部"翻成 {@link PointerFact.hitModalScopeId} /
   * {@link KeyFact.hitModalScopeId} 这一维**事实**；路由据此区分"模态内部（普通 DOM）"
   * 与"背景（被吞）"。根元素由弹窗组件在 `openModalScope` 时提交（见 `runtime/inputPort`）。
   *
   * 缺省 `undefined` ⇒ 事实恒为 `null` ⇒ 行为与旧实现逐字相同（全部按背景吞）——
   * 对**未**登记根的老调用方是安全回落，不是"猜不出来就放行"。
   */
  readonly modalRootOf?: (scopeId: string) => Element | null
  /** 页面挂起/恢复时的回调（runtime 时钟据此重置基线）。 */
  readonly onResume?: (input: { resumeBaseline: number; droppedTicks: number }) => void
  /** 每条事件处理后的观测回调（诊断）。 */
  readonly onEvent?: (result: InputEventResult) => void
  /**
   * 文本状态推进的通知（**只读**；不带政策）。
   *
   * 文本路径返回 `TextDraftEffect[]` 而非 `InputEventResult`，故需要单独的
   * 通知通道让呈现层刷新草稿镜像与提示（见 `reportTextEffects` 的说明）。
   */
  readonly onTextEffects?: (controlId: string, effects: readonly TextDraftEffect[]) => void
  /**
   * **平台动作失败**的上报口。
   *
   * 什么是平台动作：指针捕获/释放、焦点移交、滚动等"会话已经决定、由平台执行"的动作。
   * 它失败时用户感知是"拖了一下但没抓住"，而此前只有一句 `console.warn`（判据读不到）。
   * 适配器不 import 诊断层（`adapters` 不依赖 `runtime`），因此由装配边注入回调。
   */
  readonly onPlatformFailure?: (failures: readonly { readonly action: string; readonly error: string }[]) => void
}

export interface InputBinding {
  /** 断言本绑定是唯一挂载点；第二次调用抛错。 */
  claimExclusive(owner: string): void
  /** 该控件当前是否被本绑定持有（供测试断言挂卸平衡）。 */
  isMounted(): boolean
  dispose(): void
}

const POINTER_EVENT_NAMES = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'pointerenter',
  'pointerleave',
  'lostpointercapture',
  'wheel',
] as const

/**
 * **独占冲突**：第二个挂载者被结构性拒绝时抛的就是这个类型。
 *
 * 为什么要有具名类型而不是裸 `Error`：调用方（`WorkbenchRoot`）需要把这一种失败
 * 翻译成**一句人话**，而其它装配异常仍必须照原样向上抛 —— 靠
 * `err.message.includes(...)` 判别会把"文案"变成一根隐式接口（改文案就静默失效）。
 */
export class ExclusiveKeydownConflict extends Error {
  constructor(
    /** 当前持有者名（诊断用；用户看到的是上层给的人话文案）。 */
    readonly incumbent: string,
    /** 试图再挂一条的所有者名。 */
    readonly challenger: string,
  ) {
    super(
      `[inputBinding] document keydown 已被 ${incumbent} 持有；${challenger} 不得再挂第二条` +
        '（同一事件不得启动两次操作的结构性防御）',
    )
    this.name = 'ExclusiveKeydownConflict'
  }
}

/** 进程级挂载计数（**跨实例**）。"只挂一条"由它执行，而不是靠自觉。 */
let mountedKeydownOwners: string[] = []

/** 供测试与诊断读取当前挂载者（e2e 经 `window.__p7_input__` 暴露它）。 */
export function exclusiveKeydownOwners(): readonly string[] {
  return Object.freeze([...mountedKeydownOwners])
}

/**
 * 挂载输入绑定。
 *
 * 返回的对象**不包含**任何领域判断：它只做"读事件 → 事实"与"按结论执行平台动作"。
 */
export function createInputBinding(options: InputBindingOptions): InputBinding {
  const { session, hitTest } = options
  const keyTarget: Document | HTMLElement = options.keyTarget ?? document
  const pointerTarget: Document | HTMLElement = options.pointerTarget ?? document
  let mounted = true

  function captureElement(event: PointerEvent, regionId: string | null): Element | null {
    if (options.resolveCaptureElement) return options.resolveCaptureElement(event, regionId)
    const target = event.target
    if (target instanceof Element) {
      return (target.closest('.vc-viewport') as Element | null) ?? target
    }
    return null
  }

  /**
   * 事件目标落在**当前模态根**内 ⇒ 返回该作用域 id；否则 `null`。
   *
   * 只有当前打开的模态算数（`session.routing.modal.scopeId`）：残留的旧弹窗 DOM
   * 不是"内部"。根元素未登记 ⇒ 一律 `null`（安全回落：按背景吞）。
   */
  function hitModalScopeOf(target: EventTarget | null): string | null {
    const modal = session.routing.modal
    if (!modal.open || modal.scopeId === null) return null
    if (target === null) return null
    const root = options.modalRootOf?.(modal.scopeId) ?? null
    if (root === null) return null
    return target instanceof Node && root.contains(target) ? modal.scopeId : null
  }

  function ownerOf(target: EventTarget | null): string | null {
    if (!(target instanceof HTMLElement)) return null
    const el = target.closest('[data-input-control-id]') as HTMLElement | null
    return el?.dataset.inputControlId ?? null
  }

  function displayValueOf(controlId: string): string {
    const scope: ParentNode = document
    const el = scope.querySelector<HTMLElement>(`[data-input-control-id="${controlId}"]`)
    return el?.dataset.inputDisplay ?? ''
  }

  function kindOf(controlId: string): 'number' | 'text' {
    const scope: ParentNode = document
    const el = scope.querySelector<HTMLElement>(`[data-input-control-id="${controlId}"]`)
    return el?.dataset.inputKind === 'number' ? 'number' : 'text'
  }

  /**
   * 读控件的**域约束声明**（事实，不是政策）。
   *
   * 适配器不认识属性描述符（那会把它变成领域层），但它可以读 DOM 上的声明。
   * 约束的传递路径因此是"描述 → 呈现声明 → 适配器读事实 → **纯解析**判定"：
   * 判定始终只有一个来源（`domain/textDraft`），适配器只搬运事实。
   */
  function domainFactsOf(controlId: string): {
    pattern?: string
    patternReason?: string
    maxLength?: number
  } {
    const scope: ParentNode = document
    const el = scope.querySelector<HTMLElement>(`[data-input-control-id="${controlId}"]`)
    if (el === null) return {}
    const ds = el.dataset
    return {
      ...(ds.inputPattern === undefined || ds.inputPattern === '' ? {} : { pattern: ds.inputPattern }),
      ...(ds.inputPatternReason === undefined ? {} : { patternReason: ds.inputPatternReason }),
      ...(ds.inputMaxlength === undefined ? {} : { maxLength: Number(ds.inputMaxlength) }),
    }
  }

  // ── 键盘 ─────────────────────────────────────────────────────────────

  /**
   * **最近键盘所有权**：没有具体元素 target（body/document）时，
   * 键盘归谁由最近一次 pointerdown/focusin 决定。
   *
   * 为什么不看 `document.activeElement`：app 输入框失焦、菜单关闭都会让
   * activeElement 回到 body，但"最后一次交互发生在工作台内"的事实仍应保留；
   * 反过来宿主 input 失焦到 body 后，也不该被下一次 Ctrl+S"抢回"工作台。
   */
  type KeyOwnership = 'workbench' | 'host'

  function targetInsideWorkbench(target: EventTarget | null): boolean {
    if (options.keyScopeRoots === undefined) return true
    if (!(target instanceof Node)) return false
    // teleport 到 body 的模态：其根已由 openModalScope 显式登记，仍归工作台。
    if (hitModalScopeOf(target) !== null) return true
    for (const root of options.keyScopeRoots()) {
      if (root !== null && root.contains(target)) return true
    }
    return false
  }

  /** 无具体元素的键盘 target（body/document/documentElement/null）。 */
  function isDocumentBodyTarget(target: EventTarget | null): boolean {
    if (typeof document === 'undefined') return target === null
    return (
      target === null ||
      target === document ||
      target === document.body ||
      target === document.documentElement
    )
  }

  function initialKeyOwnership(): KeyOwnership {
    if (options.keyScopeRoots === undefined) return 'workbench'
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (targetInsideWorkbench(active)) return 'workbench'
    if (isDocumentBodyTarget(active)) return 'workbench'
    // 宿主元素（input 或先被交互的宿主控件）⇒ 初始归宿主。
    return 'host'
  }

  let keyOwnership: KeyOwnership = initialKeyOwnership()

  function noteKeyboardOwnership(target: EventTarget | null): void {
    if (options.keyScopeRoots === undefined) return
    keyOwnership = targetInsideWorkbench(target) ? 'workbench' : 'host'
  }

  function onOwnershipPointerDown(event: Event): void {
    noteKeyboardOwnership(event.target)
  }

  function onOwnershipFocusIn(event: Event): void {
    noteKeyboardOwnership(event.target)
  }

  /**
   * 该键盘事件是否属于本工作台。未配置根 ⇒ 恒 `true`（旧行为）。
   *
   * 显式根/模态根内 ⇒ 恒 true；宿主可编辑元素 ⇒ 恒 false；
   * body/document ⇒ 最近所有权；其它宿主元素 ⇒ false。
   */
  function keyEventInScope(event: Event): boolean {
    if (options.keyScopeRoots === undefined) return true
    const target = event.target
    if (targetInsideWorkbench(target)) return true
    if (isEditableElement(target)) return false
    if (isDocumentBodyTarget(target)) return keyOwnership === 'workbench'
    return false
  }

  function onKeyDown(event: Event): void {
    if (!mounted) return
    const ke = event as KeyboardEvent
    if (!keyEventInScope(ke)) return
    const result = session.handleKey(
      readKeyFact(ke, session.nextToken(), { hitModalScopeId: hitModalScopeOf(ke.target) }),
    )
    runPlatform(result, ke)
    options.onEvent?.(result)
  }

  function onKeyUp(event: Event): void {
    if (!mounted) return
    const ke = event as KeyboardEvent
    if (!keyEventInScope(ke)) return
    const result = session.handleKey(
      readKeyFact(ke, session.nextToken(), { hitModalScopeId: hitModalScopeOf(ke.target) }),
    )
    runPlatform(result, ke)
    options.onEvent?.(result)
  }

  function runPlatform(result: InputEventResult, event: Event): void {
    const action: PlatformActionRequest = result.platformAction
    const pointerId = action.pointerId
    const target = pointerId >= 0 && event instanceof PointerEvent ? captureElement(event, action.captureRegionId) : null
    const outcome = applyPlatformActions(event, action, pointerId, target)
    if (outcome.failures.length > 0) {
      // 缺失能力/平台拒绝必须**可见**（「不以薄适配器为由丢掉必要同步契约」）
      // 由装配边注入的上报口落到诊断面（适配器不 import 诊断层）。
      options.onPlatformFailure?.(outcome.failures)
    }
  }

  // ── 指针 ─────────────────────────────────────────────────────────────

  function onPointer(event: Event): void {
    if (!mounted) return
    if (!(event instanceof PointerEvent) && event.type !== 'wheel') return
    const pe = event as PointerEvent | WheelEvent
    const regionId = hitTest(pe.clientX, pe.clientY, pe.target)
    const pointerId = pe.type === 'wheel' ? -1 : (pe as PointerEvent).pointerId
    const captureTarget = pointerId >= 0 ? captureElement(pe as PointerEvent, regionId) : null
    const captured = captureTarget !== null && hasCapture(captureTarget, pointerId)

    const fact = readPointerFact(pe, session.nextToken(), {
      hitRegionId: regionId,
      captured,
      hitModalScopeId: hitModalScopeOf(pe.target),
    })
    if (fact === null) return
    const result = session.handlePointer(fact)

    // 捕获/释放由会话**决定**（`platformAction.captureAction`），此处只执行。
    const outcome = applyPlatformActions(pe, result.platformAction, fact.pointerId, captureTarget)
    if (outcome.failures.length > 0) {
      options.onPlatformFailure?.(outcome.failures)
    }
    options.onEvent?.(result)
  }

  function hasCapture(target: Element | null, pointerId: number): boolean {
    if (!target || pointerId < 0) return false
    try {
      return target.hasPointerCapture(pointerId)
    } catch {
      return false
    }
  }

  // ── 焦点 / 组合 / 输入 ────────────────────────────────────────────────

  function onFocusIn(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    const token = session.nextToken()
    if (controlId === null) {
      session.blurCurrentTextFocus('focus-switch', token)
      return
    }
    const effects = session.registerTextControl(
      {
        controlId,
        kind: kindOf(controlId),
        displayValue: displayValueOf(controlId),
        commitOn: controlElement(controlId)?.dataset.inputCommitOn === 'explicit' ? 'explicit' : 'enter-or-blur',
        ...domainFactsOf(controlId),
      },
      token,
    )
    // 交点是**状态推进**，呈现层必须知道（否则镜像不刷新）。
    // 焦点事件没有 `RoutingDecision`，故单独报一条：`onEvent` 的消费者
    // （`RNAWidget.syncDraftMirror`）只关心"会话推进了"，不解读结论。
    reportTextEffects(controlId, effects, null)
  }

  function onFocusOut(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    if (controlId === null) return
    const effects = session.blurTextControl(controlId, 'blur', session.nextToken())
    reportTextEffects(controlId, effects, null)
  }

  /**
   * 呈现层镜像刷新（**只读**通知，不携带任何政策）。
   *
   * 为什么文本路径需要它而键盘路径不需要：键盘路径的结论经
   * `InputEventResult.decision` 传回，装配层能读到；而文本状态推进
   * （`registerTextControl` / `applyTextInput` / 组合事件）返回的是
   * `TextDraftEffect[]`，装配层的 `onEvent` 拿不到 —— 若不显式报，
   * 界面上的草稿与提示就不会更新（e2e 实测：输入 `-` 后提示不可见）。
   */
  function reportTextEffects(
    controlId: string,
    effects: readonly TextDraftEffect[],
    result: InputEventResult | null,
  ): void {
    if (result !== null) {
      options.onEvent?.(result)
      return
    }
    options.onTextEffects?.(controlId, effects)
  }

  function controlElement(controlId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-input-control-id="${controlId}"]`)
  }

  function onCompositionStart(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    if (controlId === null) return
    session.compositionStart(controlId, session.nextToken())
    options.onTextEffects?.(controlId, Object.freeze([]))
  }

  function onCompositionUpdate(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    if (controlId === null) return
    session.compositionUpdate(controlId, (event as CompositionEvent).data, session.nextToken())
    options.onTextEffects?.(controlId, Object.freeze([]))
  }

  function onCompositionEnd(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    if (controlId === null) return
    // 只解除组合态；提交由随后的事件决定（避免 compositionend 与 input 双重提交）
    session.compositionEnd(controlId, (event as CompositionEvent).data, session.nextToken())
    options.onTextEffects?.(controlId, Object.freeze([]))
  }

  function onInput(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    if (controlId === null) return
    const target = event.target
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return
    const effects = session.applyTextInput(controlId, target.value, session.nextToken())
    options.onTextEffects?.(controlId, effects)
  }

  // ── 可见性（事实；政策在 `domain/input`）──────────────────────────────

  let lastTickAt = nowMs()
  const TICK_INTERVAL_MS = 16

  function onVisibilityChange(): void {
    if (!mounted) return
    const hidden = isPageHidden()
    const r = session.applyVisibility({ hidden, now: nowMs(), lastTickAt, tickInterval: TICK_INTERVAL_MS })
    if (r.resumeBaseline !== null) {
      lastTickAt = r.resumeBaseline
      // 恢复**不**追赶：只把基线交给调用方
      options.onResume?.({ resumeBaseline: r.resumeBaseline, droppedTicks: r.droppedTicks })
    }
  }

  keyTarget.addEventListener('keydown', onKeyDown, { capture: true })
  keyTarget.addEventListener('keyup', onKeyUp, { capture: true })
  // 所有权事实只在配置了宿主根时登记；生命周期与 binding 同起同落。
  const tracksOwnership = options.keyScopeRoots !== undefined
  if (tracksOwnership) {
    pointerTarget.addEventListener('pointerdown', onOwnershipPointerDown, { capture: true })
    keyTarget.addEventListener('focusin', onOwnershipFocusIn, { capture: true })
  }
  for (const name of POINTER_EVENT_NAMES) {
    pointerTarget.addEventListener(name, onPointer, { capture: true, passive: false })
  }
  keyTarget.addEventListener('focusin', onFocusIn, { capture: true })
  keyTarget.addEventListener('focusout', onFocusOut, { capture: true })
  keyTarget.addEventListener('compositionstart', onCompositionStart, { capture: true })
  keyTarget.addEventListener('compositionupdate', onCompositionUpdate, { capture: true })
  keyTarget.addEventListener('compositionend', onCompositionEnd, { capture: true })
  keyTarget.addEventListener('input', onInput, { capture: true })
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)

  return {
    claimExclusive(owner) {
      if (mountedKeydownOwners.length > 0) {
        // **结构禁止不变**：仍然拒绝，且拒绝发生在任何监听被挂上之前。
        // 变的是错误类型：调用方据此给用户一句人话，而不是把诊断原文抛给页面。
        throw new ExclusiveKeydownConflict(mountedKeydownOwners[0]!, owner)
      }
      mountedKeydownOwners = [owner]
    },
    isMounted() {
      return mounted
    },
    dispose() {
      if (!mounted) return
      mounted = false
      keyTarget.removeEventListener('keydown', onKeyDown, { capture: true })
      keyTarget.removeEventListener('keyup', onKeyUp, { capture: true })
      if (tracksOwnership) {
        pointerTarget.removeEventListener('pointerdown', onOwnershipPointerDown, { capture: true })
        keyTarget.removeEventListener('focusin', onOwnershipFocusIn, { capture: true })
      }
      for (const name of POINTER_EVENT_NAMES) {
        pointerTarget.removeEventListener(name, onPointer, { capture: true })
      }
      keyTarget.removeEventListener('focusin', onFocusIn, { capture: true })
      keyTarget.removeEventListener('focusout', onFocusOut, { capture: true })
      keyTarget.removeEventListener('compositionstart', onCompositionStart, { capture: true })
      keyTarget.removeEventListener('compositionupdate', onCompositionUpdate, { capture: true })
      keyTarget.removeEventListener('compositionend', onCompositionEnd, { capture: true })
      keyTarget.removeEventListener('input', onInput, { capture: true })
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
      mountedKeydownOwners = []
    },
  }
}

/** 测试用：重置跨实例挂载记账（**只**供测试；产品代码不得调用）。 */
export function resetExclusiveKeydownOwnersForTest(): void {
  mountedKeydownOwners = []
}
