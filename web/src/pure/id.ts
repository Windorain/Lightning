/**
 * pure/id.ts — Pure ID generation.
 * No side effects: no Vue refs, no DOM, no I/O (beyond Math.random), no mutation of arguments.
 */

/** Generate a short random ID with a given prefix */
export function generateId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10)
}
