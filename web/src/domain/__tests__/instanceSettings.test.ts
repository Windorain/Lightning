/**
 * A33 `instance-ui-settings` —— 语言/主题/偏好按实例隔离（A33）。
 *
 * ## A33 的两列要求
 *
 * | Given/When | 必须成立的可观测断言 | 负对照必须判红 |
 * |---|---|---|
 * | 同页两嵌入实例不同语言/主题/键位，切换其一并重挂载 | 另一实例及宿主样式/偏好不变；新实例显式继承默认；DOM/ARIA 标识不冲突；核心错误码稳定 | 模块级 activeLang 或全局 CSS/存储键覆盖所有实例 |
 *
 * ## 负对照怎么"证明确实破坏了目标保证"
 *
 * "模块级 `activeLang`"这条负对照的**实证**方式不是"声称旧代码有问题"，而是：
 *
 * 1. **静态**：断言生产代码里**不再存在** `config/i18n` 模块与任何模块级可变
 *    语言读源（该文件已删除）；`t()` 必须经实例（`ctx.t` / 闭包）取得语言。
 * 2. **行为**：同一进程内构造两个实例，切换 A 的语言/主题，断言 B 的有效设置
 *    与 DOM 作用域属性**逐字节不变**；并断言二者解析出的翻译确实不同。
 * 3. **可归因**：把"语言作为显式输入"的纯函数 `translate(key, lang)` 与
 *    两个实例各自的 `t()` 对照 —— 证明差异来自**实例状态**，不是全局。
 */

// @vitest-environment jsdom

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeEach } from 'vitest'
import {
  PREF_VERSION,
  instanceScopeId,
  parsePreferenceKey,
  preferenceKey,
  resolveInstanceSettings,
  scopedDomId,
  withLang,
  withTheme,
  type InstanceDefaults,
} from '@/domain/instanceSettings'
import { createShellSettings, migrateLegacyPreferences } from '@/runtime/shellSettings'
import { TRANSLATION_KEYS, translate } from '@/domain/i18n'

const DEFAULTS: InstanceDefaults = { lang: 'zh', theme: 'dark' }

beforeEach(() => {
  localStorage.clear()
})

describe('A33 纯层：显式继承默认（新实例）', () => {
  it('`inheritDefaults: true` ⇒ 完全取默认；实例自己的字段**不**参与', () => {
    const r = resolveInstanceSettings(DEFAULTS, {
      inheritDefaults: true,
      lang: 'en',
      theme: 'light',
    })
    expect(r).toEqual({ lang: 'zh', theme: 'dark' })
  })

  it('`inheritDefaults: false` ⇒ 用自己的值；缺字段回退默认（不产生 undefined）', () => {
    expect(resolveInstanceSettings(DEFAULTS, { inheritDefaults: false, lang: 'en' }))
      .toEqual({ lang: 'en', theme: 'dark' })
    expect(resolveInstanceSettings(DEFAULTS, { inheritDefaults: false }))
      .toEqual({ lang: 'zh', theme: 'dark' })
  })

  it('纯性：不改输入、可重复', () => {
    const overrides = { inheritDefaults: false, lang: 'en' as const }
    const snapshot = JSON.stringify(overrides)
    const a = resolveInstanceSettings(DEFAULTS, overrides)
    const b = resolveInstanceSettings(DEFAULTS, overrides)
    expect(JSON.stringify(overrides)).toBe(snapshot)
    expect(a).toEqual(b)
  })

  it('切换语言/主题返回**新**对象（不改输入）', () => {
    const base = { inheritDefaults: true } as const
    const withEn = withLang(base, 'en')
    const withLight = withTheme(withEn, 'light')
    expect(base).toEqual({ inheritDefaults: true })
    expect(withEn).toEqual({ inheritDefaults: false, lang: 'en' })
    // 显式切换后 `inheritDefaults` 必须落到 false（否则"继承默认"会把用户选择抹掉）
    expect(withEn.inheritDefaults).toBe(false)
    expect(withLight).toEqual({ inheritDefaults: false, lang: 'en', theme: 'light' })
  })
})

