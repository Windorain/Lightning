/**
 * Context 状态访问公约（与 spec C1 一致：业务改写走 Operator）。
 *
 * ## Setting 聚类（按语义归属，Context 只代理）
 *
 * | 簇 | Owner | Context 入口 |
 * |----|--------|----------------|
 * | shell | `wm.settings` | `getShellSettings()` — 主题、语言 |
 * | chrome | `wm.chrome` | `ctx.wm.chrome` — 瞬时菜单等 |
 * | tool | `workbench.tool` / `embed.tool` | `getToolSettings()` |
 * | session | `workbench.session` / `embed.session` | `getSession()` |
 * | wiki | `workbench.wiki` / `embed.wiki` | `getWikiConfig()` |
 *
 * ## 访问形态
 *
 * - Vue 响应式：`getX(): Ref<T>` — 读/写 `.value`（写仅 Operator）
 * - reactive 记录：`getX(): T` — 同一代理引用（如 session.connection）
 * - 服务单例：`getX(): T` — selection、operators 等
 *
 * 禁止 property getter 返回 primitive 快照；禁止 get/set 冒充 Ref。
 */

import type { Ref } from 'vue'
import type { ConnectionState, WorkbenchWorkspaceMode, UIWorkspace } from '@/runtime/types'
import type { BlockRef } from '@/context/selection'

export type AppTheme = 'dark' | 'light'
export type AppLanguage = 'zh' | 'en'

/** WM 壳层持久偏好（主题、语言） */
export interface ShellSettings {
  theme: Ref<AppTheme>
  lang: Ref<AppLanguage>
}

/** 工具会话参数（笔刷等） */
export interface ToolSettings {
  replaceBrush: Ref<string | null>
  fillBrush: Ref<string | null>
  generateType: Ref<string | null>
  snapEnabled: Ref<boolean>
  dragSensitivity: number
  confirmDirty: (message: string) => boolean
}

/** Workbench 编辑/连接/视口会话（非持久壳偏好） */
export interface WorkbenchSession {
  workspaceMode: Ref<WorkbenchWorkspaceMode>
  uiWorkspace: Ref<UIWorkspace>
  localFileName: Ref<string | null>
  connection: ConnectionState
  layerWorldY: Ref<number>
  hoveredBlock: Ref<BlockRef | null>
}

/** Embed 查看器会话 */
export interface EmbedSession {
  layerWorldY: Ref<number>
  initialCamera?: import('@/preview/previewConfig').InitialCamera
}

/** @deprecated 使用 ToolSettings */
export type ContextSettings = ToolSettings
