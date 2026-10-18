/**
 * `composition/viewportTexturePort` —— **`TexturePort` 的生产实现**（#301 P10f D3 的材质统一落点）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 材质库**自己**解码并持有 `THREE.Texture`，视口拿不到"哪张缺了" | `render/data/buildMaterialLibrary.ts`（`Promise.all` 整库 reject；**M8-5 已删除**，现为 `render/data/materialLibraryFromTextures`） | 呈现层按**内容身份**取纹理（`TexturePort.textureFor`），资源五态由 `composition/kernelTextureResources` 判定；本模块只做「已解码像素 → GPU 纹理」的持有与生命周期 |
 *
 * ## 为什么需要它（接缝 `presenter-surface-dual-track` 的「材质统一」前置）
 *
 * `presentation/presenter.ts:93` 声明了 `TexturePort`，`composition/presenterSession`
 * 是它**唯一**的生产消费者 —— 但**全树没有实现**。后果是具体的：呈现会话
 * `applyKernelDocument` 时 `textures === undefined` ⇒ `createMaterial` 的
 * `params.map` **永不设置**（`presenter.ts:789` 的 `textures !== undefined` 短路）
 * ⇒ 画面只有中性色/顶点色，**比 legacy 渲染链平**。那是可感知回退（#171 禁止），
 * 也正是"画面终切"至今被阻塞的实质原因。
 *
 * 本模块补上那一半：把**已解码的像素**变成 GPU 纹理，并按内容身份服务
 * `textureFor(identity)`。解码本身仍是**适配器**的职责（`TextureDecoder`），
 * 故本模块不碰 DOM/IO，可被单测直接驱动。
 *
 * ## 为什么它必须是**有状态**的（而不是每次现建一张纹理）
 *
 * `BatchedPresenter` 在每次重编时按 `binding.map` 问端口要纹理。若每次都新建
 * `THREE.DataTexture`，那么"换一帧"会把同一张纹理重新上传 —— 而 `Texture` 的
 * GPU 句柄**不会**被自动回收（`dispose()` 必须显式调）。实测形态就是
 * **每帧泄漏一张纹理**，直到上下文丢失。故：
 *
 *  - 同**内容身份**（`id@version`）⇒ 复用**同一张** `Texture`（不重传）；
 *  - 身份从资源表消失 ⇒ **prune 并 `dispose()`**（A19：不得泄漏 GPU 份额）；
 *  - `dispose()` 之后不得复活（`sync`/`textureFor` 一律答"不可用"，不静默重建）。
 *
 * ## 分层
 *
 * `composition/` 是装配根（可 import 全部层 + three）。本模块**不做判定**：
 * 哪条资源什么状态由 `composition/kernelTextureResources` 算（五态），
 * 这里只执行"上传/复用/清理"。
 */

import * as THREE from 'three'
import type { TexturePort } from '@/presentation/presenter'
import type { ContentIdentity } from '@/presentation/assetIdentity'
import type { TextureResource } from '@/presentation/textureBinding'

/** 内容身份的稳定键（`id` + `version`；两者都进键 —— 只取 `id` 会让"换了字节"复用旧纹理）。 */
function identityKey(identity: ContentIdentity): string {
  return `${identity.id}@${identity.version}`
}

/** 一次 `sync` 的结果（**显式**报告，不静默）。 */
export interface TextureSyncOutcome {
  /** 本次真实上传的纹理数（复用不计）。 */
  readonly uploaded: number
  /** 本次被清理并释放的纹理数（A19 的资源释放证据）。 */
  readonly released: number
  /** 当前就绪并存活的纹理数。 */
  readonly ready: number
  /** 资源表里**已就绪但无像素**的条目数（那是实现缺陷，不该出现；观测它而不是忽略）。 */
  readonly readyWithoutPixels: number
}

export interface ViewportTexturePort extends TexturePort {
  /**
   * 用当前**资源表**刷新纹理（幂等：同一身份不重传）。
   *
   * 纯执行：调用方负责先用 `textureResourcesOf` 判出五态。
   */
  sync(resources: readonly TextureResource[]): TextureSyncOutcome
  /** 全部释放并**不复活**（文档卸载/视口销毁）。 */
  dispose(): void
  /** 释放全部纹理但**可继续用**（换文档：新文档的资源会重新上传）。 */
  clear(): void
  /**
   * **放弃**全部纹理（WebGL 设备丢失：旧代次的 GPU 句柄已不可用）。
   *
   * 与 `clear()` 的差别只在**是否逐张 dispose**：丢失后 GL 句柄属于失效上下文，
   * `texture.dispose()` 只会向死上下文发删除命令（错误日志、无收益）。
   * 与 `OwnershipRegistry#abandonAll` 同口径：**放弃 ≠ 正常回收**。
   * 返回被放弃的纹理数（诊断关联字段）。
   */
  abandon(): number
  /** 存活纹理数（观测面）。 */
  readonly size: number
}

