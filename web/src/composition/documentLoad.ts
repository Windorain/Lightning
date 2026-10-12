/**
 * `composition/documentLoad` —— **一次文档加载的完整语义**（#289 P10d 的 D1）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 两条**各自为政**的加载路径：文件选择器装配内核、`DocumentSource` 路径**不装配** | `operators/builtin/docLifecycleOperators.ts` 与 `workbench/document/pipeline.ts` | 两条路径**共用**本模块的 {@link adoptLoadedDocument}，装配成为加载的**组成部分**而非某一条路径的可选附加 |
 * | 信封解包在 operator 层私有一份（`plainRootOf`） | 旧 `docLifecycleOperators.ts` 局部函数 | `plainRootOf` 落在 `adapters/plainRoot`（编解码职责），两条路径共用同一份判据 |
 *
 * ## 为什么必须统一（本批实测的**最高价值缺口**）
 *
 * 本批侦察实测：内核文档**只在文件选择器路径被填充**。
 * `workbench/document/pipeline.ts:40-45` 的 `documentLoadPipeline` 只调
 * `ctx.main.replaceDoc(result.document)`，**从不**调 `adoptDocumentIntoKernel`。
 *
 * ⇒ 而 `DocumentSource` 正是 **wiki-data**（最高价值路径）、SDE 导出、本地文件抽屉的入口。
 * 若不统一，任何"改读内核"的迁移会在 wiki-data 路径上读到**空内核文档** ——
 * 那是**静默能力回退**（页面照常渲染、因为旧路径兜底），而不是一次可见的失败。
 *
 * 这正是 #171 要防的"阶段间暂存的未迁移路径"最坏的形态：它绿得起来。
 *
 * ## 本模块的边界
 *
 * 它**只做装配与投递**，不含任何加载策略（不决定要不要确认脏文档、不改工作区模式、
 * 不推最近列表）—— 那些是外壳的职责，两条路径各自保留。判据：
 * 若某件事"两条路径本来就该做且做法不同"，它**不**进本模块。
 *
 * ## 为什么放在 `composition/`
 *
 * 装配是 `composition/` 的本职（该层是装配根，可 import 全部层）。放在
 * `operators/` 会让 `workbench/document/pipeline.ts` 反向依赖 operator 层；
 * 放在 `workbench/` 则反过来。`composition/` 是两条路径唯一的**共同祖先**。
 */

import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { KernelSession } from '@/runtime/kernelSession'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { captureFidelityFieldMap } from '@/adapters/fidelityCapture'
import { plainRootOf } from '@/adapters/plainRoot'
import { createDocument, withContent, withDocumentContent } from '@/domain/document'

/** 装配诊断/统计要写进去的日志面（与 `Context.log` 同形的最小投影）。 */
export interface LoadLogPort {
  info(scope: string, message: string, detail?: unknown): void
  warn(scope: string, message: string, detail?: unknown): void
}

/**
 * **取"解析器看到的 plain 形状"** ⇒ 见 `adapters/plainRoot#plainRootOf`。
 *
 * ## 为什么它不在本文件（本批被架构闸门判红后的一处分层更正）
 *
 * 第一版把它实现放在这里。`gate/no-private-cross-layer` 当场判红：
 * `composition/` 是**新实现**层，跨层导入 `adapters/files/envelopeCodec`（深度 3）
 * 超出公共出口最大深度 2。
 *
 * 判红是**对的** —— 它暴露的是"编解码判据被放进了装配层"这个分层错误，
 * 而不是闸门过严。该函数解释的是**输入文件**（信封解包 + meta 合并），
 * 那是适配职责，与 `adapters/files/*` 同层同性质。
 *
 * 现在：实现在 `adapters/plainRoot`（与 codec 同层）；两条加载脊柱各自从它导入。
 */

/**
 * 装配产物的 `multiblock` → 投影侧的**类型化投影面**（#301 P10f D2）。
 *
 * ## 为什么这个转换必须在 `composition/` 侧发生
 *
 * 装配产物给出的是 `MultiblockProjectionFace`（`kernelAssembly` 的形状），
 * 而投影要的是 `KernelDeclarationProjection`（`kernelProjection` 的形状）——
 * 两者字段同义但**是不同类型**。转换点必须在一个**同时能看见两者**的地方，
 * 那就是装配根 `composition/`（它本来就 import 两边）。
 *
 * ⚠️ 不允许把这个转换下沉到 `runtime/kernelSession`：那会让内核侧 import 装配根，
 * 依赖方向就反了（装配根依赖各层，内核不该依赖装配根）。
 * 会话只保管**不透明**载荷，解释权留在这一侧。
 *
 * ## 形状与 `kernelRenderView#declarationOf` **同源**
 *
 * 那个函数对渲染路径做同一件事（装配面 → 投影入参）。本函数是**保存路径**的对应物；
 * 两者必须给出同一个形状，否则"渲染看到的声明"与"存出来的声明"会分叉。
 */
