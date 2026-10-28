import { computed, type ComputedRef } from 'vue'
import type { Context } from '@/runtime/context'
import type { BlockRef } from '@/context/selection'
import { structureRowToWorldY } from '@/pure/vec'
import { REGION } from '@/runtime/regionIds'
import type { ViewportBlockHover, ViewportHoverState } from '@/runtime/hover/state'
import { requireViewportHover } from '@/runtime/hover/state'
// 拾取结果形状改吃**独立形状契约**（`presentation/pickResult`）——
// 旧定义寄居在 `render/interaction/scenePick.ts`（要被删除的旧实现文件）里。
import type { PickResult } from '@/presentation/pickResult'
import type { PartTooltipInfo } from '@/pure/tooltipResolution'

export function blockRefFromViewportHover(ctx: Context, vb: ViewportBlockHover | null): BlockRef | null {
  if (!vb) return null
  // 网格读面（声明尺寸；旧包围盒推导在尾层全空时会偏小 ⇒ Y 偏移）。
  const h = ctx.kernelGrid(ctx.getFrameIndex())?.height ?? 0
  const worldY = h > 0 ? structureRowToWorldY(vb.voxel.row, h) : vb.voxel.row
  return {
    pos: { x: vb.voxel.column, y: worldY, z: vb.voxel.zSlice },
    block_state_id: vb.blockId,
    // B-1：悬停目标携带部件身份 ⇒ 描边 mask 收敛到该部件（缺省 = 整格，既有行为）
    partLocalId: vb.part?.localId,
  }
}

/**
 * **某一个 region 的悬停方块**（本区块 / 本视口的描边读面）。
 *
 * ## 为什么必须按 region（双区归属）
 *
 * 旧实现写死 `REGION.WORKBENCH_VIEWPORT` —— 于是**每个**视口把**根区**的悬停
 * 画成自己的描边：B 区悬停时亮的是 A 区画面，A 区悬停时两区同时亮
 * （双区归属的缺口）。region 是"输入域/机位/槽位"的共同键，悬停读面也必须同键，
 * 否则读面与写面（`handlers/hoverHandler` 按 region 写）归属不一致。
 *
 * @param regionId 缺省仍是根区 —— 单视口装配与既有调用点的行为**逐字不变**。
 */
export function createWorkbenchHoverBlockRef(
  ctx: Context,
  regionId: string = REGION.WORKBENCH_VIEWPORT,
): ComputedRef<BlockRef | null> {
  const hover = requireViewportHover(ctx.requireRegion(regionId).state)
  return computed(() => blockRefFromViewportHover(ctx, hover.viewportBlock.value))
}

export function createWorkbenchHoverAnnotationIdRef(
  ctx: Context,
  regionId: string = REGION.WORKBENCH_VIEWPORT,
): ComputedRef<string | null> {
  const hover = requireViewportHover(ctx.requireRegion(regionId).state)
  return computed(() => hover.annotation.value?.annotationId ?? null)
}

/**
 * **全局读面该读哪个 region**：最近写入过悬停的那个 region。
 *
 * ## 语义
 *
 * 底栏悬停读数、右栏检查器的悬停回落是**全域单例**呈现（同一时刻只有一处能显示），
 * 而悬停本身是**每区一份**状态。故必须有一个显式的决胜规则：
 * 「任一 region 悬停非空即用它；多个非空取**最近写入**者」。
 * 时间戳来自**屏幕级时钟**（`runtime/hover/state#HoverClock`）—— 各区的序号
 * 由同一个计数器发放，才可比。
 *
 * ## 为什么计算时先读 `screen.hoverClock.tick`
 *
 * Vue computed 只订阅它**上次读过**的依赖。第二区是在运行期登记的
 * （`ScreenRoot.ensureViewportRegion`）⇒ 读面上次算的时候还没遍历到它。
 * 屏幕时钟在**任何** region 的悬停写入与 region 增删时推进，故本行把
 * "新区的第一次悬停"也接进依赖图，避免"B 区悬停底栏没反应"。
 *
 * 平票（理论上只在"从未写入"时出现）取**先遍历到**的 region（注册序）。
 */
export function createScreenHoverRegionRef(ctx: Context): ComputedRef<ViewportHoverState | null> {
  return computed(() => {
    const screen = ctx.getScreenRoot()
    if (screen === null) return null
    void screen.hoverClock.tick.value
    let best: ViewportHoverState | null = null
    let bestStamp = 0
    screen.forEachRegion((r) => {
      const h = r.state.hover
      if (!h) return
      if (!h.viewportBlock.value && !h.annotation.value) return
      const stamp = h.revision.value
      if (stamp > bestStamp) {
        bestStamp = stamp
        best = h
      }
    })
    return best
  })
}

/** 全域悬停方块读面（底栏 / 检查器 / 属性目标解析）——见 {@link createScreenHoverRegionRef}。 */
export function createScreenHoverBlockRef(ctx: Context): ComputedRef<BlockRef | null> {
  const top = createScreenHoverRegionRef(ctx)
  return computed(() => blockRefFromViewportHover(ctx, top.value?.viewportBlock.value ?? null))
}

/** 全域悬停注解读面（与 {@link createScreenHoverBlockRef} 同一条决胜规则）。 */
export function createScreenHoverAnnotationIdRef(ctx: Context): ComputedRef<string | null> {
  const top = createScreenHoverRegionRef(ctx)
  return computed(() => top.value?.annotation.value?.annotationId ?? null)
}

/** 将拾取结果写入 Region.state.hover（Embed / Workbench / Wiki 共用） */
export function applyRegionHoverPick(
  hover: ViewportHoverState,
  picked: PickResult,
  clientX: number,
  clientY: number,
  /** 部件命中快照（由调用方经 pickPartForScenePick 解析；缺省 = 宿主格命中） */
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
