import type { RNAStruct, RNARegistry, PropertyDescriptor } from './types'
import { widgetFor as _widgetFor } from '@/pure/layout'

export function createRNARegistry(): RNARegistry {
  const structs = new Map<string, RNAStruct>()

  return {
    structs,

    register(struct: RNAStruct): void {
      structs.set(struct.name.toLowerCase(), struct)
    },

    resolve(path: string): PropertyDescriptor | null {
      const dot = path.indexOf('.')
      if (dot === -1) return null
      const structName = path.slice(0, dot).toLowerCase()
      const propPath = path.slice(dot + 1)

      const struct = structs.get(structName)
      if (!struct) return null

      // Sub-property paths (block.pos.x) not supported — vector3 components need
      // special handling at the UI layer. Return null for now.
      if (propPath.includes('.')) return null

      return struct.properties.find(p => p.name === propPath) ?? null
    },

    widgetFor(prop: PropertyDescriptor): string {
      return _widgetFor(prop)
    },
  }
}
