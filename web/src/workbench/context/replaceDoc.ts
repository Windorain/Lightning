import type { BContext } from '@/workbench/context/bContext'
import type { RuntimeDocument } from '@/workbench/context/runtimeDocument'

/** Replace the active document and bump the structure epoch. This is the single writer for doc + structEpoch. */
export function replaceDoc(bctx: BContext, doc: RuntimeDocument | null): void {
  bctx.doc.value = doc
  bctx.structEpoch.value += 1
}
