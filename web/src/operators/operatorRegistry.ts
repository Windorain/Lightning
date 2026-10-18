/**
 * OperatorRegistry — 对标 Blender 的 WM_operatortype_append / WM_operator_name_call。
 *
 * 全局操作符注册表。管理所有操作符实例，提供 exec/invoke 便捷方法。
 */
import type { Context } from '@/runtime/context'
import type { OperatorType, OperatorProperties, OpResult } from './operatorType'
import { OP_RESULT } from './operatorType'
import { pushDocUndo } from './pushDocUndo'

import { ModalOperatorWrapper } from './modalOperatorWrapper'
import type { StateDigest } from '@/logging/LogCenter'
import { refuseOperator } from './capabilityRefusal'

/**
 * 该算子**缺哪一个能力**（`null` = 全部具备）。
 *
 * M7-5：能力门是**声明式**的（`OperatorType.requires`），结算点在注册表的两条入口
 * （`exec`/`invoke`）—— 于是"缺能力"只有一种行为：**结构化拒绝** + 成句原因，
 * 不会出现"某个算子在 poll 里悄悄返回 false、另一个在 exec 里直接 return"的分叉
 * （SPEC §10.7/§10.10）。
 */
function missingCapabilityOf(op: OperatorType, ctx: Context): string | null {
  for (const capability of op.requires ?? []) {
    if (!ctx.hasCapability(capability)) return capability
  }
  return null
}

function logOperatorResult(
  ctx: Context, opId: string, label: string, result: string,
  snapBefore?: StateDigest,
) {
  const detail: Record<string, unknown> = { opId, result }
  if (snapBefore) {
    const d = ctx.log.diff(snapBefore, ctx)
    if (d.blocksAdded.length || d.blocksRemoved.length || d.blocksMoved.length || d.selectionChanged) {
      detail.changes = d
    }
  }
  ctx.log.operator('Operator', `${label} → ${result}`, detail)
}

export class OperatorRegistry {
  private operators = new Map<string, OperatorType>()

  register(op: OperatorType): void {
    this.operators.set(op.id, op)
  }

  find(id: string): OperatorType | undefined {
    return this.operators.get(id)
  }

  all(): OperatorType[] {
    return [...this.operators.values()]
  }

  /** 无交互执行操作符。如果 flagUndo 为 true，自动包裹 undo。 */
  async exec(ctx: Context, id: string, props?: OperatorProperties): Promise<void> {
    const op = this.operators.get(id)
    if (!op) { ctx.log.warn('Operator', `exec: op not found ${id}`, { opId: id }); return }
    // 能力门优先于 poll：缺能力是**装配事实**（不会因文档状态变化），必须先结算成拒绝。
    const missingCapability = missingCapabilityOf(op, ctx)
    if (missingCapability !== null) { refuseOperator(ctx, op, missingCapability); return }
    if (op.poll && !op.poll(ctx)) {
      ctx.log.info('Operator', `exec: poll failed ${op.label}`, { opId: id, result: 'CANCELLED', reason: 'poll' })
      return
    }

    // #301 P10f C′1：存在性判定走 GF-15 读面（B′ 已建立的不变量）。
    // 原写法 `const doc = …; doc ? snapshot : undefined` 只用"有没有文档"这一位事实
    // ⇒ 换成读面后残留归零。⚠️ 下方 `:57`/`:59` 的 `.clone()` 是 **N10**
    // （受控双轨，Lead 裁决 (b)：legacy 快照在撤销路径存续，归一归 P11）—— 本批**不动**。
    const snap = ctx.hasLoadedDocument() ? ctx.log.snapshot(ctx) : undefined
    const resolvedProps: OperatorProperties = props ?? {}
    if (op.exec) {
      if (op.flagUndo && ctx.hasLoadedDocument()) {
        // #301 P10f D3（R8）：撤销快照 = **不透明令牌**（R-WK-09 裁决 3）。
        // `null` = 当时没有文档 ⇒ 表达"撤销到无文档"（内核历史结构性表达不了的那一态）。
        const before = ctx.documentSnapshot()
        await op.exec(ctx, resolvedProps)
        const after = ctx.documentSnapshot()
        pushDocUndo(ctx, before, after, op.label)
      } else {
        await op.exec(ctx, resolvedProps)
      }
      logOperatorResult(ctx, id, op.label, 'FINISHED', snap)
    }
  }

