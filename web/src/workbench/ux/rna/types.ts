export type RNAPropType =
  | 'string' | 'number' | 'boolean' | 'enum' | 'color' | 'vector3'

export interface PropertyDescriptor {
  name: string
  type: RNAPropType
  label: string
  description: string
  default: unknown
  min?: number
  max?: number
  enumItems?: string[]
  update?: string
  uiWidget?: 'text' | 'number' | 'slider' | 'checkbox' | 'dropdown' | 'color' | 'vector'
  get(owner: unknown): unknown
  set(owner: unknown, value: unknown): void
}

export interface RNAStruct {
  name: string
  description: string
  properties: PropertyDescriptor[]
}

export interface RNARegistry {
  structs: Map<string, RNAStruct>
  register(struct: RNAStruct): void
  resolve(path: string): PropertyDescriptor | null
  widgetFor(prop: PropertyDescriptor): string
}
