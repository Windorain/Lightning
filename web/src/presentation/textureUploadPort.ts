/**
 * `presentation/textureUploadPort` —— **纹理上传端口**。
 *
 * ## 它解决什么（"纹理从哪来"这件事今天没有归属）
 *
 * 冻结的呈现面只声明"我要按**内容身份**取一张 `THREE.Texture`"
 * （{@link TexturePort}，`presentation/presenter#TexturePort`，**本次不动**）。
 * 但"谁在**哪个 GL 上下文**上把像素传上 GPU"这件事此前没有端口：
 * `composition/viewportTexturePort` 在**视口作用域**里建 `THREE.DataTexture`
 * 并依赖视口渲染器上传 —— 于是一旦离屏导出也想要贴图，唯一现成的做法就是
 * **向视口借用**纹理句柄，而那正是明文禁止的「导出改坏/借用实时视口」。
 *
 * 本模块把那一层显式化：
 *
 * | 概念 | 归属 |
 * |---|---|
 * | **像素**（`TexturePixels`，纯数据）与**内容身份**（`ContentIdentity`） | **允许**跨设备域传递 |
 * | `TextureHandleRef`（不透明句柄） | **只在**产生它的设备域内解释；跨域没有意义 |
 * | 真正的 GL 上传 | `TextureUploadPort` 的**实现者**（拥有该 GL 上下文者） |
 *
 * ⇒ **实例化者 = 拥有该 GL 上下文者**：
 * 视口侧由 `shared/viewport/useViewportRuntime` 建；离屏侧由**离屏设备工厂在
 * `acquire` 内自建**（`adapters/export/renderDevice`），**不向视口索取**任何
 * GL 资源或纹理句柄。
 *
 * ## 纯度
 *
 * 本文件**不 import three 的运行时**（只 `import type`）：它不建纹理、不碰 DOM。
 * 唯一"通向 GPU 的窄门"是 {@link TextureHandleRef.resolve} —— 它返回的是
 * **该句柄所属设备域里的** `THREE.Texture`，由持有者调用（见下）。
 *
 * ## `TextureHandleRef.resolve()` 为什么是安全的
 *
 * 句柄对象由设备域（`TextureUploadPort` 实现）构造，`resolve()` 闭包捕获的正是
 * 那个域的纹理对象 ⇒ 拿到句柄的人**已经在**该域内（因为跨域传递句柄是无意义的：
 * 另一个上下文解释不了它）。闸门 `textureUploadPortCrossDevice.test.ts` 用 AST
 * 钉死两件事：① `TextureUploadPort` 的每个方法签名只出现
 * `TexturePixels`/`ContentIdentity`/`DeviceScope`/`TextureHandleRef`；
 * ② 全文件 `THREE.Texture` 只出现在 `TextureHandleRef.resolve` 一处。
 */

import type * as THREE from 'three'
import type { ContentIdentity } from './assetIdentity'
import { contentIdentityKey } from './assetIdentity'
import type { TexturePixels, TextureResource } from './textureBinding'
import type { TexturePort } from './presenter'
import type { DeviceScope } from './resourceCache'

/**
 * **设备域内的纹理句柄**（不透明引用）。
 *
 * 它**不是**可跨域携带的资产：`scope` 记录它属于哪个设备域，
 * `resolve()` 只能由该域内的消费者（呈现会话）调用。
 *
 * 为什么返回 `THREE.Texture` 而不返回"GPU 资源句柄"：呈现层的冻结接口
 * （`TexturePort.textureFor`）就是 `THREE.Texture | null`，而 `texturePortOf`
 * 必须在**同一域内**满足它 —— 这个"窄门"因此被收进句柄本身，而不是开在新接口上。
 */
export interface TextureHandleRef {
  /** 产生该句柄的设备域（跨域传递句柄是调用方错误，不是本端口支持的用法）。 */
  readonly scope: DeviceScope
  /** 该句柄对应的内容身份（含版本 ⇒ 内容变了就是另一个句柄）。 */
  readonly identity: ContentIdentity
  /** 在**该句柄所属**的 GL 上下文里解释它；仅同域可调用。 */
  resolve(): THREE.Texture
}

/**
 * **纹理上传端口**（设备域内实现；冻结语义面）。
 *
 * 五个成员一个不少：设备域、上传、查、释放、销毁。缺任何一个都会留下空洞
 * （没有 `lookup` 就无法复用同一份像素；没有 `release` 就只能等 `dispose` 全清；
 * 没有 `scope` 就无法判断"这个句柄属于哪个上下文"）。
 */
export interface TextureUploadPort {
  /** 本上传端口所服务的设备域（一个 GL 上下文一个）。 */
  readonly scope: DeviceScope
  /**
   * 把**纯像素**传上本域的 GPU 并返回句柄。
   *
   * 幂等：同一 `ContentIdentity` 重复上传返回同一句柄（不重复建纹理、不重复上传）。
   * 参数是**纯数据**（`TexturePixels`）与**内容身份** —— 这正是允许跨设备域传递的两样东西。
   */
  upload(pixels: TexturePixels, identity: ContentIdentity): TextureHandleRef
  /** 查已上传的句柄；`null` = 该身份在本域里**尚未**上传。 */
  lookup(identity: ContentIdentity): TextureHandleRef | null
  /** 释放该身份的 GPU 纹理（释放后再 `lookup` 返回 `null`；重复释放是幂等的）。 */
  release(identity: ContentIdentity): void
  /** 释放本端口持有的全部纹理。**幂等**；销毁后再 `upload` 是**显式失败**（不静默复活）。 */
  dispose(): void
}

/**
 * 把**上传端口**装配成呈现层的冻结接口 `TexturePort`（装配函数）。
 *
 * 语义（与 `presenter#TexturePort` 的 `null` 语义逐字对齐）：
 *  - 资源 `ready` 且带像素 ⇒ 上传（幂等）并返回该域里的纹理；
 *  - 未请求/加载中/缺失/失败/无像素 ⇒ `null`（呈现侧据此**不设** `map`
 *    并累计 `missingRequiredTextures`，**不得**拿占位图顶上）；
 *  - 身份（含**版本**）不匹配 ⇒ `null`：内容换了版本就必须走新句柄，
 *    不允许"旧纹理冒充新版本"（`contentIdentityKey` 把 `id@version` 当一个键）。
 *
 * @param upload 拥有目标 GL 上下文的上传端口（**由该域自己构造**）
 * @param resources 本次装配的纹理资源表（五态链的读面；纯数据侧的事实）
 */
export function texturePortOf(
  upload: TextureUploadPort,
  resources: readonly TextureResource[],
): TexturePort {
  const ready = new Map<string, TexturePixels>()
  for (const resource of resources) {
    if (resource.state !== 'ready') continue
    const pixels = resource.pixels
    if (pixels === null) continue
    ready.set(contentIdentityKey(resource.identity), pixels)
  }

  return {
    textureFor(identity: ContentIdentity): THREE.Texture | null {
      const cached = upload.lookup(identity)
      if (cached !== null) return cached.resolve()
      const key = contentIdentityKey(identity)
      const pixels = ready.get(key)
      if (pixels === undefined) return null
      return upload.upload(pixels, identity).resolve()
    },
  }
}
