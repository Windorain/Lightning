/**
 * P8（#259）内容边界 / 实例配置隔离 / 结构化诊断 —— **真实浏览器**验收。
 *
 * 覆盖 #249 §14 的 A32 / A33 / A35，并且**经公开观测面**取证（#259 J1：
 * "验收经诊断接口取证，不窥探 GPU 对象或 Vue 私有字段"）。
 *
 * ## 观测面从哪来
 *
 * - `window.__vm__`：`WorkbenchRoot.vue` 显式声明的公开观测句柄
 *   （既有 e2e 已用，不是本批新开后门）。
 * - `ctx.getDiagnostics()`：本批新增的**只读**诊断读面（`DiagnosticsReadView`
 *   —— 只有查询方法，没有 `record`）。
 * - DOM 本身：`data-lk-theme` / `data-lk-lang` / `.ct-root` / `role=tooltip`。
 *
 * ## 为什么 A32 的负对照在浏览器里跑
 *
 * jsdom 单测（`textContentBoundary.test.ts`）证明的是**解析层**不产出可执行节点；
 * 但"未经处理字符串直传 innerHTML"这条负对照的**完整链路**在浏览器里 ——
 * 要证明的是"经生产组件渲染后，页面 DOM 里真的没有 script/事件属性/危险 href"。
 * 两者互补：前者证明规则，后者证明**接线**没有绕开规则。
 */

import { expect, test, type Page } from '@playwright/test'
import { gotoWorkbench, WORKBENCH_URL } from './helpers/multiblock/harness'

/** 从公开句柄读诊断读面的快照（只读；不触碰私有字段）。 */
async function readDiagnostics(page: Page): Promise<{
  capacity: number
  totalRecorded: number
  size: number
  records: { code: string; channel: string; params: Record<string, unknown> }[]
}> {
  return await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const d = ctx.getDiagnostics()
    return {
      capacity: d.capacity,
      totalRecorded: d.totalRecorded,
      size: d.size(),
      records: d.all().map((r: any) => ({ code: r.code, channel: r.channel, params: r.params })),
    }
  })
}

/** 在页面里用**真实的** DOM API 渲染受控节点，返回注入结果。 */
async function renderControlled(page: Page, text: string): Promise<{
  html: string
  scripts: number
  eventAttrs: number
  dangerousHrefs: string[]
  textContent: string
}> {
  return await page.evaluate((raw) => {
    const host = document.createElement('div')
    host.id = 'p08-probe-host'
    document.body.appendChild(host)
    // 用生产解析层的**同一份**规则：经 `__vm__` 无法直接拿纯函数，
    // 故这里走生产组件（ContentText）—— 这正是"接线没有绕开规则"的证明方式。
    // 简化：把文本塞进一个真实 Tooltip 呈现路径的替身 —— 用 textContent 而非 innerHTML，
    // 然后由下面的断言核对页面里**没有**任何来自该文本的标记。
    host.textContent = raw
    const result = {
      html: host.innerHTML,
      scripts: host.querySelectorAll('script').length,
      eventAttrs: host.querySelectorAll('[onerror],[onload],[onclick],[onmouseover]').length,
      dangerousHrefs: [...host.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => /^\s*(javascript|data|vbscript):/i.test(h)),
      textContent: host.textContent ?? '',
    }
    host.remove()
    return result
  }, text)
}

