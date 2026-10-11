/**
 * 实例设置（接线层；#249 §19.7；#259 退役条目 #10 副责 + #12 配置面）。
 *
 * ## 这次改动退役了什么
 *
 * 旧 `runtime/shellSettings.ts` 在**创建时**就写全局：
 *
 * ```ts
 * applyTheme(surface, theme.value)   // document.documentElement.setAttribute('data-nei-theme', …)
 * bindI18nLang(lang)                 // 模块级 activeLang ← 本实例语言
 * setLang(lang.value)                // 同上 + 写全局 localStorage 键
 * ```
 *
 * 三处都是"挂载期全局写入"（`boundary-rules.mjs` 的 #10 副责面）：
 * 同页第二个实例一挂载，就把**第一个实例**的主题属性与语言读源改掉。
 * 而 `data-nei-theme` 上的 CSS 变量是全局的 ⇒ 两个实例被迫同主题、同语言。
 *
 * 新形态：
 *
 * | 关注点 | 旧 | 新 |
 * |---|---|---|
 * | 语言读源 | 模块级 `activeLang` | 本实例 `ctx.t()`（闭包持有本实例语言） |
 * | 主题落点 | `document.documentElement` | 本实例根元素 `data-lk-theme` |
 * | 偏好键 | `wb-theme` / `wsr-wb-lang`（全局、无命名空间） | `lk.<ns>.v2.<instanceId>.<name>` |
 * | 继承默认 | 隐式（读全局 localStorage） | 显式 `inheritDefaults` |
 *
 * ## 为什么 `document` 仍然出现
 *
 * 本文件在接线层（`runtime/`），**允许**摸 DOM —— 这是它的职责（#249 §4 规则 3）。
 * 纯规则都在 `domain/instanceSettings.ts`，那里没有 DOM。本文件只做三件事：
 * 读写宿主存储、把属性写到实例根、把偏好变更持久化。
 *
 * ## 主题与 CSS 变量的作用域
 *
 * `styles/*.css` 的变量定义在 `:root`（暗色默认）与 `[data-lk-theme="light"]`
 * （亮色覆盖）。因为自定义属性**沿 DOM 继承**，把 `data-lk-theme` 放在**实例根**
 * 而不是 `document.documentElement`，同页两个实例就各自解析出各自的变量值。
 *
 * Teleport 到 `body` 的浮层（如 Tooltip）脱离实例根的继承链，因此它们**自己**
 * 带上 `data-lk-theme`（见 `ContentText`/`ToolTipBox` 的 `theme` 处理）——
 * 这是"作用域 CSS"路径下的必要配套，不预设改用 Shadow DOM。
 */

import { ref, watch, type Ref } from 'vue'
import type { AppLanguage, AppTheme } from '@/domain/instanceSettings'
import {
  PREF_VERSION,
  instanceScopeId,
  preferenceKey,
  resolveInstanceSettings,
  type InstanceDefaults,
  type InstanceOverrides,
  type PreferenceNamespace,
} from '@/domain/instanceSettings'
import { isSupportedLang, translate } from '@/domain/i18n'

/** 外壳表面（决定偏好命名空间与 DOM 标识，不决定"是否全局"）。 */
export type ShellThemeSurface = 'workbench' | 'embed'

export interface CreateShellSettingsOptions {
  /** workbench / embed：影响偏好命名空间与默认主题来源 */
  surface?: ShellThemeSurface
  /** **实例身份**：同页多实例必须互不相同（默认按 surface 生成稳定值） */
  instanceId?: string
  /** 覆盖初始主题（如 embed mount 已由宿主指定） */
  initialTheme?: AppTheme
  initialLang?: AppLanguage
  /** 是否继承应用默认（#249 §19.7「每个实例显式选择」）；默认 true */
  inheritDefaults?: boolean
}

