/**
 * ResetViewOperator — 复位视角：重新适配相机到内容包围盒。
 */
import type { OperatorType } from '@/workbench/operators/operatorType'
import * as THREE from 'three'
import {
  applyDiagonalOrbitView,
  STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
} from '@/render/interaction/initialCamera'
import { resolveViewportSlot } from '@/workbench/context/bContext'

const ORTHO_FRUSTUM_REF_HALF_FOV_DEG = 25

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
    if (!camera || !group || !orbitTarget) return

    group.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(group)
    if (box.isEmpty() || !Number.isFinite(box.min.x)) return

    const center = new THREE.Vector3()
    const size = new THREE.Vector3()
    box.getCenter(center)
    box.getSize(size)

    const maxDim = Math.max(size.x, size.y, size.z, 0.1)
    const dist = Math.max(8, maxDim * 2.2)

    const cam = (bctx as any).initialCamera
    const finalDist = cam?.distance ?? dist

    orbitTarget.copy(center)
    applyDiagonalOrbitView(camera, orbitTarget, {
      yawDeg: cam?.yawDeg ?? 225,
      elevationFromHorizontalDeg:
        cam?.elevationDeg ?? STANDARD_ISOMETRIC_ELEVATION_FROM_HORIZONTAL_DEG,
      distance: finalDist,
    })

    const orthoHeight =
      2 *
      Math.abs(finalDist) *
      Math.tan(THREE.MathUtils.degToRad(ORTHO_FRUSTUM_REF_HALF_FOV_DEG))
    const dom = vp.domElement.value
    if (dom) {
      const aspect = dom.clientWidth / Math.max(dom.clientHeight, 1)
      const halfH = orthoHeight / 2
      camera.top = halfH
      camera.bottom = -halfH
      camera.left = -halfH * aspect
      camera.right = halfH * aspect
    }
    camera.zoom =
      typeof cam?.zoom === 'number' && cam.zoom > 0 ? cam.zoom : 1
    camera.updateProjectionMatrix()
  },
}
