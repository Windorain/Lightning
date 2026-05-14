/**
 * Handler type constants — 对标 Blender 的 eWM_EventHandlerType。
 *
 * 按类型排序的分发链：GIZMO → UI → OPERATOR → KEYMAP。
 * 对标 Blender eWM_EventHandlerType 顺序。
 */
export const HANDLER_TYPE = {
  GIZMO: 0,
  UI: 1,
  OPERATOR: 2,
  KEYMAP: 3,
} as const

export type HandlerType = (typeof HANDLER_TYPE)[keyof typeof HANDLER_TYPE]

export interface TypedEventHandler {
  type: HandlerType
  handle(event: Event): { break: boolean }
}
