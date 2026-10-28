import { MULTIPART } from './constants'

export function isEnvelopeDoc(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false
  const d = doc as Record<string, unknown>
  return (
    d.documentFormat === 'Envelope' ||
    (typeof d.payload === 'string' &&
      d.payload.length > 0 &&
      d.meta != null &&
      typeof d.meta === 'object')
  )
}

export function isMultipartIndex(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false
  const d = doc as Record<string, unknown>
  return d.documentFormat === MULTIPART && typeof d.partCount === 'number' && d.partCount > 0
}
