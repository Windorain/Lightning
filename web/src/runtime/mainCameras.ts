import { ref, type Ref } from 'vue'
import type { View3DFeatures } from '@/viewer/viewerConfig'
import type { ViewportCameraState } from '@/runtime/viewportCamera'
import { REGION } from '@/runtime/regionIds'

/**
 * 逻辑相机槽位键（**按 region 分配，不是固定枚举**）。
 *
 * ## 为什么从固定两键改成按 region 分配（#282 P10b，Area 产品接线）
 *
 * 旧形态是 `CAMERA_KEY = { embed, workbench }` 两键，`cameraMainKeyForRegion()`
 * 把**任何**工作台 region 都映射到 `'workbench'`。在"工作台只有一个视口"时
 * 这是对的；一旦 Area 分割出**第二个 3D 视口**，两个视口会落到**同一个**
 * `cameras['workbench']` —— 于是它们共享机位。
 *
 * 而 A05 的判据原文是「**两个 3D Area 共享拖动/注解创建暂存结果，同时保持
 * 独立观察视角**」，A05 负对照是「**只让发起视口读暂存结果**」；#249 §3.4 的
 * 所有权表把「观察视角、局部显示」归 **3D 编辑器实例**（「各实例独立、切回保留」）。
 * 共享机位正是"机位不独立"这一形态 —— 它会让 A05 判红。
 *
 * ⇒ 键由 **region id** 派生：`cameras[regionId]`。这把"一个 3D 视口一份机位"
 * 从"靠调用方记得用不同 key"变成**结构事实**（键空间按 region 分）。
 *
 * ## 兼容：旧的 `'workbench'` / `'embed'` 仍是**合法键**
 *
 * 它们现在只是"那个 region 的 id 恰好等于它"的情形 —— 见
 * {@link cameraMainKeyForRegion}。故旧代码里直接写 `CAMERA_KEY.embed` 的调用点
 * 仍然工作（`REGION.EMBED === 'r-embed'` 与 `'embed'` 不同，故那里保留别名）。
 */
export type CameraMainKey = string

/** 旧的固定键别名（**保留**：`captureEmbedInitialView` 等按语义而非 region 取键）。 */
export const CAMERA_KEY = {
  embed: 'embed',
  workbench: 'workbench',
} as const

export interface EmbedPublishSettings {
  features: View3DFeatures
  viewWidth: number
  viewHeight: number
  sceneBackgroundHex: string
}

export function defaultEmbedPublish(): EmbedPublishSettings {
  return {
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
  }
}

/**
 * region → 相机键。
 *
 * ## 判据：**一个 3D 视口一份机位**（A05 / §3.4）
 *
 * 直接返回 `regionId` —— 每个视口 region 得到自己的键，于是两个 3D Area
 * 天然不共享机位。这比"给工作台分配 N 个编号键"更简单，且**不会漏**：
 * 新加一个视口 region 就自动多一份机位，不需要在任何地方登记。
 *
 * ## 为什么 `REGION.EMBED` 仍映射到 `'embed'`
 *
 * `CAMERA_KEY.embed` 被 `captureEmbedInitialView`（"抓 Wiki 预览视角写入文档"）
 * 与 `embedTouchHandler` 按**语义**引用，而 `REGION.EMBED === 'r-embed'`。
 * 若这里返回 `'r-embed'`，那些调用点会写到另一个键 ⇒ 抓取/恢复断链。
 * 保留该映射使"嵌入的相机键"稳定，且它与 `REGION.EMBED` 是**一对一**的
 * （嵌入只有一个视口），故不引入共享。
 *
 * `REGION.WIKI_PREVIEW` 同理映射到 `'embed'`：Wiki 预览就是嵌入预览
 * （同一个 `EmbedPreview` 组件、同一份语义），两者共用一份机位是**有意**的
 * —— 它们从不同时可见（`wikiPreview.visible = false` 且按工作区切换）。
 */
export function cameraMainKeyForRegion(regionId: string): CameraMainKey {
  if (regionId === REGION.EMBED) return CAMERA_KEY.embed
  if (regionId === REGION.WIKI_PREVIEW) return CAMERA_KEY.embed
  return regionId
}

/**
 * 相机存储：**按键动态分配**（不再固定两键）。
 *
 * `ensure(key)` 惰性建 `Ref` —— 于是"多出一个 3D 视口"不需要预先声明键，
 * 也不需要改这个类型。这与 `ViewportManager.register(id)` 的惰性槽位同一手法。
 *
 * 保留 `embed`/`workbench` 两个**预置**键：它们是 `CAMERA_KEY` 的语义键，
 * 且 `resetAllViewportCameras` 会遍历槽位写它们 —— 预置让"还没挂载任何视口时
 * 读 `cameras['workbench']`"仍返回一个稳定的 `Ref`（而不是 `undefined`）。
 */
export interface MainCameraStore {
  readonly cameras: Record<CameraMainKey, Ref<ViewportCameraState | null>>
  /** 取（必要时创建）某键的相机 Ref。 */
  ensure(key: CameraMainKey): Ref<ViewportCameraState | null>
  /** 当前已分配的键（稳定排序；供诊断与资源对账）。 */
  keys(): readonly CameraMainKey[]
  readonly embedInitialView: Ref<ViewportCameraState | null>
  readonly embedPublish: Ref<EmbedPublishSettings>
}

export function createMainCameraStore(): MainCameraStore {
  const cameras: Record<CameraMainKey, Ref<ViewportCameraState | null>> = {
    [CAMERA_KEY.embed]: ref(null),
    [CAMERA_KEY.workbench]: ref(null),
  }
  return {
    cameras,
    ensure(key: CameraMainKey): Ref<ViewportCameraState | null> {
      const existing = cameras[key]
      if (existing !== undefined) return existing
      const created = ref(null)
      cameras[key] = created
      return created
    },
    keys(): readonly CameraMainKey[] {
      return Object.freeze(Object.keys(cameras).sort())
    },
    embedInitialView: ref(null),
    embedPublish: ref(defaultEmbedPublish()),
  }
}
