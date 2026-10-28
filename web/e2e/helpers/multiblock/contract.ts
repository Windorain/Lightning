/**
 * 无头渲染断言管线 —— 多方块 fixture 契约（**钉死的期望值**）。
 *
 * 反同义反复（anti-tautology）守则：
 *  期望值在这里**硬编码**，并在 spec 里与「浏览器里解析出的 RuntimeDocument 公开观测值」
 *  对比。绝不把期望值改成「再读一遍被测文件」——那样篡改文件后两边一起变，断言永远绿。
 *
 * fixture 原件位置：`web/src/context/__tests__/fixtures/multiblock-*.json`（既有产物，内容勿改）。
 * 本模块只**读**它们；所有篡改都发生在测试内存中的注入副本上。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { expect } from '@playwright/test'
import type { DocObservation } from './harness'

const HERE = import.meta.dirname
/** `web/`（本文件在 `web/e2e/helpers/multiblock/`）。 */
export const WEB_ROOT = path.resolve(HERE, '..', '..', '..')
/** 仓库 fixture 目录（只读）。 */
export const FIXTURE_DIR = path.join(WEB_ROOT, 'src', 'context', '__tests__', 'fixtures')

export interface MultiblockFixtureContract {
  /** fixture 文件名。 */
  file: string
  displayName: string
  channelKeys: string[]
  channelEnums: (string | null)[]
  channelNames: string[]
  channelKinds: string[]
  runstateIds: string[]
  runstateNames: string[]
  variantCount: number
  ruleCount: number
  frameCount: number
  totalTierDomain: { min: number; max: number }
  backbone: { sizeChannel: string; stepCount: number }
  /**
   * 骨架第 0 阶的 cellGrid 形状 `[d, h, w]`。
   * 「篡改一格」证伪用到的**格级**观测基线。
   */
  step0Shape: [number, number, number]
  /**
   * 骨架第 0 阶 `cellGrid[0][*][0]`（z=0 切片、x=0 那一整列）的逐格下标。
   * 这是 Phase 1 唯一可经公开观测拿到的「逐格」数据（帧格由装配器产生，尚未接线）。
   */
  step0Column: number[]
  blockPaletteSize: number
}

/**
 * 三份多方块 fixture 的钉死契约。
 * 数值取自 fixture 文件声明，是**验收基数**：
 * 文件若被改动，这些断言必须变红（这正是它们的价值）。
 */
export const MULTIBLOCK_CONTRACTS: MultiblockFixtureContract[] = [
  {
    file: 'multiblock-ebf-2ch.json',
    displayName: 'Electric Blast Furnace',
    channelKeys: ['height', 'coil', 'glass'],
    channelEnums: ['STRUCTURE_HEIGHT', 'HEATING_COIL', 'BOROGLASS'],
    channelNames: ['Height', 'Coil', 'Glass'],
    channelKinds: ['size', 'replace', 'replace'],
    runstateIds: ['idle', 'active'],
    runstateNames: ['Idle', 'Running'],
    variantCount: 432,
    ruleCount: 12,
    frameCount: 432,
    totalTierDomain: { min: 1, max: 14 },
    backbone: { sizeChannel: 'height', stepCount: 5 },
    step0Shape: [3, 1, 3],
    step0Column: [1],
    blockPaletteSize: 9,
  },
  {
    file: 'multiblock-tier-only.json',
    displayName: 'Tier Column',
    channelKeys: ['structTier'],
    channelEnums: [null],
    channelNames: ['Structure Tier'],
    channelKinds: ['replace'],
    runstateIds: ['idle'],
    runstateNames: ['Idle'],
    variantCount: 12,
    ruleCount: 9,
    frameCount: 12,
    totalTierDomain: { min: 1, max: 3 },
    backbone: { sizeChannel: 'totalTier', stepCount: 3 },
    step0Shape: [1, 3, 1],
    step0Column: [1, 2, 2],
    blockPaletteSize: 6,
  },
  {
    file: 'multiblock-lsc-overlap.json',
    displayName: 'Lapotronic Super Capacitor',
    channelKeys: ['height', 'capacitor', 'glass'],
    channelEnums: ['STRUCTURE_HEIGHT', 'LSC_CAPACITOR', 'BOROGLASS'],
    channelNames: ['Height', 'Lapotronic Capacitor', 'Glass'],
    channelKinds: ['size', 'replace', 'replace'],
    runstateIds: ['idle'],
    runstateNames: ['Idle'],
    variantCount: 108,
    ruleCount: 9,
    frameCount: 108,
    totalTierDomain: { min: 1, max: 14 },
    backbone: { sizeChannel: 'height', stepCount: 5 },
    step0Shape: [3, 1, 3],
    step0Column: [1],
    blockPaletteSize: 6,
  },
]

export function contractFor(file: string): MultiblockFixtureContract {
  const c = MULTIBLOCK_CONTRACTS.find((x) => x.file === file)
  if (!c) throw new Error(`未登记的 fixture 契约 ${file}`)
  return c
}

