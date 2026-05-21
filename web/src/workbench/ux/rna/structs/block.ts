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
      get(owner: any) {
        const p = owner.pos
        const h = owner._gridSize?.h
        // cellGrid row 0 = 结构顶部 → 世界 Y 翻转
        const y = h != null ? h - 1 - p.y : p.y
        return { x: p.x, y, z: p.z }
      },
      set(owner: any, val: unknown) {
        const v = val as { x: number; y: number; z: number }
        const h = owner._gridSize?.h
        // 世界 Y → cellGrid row
        const row = h != null ? h - 1 - v.y : v.y
        owner.pos = { x: v.x, y: row, z: v.z }
      },
    },
  ],
}
