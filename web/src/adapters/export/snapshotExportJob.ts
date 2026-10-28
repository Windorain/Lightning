/**
 * `adapters/export/snapshotExportJob` —— **冻结快照导出作业的生产装配**。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `ExportJob` **零生产构造**（11 处 `new` 全在测试）⇒ "导出改由 `ExportJob` 承担"不可执行 | 此前实况（接缝登记的阻塞项 ③） | 本文件是那个**生产构造点**：把两个真端口与作业装到一起 |
 *
 * ## 边界（**不**迁移四命令）
 *
 * 本文件提供"能力存在且有生产实现"的**装配入口**，但**不**接管
 * `operators/builtin/exportOperators.ts` 的四个导出命令 —— 那归后续主线
 * （依赖保真字段接线与 `deriveAssetNeeds` 的内容面）。
 * 故本文件**没有生产调用方**，那是**已核定的暂存**，不是遗漏：
 * 它与 `composition/seams.ts` 的 `export-borrows-live-viewport-dual-track` 是同一件事的两半。
 *
 * ⇒ 这里刻意**不**写"已接线"之类的说法。可核对的事实是：
 *  - 两个端口各有生产实现（`offscreenRenderPort` / `encoderPort`）；
 *  - `ExportJob` 有生产构造点（本文件）；
 *  - 全链在 vitest 里**真跑**（注入受控设备）并产出可判定的 PNG 字节。
 *
 * ## ⚠️ 措辞精确化
 *
 * 上句「本文件**没有生产调用方**」按既定口径改写为「**零生产消费方**」——
 * 两件事必须分开（混写曾让"替代面未接线"读起来像"连构造点都没有"）：
 *  - **有**生产构造点（本文件的 `assembleSnapshotExportJob`）；
 *  - **零**生产消费方（四个导出命令仍走 `workbench/export*` 旧导出器）。
 * ⇒ 登记面同步（`composition/seams.ts` 的 `export-borrows-live-viewport-dual-track` ③）。
 */

import type { DocumentContent } from '@/domain/content'
import type { ExportAssetNeed, ExportRequest } from '@/domain/captureSpec'
import type { ArtifactEncoding, ExportKind } from '@/application/exportPlan'
import type { AssetNeedDerivation, ExportCaptureFacts } from '@/application/exportPlan'
import type { AssetStateStore } from '@/presentation/assetState'
import type { TextureResource } from '@/presentation/textureBinding'
import { ExportJob, type ExportProgress } from '@/runtime/exportJob'
import { createSnapshotOffscreenRenderPort, type SnapshotOffscreenRenderPort } from './offscreenRenderPort'
import { createEncoderPort } from './encoderPort'
import type { OffscreenDeviceFactory } from './renderDevice'
import type { TexturePort } from '@/presentation/presenter'
import { cancelOnAbort } from './abortBridge'