// ---------------------------------------------------------------------------
// fixture 读写（只读原件 + 内存篡改副本）
// ---------------------------------------------------------------------------

export interface MultiblockFixtureEnvelope {
  documentFormat: string
  payloadEncoding: string
  payloadNote?: string
  meta: Record<string, unknown>
  payload: string
}

export interface LoadedFixture {
  /** 信封原件（可直接注入）。 */
  envelope: MultiblockFixtureEnvelope
  /** 解出的契约内层 body（含 multiblock / blockPalette / frames）。 */
  inner: Record<string, unknown>
}

/** 读取仓库 fixture 原件（不修改）。 */
export function readFixture(file: string): LoadedFixture {
  const p = path.join(FIXTURE_DIR, file)
  const envelope = JSON.parse(fs.readFileSync(p, 'utf8')) as MultiblockFixtureEnvelope
  return { envelope, inner: decodeInner(envelope) }
}

/** 解码信封内层 body（fixture 为 base64(未压缩 JSON)；真实产物为 base64(gzip)）。 */
export function decodeInner(envelope: MultiblockFixtureEnvelope): Record<string, unknown> {
  const buf = Buffer.from(envelope.payload, 'base64')
  const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8')
  return JSON.parse(text) as Record<string, unknown>
}

/**
 * 用篡改后的内层 body 重建一份**只存在于内存**的信封副本。
 * 仓库原件一字不改；注入路径与原件完全相同（同为 Envelope → Multiblock parser）。
 */