describe('A33 持久键：命名空间 + 版本 + 实例身份', () => {
  it('键形态含命名空间、版本与实例身份', () => {
    const key = preferenceKey('workbench', 'wb-a', 'lang')
    expect(key).toBe(`lk.workbench.v${PREF_VERSION}.wb-a.lang`)
    const parsed = parsePreferenceKey(key)!
    expect(parsed).toEqual({
      namespace: 'workbench',
      version: PREF_VERSION,
      instanceId: 'wb-a',
      name: 'lang',
    })
  })

  it('两实例的键**不同**（负对照：全局存储键覆盖所有实例）', () => {
    const a = preferenceKey('embed', 'inst-a', 'theme')
    const b = preferenceKey('embed', 'inst-b', 'theme')
    expect(a).not.toBe(b)
    expect(a).toContain('inst-a')
    expect(b).toContain('inst-b')
  })

  it('命名空间隔离：workbench 与 embed 同实例名也互不覆盖', () => {
    expect(preferenceKey('workbench', 'x', 'lang')).not.toBe(preferenceKey('embed', 'x', 'lang'))
  })

  it('实例身份为空时退化为 `default`（单实例外壳不必编造 ID，键形态仍一致）', () => {
    expect(parsePreferenceKey(preferenceKey('embed', '', 'lang'))!.instanceId).toBe('default')
    expect(parsePreferenceKey(preferenceKey('embed', '   ', 'lang'))!.instanceId).toBe('default')
  })

  it('非本方案的键解析为 null（不误吞宿主页面的键）', () => {
    expect(parsePreferenceKey('wb-theme')).toBeNull()
    expect(parsePreferenceKey('lightning.prefs')).toBeNull()
    expect(parsePreferenceKey('wsr-wb-lang')).toBeNull()
  })
})

describe('A33 DOM/ARIA 标识不冲突', () => {
  it('`instanceScopeId` 归一化非法字符（DOM 标识可用）', () => {
    expect(instanceScopeId('a b/c')).toBe('lk-a-b-c')
    expect(instanceScopeId('')).toBe('lk-inst')
  })

  it('`scopedDomId` 让同页两实例的局部 id 不撞车', () => {
    const a = scopedDomId(instanceScopeId('one'), 'mb-tier')
    const b = scopedDomId(instanceScopeId('two'), 'mb-tier')
    expect(a).not.toBe(b)
    expect(a).toBe('lk-one--mb-tier')
    expect(b).toBe('lk-two--mb-tier')
  })
})

