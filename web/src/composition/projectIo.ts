/**
 * `composition/projectIo` —— **工程格式的生产接线**（#249 §12；R1-α）。
 *
 * ## 为什么它在这里，而不在 `runtime/context`
 *
 * R1-α 第一版把 `projectForSave`/`adoptProject`/`decodeProjectFile` 直接加在
 * `Context` 上 —— 架构闸门**当场判红**（三条新的旧层→内核边：
 * `runtime/context.ts → adapters/files/projectFormat` / `→ domain/errors` /
 * `→ domain/editing`）。
 *
 * 判红是**对的**，且理由不止"闸门要登记"：
 * - `runtime/context.ts` 是**待清算**的旧层文件（`composition/seams.ts` 的
 *   `legacy-render-source-document` 等接缝都指着它；属性写那条
 *   `property-write-legacy-document-model` 已在 R1-β① C3 核销）；
 *   把新的生产接线**加进**正在退场的宿主里，正是 #171 禁止的
 *   "新门面包旧核心保活"——新能力应该落在新层。
 * - 本模块的职责（"把工程格式接到生产"）是**装配 + 接线**，与 `composition/documentLoad`
 *   （装载脊柱的接线）**同层同性质**：那里也是"把解析产物装进内核"。
 *
 * ⇒ 这两个入口与 `documentLoad#adoptLoadedDocument` 并列：一个管**装载脊柱**，
 * 一个管**工程往返**。宿主面用**结构端口**（见 {@link ProjectHost}）表达，
 * 于是本模块不依赖 `Context` 这个旧类型 —— 依赖方向是 `operators/`（旧）→
 * `composition/`（新装配层），而后者的内部依赖（→ `adapters/`、→ `domain/`）
 * 是**新层内部**的，不产生新的旧→新边。
 *
 * ## 为什么 import 的是 `@/adapters/projectFile` 而不是 `@/adapters/files/projectFormat`
 *
 * 契约 §7.3 规则 2「**公共出口最大深度 2**」：新实现层不得直接 import 深度 3 的实现。
 * `adapters/projectFile.ts` 是适配器层的**公共出口**（实现留在 `files/` 里），
 * 与既有的 `adapters/plainRoot.ts`（对 `files/envelopeCodec` + `files/plainCodec`）
 * **同一形态**。⚠️ R1-α 第一版曾把实现文件**搬到**深度 2 让规则变绿 ——
 * 那是**形状服从规则**（让目录分组迁就检查），已回退；见 `adapters/projectFile` 的文件头。
 *
 * ## 纯函数式的边界
 *
 * 三个函数都不改入参、不读全局时钟/DOM/网络。`adoptProject` 会**写**宿主
 * （经注入的 `setDocument`/`seekFrame` 端口）—— 那是接线层的职责
 * （"接线层只协调调用、调度、端口与资源"，#249 §2.1），不是政策。
 */

import type { KernelSession } from '@/runtime/kernelSession'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { err, ok, unsupportedOperation, type Result } from '@/domain/errors'
import { createEditContext } from '@/domain/editing'
import {
  readProjectFile,
  restoreProjectFile,
  projectFileOf,
  type DecodedProject,
  type ProjectFile,
} from '@/adapters/projectFile'
import { projectToRuntimeDocument } from '@/composition/kernelProjection'
import { projectAnnotationsToLegacy } from '@/runtime/annotationRead'

/**
 * **工程接线的宿主面**（结构端口）。
 *
 * 三个成员就是接线真正需要的事实：内核会话、换上旧格式载体、定位帧。
 * ⇒ 调用方（算子层）从 `ctx` 取这三样即可，本模块**不**认识 `Context`。
 */
export interface ProjectHost {
  readonly kernel: KernelSession | null
  /** 换上 legacy 渲染载体（生产实现是 `Context#setDocument`；唯一写入口）。 */
  setDocument(next: RuntimeDocument | null): void
}

/**
 * **工程保存**：内核 `Document` → `ProjectFile`。
 *
 * ## 为什么**不**回落 legacy
 *
 * `plainForSave()` 有 legacy 回落（未装配时旧文档照常能存）—— 那是它**应该**有的
 * （#171 能力不回退）。工程格式**不同**：它编码的是内核文档形状
 * （`ProjectPayload{scene, animation, content, assets, editData}`），
 * 用旧文档填它需要先造一份内核 `Document`，那正是"第二个权威"的入口。
 * ⇒ 未装配时**显式失败**，由调用方报用户可见的错误。
 *
 * @returns `err(UnsupportedOperation)` = 无会话 / 未装配 / 无文档 / 读面拒绝。
 */
