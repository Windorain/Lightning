import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { voxelKey } from '@/runtime/hoverPickKeys'

export interface ViewportBlockHover {
  blockId: string
  voxel: { column: number; row: number; zSlice: number }
  clientX: number
  clientY: number
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

/** 嵌入视口悬停分通道（挂 Screen Region.state.hover） */
export interface ViewportHoverState {
  viewportBlock: Ref<ViewportBlockHover | null>
  annotation: Ref<AnnotationHover | null>
  sidebarBlock: Ref<SidebarBlockHover | null>
  meta: Ref<MetaHover | null>
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

export function createViewportHoverState(): ViewportHoverState {
  const viewportBlock = ref<ViewportBlockHover | null>(null)
  const annotation = ref<AnnotationHover | null>(null)
  const sidebarBlock = ref<SidebarBlockHover | null>(null)
  const meta = ref<MetaHover | null>(null)

  function setViewportBlock(payload: ViewportBlockHover | null): void {
    if (!payload) {
      if (viewportBlock.value) viewportBlock.value = null
      return
    }
    const cur = viewportBlock.value
    if (cur && cur.blockId === payload.blockId && voxelKey(cur.voxel) === voxelKey(payload.voxel)) {
      cur.clientX = payload.clientX
      cur.clientY = payload.clientY
      return
    }
    viewportBlock.value = payload
    annotation.value = null
  }

  function setSidebarBlock(payload: SidebarBlockHover | null): void {
    sidebarBlock.value = payload
  }

  function setAnnotation(payload: AnnotationHover | null): void {
    if (payload) {
      annotation.value = payload
      viewportBlock.value = null
    } else if (annotation.value) {
      annotation.value = null
    }
  }

  function setMeta(payload: MetaHover | null): void {
    meta.value = payload
  }

  function clearViewport(): void {
    viewportBlock.value = null
    annotation.value = null
  }

  return {
    viewportBlock,
    annotation,
    sidebarBlock,
    meta,
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
