/**
 * ResetViewOperator — 复位视角：重新适配相机到内容包围盒。
 * CopyCameraFromEmbedOperator — 从预览拷贝当前相机至 wikiConfig。
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

export const CopyCameraFromEmbedOperator: OperatorType = {
  id: 'OPERATOR_COPY_CAMERA_FROM_EMBED',
  label: '从预览拷贝当前相机',
  flagUndo: false,

  poll(bctx: any) {
    const slot = bctx.viewports.get('r-embed')
    return slot?.camera.value !== null
  },

  exec(bctx: any) {
    const slot = bctx.viewports.get('r-embed')
    const camera = slot?.camera.value as THREE.Camera | null
    const orbitTarget = slot?.orbitTarget.value as THREE.Vector3 | null
    if (!camera || !orbitTarget) return

    const px = camera.position.x - orbitTarget.x
    const py = camera.position.y - orbitTarget.y
    const pz = camera.position.z - orbitTarget.z
    const r = Math.sqrt(px * px + py * py + pz * pz)
    if (r < 1e-6) return

    const yawDeg = Math.round(THREE.MathUtils.radToDeg(Math.atan2(px, pz)))
    const phi = Math.acos(Math.max(-1, Math.min(1, py / r)))
    const elevationDeg = Math.round(90 - THREE.MathUtils.radToDeg(phi))
    const zoom = Math.round(((camera as any).zoom as number ?? 1) * 100) / 100

    const wc = bctx.wikiConfig as Record<string, any>
    wc.cameraYaw = yawDeg
    wc.cameraElevation = elevationDeg
    wc.cameraZoom = zoom
  },
}