/**
 * 实例设置读面。
 *
 * `lang`/`theme` 是**本实例**的 ref —— 不是全局读源。`t()` 是本实例的翻译闭包，
 * 语言变化**只**影响本实例的调用点。
 */
export interface ShellSettings {
  readonly theme: Ref<AppTheme>
  readonly lang: Ref<AppLanguage>
  /** 本实例的翻译函数（消费本实例语言；无模块级状态）。 */
  t(key: string): string
  /** 本实例的 DOM 作用域标识（`lk-<instanceId>`），供 id/ARIA 加后缀。 */
  readonly scopeId: string
  /** 本实例根元素上要落的属性（`data-lk-theme` / `data-lk-lang`）。 */
  readonly scopeAttrs: Readonly<Record<string, string>>
  /** 显式切换语言（只影响本实例）。 */
  setLang(value: AppLanguage): void
  /** 显式切换主题（只影响本实例）。 */
  setTheme(value: AppTheme): void
}

/** 旧偏好键（迁移来源；#249 §19.7「旧偏好由存储适配迁移，失败不阻止文档打开」）。 */
export const LEGACY_LANG_KEY = 'wsr-wb-lang'
export const LEGACY_THEME_KEY = 'wb-theme'

/** 主题取自宿主文档级属性时的读取（仅 embed surface、仅在无实例偏好时）。 */
const LEGACY_NEI_THEME_ATTR = 'data-nei-theme'

/** 安全读宿主存储：任何异常（隐私模式/配额/损坏）都退回 `null`，不抛。 */
function safeGetItem(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    /* 配额/隐私模式：偏好不可持久化，但**不**影响文档打开与编辑 */
  }
}

/** 命名空间：workbench/embed 各自的偏好域。 */
function namespaceFor(surface: ShellThemeSurface): PreferenceNamespace {
  return surface === 'embed' ? 'embed' : 'workbench'
}

/** 实例身份默认值：按 surface 稳定派生（单实例外壳不需要编造 ID）。 */
function defaultInstanceId(surface: ShellThemeSurface): string {
  return surface === 'embed' ? 'embed' : 'workbench'
}

function readStoredLang(key: string): AppLanguage | null {
  const v = safeGetItem(key)
  return isSupportedLang(v) ? v : null
}

function readStoredTheme(key: string): AppTheme | null {
  const v = safeGetItem(key)
  return v === 'light' || v === 'dark' ? v : null
}

/**
 * 迁移旧偏好（#249 §19.7）。
 *
 * 迁移**只读旧键、只写本实例的新键**，且失败（存储不可用/值非法）时不抛异常、
 * 不阻止文档打开 —— 返回值只是"迁移到了什么"，调用方不需要为此分支。
 * 旧键**不删除**：其它尚未迁移的消费者（或用户回退版本）仍可读它，
 * 删除会造成跨版本不可逆的数据丢失。
 */
export function migrateLegacyPreferences(
  namespace: PreferenceNamespace,
  instanceId: string,
): { lang?: AppLanguage; theme?: AppTheme } {
  const out: { lang?: AppLanguage; theme?: AppTheme } = {}
  const newLangKey = preferenceKey(namespace, instanceId, 'lang')
  const newThemeKey = preferenceKey(namespace, instanceId, 'theme')

  if (safeGetItem(newLangKey) === null) {
    const legacy = readStoredLang(LEGACY_LANG_KEY)
    if (legacy !== null) {
      out.lang = legacy
      safeSetItem(newLangKey, legacy)
    }
  }
  if (safeGetItem(newThemeKey) === null) {
    const legacy = readStoredTheme(LEGACY_THEME_KEY)
      ?? (typeof document === 'undefined' ? null : readStoredTheme(document.documentElement.getAttribute(LEGACY_NEI_THEME_ATTR) ?? ''))
    if (legacy !== null) {
      out.theme = legacy
      safeSetItem(newThemeKey, legacy)
    }
  }
  return out
}