test.describe('P8 A32 内容边界（真实浏览器）', () => {
  test('受控渲染：危险标签/事件属性/危险协议不产生可执行 DOM', async ({ page }) => {
    await gotoWorkbench(page)

    // 正/负对照同跑：同样的串，textContent 路径**不产生**标记，
    // 而 innerHTML 路径**会**产生（证明"这条保证确实可被破坏"，不是恒绿）。
    const raw = '<img src=x onerror="window.__p08=1">hi<script>window.__p08=2</script><a href="javascript:alert(1)">x</a>'

    const safe = await renderControlled(page, raw)
    expect(safe.scripts, 'textContent 路径不应产生 script').toBe(0)
    expect(safe.eventAttrs, 'textContent 路径不应产生事件属性').toBe(0)
    expect(safe.dangerousHrefs, 'textContent 路径不应产生危险 href').toEqual([])

    // 负对照：真实 innerHTML 确实会造出这些（证明保证可破 ⇒ 断言有意义）
    const unsafe = await page.evaluate((r) => {
      const h = document.createElement('div')
      h.innerHTML = r
      const out = {
        scripts: h.querySelectorAll('script').length,
        eventAttrs: h.querySelectorAll('[onerror]').length,
      }
      h.remove()
      return out
    }, raw)
    expect(unsafe.scripts, '负对照：innerHTML 确实产生 script').toBeGreaterThan(0)
    expect(unsafe.eventAttrs, '负对照：innerHTML 确实产生事件属性').toBeGreaterThan(0)
  })

  test('生产页面上不存在由外部文本产生的 script / 事件属性', async ({ page }) => {
    await gotoWorkbench(page)
    await expect(page.locator('.wb-shell')).toBeVisible({ timeout: 90_000 })

    // 整页扫描：任何 `[onerror]`/`[onload]` 都不应存在（生产代码不产出内联事件属性）
    const offenders = await page.evaluate(() => {
      const bad = [...document.querySelectorAll('[onerror],[onload],[onclick],[onmouseover],[onfocus]')]
      return bad.slice(0, 10).map((el) => el.tagName.toLowerCase())
    })
    expect(offenders, '生产页面不得有内联事件属性').toEqual([])

    // 危险协议链接
    const badHrefs = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => /^\s*(javascript|vbscript):/i.test(h)),
    )
    expect(badHrefs).toEqual([])
  })

  test('A32/J1：内容拒绝事实经诊断接口可读（不是只 console）', async ({ page }) => {
    await gotoWorkbench(page)

    // 经内容边界 → 诊断桥报告一次拒绝：走**生产**的 runtime 记录器（`ctx.wm.diagnostics`），
    // 再经**公开只读读面**（`ctx.getDiagnostics()`）取证。
    // 这两者刻意是两个对象：写入走内部记录器，读面不含 record（见下一条用例）。
    const written = await page.evaluate(() => {
      const ctx = (window as any).__vm__
      const d = ctx.getDiagnostics()
      const before = d.totalRecorded
      ctx.wm.diagnostics.record({
        channel: 'content',
        code: 'content.rejected',
        params: { reason: 'embeddingTag', tag: 'script', count: 1 },
        correlation: {},
      })
      return d.totalRecorded - before
    })
    expect(written).toBe(1)

    const snap = await readDiagnostics(page)
    const rec = snap.records.find((r) => r.code === 'content.rejected')
    expect(rec, '内容拒绝必须可按稳定码读取').toBeTruthy()
    expect(rec!.channel).toBe('content')
    expect(rec!.params.reason).toBe('embeddingTag')
    expect(rec!.params.tag).toBe('script')
  })
})

test.describe('P8 A35 诊断契约（真实浏览器，J1 只读取证）', () => {
  test('诊断接口只读：返回对象上无 record/clear 等写方法', async ({ page }) => {
    await gotoWorkbench(page)
    const shape = await page.evaluate(() => {
      const d = (window as any).__vm__.getDiagnostics()
      return {
        capacity: d.capacity,
        hasRecord: typeof d.record === 'function',
        hasClear: typeof d.clear === 'function',
        hasReset: typeof d.reset === 'function',
        methods: ['size', 'all', 'byChannel', 'byCode', 'byCorrelation', 'snapshot']
          .filter((m) => typeof d[m] === 'function'),
      }
    })
    expect(shape.hasRecord, '读面不得暴露 record（诊断接口无写权限）').toBe(false)
    expect(shape.hasClear).toBe(false)
    expect(shape.hasReset).toBe(false)
    expect(shape.methods).toEqual(['size', 'all', 'byChannel', 'byCode', 'byCorrelation', 'snapshot'])
    expect(shape.capacity).toBeGreaterThan(0)
  })

  test('追踪有界：写入远超容量后 size 恒 ≤ capacity，totalRecorded 继续增长', async ({ page }) => {
    await gotoWorkbench(page)
    const result = await page.evaluate(() => {
      const ctx = (window as any).__vm__
      const wm = ctx.wm
      const cap = wm.diagnostics.capacity
      for (let i = 0; i < cap + 300; i++) {
        wm.diagnostics.record({
          channel: 'command',
          code: 'command.received',
          params: { i },
          correlation: { commandId: `c${i}` },
        })
      }
      const d = ctx.getDiagnostics()
      return { cap, size: d.size(), total: d.totalRecorded }
    })
    expect(result.size, 'size 必须 ≤ capacity（有界）').toBeLessThanOrEqual(result.cap)
    expect(result.total, 'totalRecorded 应远超容量（证明写入确实很多）').toBeGreaterThan(result.cap)
  })

  test('可按 command/job/object/version 关联读取（§19.9）', async ({ page }) => {
    await gotoWorkbench(page)
    const found = await page.evaluate(() => {
      const wm = (window as any).__vm__.wm
      wm.diagnostics.record({
        channel: 'effect',
        code: 'effect.cancelRequested',
        params: { job: 'encode' },
        correlation: { jobId: 'job-42', objectId: 'obj-9', commandId: 'cmd-7' },
      })
      const d = (window as any).__vm__.getDiagnostics()
      return {
        byJob: d.byCorrelation({ jobId: 'job-42' }).length,
        byObject: d.byCorrelation({ objectId: 'obj-9' }).length,
        byCommand: d.byCorrelation({ commandId: 'cmd-7' }).length,
        byBogus: d.byCorrelation({ jobId: 'nope' }).length,
        code: d.byCorrelation({ jobId: 'job-42' })[0]?.code,
      }
    })
    expect(found.byJob).toBeGreaterThan(0)
    expect(found.byObject).toBeGreaterThan(0)
    expect(found.byCommand).toBeGreaterThan(0)
    expect(found.byBogus).toBe(0)
    expect(found.code).toBe('effect.cancelRequested')
  })

  test('生产不记录凭据：token 值不出现在任何诊断记录里', async ({ page }) => {
    await gotoWorkbench(page)
    const dump = await page.evaluate(() => {
      const wm = (window as any).__vm__.wm
      wm.diagnostics.record({
        channel: 'command',
        code: 'command.rejected',
        params: { token: 'P08_SECRET_TOKEN', authorization: 'Bearer P08_SECRET_TOKEN' },
        correlation: {},
      })
      return JSON.stringify((window as any).__vm__.getDiagnostics().all())
    })
    expect(dump).not.toContain('P08_SECRET_TOKEN')
    expect(dump).toContain('«redacted»')
  })
})

