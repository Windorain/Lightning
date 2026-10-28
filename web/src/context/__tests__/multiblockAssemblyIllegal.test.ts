/**
 * **非法组合 / 夹取行为**（契约 §5.2、§7.2、§7.3）。
 *
 * 三条硬语义：
 *   ① 通道值 0（Not set）→ 有效值回落总 Tier，越出通道域时**域夹取**（只夹取、不拒绝）；
 *   ② 域外取值（99）→ 夹取到域上界，不抛错，结果等于域上界那一档；
 *   ③ 耦合违规 → 夹取被约束的一方（`b`）并落 `report.clamped`；`couplings: []` → 不拒绝任何组合。
 *
 * 另附一份**手写最小文档**，直接对拍契约 §4.5 的规则语义（相位顺序、fill 逐层与越界跳过、
 * indexAliases 整表替换、guard 四种形态、尺寸型定阶）——不依赖 fixture。
 */
import { describe, expect, it } from 'vitest'
import {
  assembleSelection,
  assembleVariant,
  listChannels,
  listRunstates,
  listVariants,
  variantKeyOf,
} from '@/context/multiblock'
import type {
  ClampRecord,
  CouplingClampRecord,
  DomainClampRecord,
  MultiblockInnerDocument,
} from '@/context/multiblock'
import { loadInnerDocument } from './multiblockFixtureIo.mjs'

const loadInner = (name: string): MultiblockInnerDocument => loadInnerDocument(name) as MultiblockInnerDocument

const domainClamp = (c: ClampRecord): c is DomainClampRecord => 'field' in c
const couplingClamp = (c: ClampRecord): c is CouplingClampRecord => 'coupling' in c

// ---------------------------------------------------------------------------
// fixture 上的非法组合判读
// ---------------------------------------------------------------------------

