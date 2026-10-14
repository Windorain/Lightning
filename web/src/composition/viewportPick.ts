/**
 * `composition/viewportPick` —— **视口拾取的内核链装配**（R1-β① C8 第 2 项；#387 7298）。
 *
 * ## 它替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 射线打 `vpSlot.contentGroup`（legacy `blockMesh`），从 `mesh.userData.triangleMap` 解格 | `render/interaction/scenePick#pickAtPointer` | 射线打**内核批次对象**（`PresenterSession` 持有的批次），`batchHitOf` → `PickIndex.resolve` 解出对象/元素/**格**身份 |
 * | 注解命中靠 Mesh 名 `anno-<type>-<id>` 与 AABB 两条通道 | 同上 | 同两条通道，但来源是**内核呈现产物**（`PresenterSession` 的注解子树 + 内核注解读面） |
 *
 * ## 为什么必须与画面同批切换（执行者实测的硬耦合）
 *
 * 画面切到内核呈现后，`contentGroup` 下的 Mesh **不再挂** `userData.triangleMap`
 * ⇒ 旧拾取"仍然命中、但一格都解不出" ⇒ 点选**静默失效**（没有任何断言会响）。
 * 故本模块与画面切换同批落地，并由 `e2e/p10e-presenter-live.spec.ts` 的
 * 生产入口判据（真实工作台 + 真实指针）把守。
 *
 * ## 分层
 *
 * `composition/` 是装配根：#249 §4 允许它 import 全部层。本模块把
 * 「内核求值产物（Presenterside） + 内核读面（网格/注解）」合成**一个**拾取入口，
 * 于是"谁解出的这一格"只有一个答案。判定规则（哪些命中可解、分层预览下的空气语义、
 * 去重键）**不在**这里：格解算在 `presentation/pickingIndex`，逐格键到 `blockId`
 * 的映射在 `composition/kernelPickAdapter`（两者都已有判据）。
 */

import * as THREE from 'three'
import type { KernelGridView } from '@/runtime/gridRead'

import type { KernelAnnotationView } from '@/runtime/annotationRead'
import { annotationObjectIdOf } from '@/runtime/annotationRead'
import type { PresenterSession } from '@/composition/presenterSession'
import { kernelPickBlockOf, kernelPickEntitiesOf } from '@/composition/kernelPickAdapter'
import {
  asAnnotationShape,
  isPickableBox,
  rayIntersectsBox,
  type PickAnnotation,
  type PickBlock,
  type PickEntity,
  type PickResult,
} from '@/presentation/pickResult'
import type { AnnotationShape } from '@/presentation/annotationPlan'

/**
 * 分层预览形状（**从消费端签名派生**，不是 import 深路径类型）。
 *
 * `LayerPreviewMode` 定义在 `render/data/layerPreview`（旧层、深度 3）——
 * 装配根 import 它会被 `gate/no-private-cross-layer` 判红（公共出口最大深度 2）。
 * 派生写法与 `kernelPresentationInputs#GridDefinition` 同一纪律：形状由**使用点**给出，
 * 形状变了这里编译不过（不是靠人记得同步）。
 */
type LayerPreviewMode = Parameters<typeof kernelPickBlockOf>[0]['layerPreview']

/** `worldY: number | null`（`null` = 不分层）→ legacy 的分层模式。 */
function layerModeOf(input: ViewportPickInput): LayerPreviewMode {
  return input.layerWorldY === null ? 'all' : { worldY: input.layerWorldY }
}
export interface ViewportPickInput {
  /** 呈现会话（批次 + 注解的唯一产出者）。 */
  readonly surface: PresenterSession
  readonly camera: THREE.Camera
  /** 屏幕归一化设备坐标（由调用方按 DOM 矩形换算）。 */
  readonly ndc: THREE.Vector2
  /** 内核网格读面（逐格身份 → `blockId`；缺席 ⇒ 无法解出方块）。 */
  readonly grid: KernelGridView
  readonly layerWorldY: number | null
  /** 内核注解读面（盒拾取的 `min`/`max` 与身份）。 */
  readonly annotations: readonly KernelAnnotationView[]
}

/**
 * 单次拾取（最近的一个：注解与方块按距离裁决）。
 *
 * ## 裁决口径与 legacy **逐字相同**
 *
 * `PICK_BIAS = 0.005`：注解与方块的命中距离差在此以内时判注解优先
 * （`scenePick.ts:271-275` 的原口径）。这不是新政策，是**既有行为的搬移** ——
 * 改它会改变"点在盒注解边界上选中谁"的可感知结果。
 *
 * ## `stale`（A12）的处置
 *
 * `PresenterSession.pickAt` 在"显示版本 ≠ 当前求值键"时返回 `stale`
 * （过期画面上**不得**给出新候选）。此时本函数返回 `null`（= 本次拾取无结果），
 * **不**回落到过期批次 —— 那正是 A12 要防的"新旧混用"。
 */
export function pickInViewport(input: ViewportPickInput): PickResult {
  const raycaster = raycasterOf(input.camera, input.ndc)
  const layerPreview = layerModeOf(input)
  const annotation = nearestAnnotation(input, raycaster)
  const hit = input.surface.pickAt(raycaster)

  let block: PickBlock | null = null
  if (hit.kind === 'hit') {
    const out = kernelPickBlockOf({
      resolution: hit.resolution,
      point: hit.point,
      distance: hit.distance,
      grid: input.grid,
      layerPreview,
    })
    if (out.ok) block = out.block
  }

  const blockDist = block === null ? Infinity : block.distance
  const annoDist = annotation === null ? Infinity : annotation.distance
  if (annotation !== null && annoDist <= blockDist + PICK_BIAS) return annotation
  return block
}