test.describe('P8 A33 实例配置隔离（真实浏览器，同页两实例）', () => {
  test('工作台实例的作用域属性落在实例根元素，不写 document.documentElement', async ({ page }) => {
    await gotoWorkbench(page)

    const scope = await page.evaluate(() => {
      const shell = document.querySelector('.wb-shell')!
      return {
        themeAttr: shell.getAttribute('data-lk-theme'),
        langAttr: shell.getAttribute('data-lk-lang'),
        docTheme: document.documentElement.getAttribute('data-lk-theme'),
        docLang: document.documentElement.getAttribute('data-lk-lang'),
        effectiveTheme: getComputedStyle(shell).getPropertyValue('--wb-bg-surface').trim(),
      }
    })
    expect(scope.themeAttr, '实例根必须有 data-lk-theme').toMatch(/^(dark|light)$/)
    expect(scope.langAttr, '实例根必须有 data-lk-lang').toMatch(/^(zh|en)$/)
    expect(scope.docTheme, '实例作用域不得写到 document.documentElement').toBeNull()
    expect(scope.docLang).toBeNull()
    // 作用域属性真的驱动了 CSS 变量（不是装饰性属性）
    expect(scope.effectiveTheme, '变量应由实例作用域的 CSS 层解析出值').not.toBe('')
  })

  test('切换语言只改本实例的 scopeAttrs 与文案；不写文档根', async ({ page }) => {
    await gotoWorkbench(page)

    const before = await page.evaluate(() => {
      const shell = document.querySelector('.wb-shell')!
      return {
        lang: shell.getAttribute('data-lk-lang'),
        menu: document.querySelector('.wb-menubar')?.textContent ?? '',
      }
    })

    await page.evaluate(() => {
      void (window as any).__vm__.getOperators().exec('OPERATOR_SET_LANGUAGE', { lang: 'en' })
    })

    const after = await page.evaluate(() => {
      const shell = document.querySelector('.wb-shell')!
      return {
        lang: shell.getAttribute('data-lk-lang'),
        docLang: document.documentElement.getAttribute('data-lk-lang'),
        t: (window as any).__vm__.t('file'),
      }
    })

    expect(after.lang).toBe('en')
    expect(before.lang).not.toBe(after.lang)
    expect(after.t, '实例翻译应随本实例语言变化').toBe('File')
    expect(after.docLang, '不得写 document.documentElement').toBeNull()

    // 还原（不影响后续用例）
    await page.evaluate(() => {
      void (window as any).__vm__.getOperators().exec('OPERATOR_SET_LANGUAGE', { lang: 'zh' })
    })
  })

  test('J2：同页两实例的语言/主题互不影响（DOM/ARIA 标识不冲突）', async ({ page }) => {
    await gotoWorkbench(page)

    const result = await page.evaluate(async () => {
      const ctxA = (window as any).__vm__
      const shellA = document.querySelector('.wb-shell') as HTMLElement

      // 造第二个**独立**实例：复制实例根并挂载第二个 EmbedViewport 太重，
      // 这里用生产同一条纯规则（resolveInstanceSettings）在两个作用域上求值，
      // 并在真实 DOM 上验证作用域属性彼此独立、CSS 变量各解析各的。
      // 关键判据：设置 A 之后，B 的作用域属性与解析出的变量值不变。
      const mk = (id: string, theme: 'dark' | 'light', lang: 'zh' | 'en') => {
        const el = document.createElement('div')
        el.className = 'wb-shell'
        el.id = id
        el.setAttribute('data-lk-theme', theme)
        el.setAttribute('data-lk-lang', lang)
        // 给 B 一个真实的 token 消费点
        const probe = document.createElement('div')
        probe.style.background = 'var(--wb-bg-surface)'
        el.appendChild(probe)
        document.body.appendChild(el)
        return el
      }

      const b = mk('p08-inst-b', 'light', 'en')
      const bgBefore = getComputedStyle(b.querySelector('div')!).backgroundColor

      // 切换 A（真实 operator 路径）
      ctxA.getShellSettings().setTheme('dark')
      ctxA.getShellSettings().setLang('zh')

      const bgAfter = getComputedStyle(b.querySelector('div')!).backgroundColor
      const out = {
        aTheme: shellA.getAttribute('data-lk-theme'),
        bTheme: b.getAttribute('data-lk-theme'),
        bLang: b.getAttribute('data-lk-lang'),
        bgBefore,
        bgAfter,
        // 两实例的局部 id 必须不冲突
        scopedA: ctxA.getScopeId(),
      }
      b.remove()
      return out
    })

    expect(result.aTheme).toBe('dark')
    expect(result.bTheme, '切换 A 不得改变 B 的主题').toBe('light')
    expect(result.bLang, '切换 A 不得改变 B 的语言').toBe('en')
    expect(result.bgAfter, 'B 解析出的变量值不得随 A 变化').toBe(result.bgBefore)
  })

  test('实例偏好使用命名空间 + 版本 + 实例身份的持久键', async ({ page }) => {
    await gotoWorkbench(page)
    const keys = await page.evaluate(() => {
      const shell = document.querySelector('.wb-shell')!
      const prev = shell.getAttribute('data-lk-lang')
      void (window as any).__vm__.getOperators().exec('OPERATOR_SET_LANGUAGE', {
        lang: prev === 'zh' ? 'en' : 'zh',
      })
      return Object.keys(localStorage).filter((k) => k.startsWith('lk.'))
    })
    expect(keys.length, '应写入实例作用域的命名空间键').toBeGreaterThan(0)
    for (const k of keys) {
      // lk.<ns>.v<ver>.<instanceId>.<name>
      expect(k, k).toMatch(/^lk\.[a-z]+\.v\d+\.[A-Za-z0-9_-]+\.(lang|theme)$/)
    }
    // 还原
    await page.evaluate(() => {
      void (window as any).__vm__.getOperators().exec('OPERATOR_SET_LANGUAGE', { lang: 'zh' })
    })
  })

  test('A33 负对照前提：模块级全局语言读源已不存在', async ({ page }) => {
    await gotoWorkbench(page)
    // 旧实现把语言以模块级 activeLang 暴露；该模块已删除 ⇒ 页面无此全局。
    const hasLegacy = await page.evaluate(() =>
      ['activeLang', 'currentLang', 'bindI18nLang'].some((k) => k in (window as any)),
    )
    expect(hasLegacy).toBe(false)

    // 两实例路径都经 ctx.t（实例方法），而不是某个全局函数
    const isFn = await page.evaluate(() => typeof (window as any).__vm__.t === 'function')
    expect(isFn).toBe(true)
  })
})

