import * as THREE from 'three'
import type { DrwAnnotationApi } from '@/runtime/drwMeshPipeline'
import { type Annotation, annotationIsOnLayer } from '@/render/data/annotationTypes'

const _annoState = new Map<string, { group: THREE.Group | null; hash: string; pending: boolean }>()

function _getAnnoState(viewportId: string): { group: THREE.Group | null; hash: string; pending: boolean } {
  let s = _annoState.get(viewportId)
  if (!s) {
    s = { group: null, hash: '', pending: false }
    _annoState.set(viewportId, s)
  }
  return s
}

import type { Context } from '@/runtime/context'

export function updateAnnotationOverlay(
  ctx: Context,
  regionId: string,
  drw: DrwAnnotationApi,
  showAnnotationsGate?: boolean,
): void {
  const doc = ctx.getDoc().value
  if (!doc) return
  let annos = (doc.annotations ?? []) as Annotation[]

  const mode = drw.computed.layerPreviewMode.value
  if (mode !== 'all') {
    const gh = drw.computed.gridHeight.value
    annos = annos.filter(a => annotationIsOnLayer(a, mode.worldY, gh))
  }

  const maxUpdated = annos.length > 0
    ? annos.reduce((max, a) => Math.max(max, a.updated_at), 0)
    : 0
  const layerKey = mode === 'all' ? 'all' : `l${mode.worldY}`
  const hash = annos.length > 0 ? `${layerKey}_${annos.length}_${maxUpdated}` : 'empty'

  const slot = ctx.viewports.get(regionId)
  if (!slot) return
  const s = _getAnnoState(regionId)
  if (hash === s.hash || s.pending) return
  s.hash = hash
  s.pending = true

  drw.rebuildAnnotationOverlay(annos).then(group => {
    const s2 = _getAnnoState(regionId)
    s2.pending = false
    if (s2.group) {
      slot.overlayGroup.value?.remove(s2.group)
      s2.group.traverse((c) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
          c.geometry?.dispose()
          ;(c.material as THREE.Material)?.dispose()
        }
      })
      s2.group = null
    }
    if (group) {
      s2.group = group
      if (showAnnotationsGate ?? true) {
        slot.overlayGroup.value?.add(s2.group)
      }
    }
  }).catch(() => {
    _getAnnoState(regionId).pending = false
  })
}

export function disposeAnnotationOverlay(viewportId: string): void {
  const s = _annoState.get(viewportId)
  if (!s) return
  if (s.group) {
    s.group.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
        c.geometry?.dispose()
        ;(c.material as THREE.Material)?.dispose()
      }
    })
  }
  _annoState.delete(viewportId)
}

export function getAnnotationOverlayGroup(viewportId: string): THREE.Group | null {
  return _annoState.get(viewportId)?.group ?? null
}
