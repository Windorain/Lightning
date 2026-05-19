// web/src/workbench/tools/pointTool.ts
import type { Tool } from './tool'

export const pointTool: Tool = {
  id: 'annotation-point',
  label: '标记点',
  icon: '◆',
  cursor: 'crosshair',
  operator: 'ANNOTATION_CREATE',
  properties: {
    type: 'point',
    color: '#ffaa00',
    icon: 'diamond',
    size: 1.0,
    title: '',
    description: '',
    visible: true,
    locked: false,
  },
  keymap: [
    { type: 'MOUSE', button: 0, opId: 'ANNOTATION_CREATE', description: '放置标记点' },
  ],
  keymapFallback: [
    { type: 'MOUSE', button: 0, opId: 'OPERATOR_SELECT', description: '选择（回退）' },
  ],
}
