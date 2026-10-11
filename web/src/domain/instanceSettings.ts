/**
 * 实例设置域（纯层；#249 §19.7；#259「实例配置隔离」）。
 *
 * ## 配置分域（#249 §19.7 的四域，本文件是它们的类型化边界）
 *
 * | 域 | 拥有者 | 本文件里的形态 |
 * |---|---|---|
 * | **应用默认配置** | 构建/profile | `InstanceDefaults`（随实例构造传入，不可变） |
 * | **用户持久偏好** | 宿主存储 | `PreferenceStore`（命名空间 + 版本键） |
 * | **实例覆盖** | 本实例 | `InstanceOverrides`（只影响本实例） |
 * | **文档内容** | 文档状态域 | **不在本文件**（设置不写文档） |
 *
 * ## A33 的核心不变量
 *
 * > 每个实例**显式**选择是否继承默认，不能通过模块级 `activeLang`、主题 Ref
 * > 或全局服务定位器改变所有实例。
 *
 * 本文件用纯函数实现这条：
 * - `resolveInstanceSettings(defaults, overrides)` —— 显式二选一
 *   （`inheritDefaults: true` 时从默认取，`false` 时用自己的值），
 *   没有任何"全局当前设置"可读；
 * - **没有任何模块级可变状态**：所有函数都把状态当参数收、把新状态当返回值出
 *   （#249 §2.1「纯函数：显式输入、不改输入」）；
 * - 因此"同页两个实例、切换其一"在结构上**不可能**影响另一个 ——
 *   不是靠"记得不要写全局变量"的纪律，而是因为没有全局变量可写。
 *
 * ## 持久键的命名空间与版本
 *
 * `preferenceKey(namespace, instanceId, name)` 产出
 * `lk.<namespace>.<version>.<instanceId>.<name>`：
 * - `lk` = Lightning 前缀（区分于宿主页面自己的键）；
 * - `namespace` = 应用/用户范围（见 `PREF_NAMESPACE`）；
 * - `version` = **schema 版本**，升版即自然隔离旧数据，无需删除；
 * - `instanceId` = 必要实例身份（同页多实例互不覆盖；A33 负对照
 *   「全局存储键覆盖所有实例」）；
 * - `name` = 偏好名。
 */

/** 应用范围：工作台与嵌入外壳各自的偏好域（#249 §19.5「按应用/用户范围…隔离」）。 */
export type PreferenceNamespace = 'workbench' | 'embed' | 'shared'

/** 偏好 schema 版本（升版即隔离旧值；旧值由迁移处理，见 `migrateLegacyLang`）。 */
export const PREF_VERSION = 2

/** 偏好键前缀（Lightning 专用，避免与宿主页面冲突）。 */
export const PREF_PREFIX = 'lk'

/**
 * 构造偏好键：`lk.<namespace>.v<version>.<instanceId>.<name>`。
 *
 * `instanceId` 为空时用 `default`（单实例外壳不必编造 ID，但键形态保持一致）。
 */
export function preferenceKey(
  namespace: PreferenceNamespace,
  instanceId: string,
  name: string,
): string {
  const id = instanceId.trim() === '' ? 'default' : instanceId
  return `${PREF_PREFIX}.${namespace}.v${PREF_VERSION}.${id}.${name}`
}

