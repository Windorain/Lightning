/**
 * Handler type constants — 对标 Blender 的 eWM_EventHandlerType。
 *
 * 每个 region 拥有自己的 handler 链：
 *   HOVER → GIZMO → KEYMAP
 */
export const HANDLER_TYPE = {
  HOVER: 0,
  GIZMO: 1,
  KEYMAP: 2,
} as const

export type HandlerType = (typeof HANDLER_TYPE)[keyof typeof HANDLER_TYPE]

export interface RegionEventHandler {
  type: HandlerType
  handle(event: Event): { break: boolean }
}
