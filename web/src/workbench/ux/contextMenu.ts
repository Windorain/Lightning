import { ref } from 'vue'

/**
 * 一个菜单项。
 *
 * ## `commandId` 与 `opId` 的分工（P10 #261 收口）
 *
 * | 字段 | 命名空间 | 走哪条路 |
 * |---|---|---|
 * | `commandId` | **P7 命令空间**（`edit.undo`、`ui.toggleToolshelf`…） | 输入端口 `invokeCommand` → 与键盘**同一**路由 |
 * | `opId` | 旧 operator ID（`OPERATOR_*`） | 旧 operator 入口（**待退役**） |
 *
 * ## 为什么收敛到 `commandId`（#249 §19.1 原文的落点）
 *
 * 旧实现里同一个"撤销"有**三个名字**：快捷键用 `'undo'`、菜单用
 * `'OPERATOR_UNDO'`、而 P7 的命令空间是 `'edit.undo'`。后果有两个，
 * 都在 #249 §19.1 里被点名：
 *  1. 无法做命令搜索，也无法审计"谁还能触发撤销"（三个名字各自可达）；
 *  2. 菜单的可用性与快捷键各判一遍 ⇒ 可以出现"快捷键禁用但菜单可点"
 *     （旧 `keymapHandler` 的 `if (!ctx.isEmbed())` 就是这种分叉）。
 *
 * 收敛后菜单项只写 `commandId`，可用性与执行都走**同一条**查询与同一条路由。
 *
 * `opId` 保留为可选：仍有未迁移的项（其归属批次见各调用点注释），
 * 但它们**必须**显式标注，不允许两者都不写（那会得到一个点了没反应的菜单项）。
 */
export interface ContextMenuItem {
  kind: 'operator' | 'label' | 'separator'
  label: string
  icon?: string
  /** P7 命令空间 ID（首选）。 */
  commandId?: string
  /** 旧 operator ID（**待退役**；新项不得使用）。 */
  opId?: string
  props?: Record<string, unknown>
}

export function createContextMenu() {
  return {
    open: ref(false),
    position: ref({ x: 0, y: 0 }),
    items: ref<ContextMenuItem[]>([]),
  }
}

export type ContextMenuState = ReturnType<typeof createContextMenu>

export function showContextMenu(
  cm: ContextMenuState,
  pos: { x: number; y: number },
  menuItems: ContextMenuItem[],
) {
  cm.position.value = pos
  cm.items.value = menuItems
  cm.open.value = true
}

export function hideContextMenu(cm: ContextMenuState) {
  cm.open.value = false
  cm.items.value = []
}