export function projectForSave(host: ProjectHost): Result<ProjectFile> {
  const kernel = host.kernel
  if (kernel === null) return err(unsupportedOperation({ reason: 'noKernelSession' }))
  if (!kernel.hasAdoptedContent()) return err(unsupportedOperation({ reason: 'kernelNotAdopted' }))
  const doc = kernel.document()
  if (doc === undefined) return err(unsupportedOperation({ reason: 'noKernelDocument' }))
  const view = kernel.read()
  const summary = view.interaction.context()
  if (!summary.ok) return summary
  const selection = view.interaction.selection()
  if (!selection.ok) return selection
  const seed = createEditContext(summary.value.id, summary.value.documentId)
  // `assets` **不**在这里派生：内核 `ContentResource.ref` → 文件 `ProjectAssetRef`
  // 的字段映射属**边界**（它知道文件格式的字段名），故由 `@/adapters/projectFile`
  // 的 `projectFileOf` 承担（那里缺省即派生）。装配层只交内核事实。
  return projectFileOf({
    doc,
    context: Object.freeze({
      ...seed,
      selection: selection.value,
      time: summary.value.time,
      channelValues: summary.value.channelValues,
      activeTool: summary.value.activeTool,
    }),
  })
}

/**
 * **工程重开**：`ProjectFile` → 内核权威 + legacy 渲染载体 + 可恢复编辑数据。
 *
 * ## 顺序是语义的一部分（与装载脊柱同序）
 *
 * ```
 * setDocument（legacy 载体 + 存在性镜像）
 *   → kernel.seekFrame(0)
 *   → kernel.adoptDocument（内核权威 = 还原出的 Document）
 *   → 恢复编辑数据（time / channelValues / 选择）
 * ```
 *
 * ⚠️ 反过来（先 `adoptDocument` 再 `setDocument`）会让 GF-16 被清掉 ——
 * `setDocument` 会 `markLoaded` 并清"内核里的就是那份文档"这一标记
 * （见 `docs/contracts/web-kernel-contracts.md` §2.4 的三种通知信号表）。
 *
 * ## 画面从哪来（本批的诚实边界）
 *
 * 还原出的内核 `Document` 经 `projectToRuntimeDocument` 投成旧格式 `RuntimeDocument`
 * 交给 `setDocument` ⇒ **画面仍由旧渲染链产出**。渲染链终切有独立前置
 * （材质统一 + 注解/描边统一，见 `composition/seams.ts` 的
 * `legacy-render-source-document`/`presenter-surface-dual-track`），
 * 不属于"把工程格式接进生产"这件事。
 * **但内容权威已经是内核**：还原后的语义读面读的是 `restoreProject` 的产物。
 */
export function adoptProject(host: ProjectHost, decoded: DecodedProject): Result<boolean> {
  const kernel = host.kernel
  if (kernel === null) return err(unsupportedOperation({ reason: 'noKernelSession' }))
  const { doc, context } = restoreProjectFile(decoded)
  // ① 旧格式载体（画面）+ 存在性镜像。
  const projected = projectToRuntimeDocument({
    scene: doc.scene,
    content: doc.content,
    annotationRows: projectAnnotationsToLegacy(doc),
  })
  host.setDocument(projected.doc)
  kernel.seekFrame(0)
  // ② 内核权威：`restoreProject` 同时定了内容身份与保存基线（重开必须**干净**）。
  kernel.adoptDocument(doc, doc.content)
  // ③ 可恢复编辑数据（只在有内核入口的字段上做；缺入口的**不伪造**）。
  kernel.seekTime(context.time)
  for (const [channel, value] of Object.entries(context.channelValues)) {
    kernel.setChannelValue(channel, value)
  }
  if (context.selection.active !== null) {
    kernel.submit({ kind: 'select', contextId: context.id, target: context.selection.active })
  }
  kernel.drain()
  return ok(true)
}

/**
 * **工程读入的边界解码**（唯一入口；转 `@/adapters/projectFile#readProjectFile`）。
 *
 * 算子层只该知道"把用户选的文件交给它、拿到成功/失败"，不该知道工程格式长什么样
 * （契约 §6：外部文件**只在边界**编解码）。本函数是装配层对算子的**唯一**读入口。
 */
export function decodeProjectFile(raw: unknown): Result<DecodedProject> {
  const read = readProjectFile(raw)
  if (!read.ok) return read
  return ok(read.value.decoded)
}
