import type { Context } from '@/runtime/context'
import type { RuntimeDocument } from '@/context/runtimeDocument'

/** Replace the active document and bump the structure epoch. */
export function replaceDoc(ctx: Context, doc: RuntimeDocument | null): void {
  ctx.main.replaceDoc(doc)
}

/** Bump the structure epoch to signal that the document has changed. */
export function bumpEpoch(ctx: Context): void {
  ctx.main.bumpEpoch()
}