export function rewrap(
  envelope: MultiblockFixtureEnvelope,
  inner: Record<string, unknown>,
): MultiblockFixtureEnvelope {
  return { ...envelope, payload: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}

/** 深度克隆（篡改副本用，避免污染同一测试内的原件对象）。 */
export function cloneInner(inner: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(inner)) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 断言谓词（纯函数：返回违反项列表；空数组 = 通过）
// ---------------------------------------------------------------------------

/** 「声明级」契约：通道条数/标识/呈现名、运行态、变体数、规则数、总 Tier 域、调色板。 */
export function declarationViolations(
  doc: DocObservation,
  c: MultiblockFixtureContract,
): string[] {
  const v: string[] = []
  if (!doc.hasDoc) return ['doc 未加载（hasDoc=false）']
  if (!doc.isMultiblock) v.push(`doc.isMultiblock=${doc.isMultiblock}，期望 true`)
  // 注：`documentShape` 形态键在**真实产物里位于信封 meta**（契约 §2），
  // 因此 `multiblockSource`（契约内层 body）读到的 `documentShape` 为 null 属正常。
  // 形态判别的公开观测点用 `doc.isMultiblock`；文件级形态键由 spec 直接断言信封 meta。
  if (doc.multiblockSourcePresent !== true) {
    v.push('multiblockSource 为空（装配器输入缺失）')
  }
  if (doc.channelCount !== c.channelKeys.length) {
    v.push(`通道声明条数=${doc.channelCount}，期望 ${c.channelKeys.length}`)
  }
  const keys = doc.channels.map((x) => x.key)
  if (JSON.stringify(keys) !== JSON.stringify(c.channelKeys)) {
    v.push(`通道 key=${JSON.stringify(keys)}，期望 ${JSON.stringify(c.channelKeys)}`)
  }
  const enums = doc.channels.map((x) => x.enumName)
  if (JSON.stringify(enums) !== JSON.stringify(c.channelEnums)) {
    v.push(`通道 enum=${JSON.stringify(enums)}，期望 ${JSON.stringify(c.channelEnums)}`)
  }
  const names = doc.channels.map((x) => x.name)
  if (JSON.stringify(names) !== JSON.stringify(c.channelNames)) {
    v.push(`通道呈现名=${JSON.stringify(names)}，期望 ${JSON.stringify(c.channelNames)}`)
  }
  const kinds = doc.channels.map((x) => x.kind)
  if (JSON.stringify(kinds) !== JSON.stringify(c.channelKinds)) {
    v.push(`通道 kind=${JSON.stringify(kinds)}，期望 ${JSON.stringify(c.channelKinds)}`)
  }
  if (doc.runstateCount !== c.runstateIds.length) {
    v.push(`运行态数=${doc.runstateCount}，期望 ${c.runstateIds.length}`)
  }
  const rsIds = doc.runstates.map((x) => x.id)
  if (JSON.stringify(rsIds) !== JSON.stringify(c.runstateIds)) {
    v.push(`运行态 id=${JSON.stringify(rsIds)}，期望 ${JSON.stringify(c.runstateIds)}`)
  }
  const rsNames = doc.runstates.map((x) => x.name)
  if (JSON.stringify(rsNames) !== JSON.stringify(c.runstateNames)) {
    v.push(`运行态呈现名=${JSON.stringify(rsNames)}，期望 ${JSON.stringify(c.runstateNames)}`)
  }
  if (doc.variantCount !== c.variantCount) {
    v.push(`变体数=${doc.variantCount}，期望 ${c.variantCount}`)
  }
  if (doc.ruleCount !== c.ruleCount) {
    v.push(`差异规则条数=${doc.ruleCount}，期望 ${c.ruleCount}`)
  }
  // 多方块文档的帧清单是**场景**（变体配置集合），不是时间轴 ⇒ 内核帧轴恒 0。
  if (doc.frameCount !== 0) {
    v.push(`时间轴帧数=${doc.frameCount}，期望 0（场景不是时间轴）`)
  }
  if (doc.multiblockSceneCount !== c.frameCount) {
    v.push(`场景声明数=${doc.multiblockSceneCount}，期望 ${c.frameCount}（一变体一场景）`)
  }
  if (
    !doc.totalTierDomain ||
    doc.totalTierDomain.min !== c.totalTierDomain.min ||
    doc.totalTierDomain.max !== c.totalTierDomain.max
  ) {
    v.push(
      `总 Tier 域=${JSON.stringify(doc.totalTierDomain)}，期望 ${JSON.stringify(c.totalTierDomain)}`,
    )
  }
  if (doc.blockPaletteSize !== c.blockPaletteSize) {
    v.push(`调色板条目数=${doc.blockPaletteSize}，期望 ${c.blockPaletteSize}`)
  }
  // `warnings` 的来源（R2/S3 起）= **测试进程重解析内核源根**（见 `harness#withSourceParse`）：
  // 旧来源 `doc.multiblock.warnings` 随 `Context#legacyRenderSource()` 一起退役。
  if (doc.warnings.length > 0) {
    v.push(`解析告警非空（内核源根重解析）：${doc.warnings.join(' | ')}`)
  }
  // **伴随断言**（R2/S3 要求）：应用侧观测到的声明内容必须 = 重解析得到的
  // 对应值 —— 用**内容**证明"应用解析的就是这份 body"。缺它时"告警为空"可能只是
  // "重解析了别的字节"，判据就退化成"文件本身没瑕疵"而不再是"应用读的是它"。
  if (doc.declarationMatchesSource !== true) {
    v.push(
      `应用侧声明与内核源根重解析不一致（declarationMatchesSource=${doc.declarationMatchesSource}）`
      + '：不得用"告警为空"掩盖"应用解析的不是这份 body"',
    )
  }
  return v
}

/** 「格级」契约：骨架形状 + 第 0 阶逐格下标。篡改一格必然命中这里。 */
export function backboneViolations(
  doc: DocObservation,
  c: MultiblockFixtureContract,
): string[] {
  const v: string[] = []
  const bb = doc.backbone
  if (!bb) return ['骨架观测为空（doc.multiblock.decl.backbone 缺失）']
  if (bb.kind !== 'sizeSteps') v.push(`backbone.kind=${bb.kind}，期望 "sizeSteps"`)
  if (bb.sizeChannel !== c.backbone.sizeChannel) {
    v.push(`backbone.sizeChannel=${bb.sizeChannel}，期望 ${c.backbone.sizeChannel}`)
  }
  if (bb.stepCount !== c.backbone.stepCount) {
    v.push(`backbone.sizeSteps 阶数=${bb.stepCount}，期望 ${c.backbone.stepCount}`)
  }
  const s0 = bb.steps[0]
  if (!s0) return [...v, '骨架第 0 阶缺失']
  const shape: [number, number, number] = [s0.d, s0.h, s0.w]
  if (JSON.stringify(shape) !== JSON.stringify(c.step0Shape)) {
    v.push(`第 0 阶 cellGrid 形状 [d,h,w]=${JSON.stringify(shape)}，期望 ${JSON.stringify(c.step0Shape)}`)
  }
  const col = s0.cellGrid[0]?.map((row) => row[0])
  if (JSON.stringify(col) !== JSON.stringify(c.step0Column)) {
    v.push(
      `第 0 阶 z=0/x=0 逐格下标=${JSON.stringify(col)}，期望 ${JSON.stringify(c.step0Column)}`,
    )
  }
  if (doc.backboneMatchesSource !== true) {
    v.push(`decl.backbone 与 multiblockSource 原文不一致（backboneMatchesSource=${doc.backboneMatchesSource}）`)
  }
  return v
}

/** 断言声明级契约（失败信息带 fixture 名与全部违反项）。 */
export function expectDeclaration(
  doc: DocObservation,
  c: MultiblockFixtureContract,
  label = c.file,
): void {
  const v = declarationViolations(doc, c)
  expect(v, `${label}：文档声明与钉死的 fixture 契约不一致`).toEqual([])
}

/** 断言格级契约。 */
export function expectBackbone(
  doc: DocObservation,
  c: MultiblockFixtureContract,
  label = c.file,
): void {
  const v = backboneViolations(doc, c)
  expect(v, `${label}：骨架格级数据与钉死的 fixture 契约不一致`).toEqual([])
}