describe('非法组合：只夹取、不拒绝（契约 §7.3）', () => {
  it('coil = 0（Not set）回落总 Tier：tt=1 → 有效值 1，且与 coil=1 装配结果一致', () => {
    const doc = loadInner('multiblock-ebf-2ch')
    const res = assembleSelection(doc, { totalTier: 1, values: { height: 1, coil: 0 }, runstate: 'idle' })
    expect(res.effective.coil).toBe(1)
    expect(res.report.clamped).toEqual([])
    expect(res.report.rejections).toEqual([])
    const explicit = assembleSelection(doc, { totalTier: 1, values: { height: 1, coil: 1 }, runstate: 'idle' })
    expect(JSON.stringify(res.cellGrid)).toBe(JSON.stringify(explicit.cellGrid))
  })

  it('coil = 0 回落的总 Tier 越出通道域 → 域夹取并落 clamped（tt=14 → coil 3 / glass 2）', () => {
    const doc = loadInner('multiblock-ebf-2ch')
    const res = assembleSelection(doc, { totalTier: 14, values: { height: 1, coil: 0, glass: 0 }, runstate: 'idle' })
    expect(res.effective.coil).toBe(3)
    expect(res.effective.glass).toBe(2)
    expect(res.report.clamped).toEqual([
      { field: 'coil', was: 14, now: 3, reason: 'domain' },
      { field: 'glass', was: 14, now: 2, reason: 'domain' },
    ])
    expect(res.report.rejections).toEqual([])
  })

  it('域外取值 99 夹取到域上界（不抛错），且结果等于域上界那一档', () => {
    const doc = loadInner('multiblock-ebf-2ch')
    const res = assembleSelection(doc, { totalTier: 2, values: { height: 1, coil: 99 }, runstate: 'idle' })
    expect(res.effective.coil).toBe(3)
    const hit = res.report.clamped.filter(domainClamp).find((c) => c.field === 'coil')
    expect(hit).toEqual({ field: 'coil', was: 99, now: 3, reason: 'domain' })
    expect(res.report.rejections).toEqual([])
    const atMax = assembleSelection(doc, { totalTier: 2, values: { height: 1, coil: 3 }, runstate: 'idle' })
    expect(JSON.stringify(res.cellGrid)).toBe(JSON.stringify(atMax.cellGrid))
  })

  it('totalTier 域外 99 → 夹取到域上界并落 clamped，且命中该档变体', () => {
    const doc = loadInner('multiblock-ebf-2ch')
    const res = assembleSelection(doc, { totalTier: 99, values: { height: 1 }, runstate: 'idle' })
    expect(res.totalTier).toBe(14)
    expect(res.report.clamped[0]).toEqual({ field: 'totalTier', was: 99, now: 14, reason: 'domain' })
    const atMax = assembleVariant(doc, 'height:1|coil:0|glass:0|tt:14|runstate:idle')
    expect(JSON.stringify(res.cellGrid)).toBe(JSON.stringify(atMax.cellGrid))
  })

  it('未声明的总 Tier 抽样（tt=7 不在 [1,2,14]）→ 回落最近抽样并落 warning，不抛错', () => {
    const doc = loadInner('multiblock-ebf-2ch')
    const res = assembleSelection(doc, { totalTier: 7, values: { height: 1 }, runstate: 'idle' })
    expect(res.totalTier).toBe(2)
    expect(res.report.warnings.join('\n')).toContain('tierSample')
    expect(res.report.rejections).toEqual([])
    const at2 = assembleVariant(doc, 'height:1|coil:0|glass:0|tt:2|runstate:idle')
    expect(JSON.stringify(res.cellGrid)).toBe(JSON.stringify(at2.cellGrid))
  })

  it('capacitor = 0（回落总 Tier 3 被域夹到 2）耦合不违规；结果等于 capacitor=2', () => {
    const doc = loadInner('multiblock-lsc-overlap')
    const res = assembleSelection(doc, { totalTier: 3, values: { height: 2, capacitor: 0 }, runstate: 'idle' })
    expect(res.effective.capacitor).toBe(2)
    expect(res.effective.glass).toBe(2)
    const rec = res.report.clamped.filter(domainClamp).find((c) => c.field === 'capacitor')
    expect(rec).toEqual({ field: 'capacitor', was: 3, now: 2, reason: 'domain' })
    // 耦合（capacitor ge glass）此时满足（2 >= 2）→ 无耦合夹取
    expect(res.report.clamped.filter(couplingClamp)).toEqual([])
    const at2 = assembleSelection(doc, { totalTier: 3, values: { height: 2, capacitor: 2 }, runstate: 'idle' })
    expect(JSON.stringify(res.cellGrid)).toBe(JSON.stringify(at2.cellGrid))
  })

  it('耦合违规（capacitor=1, glass=2）→ 夹取 glass 2 → 1 并落 clamped', () => {
    const doc = loadInner('multiblock-lsc-overlap')
    const res = assembleSelection(doc, {
      totalTier: 3,
      values: { height: 2, capacitor: 1, glass: 2 },
      runstate: 'idle',
    })
    expect(res.effective.capacitor).toBe(1)
    expect(res.effective.glass).toBe(1)
    const hit = res.report.clamped.filter(couplingClamp)
    expect(hit).toEqual([
      {
        coupling: 'capacitor-ge-glass',
        a: 'capacitor',
        b: 'glass',
        requires: 'ge',
        bWas: 2,
        bNow: 1,
      },
    ])
    expect(res.report.rejections).toEqual([])
  })

  it('域外 99 的 capacitor 先被域夹取、再参与耦合（无耦合违规）', () => {
    const doc = loadInner('multiblock-lsc-overlap')
    const res = assembleSelection(doc, { totalTier: 3, values: { height: 2, capacitor: 99 }, runstate: 'idle' })
    expect(res.effective.capacitor).toBe(2)
    expect(res.effective.glass).toBe(2)
    const fields = res.report.clamped.filter(domainClamp).map((c) => [c.field, c.was, c.now])
    expect(fields).toEqual([
      ['capacitor', 99, 2],
      ['glass', 3, 2],
    ])
    expect(res.report.clamped.filter(couplingClamp)).toEqual([])
  })

  it('couplings: [] + couplingMode "none" → 不拒绝任何组合（全部已声明变体可装配）', () => {
    for (const name of ['multiblock-tier-only', 'multiblock-ebf-2ch']) {
      const doc = loadInner(name)
      expect(doc.multiblock!.couplingMode).toBe('none')
      expect(doc.multiblock!.couplings).toEqual([])
      const variants = listVariants(doc)
      expect(variants.length).toBeGreaterThan(0)
      for (const v of variants) {
        const res = assembleVariant(doc, v.key)
        expect(res.report.rejections).toEqual([])
      }
    }
  })

  it('通道取值扫描：域内每一档 + 域外值都不抛错（EBF coil 0..4 / 99）', () => {
    const doc = loadInner('multiblock-ebf-2ch')
    for (const coil of [0, 1, 2, 3, 4, 99, -3]) {
      for (const tt of [1, 2, 14]) {
        const res = assembleSelection(doc, { totalTier: tt, values: { height: 3, coil }, runstate: 'active' })
        expect(res.report.rejections).toEqual([])
        expect(res.effective.coil).toBeGreaterThanOrEqual(0)
        expect(res.effective.coil).toBeLessThanOrEqual(3)
      }
    }
  })

  it('声明的通道/运行态清单可直接供通道面板消费', () => {
    const doc = loadInner('multiblock-lsc-overlap')
    const channels = listChannels(doc)
    expect(channels.map((c) => c.kind)).toEqual(['size', 'replace', 'replace'])
    expect(channels.map((c) => c.name)).toEqual(['Height', 'Lapotronic Capacitor', 'Glass'])
    expect(listRunstates(doc).map((r) => r.name)).toEqual(['Idle'])
  })
})