/** 解析偏好键（迁移与诊断用）；不匹配本方案 ⇒ `null`。 */
export function parsePreferenceKey(key: string): {
  namespace: PreferenceNamespace
  version: number
  instanceId: string
  name: string
} | null {
  const m = new RegExp(`^${PREF_PREFIX}\\.([a-z]+)\\.v(\\d+)\\.([^.]+)\\.(.+)$`).exec(key)
  if (!m) return null
  return {
    namespace: m[1] as PreferenceNamespace,
    version: Number(m[2]),
    instanceId: m[3]!,
    name: m[4]!,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 设置值
// ─────────────────────────────────────────────────────────────────────────────

export type AppLanguage = 'zh' | 'en'
export type AppTheme = 'dark' | 'light'

/** 实例设置的可序列化形态（四域中的"应用默认"与"实例覆盖"共用此形状）。 */
export interface InstanceSettings {
  readonly lang: AppLanguage
  readonly theme: AppTheme
}

/** 应用默认配置（不可变；随 profile/构建给定）。 */
export type InstanceDefaults = InstanceSettings

/**
 * 实例覆盖。
 *
 * `inheritDefaults` 是**显式**开关（#249 §19.7「每个实例显式选择是否继承默认」）：
 * - `true`：字段值从 `defaults` 取（本地字段值为"跟随默认"）；
 * - `false`：用本结构自己的 `lang`/`theme`。
 *
 * 注意 `inheritDefaults` 是**整体**开关而不是逐字段的：逐字段继承会让
 * "这个实例现在是什么语言"需要跨两个对象求值，诊断与 e2e 断言都要复制该逻辑。
 * 整体开关让"本实例的设置"永远是一个可独立观察、可独立断言的完整值。
 */
export interface InstanceOverrides {
  readonly inheritDefaults: boolean
  readonly lang?: AppLanguage
  readonly theme?: AppTheme
}

/**
 * 解析实例的有效设置 —— **纯函数**。
 *
 * - 不改 `defaults`、不改 `overrides`；
 * - 不读任何模块级/全局状态；
 * - 同一输入恒得同一输出（可重复、可断言）。
 *
 * 当 `inheritDefaults` 为 true 时，实例**没有**自己的偏好值可用：
 * `lang`/`theme` 完全来自默认。这正是"新实例显式继承默认"（#259 J2）的落地。
 */
export function resolveInstanceSettings(
  defaults: InstanceDefaults,
  overrides: InstanceOverrides,
): InstanceSettings {
  if (overrides.inheritDefaults) {
    return { lang: defaults.lang, theme: defaults.theme }
  }
  return {
    lang: overrides.lang ?? defaults.lang,
    theme: overrides.theme ?? defaults.theme,
  }
}

/** 从有效设置反向构造"不继承默认"的覆盖（用户显式改设置时用）。 */
export function overridesFromEffective(effective: InstanceSettings): InstanceOverrides {
  return { inheritDefaults: false, lang: effective.lang, theme: effective.theme }
}

/** 切换语言：返回**新**覆盖（不改输入）。 */
export function withLang(overrides: InstanceOverrides, lang: AppLanguage): InstanceOverrides {
  return { ...overrides, inheritDefaults: false, lang }
}

/** 切换主题：返回**新**覆盖（不改输入）。 */
export function withTheme(overrides: InstanceOverrides, theme: AppTheme): InstanceOverrides {
  return { ...overrides, inheritDefaults: false, theme }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI 状态投影（DOM/ARIA 标识不冲突；#259 J2）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 实例的渲染标识 —— 用于让同页多实例的 DOM 属性互不冲突。
 *
 * 旧实现把主题写成 `html[data-wb-theme]` / `html[data-nei-theme]`
 * （**文档级**属性）：同页第二个实例挂载时会覆盖第一个实例的主题，
 * 而基于该属性的 CSS 变量是全局的 ⇒ 两实例被迫同主题。
 *
 * 新形态把标识落在**实例根元素**上：
 * - `scopeAttr`：`data-lk-theme` / `data-lk-lang` 的值；
 * - `scopeId`：本实例在 DOM 里的唯一后缀（用于 `id`/`for` 关联、
 *   以及 `aria-labelledby` 等引用型 ARIA 属性）。
 */
export function instanceScopeId(instanceId: string): string {
  const cleaned = instanceId.replace(/[^A-Za-z0-9_-]/g, '-')
  return cleaned === '' || cleaned === '-' ? 'lk-inst' : `lk-${cleaned}`
}

/**
 * 把实例内某个控件的局部 id 变成**实例唯一** id。
 *
 * 用于修掉"同页两实例时 `id` 撞车"：旧代码里 `id="mb-tier"`、
 * `id="wm-layer-range"` 是页面级唯一 id，第二个实例出现即产生重复 id，
 * 进而让 `<label for=...>` 指向第一个实例的控件（ARIA 关联错位）。
 */
export function scopedDomId(scopeId: string, localId: string): string {
  return `${scopeId}--${localId}`
}