function multiblockProjectionFaceOf(assembled: {
  readonly multiblock: {
    readonly id: string
    readonly displayName: string
    readonly declRaw: Readonly<Record<string, unknown>>
    readonly projection: {
      readonly declaration: unknown
      readonly blockPalette: unknown
      readonly assets: unknown
      readonly frames: unknown
      readonly schemaVersion: number | null
      readonly multiblockCount: number
    }
  } | null
}): unknown {
  const mb = assembled.multiblock
  if (mb === null) return null
  // 逐字段**显式**搬运（不用展开运算符）：投影面的字段集若变化，
  // 这里必须同批更新（展开会让"少搬一个字段"静默通过）。
  return {
    id: mb.id,
    displayName: mb.displayName,
    declaration: mb.projection.declaration,
    declRaw: mb.declRaw,
    blockPalette: mb.projection.blockPalette,
    assets: mb.projection.assets,
    frames: mb.projection.frames,
    schemaVersion: mb.projection.schemaVersion,
    multiblockCount: mb.projection.multiblockCount,
  }
}

/**
 * **把一份已解析的旧文档装进内核会话**（#282 P10b 建立，D1 起为**两条加载路径共用**）。
 *
 * ## 这一步在整条链上的位置
 *
 * ```
 * 文件 ──解析──▶ RuntimeDocument ──装配──▶ 内核 Scene + DocumentContent
 *                                              │
 *                                              ├─▶ KernelSession.adoptDocument（内核持有权威）
 *                                              └─▶ 帧声明由内核文档自己给出（不再从旧文档读）
 * ```
 *
 * ## 为什么装配失败**不**阻断加载（如实降级，不静默）
 *
 * `assembleKernelDocument` 对"不可识别形态"显式失败。此时**仍然**加载旧文档
 * （旧渲染路径照常工作），但把失败写进日志 —— 于是：
 *  - 用户不会因为内核装配层的局限而打不开一份文件（能力不回退）；
 *  - 而"这份文件内核装配不了"是一个**可见**的事实，不是静默的双轨。
 *
 * 这条取舍是 #171「阶段间暂存的未迁移路径必须有负责人和退出阶段」的落地：
 * 旧路径此刻仍是**兜底**，它的退出条件是"装配层覆盖全部形态"。
 *
 * ## 诊断不吞
 *
 * 装配产出的诊断（未知字段/不支持能力）逐条写日志。它们**同时**已进
 * `unknownFields`（供适配器层构造保真记录）—— 这里只是让它们在 UI 上可见。
 *
 * ## 返回值：装配是否成功
 *
 * `true` = 内核文档已建立；`false` = 未装配（无会话 / 形态不支持）。
 * 调用方**不**需要用返回值决定要不要继续加载 —— 它只用于诊断与测试断言
 * （例如断言"wiki-data 路径确实装配了"）。刻意不用异常表达"未装配"：
 * 那是**预期内的降级**，不是错误。
 */
