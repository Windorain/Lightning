/**
 * **实例作用域 UI 状态键**（M7-6；S0-A §6 / D7）。
 *
 * ## 为什么与设置键分开命名空间
 *
 * 实例**设置**（lang/theme）的键由 `domain/instanceSettings#preferenceKey` 给出：
 * `lk.<namespace>.v<ver>.<instanceId>.<name>`，且 P8 的判据（`content-config-diagnostics`）
 * 按该形态逐条断言"键里有实例身份"。UI 状态是**另一类事实**：
 *
 * | 键 | 承载 | 谁消费 |
 * |---|---|---|
 * | `lk.<ns>.v2.<id>.lang\|theme` | 实例设置 | `runtime/shellSettings` |
 * | `lk-ui.v1.<id>.<name>` | 视口偏好 / 面板宽度 / 键位 / 最近结构 | 各自模块 |
 *
 * 合成一个命名空间会让"设置键的合法形状"变成一个开放集合（P8 判据要枚举 UI 状态名），
 * 而分开后两者各自可机械校验：设置键恒为 `lk.*`，UI 状态恒为 `lk-ui.*`。
 *
 * ## ⚠️ 旧键**全部作废，不做迁移**（本批的显式取舍）
 *
 * M7-6 之前这些键是**不带实例段**的固定字面量（见 `LEGACY_STORAGE_KEYS`）。
 * 本批不写迁移：旧键里没有"属于哪个实例"的信息，把它迁给 `embed-1` 只是把
 * "最后写者胜"换了个位置。代价是**用户已有偏好失效一次**（回到默认值）——
 * 不是数据损坏：文档、工程与恢复副本都不经过这些键（见交付说明的手测卡）。
 */

import { normalizeInstanceId } from '@/runtime/instanceIdentity'

/** UI 状态键前缀（与设置键 `lk.` 分开；见文件头）。 */
export const INSTANCE_UI_KEY_PREFIX = 'lk-ui'

/** UI 状态键 schema 版本（升版即自然隔离旧值）。 */
export const INSTANCE_UI_KEY_VERSION = 1

/**
 * 构造实例作用域 UI 状态键：`lk-ui.v1.<instanceId>.<name>`。
 *
 * `name` 里的点分路径（如 `viewer.r-viewport`）是刻意的：它让
 * "同一实例下不同视口/不同面板"的键仍可读，且不与实例段混淆（实例段在名字之前）。
 */
export function instanceUiKey(instanceId: string, name: string): string {
  return `${INSTANCE_UI_KEY_PREFIX}.v${INSTANCE_UI_KEY_VERSION}.${normalizeInstanceId(instanceId)}.${name}`
}

/**
 * M7-6 之前使用的**无实例段键**（只用于文档与诊断；产品代码不再读写它们）。
 *
 * 保留这份清单不是为了兼容读取，而是为了让"旧键作废"这件事**可核对**：
 * 交付说明与手测卡必须能逐条指出用户哪一项偏好会失效一次。
 */
export const LEGACY_STORAGE_KEYS = Object.freeze({
  /** 工作台根视口 viewer 偏好。 */
  viewerWorkbenchViewport: 'lightning.prefs.viewport',
  /** 运行期分割出来的视口的 viewer 偏好前缀（旧形态：`lightning.prefs.viewport.<regionId>`）。 */
  viewerWorkbenchRegionPrefix: 'lightning.prefs.viewport.',
  /** Wiki 预览（`r-wiki-preview`）viewer 偏好。 */
  viewerWikiPreview: 'lightning.prefs.wiki-preview',
  /** 独立嵌入（`r-embed`）viewer 偏好。 */
  viewerEmbed: 'lightning.prefs.embed',
  /** 工作台左侧面板宽度。 */
  panelLeftWidth: 'wsr-wb-left-w',
  /** 工作台右侧面板宽度。 */
  panelRightWidth: 'wsr-wb-right-w',
  /** 工作台键位表。 */
  keymap: 'lightning-workbench-keymap',
  /** Wiki 最近打开的结构。 */
  wikiRecentStructures: 'lightning-wiki-recent-structures',
})
