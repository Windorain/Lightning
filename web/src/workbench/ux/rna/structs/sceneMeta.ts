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
    {
      name: 'tags',
      type: 'string',
      label: '标签',
      description: '逗号分隔的标签列表',
      default: '',
      get(owner: any) {
        const tags = owner.meta?.tags
        return Array.isArray(tags) ? tags.join(', ') : ''
      },
      set(owner: any, val: unknown) {
        if (owner.meta) owner.meta.tags = (val as string).split(',').map((s: string) => s.trim()).filter(Boolean)
      },
    },
    {
      name: 'origin',
      type: 'string',
      label: '原点',
      description: '场景原点坐标 (x, y, z)',
      default: '0, 0, 0',
      get(owner: any) {
        const o = owner.meta?.origin
        return o ? `${o.x}, ${o.y}, ${o.z}` : '0, 0, 0'
      },
      set(owner: any, val: unknown) {
        const parts = (val as string).split(',').map(Number)
        if (owner.meta) owner.meta.origin = { x: parts[0] ?? 0, y: parts[1] ?? 0, z: parts[2] ?? 0 }
      },
    },
    {
      name: 'created_at',
      type: 'string',
      label: '创建时间',
      description: '场景创建时间戳',
      default: '',
      get(owner: any) {
        const ms = owner.meta?.created_at_ms
        return ms ? new Date(ms as number).toLocaleString() : ''
      },
      set(_owner: any, _val: unknown) {},
    },
    {
      name: 'format_version',
      type: 'string',
      label: '格式版本',
      description: '场景文档格式版本',
      default: '',
      get(owner: any) { return owner.formatVersion ?? '' },
      set(_owner: any, _val: unknown) {},
    },
  ],
}
