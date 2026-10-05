/**
 * runtime/embedItemOutline.ts — 左栏**物品行选中集** → 视口描边 mask（B-5 / Gitea #38）。
 *
 * 与 `runtime/embedSidebarOutline.ts`（旧文件宿主行 registryId 匹配，**逐项不动**）并列：
 * 两条路径产出的都是同一类 mask mesh，喂同一个 `SelectionOutlinePass`——所以
 * **颜色/线宽/风格与 hover 完全一致**（#38 硬约束：不新造呈现）。
 *
 * 通道复用（关键）：本模块不自己造几何，而是把命中格引用交给
 * `SelectionHighlightProvider.build(entities, getBlockGeometry, gridCenterWorld, getPartMaskGeometry)`
 * ——**hover 描边走的就是这一句**（`drw.bindSelectionOutline`）。差别只在
 * `BlockRef.partLocalId`：part 命中带上（B-1 部件盒通道），host 命中不带（整格兜底）。
 *
 * 截断口径：命中计划在 `pure/itemOutlinePlan.ts` 里已按 `OUTLINE_MASK_LIMIT` 截断，
 * 故这里的 `entities.size` 恒 ≤ 上限，`provider.build` 的"超限返回空"自保分支不会触发
 * ——即"截断 + 提示"取代了"静默失效"。
 */

import * as THREE from 'three'
import { shallowRef, type ShallowRef } from 'vue'
import type { StructureDefinition, SelectedEntity } from '@/render/schema/types'
import type { ItemHitIndex } from '@/pure/itemIndex'
import {
  EMPTY_ITEM_OUTLINE_PLAN,
  OUTLINE_MASK_LIMIT,
  itemHitBlockRefs,
  planItemOutlineHits,
  type ItemOutlinePlan,
} from '@/pure/itemOutlinePlan'
import {
  SelectionHighlightProvider,
  type MaskGeometrySource,
} from '@/render/mesh/selectionHighlightProvider'
import { disposeOutlineMaskMeshes } from '@/render/mesh/blockRegistryOutlineMasks'

export interface EmbedItemOutlineDeps {
  /** 当前渲染定义（= `vpSlot.definition`，与 DRW 渲染的网格同源） */
  definitionRef: ShallowRef<StructureDefinition | null>
  /** 侧栏附加 mask 槽（与旧路径共用同一个 shallowRef，两条路径互斥） */
  masksRef: ShallowRef<THREE.Mesh[]>
  /** 反查索引（`buildItemHitIndex` 产物） */
  indexRef: () => ItemHitIndex
  /** 当前帧键（`context/queries.ts#currentFrameKey`） */
  frameRef: () => number
  getBlockGeometry: (pos: { x: number; y: number; z: number }) => import('@/render/schema/types').BakedQuad[] | null
  gridCenterWorld: (pos: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | null
  /** B-1 部件级 mask 几何源（与 hover 同一个入口） */
  getPartMaskGeometry: MaskGeometrySource
  max?: number
}

export interface EmbedItemOutlineApi {
  /** 重建选中集对应的 mask（`null`/空集 ⇒ 清空） */
  rebuildItemSelectionMasks: (keys: ReadonlySet<string> | null) => void
  /** 最近一次重建的命中计划（UI 提示的唯一读数；空选择 ⇒ 空计划） */
  plan: Readonly<ShallowRef<ItemOutlinePlan>>
}

export function createEmbedItemOutlineMasks(deps: EmbedItemOutlineDeps): EmbedItemOutlineApi {
  const provider = new SelectionHighlightProvider()
  const plan = shallowRef<ItemOutlinePlan>(EMPTY_ITEM_OUTLINE_PLAN)

  function rebuildItemSelectionMasks(keys: ReadonlySet<string> | null): void {
    disposeOutlineMaskMeshes(deps.masksRef.value)
    deps.masksRef.value = []

    const def = deps.definitionRef.value
    if (!keys || keys.size === 0 || !def) {
      plan.value = EMPTY_ITEM_OUTLINE_PLAN
      return
    }

    const p = planItemOutlineHits(deps.indexRef(), keys, {
      frame: deps.frameRef(),
      max: deps.max ?? OUTLINE_MASK_LIMIT,
    })
    plan.value = p

    const entities = new Set<SelectedEntity>()
    for (const ref of itemHitBlockRefs(def, p.hits)) entities.add({ kind: 'block', ref })
    if (entities.size === 0) return

    deps.masksRef.value = provider.build(
      entities,
      deps.getBlockGeometry,
      deps.gridCenterWorld,
      deps.getPartMaskGeometry,
    )
  }

  return { rebuildItemSelectionMasks, plan }
}
