/**
 * ResetViewOperator — 复位视角：重新适配相机到内容包围盒。
 * CopyCameraFromEmbedOperator — 从预览拷贝当前相机至 wikiConfig。
 */
import type { OperatorType } from '@/workbench/operators/operatorType'
import * as THREE from 'three'
import { fitCameraToGroup } from '@/render/interaction/initialCamera'
import { resolveViewportSlot } from '@/workbench/context/bContext'
import { cameraToSpherical } from '@/pure/camera'

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

    const result = cameraToSpherical(
      { position: camera.position, zoom: (camera as any).zoom as number | undefined },
      { x: orbitTarget.x, y: orbitTarget.y, z: orbitTarget.z },
    )
    if (!result) return

    const wc = bctx.wikiConfig as Record<string, any>
    wc.cameraYaw = result.yawDeg
    wc.cameraElevation = result.elevationDeg
    wc.cameraZoom = result.zoom
  },
}