  /** 交互式调用操作符。返回操作状态。regionId 指定目标区域的模态栈。 */
  invoke(
    ctx: Context,
    id: string,
    props?: OperatorProperties,
    event?: PointerEvent | KeyboardEvent,
    regionId?: string,
  ): OpResult {
    const op = this.operators.get(id)
    if (!op) { ctx.log.warn('Operator', `invoke: op not found ${id}`, { opId: id }); return OP_RESULT.CANCELLED }
    const missingCapability = missingCapabilityOf(op, ctx)
    if (missingCapability !== null) { refuseOperator(ctx, op, missingCapability); return OP_RESULT.CANCELLED }
    if (op.poll && !op.poll(ctx)) {
      ctx.log.info('Operator', `invoke: poll failed ${op.label}`, { opId: id, result: 'CANCELLED', reason: 'poll' })
      return OP_RESULT.CANCELLED
    }

    // #301 P10f C′1：同 `:52`（存在性走 GF-15 读面）。
    const snap = ctx.hasLoadedDocument() ? ctx.log.snapshot(ctx) : undefined

    const resolvedProps: OperatorProperties = props ?? {}
    if (regionId) resolvedProps._regionId = regionId

    if (op.invoke) {
      const snapshot = op.flagUndo && ctx.hasLoadedDocument()
        ? ctx.documentSnapshot()
        : null

      const result = op.invoke(ctx, resolvedProps, event)

      if (result === OP_RESULT.RUNNING_MODAL) {
        const targetRegion = regionId ?? ctx.wm.events.getCurrentRegionId() ?? 'r-viewport'
        const wrapper = new ModalOperatorWrapper(op, ctx, resolvedProps, targetRegion)
        if (snapshot !== null) {
          wrapper.setUndoSnapshot(snapshot)
        }
        if (event) ctx.wm.events.pushModal(targetRegion, wrapper, event)
        logOperatorResult(ctx, id, op.label, 'RUNNING_MODAL', snap)
      } else if (result === OP_RESULT.FINISHED) {
        if (snapshot !== null) {
          const snapshotAfter = ctx.documentSnapshot()
          pushDocUndo(ctx, snapshot, snapshotAfter, op.label)
        }
        logOperatorResult(ctx, id, op.label, 'FINISHED', snap)
      }
      return result
    }

    if (op.exec) {
      invokeExecFallback(ctx, op, resolvedProps).catch(err => {
        ctx.log.error('Operator', `invoke exec fallback failed: ${op.label}`, { opId: op.id, error: String(err) })
      })
      return OP_RESULT.FINISHED
    }

    return OP_RESULT.CANCELLED
  }
}

async function invokeExecFallback(
  ctx: Context,
  op: OperatorType,
  props: OperatorProperties,
): Promise<OpResult> {
  if (op.flagUndo && ctx.hasLoadedDocument()) {
    const snapshot = ctx.documentSnapshot()
    await op.exec!(ctx, props)
    const snapshotAfter = ctx.documentSnapshot()
    pushDocUndo(ctx, snapshot, snapshotAfter, op.label)
  } else {
    await op.exec!(ctx, props)
  }
  return OP_RESULT.FINISHED
}

export function createOperatorRegistry(): OperatorRegistry {
  return new OperatorRegistry()
}

/**
 * Wrap an OperatorRegistry into the shape expected by Context.operators.
 * When `sanitize` is true, `find`/`all` return only the public face (id, label)
 * instead of the full OperatorType — used by the embed shell.
 */
export function wrapOperatorRegistry(
  registry: OperatorRegistry,
  getCtx: () => Context,
  sanitize?: boolean,
) {
  return {
    exec: (id: string, props?: Record<string, unknown>) => registry.exec(getCtx(), id, props),
    invoke: (id: string, props?: Record<string, unknown>, event?: Event, regionId?: string) =>
      registry.invoke(getCtx(), id, props, event as PointerEvent | KeyboardEvent, regionId),
    find: sanitize
      ? (id: string) => { const o = registry.find(id); return o ? { id: o.id, label: o.label } : undefined }
      : (id: string) => registry.find(id),
    all: sanitize
      ? () => registry.all().filter(o => !o.internal).map(o => ({ id: o.id, label: o.label }))
      : () => registry.all().filter(o => !o.internal),
    register: (op: OperatorType) => registry.register(op),
  }
}
