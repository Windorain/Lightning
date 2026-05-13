import type { RNAStruct } from '../types'

export const blockRNA: RNAStruct = {
  name: 'Block',
  description: '场景中的一个方块',
  properties: [
    {
      name: 'id',
      type: 'string',
      label: '方块标识',
      description: '方块类型标识符',
      default: '',
      get(owner: any) { return owner.block_state_id },
      set(owner: any, val: unknown) { owner.block_state_id = val as string },
    },
    {
      name: 'tooltip',
      type: 'string',
      label: 'Tooltip',
      description: '方块的悬浮提示文本',
      default: '',
      get(owner: any) { return owner.tooltip ?? '' },
      set(owner: any, val: unknown) { owner.tooltip = val as string },
      uiWidget: 'text',
    },
    {
      name: 'pos',
      type: 'vector3',
      label: '世界坐标',
      description: '方块在场景中的位置',
      default: { x: 0, y: 0, z: 0 },
      get(owner: any) { return { ...owner.pos } },
      set(owner: any, val: unknown) {
        const v = val as { x: number; y: number; z: number }
        owner.pos = { x: v.x, y: v.y, z: v.z }
      },
    },
  ],
}
