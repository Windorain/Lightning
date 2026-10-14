import { computed, type ComputedRef } from 'vue'
import type { Context } from '@/runtime/context'
import type { BlockRef } from '@/context/selection'
import { structureRowToWorldY } from '@/pure/vec'
import { REGION } from '@/runtime/regionIds'
import type { ViewportBlockHover, ViewportHoverState } from '@/runtime/hover/state'
import { requireViewportHover } from '@/runtime/hover/state'
// R1-β① C8：拾取结果形状改吃**独立形状契约**（`presentation/pickResult`）——
// 旧定义寄居在 `render/interaction/scenePick.ts`（要被删除的旧实现文件）里。
import type { PickResult } from '@/presentation/pickResult'
import type { PartTooltipInfo } from '@/pure/tooltipResolution'

export function blockRefFromViewportHover(ctx: Context, vb: ViewportBlockHover | null): BlockRef | null {
  if (!vb) return null
  // #301 P10f D3（R5）：网格读面（声明尺寸；旧包围盒推导在尾层全空时会偏小 ⇒ Y 偏移）。
  const h = ctx.kernelGrid(ctx.getFrameIndex())?.height ?? 0
  const worldY = h > 0 ? structureRowToWorldY(vb.voxel.row, h) : vb.voxel.row
  return {
    pos: { x: vb.voxel.column, y: worldY, z: vb.voxel.zSlice },
    block_state_id: vb.blockId,
    // B-1：悬停目标携带部件身份 ⇒ 描边 mask 收敛到该部件（缺省 = 整格，既有行为）
    partLocalId: vb.part?.localId,
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
  picked: PickResult,
  clientX: number,
  clientY: number,
  /** P2.2 部件命中快照（由调用方经 pickPartForScenePick 解析；缺省 = 宿主格命中） */
  part?: PartTooltipInfo | null,
): void {
  if (picked?.kind === 'block') {
    hover.setViewportBlock({
      blockId: picked.blockId,
      clientX,
      clientY,
      voxel: { column: picked.column, row: picked.row, zSlice: picked.zSlice },
      part: part ?? null,
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
  const h = ctx.kernelGrid(ctx.getFrameIndex())?.height ?? 0
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