/**
 * 轮换拾取（一条射线上的**全部**候选，去重后按距离升序）。
 *
 * 方块走 `kernelPickEntitiesOf`（与单次拾取**同一份**批次映射，
 * 去重键 `column,row,zSlice`）；注解走本模块的注解通道。
 * 两路合并后**重新排序**：legacy 的 `scenePickAllFromPointer` 也是先各自收集再统一排序。
 */
export function pickAllInViewport(input: ViewportPickInput): readonly PickEntity[] {
  const raycaster = raycasterOf(input.camera, input.ndc)
  const layerPreview = layerModeOf(input)
  const all = input.surface.pickAllAt(raycaster)
  const blocks: readonly PickEntity[] =
    all.kind === 'hits'
      ? kernelPickEntitiesOf({ hits: all.hits, grid: input.grid, layerPreview })
      : []

  const out: PickEntity[] = [...blocks]
  const seenAnnotations = new Set<string>()
  for (const a of annotationCandidates(input, raycaster)) {
    if (seenAnnotations.has(a.annotationId)) continue
    seenAnnotations.add(a.annotationId)
    out.push(
      Object.freeze({
        kind: 'annotation' as const,
        distance: a.distance,
        annotationId: a.annotationId,
        annotationType: annotationTypeOf(input, a.annotationId),
        point: a.point,
      }),
    )
  }
  out.sort((x, y) => x.distance - y.distance)
  return Object.freeze(out)
}

/** 与 legacy 同一偏置（注解在距离差 ≤ 该值时优先）。 */
const PICK_BIAS = 0.005

/**
 * 注解候选（**两条通道**，与 legacy 一一对应）。
 *
 * 1. **AABB**（盒注解）：用内核注解读面的 `min`/`max` 直接求交 ——
 *    与"注解网格是否在场"无关（`fillOpacity: 0` 时 overlay 不产填充面，
 *    而此时盒仍必须可拾取）；
 * 2. **注解子树**（非盒类型 point/line/text/face）：射线打
 *    `PresenterSession` 的注解子树，按 `userData.objectId` 解内核身份，
 *    再经内核注解读面换成**裸 legacy id**（`annotation:` 前缀是内核承载，
 *    面板/选中集用的是裸 id，故边界处必须反向映射 —— 就是这里）。
 *
 * ⚠️ **盒注解的网格命中被丢弃**（`shape === 'box' → continue`）：
 * 与 legacy 的 `meshIsBoxAnno ⇒ effAnnoMesh = null` 同一处置（盒的身份由
 * AABB 通道给出，否则同一盒会出现两个带不同 `point` 的候选）。
 */
function annotationCandidates(input: ViewportPickInput, raycaster: THREE.Raycaster): readonly PickAnnotation[] {
  const byObjectId = new Map<string, KernelAnnotationView>()
  for (const v of input.annotations) byObjectId.set(annotationObjectIdOf(v.id), v)

  const out: PickAnnotation[] = []
  for (const v of input.annotations) {
    if (!isPickableBox(v)) continue
    const d = rayIntersectsBox(raycaster.ray.origin, raycaster.ray.direction, v.min, v.max)
    if (d === null) continue
    out.push(Object.freeze({ kind: 'annotation', annotationId: v.id, distance: d, point: ZERO_POINT }))
  }

  for (const h of input.surface.pickAnnotationsAt(raycaster)) {
    const view = byObjectId.get(h.objectId)
    // 解不出内核身份的命中**跳过**（不猜 id）：它是"内核里没有这条注解"的事实，
    // 而猜一个 id 会让选中集指向不存在的对象（静默错选）。
    if (view === undefined) continue
    if (view.type === 'box') continue
    out.push(
      Object.freeze({
        kind: 'annotation',
        annotationId: view.id,
        distance: h.distance,
        point: { x: h.point[0], y: h.point[1], z: h.point[2] },
      }),
    )
  }
  out.sort((a, b) => a.distance - b.distance)
  return out
}

/** 注解形状（`pickAll` 的 `annotationType` 口径；面板选中集需要它）。 */
function annotationTypeOf(input: ViewportPickInput, annotationId: string): AnnotationShape | undefined {
  for (const v of input.annotations) {
    if (v.id !== annotationId) continue
    const shape = asAnnotationShape(v.type)
    // 形状不认识 ⇒ 不猜（`undefined` 让调用方按"无法构造选中实体"处理，
    // 而不是把一个非法形状塞进 `SelectedEntity`）。
    return shape ?? undefined
  }
  return undefined
}

/** 最近的一个注解（候选已按距离升序）。 */
function nearestAnnotation(input: ViewportPickInput, raycaster: THREE.Raycaster): PickAnnotation | null {
  const all = annotationCandidates(input, raycaster)
  return all.length === 0 ? null : all[0]!
}

function raycasterOf(camera: THREE.Camera, ndc: THREE.Vector2): THREE.Raycaster {
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(ndc, camera)
  return raycaster
}

/** legacy `pickAtPointer` 在 AABB 分支给的 `point` 同样是零点（逐字搬移，勿"顺手修好"）。 */
const ZERO_POINT = Object.freeze({ x: 0, y: 0, z: 0 })
