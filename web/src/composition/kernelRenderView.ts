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
import {
  assembleKernelDocument,
  type AssembledDocument,
} from '@/composition/kernelAssembly'
import { projectKernelDocument, type KernelDeclarationProjection } from '@/composition/kernelProjection'
import { evaluateMultiblock, type MultiblockSelectionInput } from '@/presentation/multiblockEvaluation'
import type { DocumentContent } from '@/domain/content'
import type { Scene } from '@/domain/scene'

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
      readonly scenes: unknown
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
    scenes: mb.projection.scenes as KernelDeclarationProjection['scenes'],
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
  /**
   * **无损源**（装配层要它恢复根级元数据）。
   *
   * ## G5（渲染链旧格式源终切 · 第一期）：**生产路径恒传它**
   *
   * 唯一生产调用点 `shared/viewport/useKernelChannels` 传
   * `Context#kernelSourceRoot()`（内核会话保管的装配期源根）。此前不传 ⇒ 本函数
   * 回落 `doc.serialize()`，而 `RuntimeDocument` **有损**（七个根级键读不回，
   * 见 `adapters/plainRoot` 文件头的实测登记）⇒ 同一个 `assembleKernelDocument`
   * 在**保存链**（吃无损源）与**渲染链**（吃 `serialize()`）算出不同的
   * `content.metadata` —— 同一份文件两条链的元数据不一致。
   *
   * ⇒ 本参数仍是**可选**只因为帧为主文档（`:103` 的早退）根本走不到装配；
   * 多方块路径上"缺它"= **如实降级**（`kernelAssembly#legacyPlainRoot` 自己
   * 标注有损），而不再是生产形态。判据必须**同时**钉住"传了 ⇒ 无损可观察"
   * 与"不传 ⇒ 判红"（负对照），否则这一行退化不可见。
   */
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

// ─────────────────────────────────────────────────────────────────────────────
// R2/S3：**内核面**求值入口（不吃 `RuntimeDocument`）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 内核面渲染视图的输入：**已求值**的装配事实（场景 + 内容 + 帧映射 + 声明投影 + 身份）。
 *
 * ## 为什么本入口不再自己装配（M5-2 的落点）
 *
 * R2/S3 时它自己调 `assembleMultiblockKernelFace`。M5-2 把"按当前取值再装配"提成
 * **唯一求值点**（`composition/kernelMultiblockEvaluation#evaluateMultiblockPresentation`）：
 * DRW 定义面与呈现会话都必须读同一份派生场景，否则"面板说 3×5×3、画面画 3×2×3"
 * 会重现（断点②的形态）。本层只做**投影**（已求值场景 → 旧格式渲染视图）。
 *
 * ## 与 `kernelRenderViewOf` 的差别（这不是"二选一回落"，是两条各自动工的路径）
 *
 * | | `kernelRenderViewOf`（旧，生产零调用） | 本入口 |
 * |---|---|---|
 * | 求值 | `assembleKernelDocument({doc, multiblockSelection})`：**整份文档**按新取值重装配 | 调用方已求值（`evaluateMultiblockPresentation`） |
 * | 输入 | 旧格式 `RuntimeDocument`（有损） | 派生场景 + 内核内容 + 装配面 + 声明投影 + 身份 |
 * | 元数据 | 靠调用方传 `plainRoot`（不传 ⇒ 有损降级，见 G5） | **不需要**：`content` 本身就是装配期的内核内容（无损） |
 */
export interface KernelRenderFaceInput {
  /**
   * **已求值**的场景（M5-2：由 `composition/kernelMultiblockEvaluation` 按当前通道取值
   * 再装配出的派生场景；帧为主文档就是内核场景本身）。
   *
   * 本入口**不再自己装配** —— 求值只能有一个点（`evaluateMultiblockPresentation`），
   * 否则"面板的尺寸/变体键"与"画面的网格"会各算一次、迟早漂移（断点②的形态）。
   */
  readonly scene: Scene
  /** 内核内容（元数据/帧轴/资源/说明池）。 */
  readonly content: DocumentContent
  /** 帧下标 → 对象 id（装配期才知道）。 */
  readonly frameObjects: readonly string[]
  /** 类型化声明投影（`null` = 帧为主文档：不开 `renderView` 模式）。 */
  readonly multiblockDeclaration: KernelDeclarationProjection | null
  /** 求值身份（由求值点给出；帧为主文档为 `''`）。 */
  readonly identity: string
  /** 当前帧下标（决定哪一帧带网格）。 */
  readonly frameIndex: number
}

/**
 * **已求值场景 → 渲染视图文档**（投影 + 读回）。
 *
 * ## 流程（顺序是判据的一部分）
 *
 *  1. `projectKernelDocument({ renderView })`：`renderView` 模式从**场景的帧对象载荷**
 *     取网格（`kernelProjection.ts:1447` 的 `structures[0]`）—— 派生场景的载荷就是
 *     "当前取值"的装配结果；
 *  2. `fromV2Plain` 读回：读不回 ⇒ `doc: null` + 诊断（实现缺陷，不静默）。
 *
 * ## 帧为主文档（`multiblockDeclaration === null`）
 *
 * 走**同一**投影（不带多方块节点、不开 `renderView` 模式），产出的仍是"帧自带的 structure"
 * 形态 —— 与切换前 `!doc.isMultiblock ⇒ 原样返回 doc` 同一语义。
 *
 * ⚠️ **为什么不能返回 `doc: null`**：`runtime/drwMeshPipeline#setCurrentWorldFrame` 的守卫是
 * `if (!doc || doc.frameCount === 0) return` ⇒ `doc === null` 会让**换帧静默失效**
 * （画面停在首帧且无报错）。故本入口在两条路径上都产出可读回的文档，读不回时**如实失败**。
 */
export function kernelRenderViewFromFace(input: KernelRenderFaceInput): KernelRenderView {
  const { identity, frameIndex } = input
  const isMultiblock = input.multiblockDeclaration !== null
  const projected = projectKernelDocument({
    scene: input.scene,
    content: input.content,
    frameObjects: input.frameObjects,
    multiblockDeclaration: isMultiblock ? input.multiblockDeclaration : null,
    ...(isMultiblock ? { renderView: { frameIndex } } : {}),
  })
  const reparsed = LegacyRuntimeDocument.fromV2Plain(projected.plain as Record<string, unknown>)
  if (reparsed === null) {
    return Object.freeze({
      doc: null,
      identity,
      diagnostics: Object.freeze([
        '内核面渲染视图的投影产物无法被 `fromV2Plain` 读回（投影产出了非法形状）—— 这是实现缺陷，不静默',
      ]),
    })
  }
  return Object.freeze({ doc: reparsed, identity, diagnostics: Object.freeze([]) })
}
