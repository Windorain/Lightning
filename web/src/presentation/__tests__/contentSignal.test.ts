/**
 * 内容信号的判据（退役 #5 的**行为侧**证据）。
 *
 * 本文件证明的关键事实：把"该不该重建"的决定权从调用方交给数据之后，
 * G1（改注解不重建几何）与 A11（转机位不重建几何）**不再依赖调用方的正确性**。
 *
 * 与之对照，负对照用例显式复现旧 `structEpoch` 的行为 —— 一个只能加一的计数器 ——
 * 并证明它在这两个场景下都会误报"需要全量重建"。
 */

import { describe, expect, it } from 'vitest'
import { createContentSignal } from '../contentSignal'
import {
  annotationDigestOf,
  contentIdentityOf,
  resourceDigestOf,
  structureDigestOf,
  type ContentIdentity,
} from '../contentIdentity'

/** 一个**可变**的假内容源（真实数据，非替身：信号读的就是这些字段）。 */
function makeSource() {
  const state = {
    documentId: 'doc:1',
    grid: [0, 1, 0, 1] as readonly number[],
    palette: ['minecraft:stone@0'] as readonly string[],
    // #334：内容级调色板身份（名称级看不见"同 name:meta、异条目内容"）
    paletteContent: [['#1', { registryId: 'minecraft:stone', meta: 0 }]] as readonly unknown[],
    annotations: [{ id: 'a1', text: '文字 A' }] as readonly unknown[],
    blobs: { stone: 'AAAA' } as unknown,
  }
  const read = (): ContentIdentity =>
    contentIdentityOf({
      documentId: state.documentId,
      structureDigest: structureDigestOf({
        frames: [state.grid],
        palette: state.palette,
        paletteContent: state.paletteContent,
        frameDecls: [{ index: 0 }],
        multiblock: null,
        layerFilter: 'all',
      }),
      annotationDigest: annotationDigestOf(state.annotations),
      resourceDigest: resourceDigestOf(state.blobs),
    })
  return { state, read }
}

describe('内容信号：变更由数据决定，不由调用方声明', () => {
  it('首次 republish ⇒ 全量计划（正常起点）；同内容再 republish ⇒ null 且不计数', () => {
    const { read } = makeSource()
    const signal = createContentSignal(read)

    const first = signal.republish('load')
    expect(first).not.toBeNull()
    expect(first!.plan).toEqual({
      reloadResources: true,
      resolveStructure: true,
      rebuildGeometry: true,
      syncAnnotations: true,
    })
    expect(signal.revisionCount.value).toBe(1)

    // 内容没变 ⇒ 无变更事实（旧机制在任何 republish 上都会自增）
    expect(signal.republish('noop')).toBeNull()
    expect(signal.revisionCount.value, '同内容重复发布不得推进版本').toBe(1)
  })

  it('G1：改注解文字 ⇒ 变更事实为真，但 rebuildGeometry 为假', () => {
    const { state, read } = makeSource()
    const signal = createContentSignal(read)
    signal.republish('load')

    state.annotations = [{ id: 'a1', text: '文字 B' }]
    const rev = signal.republish('annotation-edit')

    expect(rev).not.toBeNull()
    expect(rev!.source).toBe('annotation-edit')
    expect(rev!.change.annotationsChanged).toBe(true)
    expect(rev!.change.structureChanged).toBe(false)
    expect(rev!.plan.rebuildGeometry, 'G1：方块几何不得重建').toBe(false)
    expect(rev!.plan.syncAnnotations).toBe(true)
  })

  it('A11：转机位不触发任何内容变更（机位根本不是内容输入）', () => {
    const { read } = makeSource()
    const signal = createContentSignal(read)
    signal.republish('load')
    const before = signal.revisionCount.value

    // 机位不在 `read()` 的输入里 —— 这正是"机位不可能引发重算"的**结构性**保证：
    // 旧机制里 `bumpEpoch()` 可以被任何调用方（含机位相关代码）调用。
    for (let i = 0; i < 5; i++) expect(signal.republish('camera-move')).toBeNull()
    expect(signal.revisionCount.value).toBe(before)
  })

  it('几何真变了 ⇒ 重建几何但**不**重解码资源', () => {
    const { state, read } = makeSource()
    const signal = createContentSignal(read)
    signal.republish('load')

    state.grid = [0, 1, 0, 2]
    const rev = signal.republish('move-block')
    expect(rev!.plan.rebuildGeometry).toBe(true)
    expect(rev!.plan.resolveStructure).toBe(true)
    expect(rev!.plan.reloadResources, '改一格不必重解码纹理').toBe(false)
  })

  it('换纹理 ⇒ 重载资源（且必然连带几何，因为资源整批换了）', () => {
    const { state, read } = makeSource()
    const signal = createContentSignal(read)
    signal.republish('load')

    state.blobs = { stone: 'BBBB' }
    const rev = signal.republish('replace-texture')
    expect(rev!.plan.reloadResources).toBe(true)
    expect(rev!.change.documentChanged).toBe(true)
  })

  it('撤销回原内容 ⇒ 身份回到原值（计数器做不到这件事）', () => {
    const { state, read } = makeSource()
    const signal = createContentSignal(read)
    signal.republish('load')
    const identityA = signal.current()

    state.grid = [9, 9, 9, 9]
    signal.republish('move-block')
    expect(signal.current()!.structure).not.toBe(identityA!.structure)

    // 撤销：内容回到 A
    state.grid = [0, 1, 0, 1]
    signal.republish('undo')
    expect(signal.current()!.structure, '身份必须**回到**原值（内容身份 vs 单调计数）').toBe(
      identityA!.structure,
    )
    expect(signal.current()!.annotations).toBe(identityA!.annotations)
  })

  it('负对照：叫 bumpEpoch 的计数器在同样场景下必然误报', () => {
    // 复现旧机制的最小形状：replaceDoc() 内自增，DRW 无条件 rebuildAll
    let structEpoch = 0
    const legacyDocWrite = () => { structEpoch += 1 }
    const legacyNeedsRebuild = () => structEpoch > 0

    // 场景 1：改注解文字（G1 要求几何重建数为 0）
    legacyDocWrite()
    expect(legacyNeedsRebuild(), '计数器无法区分"改注解"与"改几何" ⇒ 必然判红 G1').toBe(true)

    // 场景 2：撤销回原内容（内容身份可判定"无需重建"，计数器只增不减）
    legacyDocWrite() // 撤销也算一次写入
    expect(structEpoch, '计数器只增，撤销后无法回到原版本').toBe(2)
  })

  it('变更记录累积可对账（诊断面：每次变更的来源与计划）', () => {
    const { state, read } = makeSource()
    const signal = createContentSignal(read)
    signal.republish('load')
    state.annotations = [{ id: 'a1', text: 'B' }]
    signal.republish('annotation-edit')
    state.grid = [1, 1, 1, 1]
    signal.republish('move-block')

    expect(signal.revisionCount.value).toBe(3)
    expect(signal.lastRevision.value!.source).toBe('move-block')
    expect(signal.lastRevision.value!.revision).toBe(3)
  })

  it('同一身份对象可比较（可作缓存键；不依赖引用相等）', () => {
    const { read } = makeSource()
    const a = read()
    const b = read()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })
})