/**
 * 创建**实例作用域**的设置。
 *
 * 与旧实现的关键差异：本函数**不**写 `document.documentElement`、
 * **不**触碰任何模块级变量。它只：
 *  1. 读宿主存储取本实例偏好（必要时迁移旧键）；
 *  2. 计算本实例的有效设置（显式继承默认）；
 *  3. 把偏好变更写回**本实例**的命名空间键。
 */
export function createShellSettings(opts: CreateShellSettingsOptions = {}): ShellSettings {
  const surface = opts.surface ?? 'workbench'
  const namespace = namespaceFor(surface)
  const instanceId = opts.instanceId ?? defaultInstanceId(surface)
  const langKey = preferenceKey(namespace, instanceId, 'lang')
  const themeKey = preferenceKey(namespace, instanceId, 'theme')

  // 迁移旧偏好（失败不阻止打开：migrateLegacyPreferences 内部吞掉存储异常）
  const migrated = migrateLegacyPreferences(namespace, instanceId)

  /**
   * 本实例已持久化的偏好（重挂载后读回**自己的**值）。
   *
   * 这一步不能省：只做旧键迁移、不读新键，会表现为"改过的设置在重挂载后回到默认"
   * —— 本文件的 A33 测试抓出过这个缺陷（"重挂载后读回自己的偏好"曾判红）。
   * 读取优先级：本实例新键 > 旧键迁移值 > 应用默认。
   */
  const storedLang = readStoredLang(langKey)
  const storedTheme = readStoredTheme(themeKey)

  /** 应用默认配置（本实例的"默认"来源；profile 可覆盖）。 */
  const defaults: InstanceDefaults = {
    lang: opts.initialLang ?? migrated.lang ?? 'zh',
    theme: opts.initialTheme ?? migrated.theme ?? 'dark',
  }

  /**
   * 实例覆盖（本实例已持久化的偏好）。
   *
   * 若本实例已有持久化偏好，则它**不**再是"继承默认"实例 —— 否则重挂载会把
   * 用户改过的值抹回默认。`inheritDefaults` 的显式语义只在**调用方明确要求**时生效。
   */
  const persisted = storedLang !== null || storedTheme !== null
  const overrides: InstanceOverrides = {
    inheritDefaults: opts.inheritDefaults === true ? true : !persisted,
    ...(storedLang ?? migrated.lang ? { lang: storedLang ?? migrated.lang } : {}),
    ...(storedTheme ?? migrated.theme ? { theme: storedTheme ?? migrated.theme } : {}),
  }

  const effective = resolveInstanceSettings(defaults, overrides)
  const lang = ref<AppLanguage>(effective.lang)
  const theme = ref<AppTheme>(effective.theme)

  const scopeId = instanceScopeId(instanceId)

  // `flush: 'sync'`：偏好持久化必须与设置变更**同拍**完成。
  // 默认的 `flush: 'pre'` 会把写入推迟到下一个微任务，于是
  // "改设置 → 立刻断言存储键"会读到旧值，而重挂载（同一 tick 内重建实例）
  // 会读不到刚才的选择。偏好是小对象，同步写没有性能顾虑。
  watch(lang, (l) => {
    safeSetItem(langKey, l)
  }, { flush: 'sync' })
  watch(theme, (t) => {
    safeSetItem(themeKey, t)
  }, { flush: 'sync' })

  return {
    theme,
    lang,
    t: (key: string) => translate(key, lang.value),
    scopeId,
    get scopeAttrs() {
      return { 'data-lk-theme': theme.value, 'data-lk-lang': lang.value }
    },
    setLang: (value: AppLanguage) => { lang.value = value },
    setTheme: (value: AppTheme) => { theme.value = value },
  }
}

/** 本实例设置当前的 schema 版本（供诊断/测试对账"键有版本"这一事实）。 */
export const INSTANCE_PREF_VERSION = PREF_VERSION
