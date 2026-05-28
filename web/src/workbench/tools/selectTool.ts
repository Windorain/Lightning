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
  hints: [
    { keys: ['Click'], action: '选择方块' },
    { keys: ['Shift', 'Click'], action: '追加选择' },
    { keys: ['Ctrl', 'Click'], action: '减少选择' },
  ],
}
