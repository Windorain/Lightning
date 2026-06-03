import { reactive } from 'vue'

export function defaultWikiConfig(): Record<string, unknown> {
  return reactive({
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
    cameraYaw: 225,
    cameraElevation: 35,
    cameraZoom: 1,
  })
}
