/**
 * `adapters/export/offscreenTextureDomain` —— **把离屏设备域自建的纹理端口接到冻结注入点**
 * （#389 R3-②；R3-1a 交付）。
 *
 * ## 接线为什么需要这一层
 *
 * 冻结注入点是 `SnapshotOffscreenRenderPortOptions.textures?: TexturePort`
 * （`adapters/export/offscreenRenderPort.ts`，**本批不改它**：`composition/__tests__/
 * p10fD3ExportOwnership.test.ts` 逐字锁定那一行的形态）。而纹理端口必须由
 * **拥有 GL 上下文者**在 `acquire` 内造出（`renderDevice` 的 `acquire`），
 * 装配方在构造 `SnapshotOffscreenRenderPort` 时**还不知道**该端口 —— 两者之间的
 * 时间差由此处的**域内委托**补上：
 *
 * ```
 *   createOffscreenTextureDomain({ scope, resources })
 *       ├─ devices  : 内层设备工厂（缺省 = createThreeOffscreenDevice，真 GL）
 *       └─ textures : 冻结注入点要的 TexturePort
 *                      └─ acquire() 时绑定到**本次设备**自建的上传端口
 * ```
 *
 * 装配方（e2e 探针 / 未来的生产导出入口）把 `devices` 与 `textures` **成对**交给
 * `createSnapshotOffscreenRenderPort`：于是"导出用的纹理"只可能来自离屏设备域，
 * 而**不可能**指向实时视口（跨域句柄在另一个上下文里无意义）。
 *
 * 委托只在**同一设备域内**发生（离屏端口同一时刻只允许一个活动设备，
 * 见 `SnapshotOffscreenRenderPort.acquire` 的重复获取拒绝）：它既不接收也不返回
 * `THREE.Texture`/GL 资源，只暴露冻结呈现接口的 `textureFor`。
 */

import type { ContentIdentity } from '@/presentation/assetIdentity'
import type { TexturePort } from '@/presentation/presenter'
import type { DeviceScope } from '@/presentation/resourceCache'
import type { TextureResource } from '@/presentation/textureBinding'
import { createThreeOffscreenDevice, type OffscreenDeviceFactory } from './renderDevice'

export interface OffscreenTextureDomainOptions {
  /** 本离屏域的设备作用域（进呈现层归属键）。 */
  readonly scope: DeviceScope
  /** 本次装配的纹理资源表（五态链读面；纯数据侧的事实）。 */
  readonly resources: readonly TextureResource[]
  /** 内层设备工厂（缺省 = 真 Three 实现；测试可注入受控设备）。 */
  readonly devices?: OffscreenDeviceFactory
}

/** 成对交付：设备工厂 + 冻结注入点要的纹理端口。 */
export interface OffscreenTextureDomain {
  readonly devices: OffscreenDeviceFactory
  readonly textures: TexturePort
}

/** 装配一个**自持 GL 上下文**的离屏纹理域（见文件头）。 */
export function createOffscreenTextureDomain(
  options: OffscreenTextureDomainOptions,
): OffscreenTextureDomain {
  const inner =
    options.devices ??
    createThreeOffscreenDevice({ scope: options.scope, resources: options.resources })

  /** 当前活动设备自建的上传端口（`acquire` 时绑定；无活动设备 ⇒ `null`）。 */
  let active: TexturePort | null = null

  const devices: OffscreenDeviceFactory = {
    acquire(render) {
      const acquired = inner.acquire(render)
      if (acquired.ok) {
        const deviceTextures = acquired.value.textures
        active = deviceTextures === undefined ? null : deviceTextures
      } else {
        active = null
      }
      return acquired
    },
  }

  const textures: TexturePort = {
    textureFor(identity: ContentIdentity) {
      return active === null ? null : active.textureFor(identity)
    },
  }

  return { devices, textures }
}
