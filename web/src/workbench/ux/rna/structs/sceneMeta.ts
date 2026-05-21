import type { RNAStruct } from '../types'

export const sceneMetaRNA: RNAStruct = {
  name: 'SceneMetadata',
  description: '场景元数据',
  properties: [
    {
      name: 'name',
      type: 'string',
      label: '场景名称',
      description: '场景显示名称',
      default: '',
      get(owner: any) { return owner.meta?.name ?? '' },
      set(owner: any, val: unknown) {
        if (owner.meta) owner.meta.name = val as string
      },
    },
    {
      name: 'author',
      type: 'string',
      label: '作者',
      description: '场景作者',
      default: '',
      get(owner: any) { return owner.meta?.author ?? '' },
      set(owner: any, val: unknown) {
        if (owner.meta) owner.meta.author = val as string
      },
    },
    {
      name: 'description',
      type: 'string',
      label: '描述',
      description: '场景描述文本',
      default: '',
      get(owner: any) { return owner.meta?.description ?? '' },
      set(owner: any, val: unknown) {
        if (owner.meta) owner.meta.description = val as string
      },
      uiWidget: 'text',
    },
  ],
}
