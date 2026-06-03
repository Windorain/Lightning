import type { BContext } from '@/context/bContext'
import type { RuntimeDocument } from '@/context/runtimeDocument'

/** Replace the active document and bump the structure epoch. This is the single writer for doc + structEpoch. */
export function replaceDoc(bctx: BContext, doc: RuntimeDocument | null): void {
  bctx.doc.value = doc
  bctx.structEpoch.value += 1
}

/** Bump the structure epoch to signal that the document has changed. Use this instead of writing bctx.structEpoch directly. */
export function bumpEpoch(bctx: BContext): void {
  bctx.structEpoch.value += 1
}
