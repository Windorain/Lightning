import { reactive } from 'vue'

export const wikiConfig = reactive({
  features: {
    titleBar: true,
    blockStatsSidebar: true,
    frameControls: true,
    layerBar: true,
    debugStatusBar: true,
    showAxesGizmo: true,
  },
  viewWidth: 800,
  viewHeight: 600,
  sceneBackgroundHex: '#5a5a5a',
  iconSizePx: 128,
  iconOrthoHalf: 0.85,
  cameraYaw: 225,
  cameraElevation: 35,
  /** 与视口滚轮相同：正交相机 zoom，1 = 默认 */
  cameraZoom: 1,
})
