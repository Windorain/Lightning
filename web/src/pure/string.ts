/**
 * pure/string.ts — Pure string utilities.
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

/** Remove trailing slashes and trim */
export function normalizeApiBase(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** Suggest a local JSON file basename (without extension) */
export function suggestedJsonBaseName(
  currentFileName: string | null,
  fallback: string,
): string {
  let base = currentFileName?.replace(/^示例 · /, '') ?? fallback
  if (!base.toLowerCase().endsWith('.json')) base = `${base}.json`
  return base.replace(/\.json$/i, '')
}

/** Derive a safe filename stem from a material entry */
export function filenameStem(
  m: { locator?: string } | undefined,
  materialId: string,
): string {
  return m?.locator
    ? m.locator.replace(/^.*[\\/]/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
    : `material_${materialId}`
}

/** Generate a unique string key for a runtime block: "#paletteIndex" or "name:meta" */
export function blockKey(b: { name: string; meta: number; paletteIndex?: number }): string {
  if (b.paletteIndex !== undefined) return '#' + String(b.paletteIndex)
  return b.name + ':' + b.meta
}

/** Generate a short random ID with a given prefix */
export function generateId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10)
}