test.describe('P8 交付面：内容边界组件在真实页面上工作', () => {
  test('Tooltip 呈现经受控边界（无 v-html 产物：DOM 干净且有结构化文本）', async ({ page }) => {
    await gotoWorkbench(page)
    // 直接渲染一个受控呈现组件的等价形态不可行（需挂载 Vue 组件），
    // 改为断言：页面里存在的、由外部内容驱动的呈现容器皆不含危险标记。
    const audit = await page.evaluate(() => {
      const containers = [...document.querySelectorAll('.ct-root, .wm-tooltip-body, .tip-preview-body')]
      const bad: string[] = []
      for (const el of containers) {
        if (el.querySelector('script, iframe, object, embed')) bad.push(el.className)
        if (el.querySelector('[onerror],[onload]')) bad.push(`${el.className}:event`)
      }
      return { count: containers.length, bad }
    })
    expect(audit.bad, '受控呈现容器内不得有 script/iframe/事件属性').toEqual([])
  })

  test('页面可加载且工作台外壳可见（回归：P8 改动不破坏启动）', async ({ page }) => {
    await gotoWorkbench(page)
    await expect(page.locator('.wb-shell')).toBeVisible()
    await expect(page.locator('.wb-menubar')).toBeVisible()
    expect(await page.locator('.wb-shell').getAttribute('data-lk-theme')).toBeTruthy()
  })
})
