import type { BlockRef } from '@/context/selection'
// R1-β① C8：形状契约迁出旧实现文件（见 `presentation/pickResult` 的说明）。
import type { PickResult } from '@/presentation/pickResult'

export function pickTargetKey(picked: PickResult): string {
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