// ---------------------------------------------------------------------------
// 手写最小文档：规则语义直测（相位顺序 / fill / indexAliases / guard / 定阶）
// ---------------------------------------------------------------------------

/** 调色板：0 = air，1..6 = 可引用下标。 */
function palette(): Array<{ registryId: string; meta: number }> {
  return Array.from({ length: 7 }, (_, i) => ({ registryId: i === 0 ? 'air' : `test:block${i}`, meta: 0 }))
}

function makeDoc(): MultiblockInnerDocument {
  return {
    schemaVersion: 1,
    multiblockCount: 1,
    blockPalette: palette(),
    multiblock: {
      id: 'test:synth',
      displayName: 'Synthetic',
      totalTierDomain: { min: 1, max: 2, default: 1 },
      tierSample: [1, 2],
      channels: [
        { enum: 'STRUCTURE_HEIGHT', id: 'size', key: 'size', name: 'Size', kind: 'size', min: 1, max: 2, domain: { min: 1, max: 2 } },
        { enum: null, id: 'pal', key: 'pal', name: 'Pal', kind: 'replace', min: 1, max: 1, domain: { max: 1 } },
      ],
      runstates: [
        { id: 'idle', name: 'Idle', materialSwap: false },
        { id: 'active', name: 'Running', materialSwap: true },
      ],
      couplingMode: 'none',
      couplings: [],
      backbone: {
        kind: 'sizeSteps',
        sizeChannel: 'size',
        sizeSteps: [
          { channel: 'size', w: 2, hh: 1, d: 2, roles: { casing: 1 }, cellGrid: [[[1, 1]], [[1, 1]]] },
          { channel: 'size', w: 2, hh: 2, d: 2, roles: { casing: 1 }, cellGrid: [[[1, 1], [1, 1]], [[1, 1], [1, 1]]] },
        ],
      },
      rules: [
        { id: 'r.fill', phase: 'backbone', kind: 'fill', sel: { y: [0, 1] }, index: 4 },
        { id: 'r.alias', phase: 'replace', kind: 'setCell', x: 0, y: 0, z: 0, index: 3, indexAliases: { 1: 2 } },
        { id: 'r.guard.not', phase: 'runstate', kind: 'setCell', x: 1, y: 0, z: 1, index: 5, guard: { clauses: [{ channel: 'pal', not: true, value: 0 }] } },
        { id: 'r.guard.min2', phase: 'runstate', kind: 'setCell', x: 0, y: 0, z: 1, index: 6, guard: { clauses: [{ channel: 'pal', min: 2 }] } },
        { id: 'r.guard.max0', phase: 'runstate', kind: 'setCell', x: 0, y: 1, z: 0, index: 6, guard: { clauses: [{ channel: 'pal', max: 0 }] } },
        { id: 'r.oob', phase: 'replace', kind: 'fill', sel: { x: [5], z: [9] }, index: 4 },
        { id: 'r.role', phase: 'replace', kind: 'setCell', x: 1, y: 1, z: 1, indexRole: 'casing' },
      ],
      variants: [
        { key: 'size:0|pal:0|tt:1|runstate:idle' },
        { key: 'size:2|pal:1|tt:2|runstate:idle' },
        { key: 'size:1|pal:0|tt:2|runstate:idle' },
      ],
    },
    frames: [
      { index: 0, variant: 'size:0|pal:0|tt:1|runstate:idle', runstate: 'idle', stepIndex: 0, rules: ['r.alias', 'r.fill', 'r.oob'] },
      { index: 1, variant: 'size:2|pal:1|tt:2|runstate:idle', runstate: 'idle', stepIndex: 1, rules: ['r.alias', 'r.fill', 'r.guard.not', 'r.guard.min2', 'r.role'] },
      { index: 2, variant: 'size:1|pal:0|tt:2|runstate:idle', runstate: 'idle', stepIndex: 0, rules: ['r.fill', 'r.guard.not', 'r.guard.max0'] },
    ],
  }
}

