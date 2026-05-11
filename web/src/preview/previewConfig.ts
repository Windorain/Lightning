/**
 * 预览与嵌入运行时配置：场景数据、预加载材质库与 UI 默认值。
 */

import type { BlockIconCacheOptions } from '@/render/interaction/blockIconCache'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { RenderBundle } from '@/render/schema/types'

export interface InitialCamera {
  yawDeg?: number
  elevationDeg?: number
  /** 相机到轨道中心的距离（世界单位）；缺省由内容包围盒自动推算 */
  distance?: number
  /** 正交相机 `OrthographicCamera.zoom`，与 OrbitControls 滚轮一致；缺省为 1 */
  zoom?: number
}

/** 功能块开关 */
export interface PreviewFeatures {
  blockStatsSidebar: boolean
  layerBar: boolean
  frameControls: boolean
  titleBar: boolean
  debugStatusBar: boolean
  showAxesGizmo: boolean
}

export const ALL_FEATURES_OFF: PreviewFeatures = {
  blockStatsSidebar: false,
  layerBar: false,
  frameControls: false,
  titleBar: false,
  debugStatusBar: false,
  showAxesGizmo: false,
}

/**
 * 预览壳（`AppShell`）唯一入口：由 `loadPreviewSessionFromDocument` / `resolveBootstrapToPreviewConfig`
 * 自场景 document 生成。几何与顶栏所读**场景真源**为 `renderBundle.document`（已 normalize，与材质库同批构建）。
 */
export interface PreviewConfig {
  sceneId: string
  renderBundle: RenderBundle
  materialLibrary: MaterialLibraryApi
  features: PreviewFeatures
  blockIconCacheOptions: BlockIconCacheOptions
  initialLayerWorldY: number
  /** World 文档时：首次加载要展示的 `frames` 下标；缺省按文档 `playback` 解析 */
  initialWorldFrameIndex?: number
  /** 初始摄像头位置；缺省为等轴视角 (yaw=225°, elevation=35.26°) */
  initialCamera?: InitialCamera
  sceneBackground: number
  loadingMessage: string
  okMessage: (modelId: string) => string
  /** 为 false 时隐藏底部调试状态栏 */
  debug: boolean
}

export const defaultEmbedUi: Omit<PreviewConfig, 'renderBundle' | 'materialLibrary' | 'sceneId'> = {
  features: {
    blockStatsSidebar: false,
    layerBar: false,
    frameControls: false,
    titleBar: false,
    debugStatusBar: false,
    showAxesGizmo: false,
  },
  blockIconCacheOptions: {
    sizePx: 128,
    orthoHalf: 0.85,
    clearColor: 0x000000,
    clearAlpha: 0,
  },
  initialLayerWorldY: -1,
  sceneBackground: 0x5a5a5a,
  loadingMessage: '正在加载数据与构建网格…',
  okMessage: () => '',
  debug: false,
}
