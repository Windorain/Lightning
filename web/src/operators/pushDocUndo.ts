/**
 * pushDocUndo — shared helper for the snapshot-before, mutate, snapshot-after, push-undo pattern.
 *
 * Takes two **opaque document snapshot tokens** (before/after) and pushes a single undo entry
 * that atomically swaps the whole document back and forth. Used by OperatorRegistry and
 * ModalOperatorWrapper.
 *
 * For cases that mutate grid cells instead of replacing the whole doc (e.g. MoveOperator),
 * callers should build their own undo entry — this helper only works with whole-doc swap undo.
 *
 * **退役改造**：原第 5 个参数 `replaceDocOptions`
 * （`{ bumpStructEpoch: false }`）已删除 —— 那是调用方替渲染层回答"这次不用重建"，
 * 属删除验收明文禁止的"版本补丁"。现在撤销/重做只替换文档，重建范围由呈现层按
 * **内容身份**自行判定（`presentation/contentIdentity`）。
 *
 * **入参改造**：入参由 `RuntimeDocument | null` 改为
 * `DocumentSnapshot | null`（**不透明令牌**，见 `runtime/documentSnapshot`）。
 * 理由：能力（"撤销到无文档"）必须存续，
 * 但**不得**再交出一个可读的旧文档句柄 —— 否则"终删 `getDoc()`"只是改名
 * （明令禁止的"新门面包旧核心保活"）。
 * `null` 令牌的语义与旧 `null` **逐字相同**：那一刻没有文档。
 */
import { generateId } from '@/pure/string'
import type { Context } from '@/runtime/context'
import type { DocumentSnapshot } from '@/runtime/documentSnapshot'

export function pushDocUndo(
  ctx: Context,
  before: DocumentSnapshot | null,
  after: DocumentSnapshot | null,
  label: string,
): void {
  if (before === null && after === null) return
  ctx.getEditHistory().push({
    id: generateId('op_'),
    label,
    timestamp: Date.now(),
      // 经唯一写入口。**存在性由传入值派生**，不能硬写"已装载" ——
    // 本函数的 early-return 只在**两者皆 null** 时生效，故 `after` 可为 null
    // 而 `before` 非 null（撤销会回到"有文档"、重做回到"无文档"）。
    // `restoreDocumentSnapshot(null)` 会把内核侧同步为"未装载"，与 legacy 逐点对齐。
    execute: () => { ctx.restoreDocumentSnapshot(after) },
    undo: () => { ctx.restoreDocumentSnapshot(before) },
  })
}
