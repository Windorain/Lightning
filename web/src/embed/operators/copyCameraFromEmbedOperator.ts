import type { OperatorType } from '@/workbench/operators/operatorType'
import * as THREE from 'three'

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
