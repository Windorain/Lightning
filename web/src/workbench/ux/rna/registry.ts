import type { RNAStruct, RNARegistry, PropertyDescriptor } from './types'

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

      const propName = propPath.includes('.') ? propPath.slice(0, propPath.indexOf('.')) : propPath

      return struct.properties.find(p => p.name === propName) ?? null
    },

    widgetFor(prop: PropertyDescriptor): string {
      if (prop.uiWidget) return prop.uiWidget
      switch (prop.type) {
        case 'string':
          return prop.enumItems && prop.enumItems.length > 0 ? 'dropdown' : 'text'
        case 'number':
          return (prop.min != null && prop.max != null) ? 'slider' : 'number'
        case 'boolean': return 'checkbox'
        case 'color':   return 'color'
        case 'enum':    return 'dropdown'
        case 'vector3': return 'vector'
        default:        return 'text'
      }
    },
  }
}