export interface SnapshotExportJobOptions {
  /** 不可变导出请求（由 `application/exportPlan.planExportRequest` 产出）。 */
  readonly request: ExportRequest
  readonly kind: ExportKind
  readonly encoding?: ArtifactEncoding
  /** 离屏设备工厂：e2e 注 `createThreeOffscreenDevice()`；vitest 注受控实现。 */
  readonly devices: OffscreenDeviceFactory
  /** 捕获时的内核内容面（捕获值；见 `offscreenRenderPort` 文件头）。 */
  readonly content: DocumentContent
  /** 设备作用域（一个作业一个；进呈现层归属键）。 */
  readonly scope: string
  /** 资源状态仓库；缺省 ⇒ 请求里有必需资源即阻塞。 */
  readonly assets?: AssetStateStore
  /** 是否显式接受有损输出（有损输出显式接受）。 */
  readonly allowLossy?: boolean
  /** 纹理取用端口（缺省 = 材质走中性色）。 */
  readonly textures?: TexturePort
  /**
   * **捕获期那一份** ¤TextureResource[]¤。
   *
   * ⚠️ 必须与 `devices` 里 `createThreeOffscreenDevice({ resources })` 用的是**同一个数组值**
   * （理由见 `offscreenRenderPort#textureResources`）。缺省 = 不绑纹理。
   */
  readonly textureResources?: readonly TextureResource[]
  /**
   * **资源需求推导记录**。作业据它判清单是否"装配过"：
   * 缺省 ⇒ 产物清单自报 `assembled: false`（不伪造"无需资源"）。
   */
  readonly assetNeeds?: AssetNeedDerivation
  /**
   * **捕获期的资源明细**（面板块；只读、不进 digest）。
   * 缺省 = 不提供该读数（受控设备测试）。
   */
  readonly captureFacts?: ExportCaptureFacts
  /**
   * **取消入口**：信号一响 ⇒ `ExportJob.cancel()`。
   *
   * 只做内部语义（**不加 UI 按钮**）。取消路径零产物、必释放、不改编辑现场。
   */
  readonly signal?: AbortSignal
  /** 进度回调（纯观察；不驱动业务）。 */
  readonly onProgress?: (p: ExportProgress) => void
  /** 仅 `kind === 'animation'`：GIF 循环次数（缺省 `0` = 无限）。 */
  readonly loopCount?: number
}

/** 一次组装的结果：作业本体 + 它用的端口（供测试断言端口状态）。 */
export interface SnapshotExportJob {
  readonly job: ExportJob
  readonly port: SnapshotOffscreenRenderPort
  /**
   * **撤销中止订阅**（作业结束后必须调用；幂等）。
   *
   * 不调用不会让作业跑错，只会让监听留在调用方的 `AbortController` 上 —— 那是资源泄漏，
   * 故把它作为返回值的一部分，而不是"记得自己清"。
   */
  readonly detachAbort: () => void
}

/**
 * 组装一个**可运行**的冻结快照导出作业。
 *
 * 两个端口都是**生产实现**（不是测试替身）：
 *  - `SnapshotOffscreenRenderPort`（取景/求值/呈现/读回/释放）；
 *  - `createEncoderPort()`（真实 PNG 字节）。
 *
 * 预检缺的 `assets`/`allowLossy`/`encoder` 三者在此**一次**给全 ——
 * 使 `ExportJob.preflight()` 的结论只取决于 `request` 与资源状态，
 * 而不是"调用方忘了传编码器"这类装配遗漏（那会被预检判
 * `ExportEncodingNotConfigured` 而阻塞，属**正确**的失败，但会掩盖真实原因）。
 */
export function assembleSnapshotExportJob(options: SnapshotExportJobOptions): SnapshotExportJob {
  const port = createSnapshotOffscreenRenderPort({
    devices: options.devices,
    content: options.content,
    scope: options.scope,
    ...(options.textures === undefined ? {} : { textures: options.textures }),
    ...(options.textureResources === undefined ? {} : { textureResources: options.textureResources }),
  })
  const encoder = createEncoderPort()

  const job = new ExportJob({
    request: options.request,
    kind: options.kind,
    ...(options.encoding === undefined ? {} : { encoding: options.encoding }),
    port,
    encoder,
    ...(options.assets === undefined ? {} : { assets: options.assets }),
    ...(options.allowLossy === undefined ? {} : { allowLossy: options.allowLossy }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.loopCount === undefined ? {} : { loopCount: options.loopCount }),
    ...(options.assetNeeds === undefined ? {} : { assetNeeds: options.assetNeeds }),
    ...(options.captureFacts === undefined ? {} : { captureFacts: options.captureFacts }),
  })

  // 信号在**构造之后**接上（作业的 cancel() 是唯一取消真相）。
  const detachAbort = cancelOnAbort(job, options.signal)

  return { job, port, detachAbort }
}

/** 未使用占位：保持 `ExportAssetNeed` 的类型可达性（调用方常需它构造 request）。 */
export type { ExportAssetNeed }
