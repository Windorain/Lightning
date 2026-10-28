/**
 * **字段级拒绝回执存储**的判据。
 *
 * ## 为什么单独测这个存储
 *
 * 它是"文本控件拒写可见"的**唯一读面**（S0 域 2 ② 的缺口）。它的三条语义
 * 决定了界面行为，任何一条写错都不会被 UI 判据稳定抓到：
 *
 *  1. **按键**：属性描述符 id（写点与读点同一个值）——不是局部 id，
 *     否则就是核销过的"写一个键、读另一个键"的镜像形态；
 *  2. **成功即清**：同字段的成功写入必须清掉该字段的回执（否则界面长期挂着旧错误）；
 *  3. **同错去重**：同一字段同一错误重复写不换对象（否则每帧重渲染，且时间戳被刷掉）。
 */
import { describe, expect, it } from 'vitest'
import type { DomainError } from '@/application/contracts'
import { createFieldRejectionStore } from '@/runtime/fieldRejections'

const E1: DomainError = { code: 'UnsupportedOperation', params: { reason: 'identity-not-in-palette' } }
const E2: DomainError = { code: 'InvalidValue', params: { reason: 'outsideDeclaredGrid', x: 1, y: 2, z: 3 } }

describe('字段拒绝回执', () => {
  it('写入后按**属性描述符 id**可读（与写点同键）', () => {
    const s = createFieldRejectionStore()
    s.reject('lightning.block.id', E1)
    expect(s.get('lightning.block.id')?.error).toBe(E1)
    expect(s.get('block.id'), '局部 id 不得命中（那正是旧镜像的读键错位）').toBeNull()
    expect(s.table.value['lightning.block.id']?.at).toBeGreaterThan(0)
  })

  it('同字段成功 ⇒ 清掉该字段（其它字段不受影响）', () => {
    const s = createFieldRejectionStore()
    s.reject('lightning.block.id', E1)
    s.reject('lightning.block.tooltip', E2)
    s.clear('lightning.block.id')
    expect(s.get('lightning.block.id')).toBeNull()
    expect(s.get('lightning.block.tooltip')?.error).toBe(E2)
  })

  it('同一错误重复写**不换对象**（避免每帧重渲染/时间戳被刷）', () => {
    const s = createFieldRejectionStore()
    s.reject('lightning.block.id', E1)
    const first = s.table.value
    const at = s.get('lightning.block.id')!.at
    s.reject('lightning.block.id', E1)
    expect(s.table.value, '同一个错误不得产生新表对象').toBe(first)
    expect(s.get('lightning.block.id')!.at).toBe(at)
  })

  it('换了错误 ⇒ 换表对象（响应式依赖必须看到变化）', () => {
    const s = createFieldRejectionStore()
    s.reject('lightning.block.id', E1)
    const first = s.table.value
    s.reject('lightning.block.id', E2)
    expect(s.table.value).not.toBe(first)
    expect(s.get('lightning.block.id')?.error).toBe(E2)
  })

  it('clearAll 清空（换文档/卸载）', () => {
    const s = createFieldRejectionStore()
    s.reject('a', E1)
    s.reject('b', E2)
    s.clearAll()
    expect(Object.keys(s.table.value)).toEqual([])
  })

  it('负对照：清空一个不存在的键不得产生新对象（防无意义重渲染）', () => {
    const s = createFieldRejectionStore()
    const first = s.table.value
    s.clear('nope')
    expect(s.table.value).toBe(first)
  })
})
