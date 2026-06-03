import type { BlockRef } from '@/context/selection'
import type { ScenePickResult } from '@/render/interaction/scenePick'

export function pickTargetKey(picked: ScenePickResult): string {
  if (!picked) return ''
  if (picked.kind === 'block') {
    return `b:${picked.blockId}:${picked.column},${picked.row},${picked.zSlice}`
  }
  return `a:${picked.annotationId}`
}

export function blockRefKey(block: BlockRef | null): string {
  if (!block) return ''
  return `b:${block.block_state_id}:${block.pos.x},${block.pos.y},${block.pos.z}`
}

export function voxelKey(v: { column: number; row: number; zSlice: number } | null | undefined): string {
  if (!v) return ''
  return `${v.column},${v.row},${v.zSlice}`
}
