/**
 * **方块检查器**面板 —— 生成式属性面板。
 *
 * 依据：「基础 Inspector 由 RNA 生成」；「属性区不得因多选而消失」。
 *
 * ## 与旧实现的差别
 *
 * 旧版本用 `singleBlockLayout()` 手写两条 `kind: 'property'`（`block.id` / `block.pos`），
 * 并对多选**另写一条** `multiBlockLayout()` 只显示「N 个方块 / M 种类型」——
 * 即多选时属性区**一个属性都没有**（无法批量改）。新形态：无论单选多选，属性都由
 * `lightning.block` 的声明生成；多选时混合值由 RNA 读面显式标出，
 * 统一值提交是**一次原子命令**（`applySetProperty` 的多选批次）。
 *
 * `renderMode`/`NBT`/`facing` 这些**只读的调色板事实**不再是手写 `kind: 'property'`
 * （它们本来就没有写面），而是留在布局里作为诊断标签；属性部分由 `component` 生成。
 */

import type { Context } from '@/runtime/context'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '@/runtime/screenTypes'
import type { UILayout, UILayoutItem } from '../types/layout'
import type { BlockRef } from '@/context/selection'
import { getBlockPaletteEntry } from '@/context/queries'
import PropertyInspector from '../PropertyInspector.vue'

/** 调色板事实（只读诊断）—— 与属性写面无关，故作为布局片段交给生成式面板一并渲染。 */
function paletteFacts(ctx: Context, item: BlockRef): UILayoutItem[] {
  const entry = getBlockPaletteEntry(ctx, item.pos)
  const items: UILayoutItem[] = []
  if (!entry) return items
  if (entry.renderMode) items.push({ kind: 'label', text: `渲染模式: ${entry.renderMode}` })
  if (entry.facing) items.push({ kind: 'label', text: `朝向: ${entry.facing}` })
  if (entry.nbt && Object.keys(entry.nbt).length > 0) {
    items.push(
      { kind: 'separator' },
      { kind: 'scroll', items: [{ kind: 'label', text: '\n' + JSON.stringify(entry.nbt, null, 2) }] },
    )
  }
  return items
}

export const blockInspectorPanel: PanelDeclaration = {
  id: 'block-inspector',
  label: '方块检查器',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,
  workspaces: ['preview'],

  poll(ctx: Context): boolean {
    if (ctx.getSelection().items.value.size >= 1) return true
    // 悬停方块也给面板（与注解面板的悬停语义一致）
    return ctx.getHoveredBlock().value !== null
  },

  component: PropertyInspector,

  /**
   * 布局**只**承载只读诊断片段 —— 属性行由 `PropertyInspector` 从 RNA 声明生成
   * （`PanelTabs` 把 `layout()` 作为 `fragment` 传给组件，故这里不再有任何
   * `kind: 'property'`）。
   */
  layout(ctx: Context): UILayout {
    const items = [...ctx.getSelection().items.value].filter((e) => e.kind === 'block')
    if (items.length === 1) {
      const facts = paletteFacts(ctx, items[0]!.ref)
      return { kind: 'column', align: false, items: facts.length > 0 ? [{ kind: 'separator' }, ...facts] : [] }
    }
    return { kind: 'column', align: false, items: [] }
  },
}
