/**
 * `composition/kernelRenderView` —— **内核求值 → 渲染视图文档**（#289 P10d 的 D2）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `buildMultiblockRenderView(doc, outcome, frameIndex)` —— 视口层用 legacy `AssemblyResult` 构造渲染视图 | `shared/viewport/multiblockChannelUi.ts` | 走**内核求值**：`assembleKernelDocument(multiblockSelection)` → `projectKernelDocument({ renderView })` |
 * | `useKernelChannels.renderDoc` 直接调旧构造器 | `shared/viewport/useKernelChannels.ts` | 改为调本模块（内核为权威，旧构造器退为对照） |
 *
 * ## 为什么必须有这一层（分工）
 *
 * | 关注点 | 归属 |
 * |---|---|
 * | **判定与身份**（"该不该重算"） | `presentation/multiblockEvaluation`（纯、可缓存） |
 * | **装配**（读懂声明、算出网格） | `composition/kernelAssembly`（装配根可 import 全部层） |
 * | **投影**（内核内容 → 旧格式 plain） | `composition/kernelProjection`（`renderView` 模式） |
 *
 * 本模块只做**协调**：把三者按正确顺序串起来，并**如实降级**（装配失败 ⇒ 返回
 * 原文档 + 一条诊断，而不是伪造一份"看起来能渲染"的视图）。
 *
 * ## 为什么不是"把求值结果写回文档"
 *
 * Lead 裁决逐字要求：**不能**"通道一变就改写内核文档里的网格"（那会把求值结果
 * 写进文档内容，制造脏文档与幽灵历史）。本模块**只产出值**：它返回一份
 * **临时**的渲染视图文档（旧格式 plain → `RuntimeDocument`），
 * 供 DRW 消费；内核 `Document` 与旧 `RuntimeDocument` 的权威内容**都不被改写**。
 */

import type { RuntimeDocument } from '@/context/runtimeDocument'
import { RuntimeDocument as LegacyRuntimeDocument } from '@/context/runtimeDocument'
import { assembleKernelDocument, type AssembledDocument } from '@/composition/kernelAssembly'
import { projectKernelDocument, type KernelDeclarationProjection } from '@/composition/kernelProjection'
import { evaluateMultiblock, type MultiblockSelectionInput } from '@/presentation/multiblockEvaluation'

/** 渲染视图的求值产物（含诊断与身份）。 */
export interface KernelRenderView {
  /** 渲染视图文档（`null` = 本次求值产不出，调用方保留上一次结果）。 */
  readonly doc: RuntimeDocument | null
  /** 求值身份（`e:<hash>`）—— 供缓存与失效判定；同输入 ⇒ 同身份。 */
  readonly identity: string
  /** 诊断（逐条可显示；**不吞**）。 */
  readonly diagnostics: readonly string[]
}

/** 装配产物的 `multiblock` → 投影入参（与生产调用点同形）。 */
function declarationOf(assembled: {
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
}): KernelDeclarationProjection | null {
  const mb = assembled.multiblock
  if (mb === null) return null
  return {
    id: mb.id,
    displayName: mb.displayName,
    declaration: mb.projection.declaration as KernelDeclarationProjection['declaration'],
    declRaw: mb.declRaw,
    blockPalette: mb.projection.blockPalette as KernelDeclarationProjection['blockPalette'],
    assets: mb.projection.assets as KernelDeclarationProjection['assets'],
    frames: mb.projection.frames as KernelDeclarationProjection['frames'],
    schemaVersion: mb.projection.schemaVersion,
    multiblockCount: mb.projection.multiblockCount,
  }
}

/**
 * **内核求值 → 渲染视图文档**。
 *
 * 步骤（顺序是判据的一部分）：
 *  1. **求值身份**：由（声明内容 + 取值 + 帧下标）派生 —— 不含机位（A11）；
 *  2. **装配**：`assembleKernelDocument({ multiblockSelection })` —— 内核承载的网格；
 *  3. **投影**：`projectKernelDocument({ renderView })` —— 网格注入帧的**渲染**形态；
 *  4. **读回**：`fromV2Plain` 得到 DRW 能吃的 `RuntimeDocument`。
 *
 * ## 如实降级（每一步失败都**显式**报告）
 *
 * | 失败 | 处置 |
 * |---|---|
 * | 文档不是多方块 | 返回 `doc` 本身（帧为主路径行为零变化） |
 * | 装配失败 | `doc: null` + 诊断（调用方保留上次可渲染结果） |
 * | 投影产物读不回 | `doc: null` + 诊断（那是实现缺陷，**不**静默） |
 */
export function kernelRenderViewOf(input: {
  readonly doc: RuntimeDocument
  readonly selection: MultiblockSelectionInput
  readonly frameIndex: number
  /** 无损源（装配层要它恢复根级元数据）；缺省回落到 `doc.serialize()`（有损，如实降级）。 */
  readonly plainRoot?: Readonly<Record<string, unknown>>
}): KernelRenderView {
  const { doc, selection, frameIndex } = input
  // 帧为主文档：原样返回（渲染路径行为零变化）。
  if (!doc.isMultiblock) {
    return Object.freeze({ doc, identity: '', diagnostics: Object.freeze([]) })
  }

  const declarationContent = doc.multiblock?.decl.raw ?? null
  // ① 求值身份（纯；不含机位 —— 见 `multiblockEvaluation` 的 A11 说明）。
  const evaluated = evaluateMultiblock({
    sceneId: doc.id,
    declarationContent,
    selection,
    frameIndex,
    // 装配端口：注入内核装配（本层是装配根，可 import 它）。
    assemble: (sel) => {
      const r = assembleKernelDocument({
        doc,
        plainRoot: input.plainRoot,
        multiblockSelection: { totalTier: sel.totalTier, values: { ...sel.values }, runstate: sel.runstate },
      })
      if (!r.ok) return null
      return { grid: r.value }
    },
  })
  if (evaluated.grid === null) {
    return Object.freeze({
      doc: null,
      identity: evaluated.identity,
      diagnostics: Object.freeze([...evaluated.notices]),
    })
  }

  // ②③④ 投影成渲染视图并读回
  const assembled = evaluated.grid as AssembledDocument
  const projected = projectKernelDocument({
    scene: assembled.scene,
    content: assembled.content,
    frameObjects: assembled.frameObjects,
    multiblockDeclaration: declarationOf(assembled),
    renderView: { frameIndex },
  })
  const reparsed = LegacyRuntimeDocument.fromV2Plain(projected.plain as Record<string, unknown>)
  if (reparsed === null) {
    return Object.freeze({
      doc: null,
      identity: evaluated.identity,
      diagnostics: Object.freeze([
        ...evaluated.notices,
        '投影产物无法被 `fromV2Plain` 读回（投影产出了非法形状）—— 这是实现缺陷，不静默',
      ]),
    })
  }
  return Object.freeze({
    doc: reparsed,
    identity: evaluated.identity,
    diagnostics: Object.freeze([...evaluated.notices]),
  })
}
