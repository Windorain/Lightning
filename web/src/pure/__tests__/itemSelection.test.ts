/**
 * B-5 — 左栏物品行的**经典多选语义**逐项断言（`pure/itemSelection.ts`）。
 *
 * 判据来源：§5「交互语义（多选已定案：对齐经典文件选择）」的硬约束表，逐行对应
 * (「完成定义」的选择语义表)。期望值**硬编码**在本文件，不从被测实现反读——
 * 篡改语义（例如把 Ctrl+单击改成单选、把 Shift 改成"锚点更新"）⇒ 断言必红。
 *
 * 可见顺序口径：`order` 由 UI 按渲染顺序给出（物品行 = 数量降序 / 并列键字典序）。
 * 本文件用显式 `order` 数组钉死顺序，使断言与 UI 排序解耦。
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_ITEM_SELECTION,
  applyItemRowClick,
  clearItemSelection,
  isItemSelected,
  itemRangeKeys,
  toggleItemKey,
  type ItemSelectionState,
} from '@/pure/itemSelection'

/** 可见顺序（模拟左栏渲染顺序；非字典序，用于证明"区间跟可见顺序，不跟字典序"） */
const ORDER = ['c', 'a', 'd', 'b', 'e'] as const

function state(selected: string[], anchor: string | null): ItemSelectionState {
  return { selected: new Set(selected), anchor }
}

/** 断言用读数：选中项按可见顺序排列（去掉 Set 迭代序的偶然性） */
function sel(s: ItemSelectionState): string[] {
  return ORDER.filter((k) => s.selected.has(k))
}

describe('B-5 多选语义：单击 / Ctrl / Shift / Ctrl+Shift / 清空', () => {
  it('单击 = 单选（清空其他），该行成为锚点', () => {
    const before = state(['a', 'b'], 'b')
    const after = applyItemRowClick(before, 'd', ORDER, {})
    expect(sel(after)).toEqual(['d'])
    expect(after.anchor).toBe('d')
    // 不修改入参（纯函数）
    expect(sel(before)).toEqual(['a', 'b'])
    expect(before.anchor).toBe('b')
  })

  it('单击已选中的行 = 仍是单选该行（不取消选中；取消走 Ctrl+单击 / Esc）', () => {
    const after = applyItemRowClick(state(['a', 'b'], 'a'), 'a', ORDER, {})
    expect(sel(after)).toEqual(['a'])
    expect(after.anchor).toBe('a')
  })

  it('Ctrl / Cmd + 单击 = 切换累加（未选⇒加入；已选⇒移出），锚点更新为该行', () => {
    const add = applyItemRowClick(state(['c'], 'c'), 'b', ORDER, { ctrl: true })
    expect(sel(add)).toEqual(['c', 'b'])
    expect(add.anchor).toBe('b')

    const remove = applyItemRowClick(state(['c', 'b'], 'b'), 'c', ORDER, { ctrl: true })
    expect(sel(remove)).toEqual(['b'])
    expect(remove.anchor).toBe('c')

    // 全部移出后集合为空、锚点仍是最后点击行
    const emptied = applyItemRowClick(state(['c'], 'c'), 'c', ORDER, { ctrl: true })
    expect(sel(emptied)).toEqual([])
    expect(emptied.anchor).toBe('c')
  })

  it('Shift + 单击 = 锚点→当前区间（含两端）替换既有选择；锚点不变', () => {
    // 可见顺序 c,a,d,b,e：锚点 d(2) → 目标 e(4) ⇒ [d, b, e]（字典序无关）
    const after = applyItemRowClick(state(['c'], 'd'), 'e', ORDER, { shift: true })
    expect(sel(after)).toEqual(['d', 'b', 'e'])
    expect(after.anchor, 'Shift 不改锚点').toBe('d')
  })

  it('Shift 反向区间同样含两端（目标在锚点之前）', () => {
    const after = applyItemRowClick(state(['e'], 'e'), 'a', ORDER, { shift: true })
    expect(sel(after)).toEqual(['a', 'd', 'b', 'e'])
    expect(after.anchor).toBe('e')
  })

  it('Ctrl + Shift + 单击 = 区间并入既有选择；锚点不变', () => {
    const before = state(['c'], 'a')
    // 锚点 a(1) → 目标 d(2) ⇒ 区间 [a, d]，并入已有的 c
    const after = applyItemRowClick(before, 'd', ORDER, { ctrl: true, shift: true })
    expect(sel(after)).toEqual(['c', 'a', 'd'])
    expect(after.anchor).toBe('a')

    // 区间内已选中的键保持选中（并集，不是异或）
    const again = applyItemRowClick(after, 'a', ORDER, { ctrl: true, shift: true })
    expect(sel(again)).toEqual(['c', 'a', 'd'])
    expect(again.anchor).toBe('a')
  })

  it('Esc / 点左栏空白 = 清空（共享空状态，锚点一并清）', () => {
    const cleared = clearItemSelection()
    expect(cleared).toBe(EMPTY_ITEM_SELECTION)
    expect(cleared.selected.size).toBe(0)
    expect(cleared.anchor).toBeNull()
    expect(EMPTY_ITEM_SELECTION.selected.size, '严禁就地改写共享空集').toBe(0)
  })
})

describe('B-5 多选语义：退化路径（无锚点 / 锚点已不在可见顺序）', () => {
  it('无锚点时 Shift+单击 ⇒ 退化单选该行，并建立锚点（不清空既有选择之外的东西）', () => {
    const after = applyItemRowClick(state(['a', 'b'], null), 'd', ORDER, { shift: true })
    expect(sel(after)).toEqual(['d'])
    expect(after.anchor).toBe('d')
  })

  it('锚点行已不在可见顺序（过滤层/文档变化）⇒ Shift 退化单选，且既有选择不被无声保留', () => {
    const before = state(['a'], 'zzz') // zzz 不在 ORDER
    const after = applyItemRowClick(before, 'e', ORDER, { shift: true })
    expect(sel(after)).toEqual(['e'])
    expect(after.anchor).toBe('e')
  })

  it('锚点丢失时 Ctrl+Shift ⇒ 退化切换累加（并入语义），锚点置为该行', () => {
    const after = applyItemRowClick(state(['c'], 'zzz'), 'a', ORDER, { ctrl: true, shift: true })
    expect(sel(after)).toEqual(['c', 'a'])
    expect(after.anchor).toBe('a')
  })
})

describe('B-5 多选语义：纯工具函数', () => {
  it('itemRangeKeys：可见顺序闭区间、双向、缺端 ⇒ null', () => {
    expect(itemRangeKeys(ORDER, 'c', 'd')).toEqual(['c', 'a', 'd'])
    expect(itemRangeKeys(ORDER, 'd', 'c')).toEqual(['c', 'a', 'd'])
    expect(itemRangeKeys(ORDER, 'b', 'b')).toEqual(['b'])
    expect(itemRangeKeys(ORDER, 'c', 'zzz')).toBeNull()
    expect(itemRangeKeys(ORDER, 'zzz', 'c')).toBeNull()
  })

  it('toggleItemKey：返回新 Set，不改入参', () => {
    const src = new Set(['a'])
    const added = toggleItemKey(src, 'b')
    expect([...added].sort()).toEqual(['a', 'b'])
    const removed = toggleItemKey(src, 'a')
    expect([...removed]).toEqual([])
    expect([...src]).toEqual(['a'])
  })

  it('isItemSelected：集合判定入口', () => {
    expect(isItemSelected(state(['a'], 'a'), 'a')).toBe(true)
    expect(isItemSelected(state(['a'], 'a'), 'b')).toBe(false)
  })
})
