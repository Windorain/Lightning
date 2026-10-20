// @vitest-environment jsdom
/**
 * M7-6 · **实例作用域 UI 状态键**（D7 / GE-3 的单元层判据）。
 *
 * 判据三面：
 *  1. 键形态含实例段（`lk-ui.v1.<id>.<name>`），且**不同实例必然不同键**；
 *  2. 真实消费者（`createViewerPreferences` / `readPersistedPanelWidths`）
 *     在两个实例上互不覆盖 —— 这正是 GE-3 的机制，不需要浏览器即可判红；
 *  3. 旧键（无实例段）不再被读：把旧键写成显著非默认值，新实例仍读默认。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { instanceUiKey, LEGACY_STORAGE_KEYS } from '@/runtime/instanceStorage'
import { normalizeInstanceId } from '@/runtime/instanceIdentity'
import { createViewerPreferences } from '@/viewer/preferences'
import {
  DEFAULT_PANEL_LEFT,
  DEFAULT_PANEL_RIGHT,
  readPersistedPanelWidths,
  writePersistedPanelWidth,
} from '@/workbench/layout/panelLayoutStorage'

beforeEach(() => {
  localStorage.clear()
})

describe('M7-6 · 实例作用域 UI 状态键', () => {
  it('键形态：lk-ui.v1.<instanceId>.<name>，两个实例必然不同键', () => {
    const a = instanceUiKey('embed-1', 'viewer.r-embed')
    const b = instanceUiKey('embed-2', 'viewer.r-embed')
    expect(a).toBe('lk-ui.v1.embed-1.viewer.r-embed')
    expect(b).toBe('lk-ui.v1.embed-2.viewer.r-embed')
    expect(a).not.toBe(b)
    // 实例段在名字之前：同实例不同 region 仍是不同键
    expect(instanceUiKey('embed-1', 'viewer.r-wiki-preview')).not.toBe(a)
    // 空/非法 id 归一，不产生两段空实例键
    expect(normalizeInstanceId('  ')).toBe('default')
    expect(instanceUiKey('', 'keymap')).toBe('lk-ui.v1.default.keymap')
  })

  it('旧键与新键不撞车（旧键直接作废，不迁移）', () => {
    for (const legacy of Object.values(LEGACY_STORAGE_KEYS)) {
      expect(legacy.startsWith('lk-ui.')).toBe(false)
      expect(instanceUiKey('workbench', legacy)).not.toBe(legacy)
    }
  })

  it('viewer 偏好按实例隔离：A 改一项，新实例仍读默认值', () => {
    const a = createViewerPreferences(instanceUiKey('embed-1', 'viewer.r-embed'))
    expect(a.highlightOnHover, '前提：默认值是 true').toBe(true)
    a.highlightOnHover = false

    // A 自己重开（同键）必须读回改后的值 —— 否则"新实例读默认"只是因为谁都没写
    expect(createViewerPreferences(instanceUiKey('embed-1', 'viewer.r-embed')).highlightOnHover).toBe(false)
    // 另一个实例：新键不存在 ⇒ 默认
    expect(createViewerPreferences(instanceUiKey('embed-2', 'viewer.r-embed')).highlightOnHover).toBe(true)
  })

  it('旧 viewer 键不得被新实例读取（旧偏好失效一次，不是数据损坏）', () => {
    localStorage.setItem(LEGACY_STORAGE_KEYS.viewerEmbed, JSON.stringify({ highlightOnHover: false }))
    const fresh = createViewerPreferences(instanceUiKey('embed-3', 'viewer.r-embed'))
    expect(fresh.highlightOnHover).toBe(true)
  })

  it('面板宽度按实例隔离：写 A 不改 B', () => {
    writePersistedPanelWidth('workbench', 'left', 333)
    expect(readPersistedPanelWidths('workbench').leftWidth).toBe(333)
    expect(readPersistedPanelWidths('other').leftWidth).toBe(DEFAULT_PANEL_LEFT)
    expect(readPersistedPanelWidths('other').rightWidth).toBe(DEFAULT_PANEL_RIGHT)
  })
})
