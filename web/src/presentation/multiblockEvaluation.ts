/**
 * `presentation/multiblockEvaluation` —— **多方块网格求值节点**。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `buildMultiblockRenderView(doc, outcome, frameIndex)` —— 在**视口层**构造渲染视图文档 | `shared/viewport/multiblockChannelUi.ts` | 同一语义升格为**求值节点**：显式输入（声明 + 取值）、纯、可缓存、由内容身份驱动失效 |
 * | `useKernelChannels.renderDoc` 每次取值变化重算 + `contentRefreshTick` 手动请求重读 | `shared/viewport/useKernelChannels.ts` | 求值产物带**版本化身份**；失效由 `computeInvalidation` 的节点声明判定，不由调用方声明 |
 *
 * ## 为什么它是"求值节点"而不是"文档变更"（契约的边界）
 *
 * 契约逐字要求：多方块**声明 + 通道取值是输入，网格是求值产物**。
 * 故正确形态是：
 *
 * ```
 * 求值节点「声明内容版本 + 通道取值版本 → 网格」
 * ```
 *
 * 而**不是**"通道一变就改写内核文档里的网格"。后者会把求值结果写进文档内容，
 * 制造**脏文档**与**幽灵历史** —— 与禁止的「动画输出反写手动取值」同族。
 *
 * 本模块因此**只读**输入、只产出**值**（身份），不碰 `Document`。
 *
 * ## 纯性
 *
 * 无 IO、无 DOM、无时钟、无 Vue、无全局：同一 `(declaration, selection, frameIndex)`
 * 必然得到同一结果。故它可在 vitest 里直接断言（无需宿主），也天然可缓存。
 *
 * ## 节点身份与失效（判据的落点）
 *
 * 本模块只留**身份**（{@link evaluationIdentityOf}）：它由读集机械派生 ——
 * 声明内容 + 取值 + 帧下标，**不含** `documentVersion`（否则"改一个注解文字"
 * 会让网格重算，而契约明文要求那种改动**不**重建方块几何）。
 *
 * ⚠️ 旧的 `evaluateMultiblock`（含它的注入式装配端口）与
 * `evaluationNodeDependency` 已删除 —— 生产求值点是
 * `composition/kernelMultiblockEvaluation#evaluateMultiblockPresentation`（唯一），
 * 节点依赖声明不再有"第二份"。机位失效判据由
 * `application/__tests__/evaluationInvalidation.test.ts` 在**生产**节点形状上把守。
 */

import { contentDigestOf } from './invalidationPlan'

/** 通道取值选择（与 `context/multiblock` 的 `MultiblockSelection` 同形）。 */
export interface MultiblockSelectionInput {
  readonly totalTier: number
  readonly values: Readonly<Record<string, number>>
  readonly runstate: string
}

/**
 * 求值身份：由**读集**机械派生（`sceneId` + 声明内容 + 取值 + 帧下标）。
 *
 * **不含机位/选择/布局** —— 那些不是本节点的读集（它们属视图投影节点）。
 * 这条区分是机位判据的实现落点：把机位计进身份会让"转视角"重算几何。
 */
export function evaluationIdentityOf(input: {
  readonly sceneId: string
  readonly declarationContent: unknown
  readonly selection: MultiblockSelectionInput
  readonly frameIndex: number
}): string {
  return `e:${contentDigestOf([
    input.sceneId,
    input.declarationContent,
    // 取值按**键序稳定**序列化（`contentDigestOf` 内部走 `stableStringify`）
    input.selection.values,
    input.selection.totalTier,
    input.selection.runstate,
    input.frameIndex,
  ])}`
}
