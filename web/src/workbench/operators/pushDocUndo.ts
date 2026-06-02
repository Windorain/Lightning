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
import type { BContext } from '@/workbench/context/bContext'
import type { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import { replaceDoc } from '@/workbench/context/replaceDoc'

export function pushDocUndo(
  bctx: BContext,
  before: RuntimeDocument | null,
  after: RuntimeDocument | null,
  label: string,
): void {
  if (before === null && after === null) return
  bctx.editHistory.push({
    id: generateId('op_'),
    label,
    timestamp: Date.now(),
    execute: () => { replaceDoc(bctx, after) },
    undo: () => { replaceDoc(bctx, before) },
  })
}
