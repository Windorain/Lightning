/**
 * pure/selection.ts — Pure selection utilities.
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

import type { ScenePickEntity } from '@/render/interaction/scenePick'
import type { AnnotationType } from '@/render/data/annotationTypes'

/**
 * Convert a scene pick result to a SelectedEntity (or null if not matchable).
 */
export function scenePickToSelectedEntity(
  pick: ScenePickEntity,
):
  | { kind: 'block'; ref: { pos: { x: number; y: number; z: number }; block_state_id: string } }
  | { kind: 'annotation'; id: string; type: AnnotationType }
  | null {
  if (
    pick.kind === 'block' &&
    pick.blockId &&
    pick.column !== undefined &&
    pick.row !== undefined &&
    pick.zSlice !== undefined
  ) {
    return {
      kind: 'block',
      ref: {
        pos: { x: pick.column, y: pick.row, z: pick.zSlice },
        block_state_id: pick.blockId,
      },
    }
  }
  if (pick.kind === 'annotation' && pick.annotationId && pick.annotationType) {
    return {
      kind: 'annotation',
      id: pick.annotationId,
      type: pick.annotationType,
    }
  }
  return null
}
