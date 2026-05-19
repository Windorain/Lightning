// web/src/workbench/tools/textTool.ts
import type { Tool } from './tool'

export const textTool: Tool = {
  id: 'annotation-text',
  label: '文本标签',
  icon: 'T',
  cursor: 'text',
  operator: 'ANNOTATION_CREATE',
  properties: {
    type: 'text',
    color: '#ffffff',
    fontSize: 14,
    backgroundAlpha: 0xCC,
    text: '',
    title: '',
    description: '',
    visible: true,
    locked: false,
  },
  keymap: [
    { type: 'MOUSE', button: 0, opId: 'ANNOTATION_CREATE', description: '放置文本标签' },
  ],
  keymapFallback: [
    { type: 'MOUSE', button: 0, opId: 'OPERATOR_SELECT', description: '选择（回退）' },
  ],
}