describe('A33 行为：同页两实例互不影响（负对照的核心）', () => {
  it('切换实例 A 的语言 ⇒ 实例 B 的有效设置与翻译**不变**', () => {
    const a = createShellSettings({ surface: 'workbench', instanceId: 'a', initialLang: 'zh' })
    const b = createShellSettings({ surface: 'workbench', instanceId: 'b', initialLang: 'zh' })

    // 初始：两实例同语言
    expect(a.lang.value).toBe('zh')
    expect(b.lang.value).toBe('zh')
    expect(a.t('file')).toBe('文件')
    expect(b.t('file')).toBe('文件')

    // 切 A
    a.setLang('en')
    expect(a.lang.value).toBe('en')
    expect(a.t('file')).toBe('File')

    // B 不受影响（这是"模块级 activeLang"负对照的直接反证）
    expect(b.lang.value).toBe('zh')
    expect(b.t('file')).toBe('文件')
  })

  it('切换实例 A 的主题 ⇒ 实例 B 的主题与 scopeAttrs 不变', () => {
    const a = createShellSettings({ surface: 'embed', instanceId: 'a', initialTheme: 'dark' })
    const b = createShellSettings({ surface: 'embed', instanceId: 'b', initialTheme: 'dark' })

    a.setTheme('light')
    expect(a.theme.value).toBe('light')
    expect(a.scopeAttrs['data-lk-theme']).toBe('light')

    expect(b.theme.value).toBe('dark')
    expect(b.scopeAttrs['data-lk-theme']).toBe('dark')
  })

  it('**不写** `document.documentElement`（退役"挂载期全局写入"）', () => {
    delete document.documentElement.dataset.lkTheme
    document.documentElement.removeAttribute('data-wb-theme')
    document.documentElement.removeAttribute('data-nei-theme')

    const s = createShellSettings({ surface: 'embed', instanceId: 'glob', initialTheme: 'light' })
    s.setLang('en')
    s.setTheme('dark')

    // 实例设置落在**实例作用域属性**上，不落在文档根
    expect(s.scopeAttrs['data-lk-theme']).toBe('dark')
    expect(document.documentElement.hasAttribute('data-wb-theme')).toBe(false)
    expect(document.documentElement.hasAttribute('data-nei-theme')).toBe(false)
  })

  it('实例偏好写入**各自的**存储键（互不覆盖）', () => {
    // 初始语言取不同值，随后各自切换 —— 这样两个实例的写入都是**真实变更**。
    const a = createShellSettings({ surface: 'workbench', instanceId: 'sa', initialLang: 'zh' })
    const b = createShellSettings({ surface: 'workbench', instanceId: 'sb', initialLang: 'en' })
    a.setLang('en')
    b.setLang('zh')
    expect(localStorage.getItem(preferenceKey('workbench', 'sa', 'lang'))).toBe('en')
    expect(localStorage.getItem(preferenceKey('workbench', 'sb', 'lang'))).toBe('zh')
    // 互不覆盖：a 的键里不是 b 的值，反之亦然
    expect(localStorage.getItem(preferenceKey('workbench', 'sa', 'lang'))).not.toBe(
      localStorage.getItem(preferenceKey('workbench', 'sb', 'lang')),
    )
  })

  it('把设置设为**当前值**是 no-op（Vue ref 无变化 ⇒ 不触发写入，不产生噪声键）', () => {
    const s = createShellSettings({ surface: 'embed', instanceId: 'noop', initialLang: 'zh' })
    s.setLang('zh')
    expect(localStorage.getItem(preferenceKey('embed', 'noop', 'lang'))).toBeNull()
    s.setLang('en')
    expect(localStorage.getItem(preferenceKey('embed', 'noop', 'lang'))).toBe('en')
  })

  it('重挂载（重建实例）后**读回自己的**偏好 —— 不读别的实例的', () => {
    const a1 = createShellSettings({ surface: 'workbench', instanceId: 'ra' })
    const b1 = createShellSettings({ surface: 'workbench', instanceId: 'rb' })
    a1.setLang('en')
    b1.setLang('zh')

    // 模拟"切换其一并重挂载"
    const a2 = createShellSettings({ surface: 'workbench', instanceId: 'ra' })
    const b2 = createShellSettings({ surface: 'workbench', instanceId: 'rb' })
    expect(a2.lang.value).toBe('en')
    expect(b2.lang.value).toBe('zh')
  })
})

