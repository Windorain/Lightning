import { computed, type ComputedRef } from 'vue'
import type { Context } from '@/runtime/context'
import type { BlockRef } from '@/context/selection'
import { structureRowToWorldY } from '@/pure/vec'
import { REGION } from '@/runtime/regionIds'
import type { ViewportBlockHover, ViewportHoverState } from '@/runtime/viewportHover'
import { requireViewportHover } from '@/runtime/viewportHover'
import type { ScenePickResult } from '@/render/interaction/scenePick'

export function blockRefFromViewportHover(ctx: Context, vb: ViewportBlockHover | null): BlockRef | null {
  if (!vb) return null
  const doc = ctx.getDoc().value
  const rf = doc?.frame(ctx.getCurrentFrameIndex().value ?? 0)
  const h = rf?.grid?.height ?? 0
  const worldY = h > 0 ? structureRowToWorldY(vb.voxel.row, h) : vb.voxel.row
  return {
    pos: { x: vb.voxel.column, y: worldY, z: vb.voxel.zSlice },
    block_state_id: vb.blockId,
  }
}

export function createWorkbenchHoverBlockRef(ctx: Context): ComputedRef<BlockRef | null> {
  const hover = requireViewportHover(ctx.requireRegion(REGION.WORKBENCH_VIEWPORT).state)
  return computed(() => blockRefFromViewportHover(ctx, hover.viewportBlock.value))
}

export function createWorkbenchHoverAnnotationIdRef(ctx: Context): ComputedRef<string | null> {
  const hover = requireViewportHover(ctx.requireRegion(REGION.WORKBENCH_VIEWPORT).state)
  return computed(() => hover.annotation.value?.annotationId ?? null)
}

/** 将拾取结果写入 Region.state.hover（Embed / Workbench / Wiki 共用） */
export function applyRegionHoverPick(
  hover: ViewportHoverState,
  picked: ScenePickResult,
  clientX: number,
  clientY: number,
): void {
  if (picked?.kind === 'block') {
    hover.setViewportBlock({
      blockId: picked.blockId,
      clientX,
      clientY,
      voxel: { column: picked.column, row: picked.row, zSlice: picked.zSlice },
    })
    return
  }
  if (picked?.kind === 'annotation') {
    hover.setAnnotation({
      annotationId: picked.annotationId,
      clientX,
      clientY,
    })
    return
  }
  hover.clearViewport()
}

/** Operator / 脚本：BlockRef → viewport hover */
export function setRegionHoverBlock(ctx: Context, regionId: string, block: BlockRef | null): void {
  const hover = requireViewportHover(ctx.requireRegion(regionId).state)
  if (!block) {
    hover.clearViewport()
    return
  }
  const doc = ctx.getDoc().value
  const grid = doc?.frame(ctx.getCurrentFrameIndex().value ?? 0)?.grid
  const h = grid?.height ?? 0
  const row = h > 0 ? h - 1 - block.pos.y : block.pos.y
  hover.setViewportBlock({
    blockId: block.block_state_id,
    clientX: 0,
    clientY: 0,
    voxel: { column: block.pos.x, row, zSlice: block.pos.z },
  })
}

export function setRegionHoverAnnotation(ctx: Context, regionId: string, id: string | null): void {
  const hover = requireViewportHover(ctx.requireRegion(regionId).state)
  if (!id) {
    hover.clearViewport()
    return
  }
  hover.setAnnotation({ annotationId: id, clientX: 0, clientY: 0 })
}
