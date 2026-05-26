import { ref } from 'vue'

export interface BlockHoverViewport {
  kind: 'block'
  source: 'viewport'
  blockId: string
  voxel: { column: number; row: number; zSlice: number }
  clientX: number
  clientY: number
}

export interface BlockHoverSidebar {
  kind: 'block'
  source: 'sidebar'
  blockId: string
  clientX: number
  clientY: number
}

export interface AnnotationHover {
  kind: 'annotation'
  annotationId: string
  clientX: number
  clientY: number
}

export interface MetaHover {
  kind: 'meta'
  clientX: number
  clientY: number
}

export type EmbedHover = BlockHoverViewport | BlockHoverSidebar | AnnotationHover | MetaHover

export function useEmbedHover() {
  const hover = ref<EmbedHover | null>(null)

  /** Viewport block hover (from ViewerCore hover-block event).
   *  Always creates a new object — plain objects don't trigger ref reactivity on in-place mutations. */
  function setViewportBlock(payload: {
    blockId: string; voxel: { column: number; row: number; zSlice: number }; clientX: number; clientY: number
  } | null): void {
    if (!payload) {
      if (hover.value?.kind === 'block' && hover.value.source === 'viewport') hover.value = null
      return
    }
    hover.value = { kind: 'block', source: 'viewport', ...payload }
  }

  /** Sidebar block hover (from BlockStatsSidebar tooltip-hover event) */
  function setSidebarBlock(payload: {
    blockId: string; clientX: number; clientY: number
  } | null): void {
    if (!payload) {
      if (hover.value?.kind === 'block' && hover.value.source === 'sidebar') hover.value = null
      return
    }
    hover.value = { kind: 'block', source: 'sidebar', ...payload }
  }

  /** Annotation hover (from ViewerCore hover-annotation event).
   *  Only clears if current hover is an annotation (avoids wiping block hover). */
  function setAnnotation(payload: {
    annotationId: string; clientX: number; clientY: number
  } | null): void {
    if (payload) {
      hover.value = { kind: 'annotation', ...payload }
    } else if (hover.value?.kind === 'annotation') {
      hover.value = null
    }
  }

  /** Meta hint hover (from title bar "?" icon) */
  function setMeta(payload: { clientX: number; clientY: number } | null): void {
    if (payload) {
      hover.value = { kind: 'meta', ...payload }
    } else if (hover.value?.kind === 'meta') {
      hover.value = null
    }
  }

  return { hover, setViewportBlock, setSidebarBlock, setAnnotation, setMeta }
}
