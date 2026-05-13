import { describe, it, expect, beforeEach } from 'vitest'
import { createRNARegistry } from '../rna/registry'
import type { RNARegistry, RNAStruct } from '../rna/types'

describe('RNARegistry', () => {
  let rna: RNARegistry

  beforeEach(() => {
    rna = createRNARegistry()
  })

  it('registers and resolves a property by path "struct.prop"', () => {
    const blockStruct: RNAStruct = {
      name: 'Block',
      description: 'A scene block',
      properties: [
        {
          name: 'id',
          type: 'string',
          label: 'Block ID',
          description: 'Block type identifier',
          default: '',
          get(o: any) { return o.block_state_id },
          set(o: any, v: unknown) { o.block_state_id = v as string },
        },
      ],
    }
    rna.register(blockStruct)

    const desc = rna.resolve('block.id')
    expect(desc).not.toBeNull()
    expect(desc!.name).toBe('id')
    expect(desc!.type).toBe('string')
    expect(desc!.label).toBe('Block ID')
  })

  it('returns null for unknown path', () => {
    expect(rna.resolve('nonexistent.field')).toBeNull()
  })

  it('returns null for unknown struct name', () => {
    expect(rna.resolve('unknown.id')).toBeNull()
  })

  it('resolves nested path "block.pos.x" to parent vector3 property', () => {
    const blockStruct: RNAStruct = {
      name: 'Block',
      description: 'A scene block',
      properties: [
        {
          name: 'pos',
          type: 'vector3',
          label: 'Position',
          description: 'Block world position',
          default: { x: 0, y: 0, z: 0 },
          get(o: any) { return { ...o.pos } },
          set(o: any, v: unknown) { o.pos = { ...(v as any) } },
        },
      ],
    }
    rna.register(blockStruct)

    const desc = rna.resolve('block.pos.x')
    expect(desc).not.toBeNull()
    expect(desc!.name).toBe('pos')
    expect(desc!.type).toBe('vector3')
  })

  it('widgetFor maps string to text', () => {
    const desc = {
      name: 'test', type: 'string' as const, label: '', description: '', default: '',
      get() { return '' }, set() {},
    }
    expect(rna.widgetFor(desc)).toBe('text')
  })

  it('widgetFor maps string+enumItems to dropdown', () => {
    const desc = {
      name: 'test', type: 'string' as const, label: '', description: '', default: '',
      enumItems: ['a', 'b', 'c'],
      get() { return '' }, set() {},
    }
    expect(rna.widgetFor(desc)).toBe('dropdown')
  })

  it('widgetFor maps number+min/max to slider', () => {
    const desc = {
      name: 'test', type: 'number' as const, label: '', description: '', default: 0,
      min: 0, max: 100,
      get() { return 0 }, set() {},
    }
    expect(rna.widgetFor(desc)).toBe('slider')
  })

  it('widgetFor maps boolean to checkbox', () => {
    const desc = {
      name: 'test', type: 'boolean' as const, label: '', description: '', default: false,
      get() { return false }, set() {},
    }
    expect(rna.widgetFor(desc)).toBe('checkbox')
  })

  it('widgetFor respects explicit uiWidget override', () => {
    const desc = {
      name: 'test', type: 'number' as const, label: '', description: '', default: 0,
      min: 0, max: 100, uiWidget: 'number',
      get() { return 0 }, set() {},
    }
    expect(rna.widgetFor(desc)).toBe('number')
  })
})
