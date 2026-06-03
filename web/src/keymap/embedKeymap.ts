import type { InputBinding } from '@/keymap'

/** Embed 视口：仅导航，无编辑/撤销键位 */
export const EMBED_KEYMAP: InputBinding[] = [
  { type: 'MOUSE', button: 0, opId: 'OPERATOR_VIEW_ROTATE', description: '旋转视图 (LMB)' },
  { type: 'MOUSE', button: 0, shift: true, opId: 'OPERATOR_VIEW_PAN', description: '平移视图 (Shift+LMB)' },
  { type: 'MOUSE', button: 0, ctrl: true, opId: 'OPERATOR_VIEW_ZOOM', description: '缩放视图 (Ctrl+LMB)' },
  { type: 'MOUSE', button: 1, opId: 'OPERATOR_VIEW_PAN', description: '平移视图 (MMB)' },
  { type: 'MOUSE', button: 1, shift: true, opId: 'OPERATOR_VIEW_ROTATE', description: '旋转视图 (Shift+MMB)' },
  { type: 'MOUSE', button: 1, ctrl: true, opId: 'OPERATOR_VIEW_ZOOM', description: '缩放视图 (Ctrl+MMB)' },
  { type: 'MOUSE', button: 2, opId: 'OPERATOR_VIEW_PAN', description: '平移视图 (RMB)' },
  { type: 'MOUSE', button: 2, shift: true, opId: 'OPERATOR_VIEW_ROTATE', description: '旋转视图 (Shift+RMB)' },
  { type: 'MOUSE', button: 2, ctrl: true, opId: 'OPERATOR_VIEW_ZOOM', description: '缩放视图 (Ctrl+RMB)' },
  { type: 'WHEEL', direction: 'down', opId: 'OPERATOR_VIEW_ZOOM', description: '缩小' },
  { type: 'WHEEL', direction: 'up', opId: 'OPERATOR_VIEW_ZOOM', description: '放大' },
]
