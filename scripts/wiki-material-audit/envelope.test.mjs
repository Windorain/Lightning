/**
 * envelope.test.mjs —— 导出件解码与分片拼装的判据
 * ============================================================================
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeEnvelope,
  isMultipartIndex,
  mergeMultipart,
  multipartPartTitleCandidates,
  normalizeStructureBase,
  parseJsonDocument,
  titleKey,
} from './envelope.mjs'
import { gridWith, makeBlock, makeDocument, makeEnvelope, makeMaterial, makeMultipart, placeholder16, pngBase64 } from './fixtures.mjs'

function sampleDoc() {
  return makeDocument({
    blobs: [pngBase64(placeholder16())],
    materials: [makeMaterial('minecraft:stone', 0)],
    blocks: [makeBlock('minecraft:stone', [0])],
    grid: gridWith([0]),
  })
}

test('Envelope roundtrip', () => {
  const decoded = decodeEnvelope(parseJsonDocument(makeEnvelope(sampleDoc())))
  assert.equal(decoded.documentFormat, 'Envelope')
  assert.equal(decoded.doc.textureBlobs.length, 1)
  assert.equal(decoded.doc.materialPalette[0].locator, 'minecraft:stone')
})

test('BOM 容错', () => {
  const text = '\uFEFF' + makeEnvelope(sampleDoc())
  assert.equal(parseJsonDocument(text).documentFormat, 'Envelope')
})

test('分片索引识别 + 两种分片标题候选', () => {
  const { index } = makeMultipart({ base: 'PseudoBiosphere', docs: [sampleDoc()] })
  assert.equal(isMultipartIndex(index), true)
  const titles = multipartPartTitleCandidates(index, 'PseudoBiosphere', 1)
  assert.deepEqual(titles, [
    'Data:Structures/PseudoBiosphere_01.json',
    'Data:Structures/PseudoBiosphere 01.json',
  ])
})

test('分片拼装后能解出完整文档', () => {
  const doc = sampleDoc()
  const { index, parts } = makeMultipart({ base: 'PseudoBiosphere', docs: [doc, doc] })
  const merged = mergeMultipart(index, parts)
  const decoded = decodeEnvelope(merged)
  assert.equal(decoded.doc.materialPalette.length, 1)
  assert.equal(decoded.doc.textureBlobs.length, 1)
})

test('分片数量不匹配必须显式失败', () => {
  const { index, parts } = makeMultipart({ base: 'X', docs: [sampleDoc(), sampleDoc()] })
  assert.throws(
    () => mergeMultipart(index, [parts[0]]),
    (error) => error.code === 'PART-COUNT',
  )
})

test('名字归一化：去 .json / Data 前缀 / 路径前缀', () => {
  assert.equal(normalizeStructureBase('Data:Structures/沙盒.json'), '沙盒')
  assert.equal(normalizeStructureBase('半自动核反应堆升温-envelope.json'), '半自动核反应堆升温-envelope')
  assert.equal(normalizeStructureBase('  '), '')
})

test('标题对齐：下划线视同空格', () => {
  assert.equal(titleKey('Data:Structures/OkangbaO_BEC自动化_PR方案_通用通道.json'), 'Structures/OkangbaO BEC自动化 PR方案 通用通道')
  assert.equal(titleKey('Structures/OkangbaO BEC自动化 PR方案 通用通道'), titleKey('Data:Structures/OkangbaO_BEC自动化_PR方案_通用通道.json'))
})
