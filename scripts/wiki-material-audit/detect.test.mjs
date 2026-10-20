/**
 * detect.test.mjs —— 判型判据的正/负对照（零依赖，node --test）
 * ============================================================================
 * 每条判据都必须能同时给出「命中」与「不命中」两侧的证据，否则阈值只是摆设。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { auditDocument, classifyBlob, judgeMaterial } from './detect.mjs'
import {
  goodTexture,
  gridWith,
  makeBlock,
  makeDocument,
  makeEnvelope,
  makeMaterial,
  placeholder16,
  pngBase64,
  strip,
} from './fixtures.mjs'
import { pngStats } from './png.mjs'

function placeholderDoc({ used }) {
  return makeDocument({
    blobs: [pngBase64(placeholder16())],
    materials: [makeMaterial('minecraft:stone', 0)],
    blocks: [makeBlock('minecraft:stone', [0])],
    grid: gridWith([used ? 0 : -1]),
  })
}

test('missingTexture 命中：占位 blob 被 grid 里的方块引用 => status=bad', () => {
  const result = auditDocument(placeholderDoc({ used: true }))
  assert.equal(result.status, 'bad')
  assert.equal(result.hitsMissingTexture, 1)
  assert.equal(result.badBlobs[0].usedInGrid, true)
  assert.deepEqual(result.badBlobs[0].stats, {
    width: 16,
    height: 16,
    uniqueColors: 2,
    magentaRatio: 0.5,
    blackRatio: 0.5,
    bytes: result.badBlobs[0].stats.bytes,
  })
})

test('missingTexture 残留：坏 blob 存在但没有任何格子用到 => status=warn，不冤枉页面', () => {
  const result = auditDocument(placeholderDoc({ used: false }))
  assert.equal(result.status, 'warn')
  assert.equal(result.hitsMissingTexture, 1)
  assert.equal(result.badBlobs[0].usedInGrid, false)
})

test('ic2FaceStrip 命中：384x32 + IC2 locator', () => {
  const doc = makeDocument({
    blobs: [pngBase64(strip(12))],
    materials: [makeMaterial('ic2:machine/blockLathe:0', 0)],
    blocks: [makeBlock('ic2:blockMachine', [0])],
    grid: gridWith([0]),
  })
  const result = auditDocument(doc)
  assert.equal(result.status, 'bad')
  assert.equal(result.hitsFaceStrip, 1)
})

test('ic2FaceStrip 命中：192x32 也是横向多面带', () => {
  const doc = makeDocument({
    blobs: [pngBase64(strip(6))],
    materials: [makeMaterial('ic2:generator/blockNuclearReactor:4', 0)],
    blocks: [makeBlock('ic2:blockGenerator', [0])],
    grid: gridWith([0]),
  })
  assert.equal(auditDocument(doc).hitsFaceStrip, 1)
})

test('ic2FaceStrip 负对照：384x32 但 locator 不是 IC2 => 未判型，不硬塞', () => {
  const doc = makeDocument({
    blobs: [pngBase64(strip(12))],
    materials: [makeMaterial('gregtech:iconsets/MACHINE_LV_BOTTOM', 0)],
    blocks: [makeBlock('gregtech:machine', [0])],
    grid: gridWith([0]),
  })
  const result = auditDocument(doc)
  assert.equal(result.hitsFaceStrip, 0)
  assert.equal(result.unclassifiedCount, 1)
  assert.match(result.unclassified[0].reason, /非 IC2/)
  assert.equal(result.status, 'warn')
})

test('ic2FaceStrip 负对照：32x32 单面 + IC2 locator 不是横向带', () => {
  const doc = makeDocument({
    blobs: [pngBase64(strip(1))],
    materials: [makeMaterial('ic2:machine/blockMiner:7', 0)],
    blocks: [makeBlock('ic2:blockMachine', [0])],
    grid: gridWith([0]),
  })
  const result = auditDocument(doc)
  assert.equal(result.hitsFaceStrip, 0)
  assert.equal(result.status, 'ok')
})

test('负对照：正常贴图 => ok', () => {
  const doc = makeDocument({
    blobs: [pngBase64(goodTexture())],
    materials: [makeMaterial('minecraft:stone', 0)],
    blocks: [makeBlock('minecraft:stone', [0])],
    grid: gridWith([0]),
  })
  assert.equal(auditDocument(doc).status, 'ok')
})

test('坏贴图解码失败 => error 记入未判型/缺口，不当成 ok', () => {
  const doc = makeDocument({
    blobs: ['bm90LWEtcG5n'],
    materials: [makeMaterial('broken:texture', 0)],
    blocks: [makeBlock('broken:block', [0])],
    grid: gridWith([0]),
  })
  const result = auditDocument(doc)
  assert.equal(result.decodeErrorCount, 1)
  assert.equal(result.status, 'warn')
})

test('frames 布局：几何在 frames[].structure，材质/贴图在根上', () => {
  const doc = makeDocument({
    blobs: [pngBase64(placeholder16())],
    materials: [makeMaterial('minecraft:stone', 0)],
    frames: [
      { index: 0, structure: { blockPalette: [makeBlock('minecraft:stone', [0])], cellGrid: gridWith([0]) } },
    ],
  })
  const result = auditDocument(doc)
  assert.equal(result.frameCount, 1)
  assert.equal(result.status, 'bad')
})

test('classifyBlob/judgeMaterial 边界：5 色 16x16 不满足 missingTexture 颜色数', () => {
  const stats = {
    width: 16,
    height: 16,
    uniqueColors: 5,
    magentaRatio: 0.3,
    blackRatio: 0.3,
    bytes: 100,
  }
  assert.equal(classifyBlob(stats).missingTexture, false)
  assert.equal(judgeMaterial(stats, 'x:y').verdict, 'unclassified')
})

test('伴生数据可 JSON 化（报告要落盘）', () => {
  const result = auditDocument(placeholderDoc({ used: true }))
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('makeEnvelope 产出可被 envelope.mjs 解码的字符串', () => {
  const text = makeEnvelope(placeholderDoc({ used: true }))
  assert.equal(JSON.parse(text).documentFormat, 'Envelope')
  assert.match(JSON.parse(text).payload, /^[A-Za-z0-9+/=]+$/)
})

test('统计读数保留 4 位小数，避免报告里出现浮点噪声', () => {
  const stats = pngStats(new Uint8Array(Buffer.from(pngBase64(placeholder16()), 'base64')))
  assert.equal(stats.magentaRatio, 0.5)
  assert.equal(stats.blackRatio, 0.5)
})
