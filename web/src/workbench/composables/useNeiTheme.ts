/**
 * @deprecated 壳层主题已迁入 `wm.settings`（`createShellSettings`）。
 * Workbench 在 `new WM()` 时自动应用 DOM / localStorage；请用 `ctx.getShellSettings().theme`。
 */
import type { Ref } from 'vue'
import type { AppTheme } from '@/runtime/contextAccess'

/** 仅供尚未接入 Context 的遗留代码；新代码勿用。 */
export function useNeiTheme(): { theme: Ref<AppTheme> | null } {
  return { theme: null }
}
