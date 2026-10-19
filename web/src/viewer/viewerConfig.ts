/**
 * 预览与嵌入运行时配置：场景数据、预加载材质库与 UI 默认值。
 */

import type { BlockIconCacheOptions } from '@/render/interaction/blockIconCache'
import type { RenderBundle } from '@/render/schema/types'
import type { Main } from '@/runtime/main'

export interface InitialCamera {
  yawDeg?: number
  elevationDeg?: number
  /** 相机到轨道中心的距离（世界单位）；缺省由内容包围盒自动推算 */
  distance?: number
  /** 正交相机 `OrthographicCamera.zoom`，与 OrbitControls 滚轮一致；缺省为 1 */
  zoom?: number
}

/** 功能块开关 */
export interface View3DFeatures {
  blockStatsSidebar: boolean
  layerBar: boolean
  frameControls: boolean
  titleBar: boolean
  debugStatusBar: boolean
  showAxesGizmo: boolean
  /** 标题栏「在结构工作台中打开」（需 data-wsr-feature-edit-workbench） */
  editInWorkbench?: boolean
}

export const ALL_FEATURES_OFF: View3DFeatures = {
  blockStatsSidebar: false,
  layerBar: false,
  frameControls: false,
  titleBar: false,
  debugStatusBar: false,
  showAxesGizmo: false,
  editInWorkbench: false,
}

/**
 * 预览壳（`AppShell`）唯一入口：由 `loadPreviewSessionFromDocument` / `resolveBootstrapToView3DConfig`
 * 自场景 document 生成。几何与顶栏所读**场景真源**为 `renderBundle.document`（已 normalize，与材质库同批构建）。
 */
export interface View3DConfig {
  sceneId: string
  renderBundle: RenderBundle
  features: View3DFeatures
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

/**
 * EmbedSettings — 嵌入视口的渲染配置。
 * 从 View3DConfig 拆解出渲染端所需字段，不含 renderBundle / sceneId。
 *
 * 材质库**不在**配置里（M8-5）：图标材质库由 DRW 内部按**已解码像素**装配
 * （唯一解码链 = `composition/kernelTextureResources`），旧的 `buildMaterialLibrary`
 * 第二解码链已退役。
 */
export interface EmbedSettings {
  features: View3DFeatures
  blockIconCacheOptions: BlockIconCacheOptions
  initialLayerWorldY: number
  initialWorldFrameIndex?: number
  initialCamera?: InitialCamera
  sceneBackground: number
  loadingMessage: string
  okMessage: (modelId: string) => string
  debug: boolean
  /**
   * 宿主指定的主题（P10 #261，收口 F1）。
   *
   * ## 为什么它必须进 `EmbedSettings` 而不是被 `mount()` 写进全局
   *
   * 旧 `mount()` 直接 `document.documentElement.dataset.neiTheme = theme` ——
   * 全页一份，同页两实例互相覆盖（F1）。现在它是**本实例**的初始设置，
   * 经 `createEmbedHost` → `createShellSettings({ initialTheme })` →
   * 实例根元素的 `data-lk-theme`。
   *
   * 缺省 `undefined` = "不指定，走实例偏好/宿主页属性/默认 dark 那条既有优先级"
   * —— 不是"默认 light"，也不是"默认 dark"：那两者都由 `shellSettings` 决定，
   * 本字段只表达"宿主**显式**要求了什么"。
   */
  theme?: 'light' | 'dark'
}

/** 从 View3DConfig 提取 EmbedSettings */
export function embedSettingsFromConfig(cfg: View3DConfig): EmbedSettings {
  return {
    features: cfg.features,
    blockIconCacheOptions: cfg.blockIconCacheOptions,
    initialLayerWorldY: cfg.initialLayerWorldY,
    initialWorldFrameIndex: cfg.initialWorldFrameIndex,
    initialCamera: cfg.initialCamera,
    sceneBackground: cfg.sceneBackground,
    loadingMessage: cfg.loadingMessage,
    okMessage: cfg.okMessage,
    debug: cfg.debug,
  }
}

/** Embed 契约 bootstrap → EmbedSettings */
export function buildEmbedSettingsFromBootstrap(parts: {
  ui?: {
    blockIconCacheOptions?: BlockIconCacheOptions
    initialLayerWorldY?: number
    initialWorldFrameIndex?: number
    initialCamera?: InitialCamera
    sceneBackground?: number
    loadingMessage?: string
    okMessage?: (modelId: string) => string
    debug?: boolean
    /** 宿主指定的主题（P10 #261 F1：进实例设置，不写全局）。 */
    theme?: 'light' | 'dark'
  }
  features?: Partial<View3DFeatures>
}): EmbedSettings {
  const ui = parts.ui ?? {}
  const features = parts.features ?? {}
  return {
    features: { ...defaultEmbedUi.features, ...features } as View3DFeatures,
    blockIconCacheOptions: {
      ...defaultEmbedUi.blockIconCacheOptions,
      ...ui.blockIconCacheOptions,
    },
    initialLayerWorldY: ui.initialLayerWorldY ?? defaultEmbedUi.initialLayerWorldY,
    initialWorldFrameIndex: ui.initialWorldFrameIndex,
    initialCamera: ui.initialCamera,
    sceneBackground: ui.sceneBackground ?? defaultEmbedUi.sceneBackground,
    loadingMessage: ui.loadingMessage ?? defaultEmbedUi.loadingMessage,
    okMessage: ui.okMessage ?? defaultEmbedUi.okMessage,
    debug: ui.debug ?? defaultEmbedUi.debug,
    // P10 #261（F1）：宿主显式指定的主题进**实例**设置，不再写文档根。
    ...(ui.theme === undefined ? {} : { theme: ui.theme }),
  }
}

function parseWikiSceneBackgroundHex(hex: string | undefined): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? '#5a5a5a').trim())
  if (!m) return 0x5a5a5a
  return parseInt(m[1], 16)
}

/** Workbench Wiki 预览 tab → EmbedSettings（真源 Main） */
export function buildEmbedSettingsFromMain(main: Main): EmbedSettings {
  const pub = main.embedPublish.value
  return {
    features: { ...defaultEmbedUi.features, ...pub.features },
    blockIconCacheOptions: defaultEmbedUi.blockIconCacheOptions,
    initialLayerWorldY: defaultEmbedUi.initialLayerWorldY,
    sceneBackground: parseWikiSceneBackgroundHex(pub.sceneBackgroundHex),
    loadingMessage: defaultEmbedUi.loadingMessage,
    okMessage: defaultEmbedUi.okMessage,
    debug: pub.features.debugStatusBar ?? false,
  }
}

export const defaultEmbedUi: Omit<View3DConfig, 'renderBundle' | 'sceneId'> = {
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
