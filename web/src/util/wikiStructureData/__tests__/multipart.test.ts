import { describe, expect, it } from 'vitest'
import {
  isMultipartIndex,
  mergeMultipartIndex,
  planUpload,
  normalizeBase,
  indexTitle,
  MAX_PART_COUNT,
} from '@/util/wikiStructureData'

describe('wikiStructureData', () => {
  it('normalizeBase strips path and extension', () => {
    expect(normalizeBase('Data:Structures/Foo.json')).toBe('Foo')
    expect(normalizeBase('  bar.json ')).toBe('bar')
  })

  it('indexTitle', () => {
    expect(indexTitle('Test')).toBe('Data:Structures/Test.json')
  })

  it('rejects multipart index as upload input', () => {
    expect(() =>
      planUpload('X', { documentFormat: 'Envelope/multipart', partCount: 2 }),
    ).toThrow(/索引/)
  })

  it('mergeMultipartIndex rebuilds envelope', () => {
    const index = {
      documentFormat: 'Envelope/multipart',
      partCount: 2,
      payloadEncoding: 'gzip+base64',
      meta: {},
      base: 'T',
    }
    const merged = mergeMultipartIndex(index, [
      { part: 1, payload: 'aa' },
      { part: 2, payload: 'bb' },
    ])
    expect(merged.documentFormat).toBe('Envelope')
    expect(merged.payload).toBe('aabb')
  })

  it('single small envelope uses single mode', () => {
    const doc = {
      documentFormat: 'Envelope',
      payloadEncoding: 'gzip+base64',
      meta: { title: 't' },
      payload: 'eJx',
    }
    const plan = planUpload('Small', doc)
    expect(plan.mode).toBe('single')
    expect(plan.pages).toHaveLength(1)
  })

  it('isMultipartIndex', () => {
    expect(isMultipartIndex({ documentFormat: 'Envelope/multipart', partCount: 1 })).toBe(true)
    expect(isMultipartIndex({ documentFormat: 'Envelope' })).toBe(false)
  })

  it('exports MAX_PART_COUNT', () => {
    expect(MAX_PART_COUNT).toBe(6)
  })
})
