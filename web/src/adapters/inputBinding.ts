/**
 * `adapters/inputBinding` —— **DOM 事件到输入会话的绑定**：事实提取 + 平台同步动作 + 单一挂载点
 * （#249 §9 §19.1；契约 §7.1 规则 4「`adapters` 实现端口」；P7 = #258）。
 *
 * ## 与 `runtime/inputSession` 的分工（#249 §4/#249 §9 的分层判据）
 *
 * | 模块 | 层 | 职责 |
 * |---|---|---|
 * | `runtime/inputSession` | `runtime`（**纯核心**） | 判定谁收、产出命令、推进草稿状态 |
 * | **本模块** | `adapters` | 读 DOM 事件 → 事实；把路由结论落成平台动作 |
 *
 * 分开是**判据要求**，不是风格：`runtime` 在 P1 被登记为 `corePurity`，
 * `gate/core-no-dom-globals` 拒绝其中任何 `document`/`window` 引用。
 * 更根本的理由是 #249 §9：「平台动作根据**纯路由策略提供的结果**执行」——
 * 若同一模块既决定接收者又执行平台动作，这条边界就不存在，A22 的
 * 「两个 handler 各启动操作」也就无法被结构性阻止。
 *
 * ## 本模块替代的旧机制（B5 退役矩阵 #12 的 P7 半边）
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

import { applyPlatformActions, isPageHidden, nowMs, readKeyFact, readPointerFact } from './inputFacts'
import type { InputSession, PlatformActionRequest } from '@/runtime/inputSession'
import type { InputEventResult } from '@/runtime/inputSession'

// ─────────────────────────────────────────────────────────────────────────────
// 挂载点与配置
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 该坐标命中哪个 region（Area 布局知识由装配层提供 —— 见 #257 的 Area 所有权）。
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
  /** 捕获宿主解析（缺省：事件 target 最近的 `.vc-viewport`）。 */
  readonly resolveCaptureElement?: (event: PointerEvent, regionId: string | null) => Element | null
  /** 页面挂起/恢复时的回调（runtime 时钟据此重置基线）。 */
  readonly onResume?: (input: { resumeBaseline: number; droppedTicks: number }) => void
  /** 每条事件处理后的观测回调（诊断/探针）。 */
  readonly onEvent?: (result: InputEventResult) => void
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

/** 进程级挂载计数（**跨实例**）。A22 的"只挂一条"由它执行，而不是靠自觉。 */
let mountedKeydownOwners: string[] = []

/** 供测试与诊断读取当前挂载者（e2e 探针经 `window.__p7_input__` 暴露它）。 */
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

  // ── 键盘 ─────────────────────────────────────────────────────────────

  function onKeyDown(event: Event): void {
    if (!mounted) return
    const ke = event as KeyboardEvent
    const result = session.handleKey(readKeyFact(ke, session.nextToken()))
    runPlatform(result, ke)
    options.onEvent?.(result)
  }

  function onKeyUp(event: Event): void {
    if (!mounted) return
    const ke = event as KeyboardEvent
    const result = session.handleKey(readKeyFact(ke, session.nextToken()))
    runPlatform(result, ke)
    options.onEvent?.(result)
  }

  function runPlatform(result: InputEventResult, event: Event): void {
    const action: PlatformActionRequest = result.platformAction
    const pointerId = action.pointerId
    const target = pointerId >= 0 && event instanceof PointerEvent ? captureElement(event, action.captureRegionId) : null
    const outcome = applyPlatformActions(event, action, pointerId, target)
    if (outcome.failures.length > 0) {
      // 缺失能力/平台拒绝必须**可见**（#249 §9「不以薄适配器为由丢掉必要同步契约」）
      console.warn('[inputBinding] 平台动作失败', outcome.failures)
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

    const fact = readPointerFact(pe, session.nextToken(), { hitRegionId: regionId, captured })
    if (fact === null) return
    const result = session.handlePointer(fact)

    // 捕获/释放由会话**决定**（`platformAction.captureAction`），此处只执行。
    const outcome = applyPlatformActions(pe, result.platformAction, fact.pointerId, captureTarget)
    if (outcome.failures.length > 0) {
      console.warn('[inputBinding] 平台动作失败', outcome.failures)
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
    session.registerTextControl(
      {
        controlId,
        kind: kindOf(controlId),
        displayValue: displayValueOf(controlId),
        commitOn: controlElement(controlId)?.dataset.inputCommitOn === 'explicit' ? 'explicit' : 'enter-or-blur',
      },
      token,
    )
  }

  function onFocusOut(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    if (controlId === null) return
    session.blurTextControl(controlId, 'blur', session.nextToken())
  }

  function controlElement(controlId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-input-control-id="${controlId}"]`)
  }

  function onCompositionStart(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    if (controlId === null) return
    session.compositionStart(controlId, session.nextToken())
  }

  function onCompositionUpdate(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    if (controlId === null) return
    session.compositionUpdate(controlId, (event as CompositionEvent).data, session.nextToken())
  }

  function onCompositionEnd(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    if (controlId === null) return
    // 只解除组合态；提交由随后的事件决定（避免 compositionend 与 input 双重提交）
    session.compositionEnd(controlId, (event as CompositionEvent).data, session.nextToken())
  }

  function onInput(event: Event): void {
    if (!mounted) return
    const controlId = ownerOf(event.target)
    if (controlId === null) return
    const target = event.target
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return
    session.applyTextInput(controlId, target.value, session.nextToken())
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
      // 恢复**不**追赶：只把基线交给调用方（#249 §9）
      options.onResume?.({ resumeBaseline: r.resumeBaseline, droppedTicks: r.droppedTicks })
    }
  }

  keyTarget.addEventListener('keydown', onKeyDown, { capture: true })
  keyTarget.addEventListener('keyup', onKeyUp, { capture: true })
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
        throw new Error(
          `[inputBinding] document keydown 已被 ${mountedKeydownOwners[0]} 持有；${owner} 不得再挂第二条` +
            '（A22「两个 handler 各启动操作」的结构性防御）',
        )
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
