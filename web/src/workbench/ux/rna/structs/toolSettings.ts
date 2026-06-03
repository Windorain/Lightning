import type { ToolSettings } from '@/runtime/contextAccess'
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
      get(owner: ToolSettings) { return owner.generateType.value ?? '' },
      set(_owner: ToolSettings, _val: unknown) { /* via OPERATOR_SET_TOOL_SETTING */ },
    },
    {
      name: 'replaceBrush',
      type: 'string',
      label: '替换画笔',
      description: '替换工具使用的方块类型',
      default: '',
      get(owner: ToolSettings) { return owner.replaceBrush.value ?? '' },
      set(_owner: ToolSettings, _val: unknown) { /* via OPERATOR_SET_TOOL_SETTING */ },
    },
    {
      name: 'fillBrush',
      type: 'string',
      label: '填充画笔',
      description: '填充工具使用的方块类型',
      default: '',
      get(owner: ToolSettings) { return owner.fillBrush.value ?? '' },
      set(_owner: ToolSettings, _val: unknown) { /* via OPERATOR_SET_TOOL_SETTING */ },
    },
    {
      name: 'dragSensitivity',
      type: 'number',
      label: '拖拽灵敏度',
      description: 'Gizmo 拖拽的灵敏度系数',
      default: 0.05,
      min: 0.01,
      max: 1.0,
      get(owner: ToolSettings) { return owner.dragSensitivity },
      set(_owner: ToolSettings, _val: unknown) { /* via OPERATOR_SET_TOOL_SETTING */ },
    },
    {
      name: 'snapEnabled',
      type: 'boolean',
      label: '吸附',
      description: '移动时吸附到整数坐标',
      default: false,
      get(owner: ToolSettings) { return owner.snapEnabled.value },
      set(_owner: ToolSettings, _val: unknown) { /* via OPERATOR_SET_TOOL_SETTING */ },
    },
  ],
}
