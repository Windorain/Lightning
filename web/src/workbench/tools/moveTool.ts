// web/src/workbench/tools/moveTool.ts
import type { Tool } from './tool'

export const moveTool: Tool = {
  id: 'move',
  label: '移动',
  icon: '↕',
  cursor: 'move',
  operator: 'OPERATOR_MOVE',
  keymap: [
    { type: 'KEY', key: 'g', toolId: 'move', description: '移动工具' },
  ],
  properties: {},
}
