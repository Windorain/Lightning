// web/src/workbench/tools/selectTool.ts
import type { Tool } from './tool'

export const selectTool: Tool = {
  id: 'select',
  label: '选择',
  icon: '▲',
  cursor: 'default',
  operator: 'OPERATOR_SELECT',
  keymap: [
    { type: 'MOUSE', button: 0, opId: 'OPERATOR_SELECT', description: '选择方块' },
  ],
}