describe('规则语义（手写最小文档）：相位顺序 / fill / indexAliases / guard / 定阶', () => {
  it('相位顺序 backbone → replace → runstate（后写者胜），fill 越界跳过，indexAliases 整表替换', () => {
    const doc = makeDoc()
    // 变体 A：stepIndex 0（2x1x2），r.fill（backbone）先写满 4 —— layer y=1 越界跳过；
    // 随后 r.alias（replace）整表把 1→2（此处已无 1）+ 单格 3；r.oob 的 x=5/z=9 全部越界 → 0 写入。
    const a = assembleVariant(doc, 'size:0|pal:0|tt:1|runstate:idle')
    expect(a.stepIndex).toBe(0)
    expect(a.dims).toEqual({ w: 2, h: 1, d: 2 })
    expect(a.cellGrid).toEqual([[[3, 4]], [[4, 4]]])
    expect(a.report.opsApplied).toBe(5) // 4 次 fill + 1 次 setCell，越界规则 0 写入
    expect(a.report.rulesApplied).toEqual(['r.fill', 'r.alias', 'r.oob'])
  })

  it('stepIndex 定骨干阶（尺寸型）：同一规则表在不同阶上得到不同尺寸与结果', () => {
    const doc = makeDoc()
    const b = assembleVariant(doc, 'size:2|pal:1|tt:2|runstate:idle')
    expect(b.stepIndex).toBe(1)
    expect(b.dims).toEqual({ w: 2, h: 2, d: 2 })
    // 执行序（相位 rank → 引用序）：r.fill(backbone) → r.alias → r.role → r.guard.not
    //   r.fill 先写满 4；r.alias 的整表 1→2 无命中，但单格 (0,0,0)=3 落在 fill 之后故保留；
    //   r.role 取 roles.casing = 1 写 (1,1,1)；r.guard.not（pal=1 ≠ 0 → 生效）写 (1,0,1)=5；
    //   r.guard.min2（pal=1 < 2 → guard 不通过，不进入规则序列）。
    expect(b.cellGrid).toEqual([
      [[3, 4], [4, 4]],
      [[4, 5], [4, 1]],
    ])
    expect(b.report.rulesApplied).toEqual(['r.fill', 'r.alias', 'r.role', 'r.guard.not'])
  })

  it('guard 四种形态 + Not set 回落 + 域夹取（pal=0 → 回落 tt=2 → 夹到 1）', () => {
    const doc = makeDoc()
    const c = assembleVariant(doc, 'size:1|pal:0|tt:2|runstate:idle')
    expect(c.effective.pal).toBe(1)
    expect(c.report.clamped).toEqual([{ field: 'pal', was: 2, now: 1, reason: 'domain' }])
    // r.fill 写满；r.guard.not 生效（1 ≠ 0）→ (1,0,1)=5；r.guard.max0 的 guard（pal ≤ 0）不通过 → 不生效
    expect(c.cellGrid).toEqual([[[4, 4]], [[4, 5]]])
    expect(c.report.rulesApplied).toEqual(['r.fill', 'r.guard.not'])
  })

  it('assembleSelection 与手算变体键一致；域外取值夹取后命中同一变体', () => {
    const doc = makeDoc()
    const mb = doc.multiblock!
    const key = variantKeyOf(mb.channels, { size: 2, pal: 1 }, 'idle', 2)
    expect(key).toBe('size:2|pal:1|tt:2|runstate:idle')

    const res = assembleSelection(doc, { totalTier: 2, values: { size: 9, pal: 9 }, runstate: 'idle' })
    expect(res.variantKey).toBe('size:2|pal:1|tt:2|runstate:idle')
    expect(res.report.clamped.filter(domainClamp).map((c) => [c.field, c.was, c.now])).toEqual([
      ['size', 9, 2],
      ['pal', 9, 1],
    ])
    expect(JSON.stringify(res.cellGrid)).toBe(JSON.stringify(assembleVariant(doc, key).cellGrid))
    expect(res.report.rejections).toEqual([])
  })

  it('未声明的组合不抛错：回落最近的已声明变体并落 warning', () => {
    const doc = makeDoc()
    doc.multiblock!.variants!.push({
      key: 'size:0|pal:1|tt:2|runstate:active',
      totalTier: 2,
      values: { size: 0, pal: 1 },
      runstate: 'active',
    })
    doc.frames!.push({ index: 3, variant: 'size:0|pal:1|tt:2|runstate:active', runstate: 'active', stepIndex: 0, rules: ['r.fill'] })
    // 组合 size:2|pal:1|tt:1|active 未声明 → 回落（运行态相同；同通道值优先，否则最近 L1 距离）
    const res = assembleSelection(doc, { totalTier: 1, values: { size: 2, pal: 1 }, runstate: 'active' })
    expect(res.report.rejections).toEqual([])
    expect(res.report.warnings.join('\n')).toContain('回落到最近的已声明变体')
    expect(res.variantKey).toBe('size:0|pal:1|tt:2|runstate:active')
  })

  it('非法组合的兜底：未声明通道 / 未声明运行态都被忽略并落 warning，不抛错', () => {
    const doc = makeDoc()
    const res = assembleSelection(doc, { totalTier: 1, values: { size: 0, nope: 5 }, runstate: 'ghost' })
    expect(res.report.warnings.join('\n')).toContain('未声明通道 nope')
    expect(res.report.warnings.join('\n')).toContain('运行态 ghost 未声明')
    expect(res.report.rejections).toEqual([])
    expect(res.effective.nope).toBeUndefined()
  })

  it('规则表完整性：未声明规则 / 未声明通道的 indexTable 会抛错（文档缺陷而非非法组合）', () => {
    const doc = makeDoc()
    doc.frames![0]!.rules = ['r.nope']
    expect(() => assembleVariant(doc, 'size:0|pal:0|tt:1|runstate:idle')).toThrow(/未声明规则/)

    const doc2 = makeDoc()
    doc2.multiblock!.rules!.push({ id: 'r.bad', kind: 'setCell', x: 0, y: 0, z: 0, channel: 'ghost', indexTable: [1] })
    doc2.frames![0]!.rules = ['r.bad']
    expect(() => assembleVariant(doc2, 'size:0|pal:0|tt:1|runstate:idle')).toThrow(/未声明\/未解析通道/)

    const doc3 = makeDoc()
    expect(() => assembleVariant(doc3, 'size:0|pal:0|tt:1|runstate:ghost')).toThrow(/未声明的变体键/)
  })
})
