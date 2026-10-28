/**
 * `composition/kernelRenderView` —— **已求值场景 → 渲染视图文档**。
 *
 * ## 本模块替代的旧机制（两条都已删除，这里只留"替代了什么"）
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `buildMultiblockRenderView(doc, outcome, frameIndex)` —— 视口层用 legacy `AssemblyResult` 构造渲染视图 | `shared/viewport/multiblockChannelUi.ts`（已删除） | {@link kernelRenderViewFromFace}：吃**已求值场景**，只做投影 |
 * | `kernelRenderViewOf({ doc, selection, plainRoot })` —— 自己按取值**重装配整份旧文档** | 本文件（已删除） | 同上；求值归**唯一求值点** `composition/kernelMultiblockEvaluation#evaluateMultiblockPresentation` |
 *
 * ## 为什么必须有这一层（分工）
 *
 * | 关注点 | 归属 |
 * |---|---|
 * | **判定与身份**（"该不该重算"） | `presentation/multiblockEvaluation#evaluationIdentityOf`（纯、可缓存） |
 * | **求值**（读懂声明、算出网格） | `composition/kernelMultiblockEvaluation`（唯一求值点） |
 * | **投影**（内核内容 → 旧格式 plain） | `composition/kernelProjection`（`renderView` 模式） |
 *
 * 本模块只做**投影 + 读回**，并**如实降级**（投影产不出可读回的形状 ⇒ `doc: null` + 诊断，
 * 而不是伪造一份"看起来能渲染"的视图）。
 *
 * ## 为什么不是"把求值结果写回文档"
 *
 * 约束要求：**不能**"通道一变就改写内核文档里的网格"（那会把求值结果
 * 写进文档内容，制造脏文档与幽灵历史）。本模块**只产出值**：它返回一份
 * **临时**的渲染视图文档（旧格式 plain → `RuntimeDocument`），
 * 供 DRW 消费；内核 `Document` 与旧 `RuntimeDocument` 的权威内容**都不被改写**。
 */

import type { RuntimeDocument } from '@/context/runtimeDocument'
import { RuntimeDocument as LegacyRuntimeDocument } from '@/context/runtimeDocument'
import { projectKernelDocument, type KernelDeclarationProjection } from '@/composition/kernelProjection'
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

// ─────────────────────────────────────────────────────────────────────────────
// **内核面**求值入口（不吃 `RuntimeDocument`）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 内核面渲染视图的输入：**已求值**的装配事实（场景 + 内容 + 帧映射 + 声明投影 + 身份）。
 *
 * ## 为什么本入口不再自己装配
 *
 * 本入口此前自己调 `assembleMultiblockKernelFace`。"按当前取值再装配"现已提成
 * **唯一求值点**（`composition/kernelMultiblockEvaluation#evaluateMultiblockPresentation`）：
 * DRW 定义面与呈现会话都必须读同一份派生场景，否则"面板说 3×5×3、画面画 3×2×3"
 * 会重现（断点②的形态）。本层只做**投影**（已求值场景 → 旧格式渲染视图）。
 *
 * ## 与被删入口 `kernelRenderViewOf` 的差别（历史对照：那条路已删除）
 *
 * | | `kernelRenderViewOf`（旧，生产零调用） | 本入口 |
 * |---|---|---|
 * | 求值 | `assembleKernelDocument({doc, multiblockSelection})`：**整份文档**按新取值重装配 | 调用方已求值（`evaluateMultiblockPresentation`） |
 * | 输入 | 旧格式 `RuntimeDocument`（有损） | 派生场景 + 内核内容 + 装配面 + 声明投影 + 身份 |
 * | 元数据 | 靠调用方传 `plainRoot`（不传 ⇒ 有损降级） | **不需要**：`content` 本身就是装配期的内核内容（无损） |
 */
export interface KernelRenderFaceInput {
  /**
   * **已求值**的场景（由 `composition/kernelMultiblockEvaluation` 按当前通道取值
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
