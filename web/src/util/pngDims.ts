/**
 * Parse PNG width and height from a base64-encoded PNG data URL.
 * Reads bytes 16-23 of the PNG header (after the 8-byte signature).
 */
export function parsePngDims(dataUrl: string): { w: number; h: number } | null {
  try {
    const b64 = dataUrl.slice(dataUrl.indexOf('base64,') + 7)
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    // PNG signature: 137 80 78 71
    if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return null
    // Bytes 16-19: width (big-endian), 20-23: height
    const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]
    const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]
    return { w, h }
  } catch {
    return null
  }
}
