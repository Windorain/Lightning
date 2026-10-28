/**
 * 工作台面板宽度的持久化（**按实例**）。
 *
 * ## 键形态
 *
 * `lk-ui.v1.<instanceId>.panel.left|right`（见 `runtime/instanceStorage`）。
 *
 * 旧键是固定的 `wsr-wb-left-w`/`wsr-wb-right-w`（全页一份）。同页两个工作台
 * 今天被结构禁止，但"键里带实例段"仍必须做：它是机械判据
 * （同一实例的两份存储键可区分 + 两个实例互不覆盖），也是将来放开多工作台的
 * 前置条件。旧键**不迁移**（无实例身份可归属）。
 */

import { instanceUiKey } from '@/runtime/instanceStorage'

export const DEFAULT_PANEL_LEFT = 220
export const DEFAULT_PANEL_RIGHT = 300

function readPersisted(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch { /* noop */ }
  return fallback
}

/** 本实例的面板宽度键（诊断/重置共用；避免调用点各自拼串）。 */
export function panelWidthKey(instanceId: string, side: 'left' | 'right'): string {
  return instanceUiKey(instanceId, `panel.${side}`)
}

export function readPersistedPanelWidths(instanceId: string): { leftWidth: number; rightWidth: number } {
  return {
    leftWidth: readPersisted(panelWidthKey(instanceId, 'left'), DEFAULT_PANEL_LEFT),
    rightWidth: readPersisted(panelWidthKey(instanceId, 'right'), DEFAULT_PANEL_RIGHT),
  }
}

export function writePersistedPanelWidth(instanceId: string, side: 'left' | 'right', val: number): void {
  const key = panelWidthKey(instanceId, side)
  try { localStorage.setItem(key, String(Math.round(val))) } catch { /* noop */ }
}
