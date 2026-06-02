/**
 * ResetViewOperator — 复位视角：重新适配相机到内容包围盒。
 */
import type { OperatorType } from '@/operators/operatorType'
import * as THREE from 'three'
import { fitCameraToGroup } from '@/render/interaction/initialCamera'
import { resolveViewportSlot } from '@/context/bContext'

export const ResetViewOperator: OperatorType = {
  id: 'OPERATOR_RESET_VIEW',
  label: '复位视角',

  poll(bctx: any) {
    return (
      bctx.viewport.camera.value !== null &&
      bctx.viewport.contentGroup.value !== null
    )
  },

  exec(bctx: any, props?: Record<string, unknown>) {
    const vp = resolveViewportSlot(bctx, props)
    const camera = vp.camera.value as THREE.OrthographicCamera | null
    const group = vp.contentGroup.value
    const orbitTarget = vp.orbitTarget.value
    const domElement = vp.domElement.value
    if (!camera || !group || !orbitTarget || !domElement) return

    const cam = (bctx as any).initialCamera
    fitCameraToGroup(camera, group, orbitTarget, domElement, {
      yawDeg: cam?.yawDeg,
      elevationDeg: cam?.elevationDeg,
      distance: cam?.distance,
      zoom: cam?.zoom,
    })
  },
}
