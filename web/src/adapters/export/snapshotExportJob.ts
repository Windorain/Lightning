/**
 * `adapters/export/snapshotExportJob` —— **冻结快照导出作业的生产装配**（#301 P10f/E）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `ExportJob` **零生产构造**（11 处 `new` 全在测试）⇒ "导出改由 `ExportJob` 承担"不可执行 | 本批前的实况（`composition/seams.ts` 的 `blocker` ③ 原文） | 本文件是那个**生产构造点**：把两个真端口与作业装到一起 |
 *
 * ## 本批的边界（**不**迁移四命令）
 *
 * 本文件提供"能力存在且有生产实现"的**装配入口**，但**不**接管
 * `operators/builtin/exportOperators.ts` 的四个导出命令 —— 那归主线 D/E
 * （依赖保真字段接线与 `deriveAssetNeeds` 的内容面）。
 * 故本文件**没有生产调用方**，那是**已核定的暂存**，不是遗漏：
 * 它与 `composition/seams.ts` 的 `export-borrows-live-viewport-dual-track` 是同一件事的两半。
 *
 * ⇒ 这里刻意**不**写"已接线"之类的说法。可核对的事实是：
 *  - 两个端口各有生产实现（`offscreenRenderPort` / `encoderPort`）；
 *  - `ExportJob` 有生产构造点（本文件）；
 *  - 全链在 vitest 里**真跑**（注入受控设备）并产出可判定的 PNG 字节。
 */

import type { DocumentContent } from '@/domain/content'
import type { ExportAssetNeed, ExportRequest } from '@/domain/captureSpec'
import type { ExportKind, ImageEncoding } from '@/application/exportPlan'
import type { AssetStateStore } from '@/presentation/assetState'
import { ExportJob, type ExportProgress } from '@/runtime/exportJob'
import { createSnapshotOffscreenRenderPort, type SnapshotOffscreenRenderPort } from './offscreenRenderPort'
import { createEncoderPort } from './encoderPort'
import type { OffscreenDeviceFactory } from './renderDevice'
import type { TexturePort } from '@/presentation/presenter'

export interface SnapshotExportJobOptions {
  /** 不可变导出请求（由 `application/exportPlan.planExportRequest` 产出）。 */
  readonly request: ExportRequest
  readonly kind: ExportKind
  readonly encoding?: ImageEncoding
  /** 离屏设备工厂：e2e 注 `createThreeOffscreenDevice()`；vitest 注受控实现。 */
  readonly devices: OffscreenDeviceFactory
  /** 捕获时的内核内容面（S0 值；见 `offscreenRenderPort` 文件头）。 */
  readonly content: DocumentContent
  /** 设备作用域（一个作业一个；进呈现层归属键）。 */
  readonly scope: string
  /** 资源状态仓库（P5 交付）；缺省 ⇒ 请求里有必需资源即阻塞。 */
  readonly assets?: AssetStateStore
  /** 是否显式接受有损输出（§19.4）。 */
  readonly allowLossy?: boolean
  /** 纹理取用端口（缺省 = 材质走中性色）。 */
  readonly textures?: TexturePort
  /** 进度回调（纯观察；不驱动业务）。 */
  readonly onProgress?: (p: ExportProgress) => void
}

/** 一次组装的结果：作业本体 + 它用的端口（供测试断言端口状态）。 */
export interface SnapshotExportJob {
  readonly job: ExportJob
  readonly port: SnapshotOffscreenRenderPort
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
  })

  return { job, port }
}

/** 未使用占位：保持 `ExportAssetNeed` 的类型可达性（调用方常需它构造 request）。 */
export type { ExportAssetNeed }
