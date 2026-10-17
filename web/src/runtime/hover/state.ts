import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { voxelKey } from '@/runtime/hover/pickKeys'
import type { PartTooltipInfo } from '@/pure/tooltipResolution'

export interface ViewportBlockHover {
  blockId: string
  voxel: { column: number; row: number; zSlice: number }
  clientX: number
  clientY: number
  /**
   * 部件命中快照（P2.2）：命中格有部件且命中点落入部件盒时非空；
   * null/缺省 = 宿主格命中（既有行为）。tooltip 为导出时生成完毕的最终行（契约 §8）。
   */
  part?: PartTooltipInfo | null
}

export interface SidebarBlockHover {
  blockId: string
  clientX: number
  clientY: number
}

export interface AnnotationHover {
  annotationId: string
  clientX: number
  clientY: number
}

export interface MetaHover {
  clientX: number
  clientY: number
}

/**
 * **屏幕级悬停时钟**（M4-1 双区归属）。
 *
 * ## 为什么需要它（而不是每个 region 自己数）
 *
 * "全域单例读面该读哪一个 region 的悬停"必须先能回答**谁更近**。
 * 每个 region 自己维护一个自增计数器是**不可比**的（A 的 5 与 B 的 3 推不出先后），
 * 故计数器归**屏幕**：每次写入都从同一个时钟取下一个序号，各 region 只记录
 * "我上次写入时取到的是几"。于是跨 region 的比较成立，且比较本身仍是纯读。
 *
 * ## 它还承担"唤醒"职责
 *
 * 读面（见 `runtime/hover/access#createScreenHoverBlockRef`）在计算时读
 * `tick`：任何 region 的悬停写入（含 `screenRoot.reindex()` 的 region 增删）
 * 都会让读面失效并重算。否则"新登记的第二区第一次悬停"不会触发已算过的读面
 * （Vue computed 只订阅它**上次读过的**依赖）。
 */
export interface HoverClock {
  /** 单调递增的写入序号（读面靠它唤醒）。 */
  readonly tick: Ref<number>
  /** 取下一个序号（写入方调用；会推进 `tick`）。 */
  next(): number
}

export function createHoverClock(): HoverClock {
  const tick = ref(0)
  return {
    tick,
    next: () => {
      tick.value += 1
      return tick.value
    },
  }
}

/** 嵌入视口悬停分通道（挂 Screen Region.state.hover） */
export interface ViewportHoverState {
  viewportBlock: Ref<ViewportBlockHover | null>
  annotation: Ref<AnnotationHover | null>
  sidebarBlock: Ref<SidebarBlockHover | null>
  meta: Ref<MetaHover | null>
  /**
   * 本 region **最近一次悬停写入**在屏幕时钟上的序号（M4-1）。
   *
   * 0 = 从未写入。跨 region 比较它即得"谁最近悬停过"（见 `access#createScreenHoverBlockRef`）。
   */
  readonly revision: Ref<number>
  setViewportBlock(payload: ViewportBlockHover | null): void
  setSidebarBlock(payload: SidebarBlockHover | null): void
  setAnnotation(payload: AnnotationHover | null): void
  setMeta(payload: MetaHover | null): void
  clearViewport(): void
}

export type EmbedHover =
  | ({ kind: 'block'; source: 'viewport' } & ViewportBlockHover)
  | ({ kind: 'block'; source: 'sidebar' } & SidebarBlockHover)
  | ({ kind: 'annotation' } & AnnotationHover)
  | ({ kind: 'meta' } & MetaHover)

export function createViewportHoverState(
  /**
   * 屏幕级悬停时钟（M4-1）。缺省**自建**一个，于是"单独造一个悬停状态"的
   * 既有用法逐字不变；装配期（`runtime/screenRoot`）会把**屏幕的那一只**传进来，
   * 使同屏各 region 的写入序号可比。
   */
  clock: HoverClock = createHoverClock(),
): ViewportHoverState {
  const viewportBlock = ref<ViewportBlockHover | null>(null)
  const annotation = ref<AnnotationHover | null>(null)
  const sidebarBlock = ref<SidebarBlockHover | null>(null)
  const meta = ref<MetaHover | null>(null)
  /** 本 region 最近一次写入的时钟序号（跨 region 决胜用）。 */
  const revision = ref(0)

  function touch(): void {
    revision.value = clock.next()
  }

  function setViewportBlock(payload: ViewportBlockHover | null): void {
    if (!payload) {
      if (viewportBlock.value) {
        viewportBlock.value = null
        touch()
      }
      return
    }
    const cur = viewportBlock.value
    if (
      cur
      && cur.blockId === payload.blockId
      && voxelKey(cur.voxel) === voxelKey(payload.voxel)
      && (cur.part?.localId ?? null) === (payload.part?.localId ?? null)
    ) {
      cur.clientX = payload.clientX
      cur.clientY = payload.clientY
      // 同一目标上的持续移动**也算**一次写入：否则"离开 → 回到同一格"时
      // 本区停留在一个更旧的序号上，全域读面会继续报另一个区的悬停。
      touch()
      return
    }
    viewportBlock.value = payload
    annotation.value = null
    touch()
  }

  function setSidebarBlock(payload: SidebarBlockHover | null): void {
    sidebarBlock.value = payload
    if (payload) touch()
  }

  function setAnnotation(payload: AnnotationHover | null): void {
    if (!payload) {
      if (annotation.value) {
        annotation.value = null
        touch()
      }
      return
    }
    const cur = annotation.value
    if (cur && cur.annotationId === payload.annotationId) {
      cur.clientX = payload.clientX
      cur.clientY = payload.clientY
      touch()
      return
    }
    annotation.value = payload
    viewportBlock.value = null
    touch()
  }

  function setMeta(payload: MetaHover | null): void {
    meta.value = payload
    if (payload) touch()
  }

  function clearViewport(): void {
    viewportBlock.value = null
    annotation.value = null
    touch()
  }

  return {
    viewportBlock,
    annotation,
    sidebarBlock,
    meta,
    revision,
    setViewportBlock,
    setSidebarBlock,
    setAnnotation,
    setMeta,
    clearViewport,
  }
}

/** 供 tooltip 使用的联合悬停视图（优先级：meta > annotation > viewport > sidebar） */
export function embedHoverFromState(hover: ViewportHoverState): ComputedRef<EmbedHover | null> {
  return computed(() => {
    if (hover.meta.value) return { kind: 'meta', ...hover.meta.value }
    if (hover.annotation.value) return { kind: 'annotation', ...hover.annotation.value }
    if (hover.viewportBlock.value) {
      return { kind: 'block', source: 'viewport', ...hover.viewportBlock.value }
    }
    if (hover.sidebarBlock.value) {
      return { kind: 'block', source: 'sidebar', ...hover.sidebarBlock.value }
    }
    return null
  })
}

export function requireViewportHover(regionState: { hover?: ViewportHoverState }): ViewportHoverState {
  const h = regionState.hover
  if (!h) throw new Error('region.state.hover missing')
  return h
}
