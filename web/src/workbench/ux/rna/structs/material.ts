import type { RNAStruct } from '../types'
import type { MaterialQueryItem } from '@/workbench/context/bContext'

export const materialRNA: RNAStruct = {
  name: 'Material',
  description: '材质属性描述',
  properties: [
    {
      name: 'kind',
      type: 'enum',
      label: '类型',
      description: '静态纹理或动画纹理',
      default: 'static16',
      enumItems: ['static16', 'animated'],
      get(owner: unknown) {
        return (owner as MaterialQueryItem).kind
      },
      set(_owner: unknown, _value: unknown) {},
    },
    {
      name: 'blend',
      type: 'enum',
      label: '混合模式',
      description: '纹理透明度处理方式',
      default: 'opaque',
      enumItems: ['opaque', 'cutout', 'translucent'],
      get(owner: unknown) {
        return (owner as MaterialQueryItem).blend ?? 'opaque'
      },
      set(_owner: unknown, _value: unknown) {},
    },
    {
      name: 'emissive',
      type: 'number',
      label: '自发光',
      description: '自发光强度 (0-15)',
      default: 0,
      min: 0,
      max: 15,
      get(owner: unknown) {
        return (owner as MaterialQueryItem).emissive ?? 0
      },
      set(_owner: unknown, _value: unknown) {},
    },
    {
      name: 'locator',
      type: 'string',
      label: '资源定位符',
      description: 'MC 资源包定位符 (namespace:path)',
      default: '',
      get(owner: unknown) {
        return (owner as MaterialQueryItem).locator ?? ''
      },
      set(_owner: unknown, _value: unknown) {},
    },
  ],
}
