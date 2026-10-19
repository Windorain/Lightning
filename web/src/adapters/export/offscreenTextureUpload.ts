/**
 * `adapters/export/offscreenTextureUpload` —— **离屏设备域的纹理上传实现**（#389 R3-②；R3-1a 交付）。
 *
 * ## 它在哪个设备域里跑
 *
 * 本实现在**离屏设备自己的** `THREE.WebGLRenderer` 上建纹理并上传
 * （`renderer.initTexture`，见 `adapters/export/renderDevice` 的 `acquire`）。
 * 它**不**向实时视口索取任何 GL 资源或纹理句柄 —— 视口渲染器（
 * `render/viewport/renderViewport`）与视口纹理端口（`composition/viewportTexturePort`）
 * 都不在本文件的依赖里（闸门 `textureUploadPortCrossDevice.test.ts` 判据 B 把守）。
 *
 * ## 为什么"上传"必须是显式的 `initTexture`
 *
 * `THREE.DataTexture` 的构造只**记录**像素；真正的 `texImage2D` 发生在该纹理
 * 第一次被某个渲染器使用时。若把上传留给"渲染时顺便发生"，那么
 * "像素到底进了哪个上下文"就又一次变成隐式事实（这正是本轴要消灭的东西）。
 * ⇒ 上传点显式落在**本域**的渲染器上，`upload()` 返回即代表"已上传"。
 *
 * ## 身份与幂等
 *
 * 键是 `contentIdentityKey`（`id@version`）⇒ **内容版本变了就是另一张纹理**
 * （不允许旧纹理冒充新版本）；同一身份重复 `upload` 返回**同一句柄**，
 * 不重复建纹理、不重复上传。
 */

import * as THREE from 'three'
import { contentIdentityKey, type ContentIdentity } from '@/presentation/assetIdentity'
import type { DeviceScope } from '@/presentation/resourceCache'
import type { TexturePixels } from '@/presentation/textureBinding'
import type { TextureHandleRef, TextureUploadPort } from '@/presentation/textureUploadPort'

/**
 * 在**本设备域**的渲染器上建一个纹理上传端口。
 *
 * @param scope 本设备域（一个 GL 上下文一个）
 * @param renderer 本域自己的渲染器（**不得**传入实时视口的渲染器）
 */
export function createRendererTextureUpload(
  scope: DeviceScope,
  renderer: THREE.WebGLRenderer,
): TextureUploadPort {
  const entries = new Map<string, { readonly handle: TextureHandleRef; readonly texture: THREE.DataTexture }>()
  let disposed = false

  function build(pixels: TexturePixels, identity: ContentIdentity): THREE.DataTexture {
    // 复制一份：上传端口不持有调用方的可变缓冲（纯数据进、GPU 资源出）
    const rgba = new Uint8Array(pixels.rgba)
    const texture = new THREE.DataTexture(rgba, pixels.width, pixels.height, THREE.RGBAFormat)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.name = `${scope}:${contentIdentityKey(identity)}`
    texture.needsUpdate = true
    // 显式上传到**本域**的渲染器（不留"渲染时顺便上传"的隐式路径）
    renderer.initTexture(texture)
    return texture
  }

  return {
    scope,
    upload(pixels: TexturePixels, identity: ContentIdentity): TextureHandleRef {
      if (disposed) throw new Error('createRendererTextureUpload: disposed')
      const key = contentIdentityKey(identity)
      const existing = entries.get(key)
      if (existing !== undefined) return existing.handle
      const texture = build(pixels, identity)
      const handle: TextureHandleRef = Object.freeze({ scope, identity, resolve: () => texture })
      entries.set(key, { handle, texture })
      return handle
    },
    lookup(identity: ContentIdentity): TextureHandleRef | null {
      if (disposed) return null
      return entries.get(contentIdentityKey(identity))?.handle ?? null
    },
    release(identity: ContentIdentity): void {
      const key = contentIdentityKey(identity)
      const entry = entries.get(key)
      if (entry === undefined) return
      entries.delete(key)
      entry.texture.dispose()
    },
    dispose(): void {
      if (disposed) return // 幂等（离屏端口在四条路径上都会释放）
      disposed = true
      for (const entry of entries.values()) entry.texture.dispose()
      entries.clear()
    },
  }
}