export function adoptLoadedDocument(
  ctx: {
    readonly kernel: KernelSession | null
    log: LoadLogPort
  },
  doc: RuntimeDocument,
  plainRoot: Readonly<Record<string, unknown>> | undefined,
  locator: string,
): boolean {
  const kernel = ctx.kernel
  if (kernel === null) {
    // 无会话（诊断/装配测试路径）：不装配，也不报错 —— 那是配置事实，不是缺陷。
    return false
  }
  // ── ⚠️ 边界处的**幂等归一化**（#301 P10f D2 实测抓出的污染入口）────────────
  //
  // ## 为什么必须在这里（而不是只靠 12 个调用点自觉）
  //
  // `assembly` 把 `plainRoot` 里**不认识的键**收进保真记录，而保真记录**整份写回产物根**。
  // ⇒ 若调用方误传**信封根**（`{documentFormat, payloadEncoding, payload, meta}`）
  // 而不是解包后的 plain，那么：
  //  ① 信封结构键（`payload` = 整份 base64 正文！）会被当成"未知顶层字段"收进保真记录；
  //  ② 保存时它们被写回**Plain 产物的根** ⇒ 产物同时是 Plain 形态又带一份内嵌 payload
  //     （体积翻倍 + 形态自相矛盾）；
  //  ③ 而信封根里**没有**真正的 plain 键（`mode`/`fixtureFile`/`cellGrid`…）
  //     ⇒ 那些键**不进**保真记录 ⇒ 保存一次就丢。
  // 实测（真实信封 + 多方块夹具，探针 `temp/p10f/probe/keys2`）：误传 raw 时
  // `unknownFields` 从 `{mode,scanBounds,source,documentFormat}` 变成
  // `{documentFormat,payload,payloadEncoding[,payloadNote]}` —— **一边污染、一边丢失**。
  //
  // ## 为什么是幂等的
  //
  // `plainRootOf` 对**非信封**输入原样返回（零成本、无拷贝），故对"已经正确的调用方"
  // 完全无行为变化；对误传 raw 的调用方则还原成生产 12 个调用点传入的那个形状。
  // ⇒ 这是"统一入口"而不是"第二个实现"：解包判据只有 `adapters/plainRoot` 一份。
  const normalizedRoot = plainRoot === undefined ? undefined : plainRootOf(plainRoot)
  const assembled = assembleKernelDocument({ doc, plainRoot: normalizedRoot })
  if (!assembled.ok) {
    ctx.log.warn('场景加载', `内核装配未支持该文档形态（旧路径照常渲染）`, {
      locator,
      code: assembled.error.code,
      reason: assembled.error.params.reason,
    })
    return false
  }
  const value = assembled.value
  // 组装内核 Document：装配产出的场景 + 内容三块。
  // 基线钉到内容本身（"刚打开 = 与保存基线相同"，与 `restoreProject` 同一口径）。
  const base = createDocument(kernel.documentId, { sceneId: value.scene.id, content: value.content })
  const withScene = withContent(base, value.scene, base.animation, value.content)
  const withBaseline = Object.freeze({ ...withScene.doc, saveBaseline: withScene.version })
  const adopted = withDocumentContent(withBaseline, value.content).doc
  kernel.adoptDocument(adopted, value.content)

  // ── #301 P10f D1（G-6a）：**采集源文件的未知顶层字段**并交给会话承载 ──────
  //
  // ## 本行替代的旧机制
  //
  // 原先这里（下方日志）**只把键数写进一条日志**，记录从未被构造
  // ⇒ "保存 → 再打开"静默丢掉未知顶层字段（seam `fidelity-record-transport-unwired`
  // 的 `oldTrack` 描述的正是这个形态）。
  //
  // ## ⚠️ 为什么经 `adapters/fidelityCapture`（深度 2）而不是直接调 `captureFidelity`
  //
  // `captureFidelity` 在 `adapters/files/fidelityRecord.ts` ⇒ 深度 3，而
  // `composition/` 是**整层的闸门执行面** ⇒ 直引触 `gate/no-private-cross-layer`（实测确认）。
  // 而"再导出一层"触 `gate/no-barrel-smuggling`（`APPROVED_BARRELS = []`）。
  // ⇒ 正解是**模块归位**：那一小块自己就是深度 2 的模块（先例：`adapters/tooltipPool.ts`）。
  //
  // ## 为什么写进**会话**而不是留在本函数局部
  //
  // 消费方是**保存/导出投影**（D2 的三条保存路径 + 四条导出），在别的调用栈上
  // ⇒ 记录必须有**生命周期 = 文档生命周期**的宿主。会话正是它：
  // 装载时置位、卸载时清空（`markUnloaded`）⇒ 不串档。
  kernel.setFidelityFieldMap(
    captureFidelityFieldMap({
      sourceFormat: value.sourceFormat,
      sourceVersion: value.sourceVersion,
      unknownFields: value.unknownFields,
    }),
  )

  // ── #301 P10f D2：把**装配面**交给会话保管（投影侧要用） ─────────────────
  //
  // 两样东西只有装配期知道：帧对象映射（帧下标 → 对象 id）与多方块类型化投影面。
  // 为什么不留在本函数局部：消费方是**保存/导出**（在别的调用栈上）；
  // 为什么不让投影自己去场景里翻：那会把装配的命名约定
  // （`structure:frame-<i>` / `structure:multiblock`）泄漏给投影层
  // （`kernelAssembly.ts:475-483` 已就此裁定"装配显式给出，投影只做重建"）。
  //
  // ⚠️ `multiblock` 以**不透明**形式交给会话（会话在内核侧，不得 import 装配根的类型）。
  kernel.setAssemblyFace({
    frameObjects: value.frameObjects,
    multiblock: value.multiblock === null ? null : multiblockProjectionFaceOf(value),
  })

  for (const d of value.diagnostics) {
    ctx.log.info('内核装配', `${d.code} @ ${d.path}`, { locator, detail: d.detail })
  }
  ctx.log.info('场景加载', '内核装配完成', {
    locator,
    objects: Object.keys(value.scene.objects).length,
    frames: value.frameObjects.length,
    resources: value.content.resources.length,
    multiblock: value.multiblock !== null,
    unknownFields: Object.keys(value.unknownFields).length,
    diagnostics: value.diagnostics.length,
    // #289 P10d：几何/部件/说明的类型化承载规模（诊断面）。
    // 这三个数字是"内容面真的进了内核"的可观测证据：切换前它们恒为 0
    // （几何只在 `multiblockSource` 回显里，部件/说明根本不进内核）。
    geometryAssets: value.contentStats.geometryAssets,
    geometryEntries: value.contentStats.geometryEntries,
    contentCells: value.contentStats.contentCells,
  })
  return true
}
