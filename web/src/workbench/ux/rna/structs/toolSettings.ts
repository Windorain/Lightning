import type { RNAStruct } from '../types'

export const toolSettingsRNA: RNAStruct = {
  name: 'ToolSettings',
  description: '当前工具设置',
  properties: [
    {
      name: 'generateType',
      type: 'string',
      label: '生成类型',
      description: '生成工具使用的方块类型',
      default: '',
      get(owner: any) { return owner.generateType },
      set(owner: any, val: unknown) { owner.generateType = val as string },
    },
    {
      name: 'replaceBrush',
      type: 'string',
      label: '替换画笔',
      description: '替换工具使用的方块类型',
      default: '',
      get(owner: any) { return owner.replaceBrush },
      set(owner: any, val: unknown) { owner.replaceBrush = val as string },
    },
    {
      name: 'fillBrush',
      type: 'string',
      label: '填充画笔',
      description: '填充工具使用的方块类型',
      default: '',
      get(owner: any) { return owner.fillBrush },
      set(owner: any, val: unknown) { owner.fillBrush = val as string },
    },
    {
      name: 'dragSensitivity',
      type: 'number',
      label: '拖拽灵敏度',
      description: 'Gizmo 拖拽的灵敏度系数',
      default: 0.05,
      min: 0.01,
      max: 1.0,
      get(owner: any) { return owner.dragSensitivity },
      set(owner: any, val: unknown) { owner.dragSensitivity = val as number },
    },
  ],
}
