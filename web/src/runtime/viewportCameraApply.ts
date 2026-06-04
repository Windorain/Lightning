import * as THREE from 'three'
import type { Context } from '@/runtime/context'
import { resolveViewportSlot } from '@/runtime/context'
import { fitCameraToGroup } from '@/render/interaction/initialCamera'
import type { CameraMainKey } from '@/runtime/mainCameras'
import {
  captureViewportCamera,
  hasExplicitExternalCamera,
  resolveInitialViewportCamera,
} from '@/runtime/viewportCamera'

/** INIT / RESET：有外界初始则恢复 preset；否则 fit 结构 + 默认等轴 */
export function applyViewportCameraFromMainInitial(
  ctx: Context,
  props?: Record<string, unknown>,
): void {
  const vp = resolveViewportSlot(ctx, props)
  const key: CameraMainKey = vp.cameraMainKey
  const external = ctx.main.initialCameras[key].value
  const def = vp.definition.value
  const camRef = ctx.main.cameras[key]

  if (hasExplicitExternalCamera(external)) {
    camRef.value = resolveInitialViewportCamera({ external, definition: def })
    return
  }

  const group = vp.contentGroup.value
  const camera = vp.camera.value
  const orbit = vp.orbitTarget.value
  const dom = vp.domElement.value
  if (!group || !camera || !orbit || !dom) {
    camRef.value = resolveInitialViewportCamera({ external, definition: def })
    return
  }

  const preset = resolveInitialViewportCamera({ external, definition: def })
  fitCameraToGroup(
    camera as THREE.OrthographicCamera,
    group,
    orbit,
    dom,
    {
      yawDeg: preset.yawDeg,
      elevationDeg: preset.elevationDeg,
      distance: preset.distance,
      zoom: preset.zoom,
    },
  )
  camRef.value = captureViewportCamera(camera, orbit) ?? preset
}
