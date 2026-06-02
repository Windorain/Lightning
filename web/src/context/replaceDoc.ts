import type { BContext } from '@/context/bContext'
import type { RuntimeDocument } from '@/context/runtimeDocument'

/** Replace the active document and bump the structure epoch. This is the single writer for doc + structEpoch. */
export function replaceDoc(bctx: BContext, doc: RuntimeDocument | null): void {
  bctx.doc.value = doc
  bctx.structEpoch.value += 1
}