/**
 * 造一个视口作用域的纹理端口。
 *
 * @param scope 设备作用域（诊断用；与 `PresenterSession` 同一 `scope` 口径）
 */
export function createViewportTexturePort(scope: string): ViewportTexturePort {
  const byKey = new Map<string, { readonly identity: ContentIdentity; readonly texture: THREE.Texture }>()
  let disposed = false
  // 作用域只用于**诊断归属**（`Texture` 自带 `name`，排障时能看出是哪张、属于谁）。
  // 它不参与身份/键 —— 纹理身份是内容身份，与设备作用域无关（同一份字节两个视口
  // 各持一张 GPU 纹理，那是 A19"关其一不破坏另一方"的要求）。
  const nameFor = (identity: ContentIdentity): string => `${scope}:${identity.id}`

  const releaseAll = (): number => {
    let n = 0
    for (const entry of byKey.values()) {
      entry.texture.dispose()
      n += 1
    }
    byKey.clear()
    return n
  }

  return {
    get size(): number {
      return byKey.size
    },

    textureFor(identity: ContentIdentity): THREE.Texture | null {
      if (disposed) return null
      return byKey.get(identityKey(identity))?.texture ?? null
    },

    sync(resources: readonly TextureResource[]): TextureSyncOutcome {
      if (disposed) {
        return Object.freeze({ uploaded: 0, released: 0, ready: 0, readyWithoutPixels: 0 })
      }
      const kept = new Set<string>()
      let uploaded = 0
      let readyWithoutPixels = 0

      for (const r of resources) {
        if (r.state !== 'ready') continue
        const key = identityKey(r.identity)
        kept.add(key)
        if (byKey.has(key)) continue // 同一身份 ⇒ 复用（不重传）
        if (r.pixels === null) {
          // 就绪却没有像素：契约说 `state === 'ready'` ⇒ `pixels !== null`。
          // 这个分支**不是**合法缺省 —— 它是实现缺陷，计数上报而不伪造一张纹理。
          readyWithoutPixels += 1
          continue
        }
        byKey.set(key, { identity: r.identity, texture: textureOfPixels(r.pixels, nameFor(r.identity)) })
        uploaded += 1
      }

      // 清理：身份不在当前资源表里 ⇒ 释放（否则换文档/换帧会累积 GPU 句柄）。
      let released = 0
      for (const [key, entry] of [...byKey.entries()]) {
        if (kept.has(key)) continue
        entry.texture.dispose()
        byKey.delete(key)
        released += 1
      }

      return Object.freeze({
        uploaded,
        released,
        ready: byKey.size,
        readyWithoutPixels,
      })
    },

    clear(): void {
      if (disposed) return
      releaseAll()
    },

    abandon(): number {
      if (disposed) return 0
      const n = byKey.size
      // **不**逐张 dispose（设备已失效）；直接丢引用 ⇒ 恢复后按当前资源表重建。
      byKey.clear()
      return n
    },

    dispose(): void {
      if (disposed) return
      releaseAll()
      // 置位后 `sync`/`textureFor` 都不再产生新句柄 —— 释放后复活是最难查的一类泄漏。
      disposed = true
    },
  }
}

/**
 * 像素 → `THREE.DataTexture`。
 *
 * ## 为什么是 `DataTexture` 而不是 `CanvasTexture`
 *
 * `TexturePixels` 已经是 RGBA8（`presentation/textureBinding` 的类型），
 * 而 `CanvasTexture` 要求把像素再塞回 DOM canvas —— 那会让本模块**需要 DOM**，
 * 从而不能在 vitest 里被断言。`DataTexture` 直接吃 `Uint8Array`。
 *
 * 采样参数**不在这里设**：`presenter.createMaterial` 每次按 `binding.sampling` 设置
 * （见 `presentation/presenter.ts:792-805`），故"采样口径"只有一处。
 * 颜色空间在此设一次（sRGB 贴图 → 线性工作空间，与 material 的既有口径一致）。
 */
function textureOfPixels(
  pixels: { readonly width: number; readonly height: number; readonly rgba: Uint8Array },
  name: string,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(pixels.rgba, pixels.width, pixels.height, THREE.RGBAFormat)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.name = name
  tex.needsUpdate = true
  return tex
}