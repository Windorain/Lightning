export function utf8ByteLength(str: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length
  }
  try {
    return unescape(encodeURIComponent(str)).length
  } catch {
    return str.length
  }
}

export function jsonPageBytes(obj: unknown): number {
  return utf8ByteLength(JSON.stringify(obj))
}
