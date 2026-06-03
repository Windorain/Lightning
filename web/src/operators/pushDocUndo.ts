/**
 * pushDocUndo — shared helper for the snapshot-before, mutate, snapshot-after, push-undo pattern.
 *
 * Clones the full RuntimeDocument before and after a mutation, then pushes a single undo entry
 * that atomically swaps the entire document. Used by OperatorRegistry and ModalOperatorWrapper.
 *
 * For cases that mutate grid cells instead of replacing the whole doc (e.g. MoveOperator),
 * callers should build their own undo entry — this helper only works with whole-doc swap undo.
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
    execute: () => { ctx.main.replaceDoc(after) },
    undo: () => { ctx.main.replaceDoc(before) },
  })
}
