/**
 * pushDocUndo — shared helper for the snapshot-before, mutate, snapshot-after, push-undo pattern.
 *
 * Clones the full RuntimeDocument before and after a mutation, then pushes a single undo entry
 * that atomically swaps the entire document. Used by OperatorRegistry and ModalOperatorWrapper.
 *
 * For cases that mutate grid cells instead of replacing the whole doc (e.g. MoveOperator),
 * callers should build their own undo entry — this helper only works with whole-doc swap undo.
 *
 * **退役改造（#249 §15 第 5 条）**：原第 5 个参数 `replaceDocOptions`
 * （`{ bumpStructEpoch: false }`）已删除 —— 那是调用方替渲染层回答"这次不用重建"，
 * 属删除验收明文禁止的"版本补丁"。现在撤销/重做只替换文档，重建范围由呈现层按
 * **内容身份**自行判定（`presentation/contentIdentity`）。
 */
import { generateId } from '@/pure/string'
import type { Context } from '@/runtime/context'
import type { RuntimeDocument } from '@/context/runtimeDocument'

export function pushDocUndo(
  ctx: Context,
  before: RuntimeDocument | null,
  after: RuntimeDocument | null,
  label: string,
): void {
  if (before === null && after === null) return
  ctx.getEditHistory().push({
    id: generateId('op_'),
    label,
    timestamp: Date.now(),
    // #301 A′：经唯一写入口。**存在性由传入值派生**，不能硬写"已装载" ——
    // 本函数的 early-return 只在**两者皆 null** 时生效，故 `after` 可为 null
    // 而 `before` 非 null（撤销会回到"有文档"、重做回到"无文档"）。
    // `setDocument(null)` 会把内核侧同步为"未装载"，与 legacy 逐点对齐。
    execute: () => { ctx.setDocument(after) },
    undo: () => { ctx.setDocument(before) },
  })
}
