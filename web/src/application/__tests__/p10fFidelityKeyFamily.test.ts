/**
 * **P10f D1(b) 判据：保真键并入 recovery/save 家族**（#301；GF-14）。
 *
 * ## 要证明什么
 *
 * 逐条钉住本批修掉的**八处**分歧（每处一条断言，不是"整体看起来像"）：
 *
 * | # | 分歧 | 本条判据 |
 * |---|---|---|
 * | 1 | 缺 `scope` 段 | 键含 scope，且解析回来正确 |
 * | 2 | 缺 `instanceId` 段 | 同文档不同实例 ⇒ **不同键**（多标签不互覆） |
 * | 3 | 不被 `artifactKindOfKey` 识别 | 返回 `fidelity-record`（旧方案返回 `null`） |
 * | 4 | 与 `saveStoreKey` 位置长度撞车 | 段数不同（6 vs 5）⇒ 互不误解析 |
 * | 5 | 无解析器 / 不可逆 | `parseFidelityStoreKey` 往返成立 |
 * | 6 | 返回裸 `string` | 返回 `Result`，空 id ⇒ `err` |
 * | 7 | 版本硬编码在模板串 | 具名 `FIDELITY_SCHEMA_VERSION`，且出现在键里 |
 * | 8 | 空 id 静默降级为 `'unnamed'` | 权威构造器**显式拒绝** |
 *
 * ## 为什么逐条（而不是"新键能用就行"）
 *
 * 八处分歧是"不兼容"的**机械证据**；只断言"新键能被解析"会让其中任何一处
 * 悄悄回归（例如有人把 instance 段去掉，键**照样能解析**，但多标签又开始互覆）。
 */

import { describe, it, expect } from 'vitest'
import {
  artifactKindOfKey,
  fidelityStoreKey,
  FIDELITY_SCHEMA_VERSION,
  instanceIdentity,
  parseFidelityStoreKey,
  parseSaveStoreKey,
  saveStoreKey,
} from '@/application/recovery'

const A = instanceIdentity('workbench', 'tab-a')
const B = instanceIdentity('workbench', 'tab-b')

describe('P10f D1(b) · ① 键形状：带 scope + instance 段（分歧 1/2）', () => {
  it('键含 scope 与 instanceId 两段，且各就各位', () => {
    const r = fidelityStoreKey(A, 'doc-1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe('lk.fidelity.v1.workbench.tab-a.doc-1')
    const parsed = parseFidelityStoreKey(r.value)!
    expect(parsed.scope, '分歧 1：scope 必须可解析回来').toBe('workbench')
    expect(parsed.instanceId, '分歧 2：instanceId 必须可解析回来').toBe('tab-a')
    expect(parsed.documentId).toBe('doc-1')
  })

  it('**分歧 2 的实质**：同文档不同实例 ⇒ **不同键**（多标签不得静默互覆）', () => {
    const a = fidelityStoreKey(A, 'same-doc')
    const b = fidelityStoreKey(B, 'same-doc')
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value, '两个标签页编辑同一文档必须落**不同**键').not.toBe(b.value)
  })
})

describe('P10f D1(b) · ② 分类器可见（分歧 3）+ 不与正式保存撞车（分歧 4）', () => {
  it('`artifactKindOfKey` 识别保真键（旧方案对它**不可见**）', () => {
    const r = fidelityStoreKey(A, 'doc-1')
    if (!r.ok) throw new Error('前提失败')
    expect(artifactKindOfKey(r.value), '分歧 3：必须被分类器识别').toBe('fidelity-record')
  })

  it('**分歧 4**：保真键与正式保存键互不误解析（段数 6 vs 5）', () => {
    const f = fidelityStoreKey(A, 'doc-1')
    const s = saveStoreKey('workbench', 'doc-1')
    if (!f.ok || !s.ok) throw new Error('前提失败')
    // 形状不同 ⇒ 三个解析器各自只认自己的那一族
    expect(parseFidelityStoreKey(s.value), '正式保存键不得被当作保真键').toBeNull()
    expect(parseSaveStoreKey(f.value), '保真键不得被当作正式保存键').toBeNull()
    // 且字面量种类段不同（不是"只靠位置区分"）
    expect(f.value.split('.')[1]).toBe('fidelity')
    expect(s.value.split('.')[1]).toBe('save')
    expect(f.value.split('.').length, '保真键 6 段（含 instance）').toBe(6)
    expect(s.value.split('.').length, '正式保存键 5 段（不含 instance —— 它是文档级事实）').toBe(5)
  })
})

describe('P10f D1(b) · ③ 可逆（分歧 5）+ Result（分歧 6）+ 具名版本（分歧 7）', () => {
  it('**分歧 5**：解析器往返成立（旧方案结构上不可逆）', () => {
    const r = fidelityStoreKey(instanceIdentity('embed', 'inst-9'), 'doc-x')
    if (!r.ok) throw new Error('前提失败')
    const p = parseFidelityStoreKey(r.value)!
    // 往返：用解析出的成分重建 ⇒ 同一个键（这是"可逆"的定义）
    const again = fidelityStoreKey({ scope: p.scope, instanceId: p.instanceId }, p.documentId)
    expect(again.ok && again.value).toBe(r.value)
  })

  it('**分歧 5 反向**：形状不合 ⇒ `null`（不猜测、不降级）', () => {
    for (const bad of [
      'lk.fidelity.v1.workbench.doc-1', // 缺 instance 段
      'lk.fidelity.doc-1.record', // 旧方案的形状（必须不被认）
      'lk.recovery.v1.workbench.tab-a.doc-1', // 恢复副本键
      'nonsense',
    ]) {
      expect(parseFidelityStoreKey(bad), `「${bad}」不得被解析成保真键`).toBeNull()
    }
  })

  it('**分歧 6**：空文档 id ⇒ `err`（不是静默降级）', () => {
    const r = fidelityStoreKey(A, '   ')
    expect(r.ok, '分歧 6+8：空 id 必须显式拒绝').toBe(false)
  })

  it('**分歧 7**：版本是**具名常量**且出现在键里（不是模板串里的字面量）', () => {
    const r = fidelityStoreKey(A, 'doc-1')
    if (!r.ok) throw new Error('前提失败')
    expect(r.value).toContain(`.v${FIDELITY_SCHEMA_VERSION}.`)
    expect(FIDELITY_SCHEMA_VERSION, '版本必须是个数（具名常量）').toBeTypeOf('number')
    // 解析回来的版本与常量一致（升版即隔离旧值）
    expect(parseFidelityStoreKey(r.value)!.schemaVersion).toBe(FIDELITY_SCHEMA_VERSION)
  })
})
