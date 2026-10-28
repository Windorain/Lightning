import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { ViewportCameraState } from '@/runtime/viewportCamera'

/** V2 `meta` 键：嵌入/读者打开时的全量初始视角（与结构 focus `initialCamera` 无关） */
export const EMBED_INITIAL_VIEW_META_KEY = 'embed_initial_view'

export type DocumentEmbedInitialView = ViewportCameraState

export function cloneViewportCameraState(s: ViewportCameraState): ViewportCameraState {
  return {
    target: { x: s.target.x, y: s.target.y, z: s.target.z },
    yawDeg: s.yawDeg,
    elevationDeg: s.elevationDeg,
    distance: s.distance,
    zoom: s.zoom,
  }
}

function isViewportCameraState(v: unknown): v is ViewportCameraState {
  if (!v || typeof v !== 'object') return false
  const o = v as ViewportCameraState
  const t = o.target
  return (
    t != null
    && typeof t.x === 'number'
    && typeof t.y === 'number'
    && typeof t.z === 'number'
    && typeof o.yawDeg === 'number'
    && typeof o.elevationDeg === 'number'
    && typeof o.distance === 'number'
    && typeof o.zoom === 'number'
  )
}

export function getDocumentEmbedInitialView(doc: RuntimeDocument | null): DocumentEmbedInitialView | null {
  if (!doc) return null
  const raw = doc.meta[EMBED_INITIAL_VIEW_META_KEY]
  if (!isViewportCameraState(raw)) return null
  return cloneViewportCameraState(raw)
}

export function setDocumentEmbedInitialView(
  doc: RuntimeDocument,
  view: DocumentEmbedInitialView | null,
): void {
  if (view == null) {
    delete doc.meta[EMBED_INITIAL_VIEW_META_KEY]
    return
  }
  doc.meta[EMBED_INITIAL_VIEW_META_KEY] = cloneViewportCameraState(view)
}

export function hasDocumentEmbedInitialView(doc: RuntimeDocument | null): boolean {
  return getDocumentEmbedInitialView(doc) != null
}

/** 将文档 meta 镜像到 Main.embedInitialView（加载/替换文档后调用） */
export function hydrateMainEmbedInitialViewFromDoc(
  main: { doc: { value: RuntimeDocument | null }; embedInitialView: { value: ViewportCameraState | null } },
): void {
  const snap = getDocumentEmbedInitialView(main.doc.value)
  main.embedInitialView.value = snap ? cloneViewportCameraState(snap) : null
}
