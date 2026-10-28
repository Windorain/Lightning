/**
 * **Wiki 远端陈旧判据**的纯函数判据：完整产物 canonical 语义相等 + baseline 派生缓存。
 *
 * 覆盖：
 *  1. 键顺序不同但语义相同 ⇒ **不脏**（避免刚装载就报未保存）；
 *  2. 数组顺序不同 ⇒ **脏**；
 *  3. `cellGrid` 等摘要字段表之外的差异 ⇒ **脏**；
 *  4. 缺一侧（baseline/current）⇒ **脏**；双 null ⇒ 不脏；
 *  5. 同一 baseline 对象重复求值只 canonicalize 一次（WeakMap 派生缓存），current 每次重算；
 *  6. baseline 整对象替换 ⇒ 新对象重新规范化（不残留旧缓存）。
 */
import { describe, expect, it } from 'vitest'
import { canonicalize } from '@/domain/identity'
import {
  createWikiRemoteDirtyReader,
  hasWikiRemoteChanges,
} from '@/wiki/wikiRemoteDirty'

function docOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: '2.0',
    id: 'remote-doc',
    meta: { title: 'A', author: '' },
    frames: [
      {
        index: 0,
        structure: {
          cellGrid: [
            [
              [1, 1],
              [1, 1],
            ],
          ],
          blockPalette: [{ registryId: 'minecraft:stone', meta: 0 }],
        },
      },
    ],
    tooltipPalette: ['a', 'b'],
    annotations: [],
    labels: [],
    ...over,
  }
}

describe('hasWikiRemoteChanges：完整产物 vs 远端基线', () => {
  it('语义相同、键顺序不同 ⇒ 不脏（canonical 键序稳定）', () => {
    const a = docOf()
    const reordered: Record<string, unknown> = {}
    for (const k of Object.keys(a).reverse()) reordered[k] = a[k]
    expect(hasWikiRemoteChanges(a, reordered), '键序不是内容差异').toBe(false)
  })

  it('cellGrid 改变（摘要字段之外）⇒ 脏', () => {
    const a = docOf()
    const b = docOf({
      frames: [
        {
          index: 0,
          structure: {
            cellGrid: [
              [
                [1, 2],
                [1, 1],
              ],
            ],
            blockPalette: [{ registryId: 'minecraft:stone', meta: 0 }],
          },
        },
      ],
    })
    expect(hasWikiRemoteChanges(a, b), '主编辑内容(cellGrid)必须被全量判据看见').toBe(true)
  })

  it('数组顺序改变 ⇒ 脏；数值 0/-0 视为相同', () => {
    expect(hasWikiRemoteChanges({ xs: [1, 2] }, { xs: [2, 1] })).toBe(true)
    expect(hasWikiRemoteChanges({ n: 0 }, { n: -0 })).toBe(false)
  })

  it('缺一侧 ⇒ 脏（不能把"不知道"当干净）；双 null ⇒ 不脏', () => {
    expect(hasWikiRemoteChanges(null, docOf()), '缺 baseline 不得当干净').toBe(true)
    expect(hasWikiRemoteChanges(docOf(), null), '缺 current 不得当干净').toBe(true)
    expect(hasWikiRemoteChanges(null, null), '双侧都不存在才是否定形态').toBe(false)
  })
})

describe('baseline canonical 派生缓存（WeakMap，按对象身份）', () => {
  it('同一 baseline 对象重复 dirty 求值只规范化一次；current 每次重算', () => {
    const calls: unknown[] = []
    const reader = createWikiRemoteDirtyReader((value) => {
      calls.push(value)
      return canonicalize(value)
    })
    const baseline = docOf()
    const currentA = docOf({ changed: 'a' })
    const currentB = docOf({ changed: 'b' })

    expect(reader.hasChanges(baseline, currentA)).toBe(true)
    expect(reader.hasChanges(baseline, currentB)).toBe(true)
    expect(reader.hasChanges(baseline, currentA)).toBe(true)

    expect(
      calls.filter((v) => v === baseline),
      '同一 baseline 对象只允许 canonicalize 一次',
    ).toHaveLength(1)
    expect(calls, 'baseline 1 次 + current 3 次').toHaveLength(4)
  })

  it('baseline 整对象替换 ⇒ 新对象重新规范化（不残留旧字符串）', () => {
    const calls: unknown[] = []
    const reader = createWikiRemoteDirtyReader((value) => {
      calls.push(value)
      return canonicalize(value)
    })
    const current = docOf({ x: 1 })
    const baselineA = docOf({ x: 0 })
    const baselineB = docOf({ x: 1 }) // 与 current 语义相同、但是新对象

    expect(reader.hasChanges(baselineA, current)).toBe(true)
    expect(reader.hasChanges(baselineA, current)).toBe(true)
    expect(calls.filter((v) => v === baselineA)).toHaveLength(1)

    expect(reader.hasChanges(baselineB, current), '替换后的基线立即与 current 相同 ⇒ clean').toBe(false)
    expect(calls.filter((v) => v === baselineB), '新基线对象必须重新规范化一次').toHaveLength(1)

    const currentB = docOf({ x: 2 })
    expect(reader.hasChanges(baselineB, currentB), 'current 变化仍立即 dirty').toBe(true)
  })

  it('缓存不是 dirty 布尔：同一 baseline 下 current 反复变化仍逐次判定', () => {
    const reader = createWikiRemoteDirtyReader()
    const baseline = docOf()
    expect(reader.hasChanges(baseline, docOf())).toBe(false)
    expect(reader.hasChanges(baseline, docOf({ tooltipPalette: ['a', 'b', 'c'] }))).toBe(true)
    expect(reader.hasChanges(baseline, docOf())).toBe(false)
  })
})
