/**
 * Handler type constants — 对标 Blender 的 eWM_EventHandlerType。
 *
 * 按类型排序的分发链：GIZMO → OPERATOR → KEYMAP → UI。
 * 不再使用裸整数 priority 值。
 */
export const HANDLER_TYPE = {
  GIZMO: 0,
  OPERATOR: 1,
  KEYMAP: 2,
  UI: 3,
} as const

export type HandlerType = (typeof HANDLER_TYPE)[keyof typeof HANDLER_TYPE]

export interface TypedEventHandler {
  type: HandlerType
  handle(event: Event): { break: boolean }
}
