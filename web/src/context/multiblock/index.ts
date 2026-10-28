/**
 * `web/src/context/multiblock/` —— 多方块查表装配器。
 *
 * **输入的冻结接缝**：信封内层 JSON 对象（`multiblock` + `blockPalette` + `frames`）
 * + 取值选择 `{totalTier, values, runstate}`；**输出** = 既有 `Grid` + 装配报告（`clamped` 清单等）。
 * 信封解包（base64/gzip）与 RuntimeDocument 承载由解析器负责，本包不依赖它们。
 *
 * **零游戏逻辑**：只有查表、索引、深拷贝、排序、规则应用；无 GT/StructureLib 语义、无函数求值。
 *
 * 典型用法：
 * ```ts
 * import { assembleSelection, listChannels, listRunstates, channelRange } from '@/context/multiblock'
 * const res = assembleSelection(inner, { totalTier: 2, values: { coil: 3, glass: 0 }, runstate: 'idle' })
 * res.grid      // Y-up Grid，尺寸 = 骨架阶尺寸
 * res.cellGrid  // 契约朝向（row 0 = 顶部）的下标网格，用于逐格 diff
 * res.report.clamped  // 夹取清单（UI 提示）
 * ```
 */
export * from './types'
export {
  applyCouplings,
  channelBounds,
  evalGuard,
  isSet,
  parseVariantKey,
  resolveEffective,
  resolveVariantValues,
  stepIndexForEffective,
  tierSampleOf,
  variantKeyOf,
} from './values'
export { applyIndexAliases, expandOp, resolveRuleIndex, type WriteCell } from './rules'
export { AIR_PALETTE_INDEX, buildPalette, slotAt, type MultiblockPalette } from './palette'
export {
  assembleSelection,
  assembleVariant,
  assembleVariantFrames,
  channelRange,
  listChannels,
  listRunstates,
  listTierSample,
  listVariantFrames,
  listVariants,
  type AssembleOptions,
} from './assemble'
export { createReport } from './values'