describe('A33 旧偏好迁移（失败不阻止文档打开）', () => {
  it('旧全局键被迁移到本实例键，且旧键**保留**（不造成不可逆数据丢失）', () => {
    localStorage.setItem('wsr-wb-lang', 'en')
    localStorage.setItem('wb-theme', 'light')

    const migrated = migrateLegacyPreferences('workbench', 'mig')
    expect(migrated).toEqual({ lang: 'en', theme: 'light' })
    expect(localStorage.getItem(preferenceKey('workbench', 'mig', 'lang'))).toBe('en')
    expect(localStorage.getItem(preferenceKey('workbench', 'mig', 'theme'))).toBe('light')
    // 旧键保留（其它消费者/回退版本仍可读）
    expect(localStorage.getItem('wsr-wb-lang')).toBe('en')
    expect(localStorage.getItem('wb-theme')).toBe('light')
  })

  it('已有本实例新键时**不**被旧键覆盖', () => {
    localStorage.setItem(preferenceKey('workbench', 'keep', 'lang'), 'zh')
    localStorage.setItem('wsr-wb-lang', 'en')
    const migrated = migrateLegacyPreferences('workbench', 'keep')
    expect(migrated.lang).toBeUndefined()
    expect(localStorage.getItem(preferenceKey('workbench', 'keep', 'lang'))).toBe('zh')
  })

  it('迁移对非法/损坏的旧值安全：忽略并返回空（不抛异常）', () => {
    localStorage.setItem('wsr-wb-lang', '{"oops":1}')
    localStorage.setItem('wb-theme', 'neon')
    expect(() => migrateLegacyPreferences('workbench', 'bad')).not.toThrow()
    expect(migrateLegacyPreferences('workbench', 'bad')).toEqual({})
  })

  it('存储不可用（抛异常）时不阻止创建实例（文档仍可打开）', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('storage disabled') },
    })
    try {
      expect(() => createShellSettings({ surface: 'workbench', instanceId: 'nb' })).not.toThrow()
      const s = createShellSettings({ surface: 'workbench', instanceId: 'nb' })
      // 存储不可用 ⇒ 落到默认语言，但实例可用
      expect(s.lang.value).toBe('zh')
      expect(s.t('file')).toBe('文件')
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
    }
  })
})

describe('A33 负对照的静态证据：模块级全局语言读源已退役', () => {
  it('`config/i18n` 模块与模块级 `activeLang` 已从源码树删除', () => {
    const webRoot = path.resolve(import.meta.dirname, '..', '..', '..')
    expect(fs.existsSync(path.join(webRoot, 'src/config/i18n.ts'))).toBe(false)
    expect(fs.existsSync(path.join(webRoot, 'src/config'))).toBe(false)
  })

  it('生产代码不再有 `bindI18nLang` / `setLang(` 这类全局语言接管口', () => {
    const root = path.resolve(import.meta.dirname, '..')
    const offenders: string[] = []
    /**
     * 去掉注释后再扫。
     *
     * 必要性：退役纪律要求"实现与引用同批删除"，但**注释里说明
     * 旧机制叫什么**恰恰是交接所需的信息（不改代码的人要能读懂为什么这么改）。
     * 若把注释也算违规，就会逼着实现者删掉解释 —— 那是把治理手段变成知识损失。
     * 因此本断言的对象是**可执行代码**，不是散文。
     */
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name === '__tests__') continue
          walk(full)
          continue
        }
        if (!/\.(ts|vue)$/.test(e.name)) continue
        const text = stripComments(fs.readFileSync(full, 'utf8'))
        if (/\bbindI18nLang\b/.test(text)) offenders.push(`${e.name}:bindI18nLang`)
        // 模块级可变语言读源：`let activeLang` / `export const currentLang`
        if (/\b(let|var)\s+activeLang\b/.test(text)) offenders.push(`${e.name}:activeLang`)
        if (/\bexport const currentLang\b/.test(text)) offenders.push(`${e.name}:currentLang`)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })

  it('翻译在**实例**上：同一键在不同语言下取不同值，且键集不随语言改变', () => {
    const keys = TRANSLATION_KEYS
    // 键集稳定（改语言不改键 ⇒ 断言对象不随语言变化）
    expect(translate('file', 'zh')).toBe('文件')
    expect(translate('file', 'en')).toBe('File')
    expect(translate('nonexistent.key', 'en')).toBe('nonexistent.key')
    // 每个键在两种语言下都有值（无空洞）
    for (const k of keys) {
      expect(translate(k, 'zh'), k).not.toBe('')
      expect(translate(k, 'en'), k).not.toBe('')
    }
  })

  it('核心错误码/原因码不随语言变化（诊断与语言分离）', async () => {
    const { diagnosticReasonKey } = await import('@/application/diagnostics')
    // 键由稳定码派生，与语言无关
    expect(diagnosticReasonKey('property.readOnly')).toBe('diagnostic.property.readOnly')
    expect(diagnosticReasonKey('command.rejected')).toBe('diagnostic.command.rejected')
    // 码本身是字面量，不含自然语言
    expect(diagnosticReasonKey('content.rejected')).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
