/**
 * CopyCameraFromEmbedOperator — 从预览拷贝当前相机至 wikiConfig。
 */
import type { OperatorType } from '@/operators/operatorType'
import * as THREE from 'three'
import { cameraToSpherical } from '@/pure/camera'

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
