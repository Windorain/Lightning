/**
 * **呈现层纯净性 + 遗留 RAF 普查** 闸门（#256；#249 §15 第 6/8 条与 §19.3 的可执行面）。
 *
 * ## 为什么需要它（两条判据各自防什么）
 *
 * ### 一、呈现层不得自驱时间（防止"在新层里重建旧病"）
 *
 * #249 §2.1 要求纯函数不读全局时钟；§19.3 的 A27 判据原文是
 * 「各视口**累加 delta**、边界偏移或默认淡入淡出」属**违规**，且「无材质独立 tick」。
 *
 * 本批新建的 `src/presentation/**` 是"求值场景 → 渲染数据"的编译层，它的时间**必须**
 * 来自 `EvaluationKey.time`（契约 §4）这一**显式输入**。若哪天有人在呈现层里写
 * `requestAnimationFrame` / `Date.now()` / `new THREE.Clock()`，那就是把旧病
 * （每视口/每材质自行累计 tick）搬进了新层 —— 而新层是**同步**阶段唯一无此病的证据。
 * 故本闸门把它钉成不变量（P1 用同类方式钉住了内核无 Proxy）。
 *
 * ### 二、遗留 RAF 必须逐条登记（把"接缝"变成可审计事实，而不是汇报里的一句话）
 *
 * #249 §15 第 6 条的判据是「**所有业务推进可枚举**；**局部绘制唤醒不写领域状态**」。
 * 注意它**不**要求"零 RAF" —— 绘制唤醒与输入合并本身是合法的；
 * 违规的是「多 RAF 分别推进业务」。
 *
 * 因此本闸门的做法是**普查 + 强制登记**，而不是断言数量为零：
 *  - 机制的每一条 `requestAnimationFrame` 都必须在本文件的 `LEGACY_RAF_SITES` 里有条目，
 *    并写明 `kind`（推进业务 / 绘制唤醒 / 输入合并）、归属批次与退出阶段；
 *  - 反向也要求：登记表里不得有已不存在的条目（防止"登记了就算退役"的假象）。
 *
 * 于是 P11（#262）的「业务 RAF 零残留终局审计」有了**机械起点**：
 * 只要 `kind: 'business-advance'` 的集合非空，就没退完；退完了这一集合自然为空。
 * 这条集合**本批仍非空**（见下方表内注释与 #256 汇报的接缝一节），
 * 本闸门如实反映该事实，不把它写成已清。
 *
 * ## 为什么不改 `boundary-rules.mjs`
 *
 * Lead 裁决：不碰规则本体。本文件与 `kernel-legacy-isolation.test.ts` 并列，
 * 走 `npm run test:arch`（其 include 为 `tests/architecture/**\/*.test.ts`）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEB_ROOT } from './module-graph.mjs'

const SRC_ROOT = path.join(WEB_ROOT, 'src')
const PRESENTATION_DIR = path.join(SRC_ROOT, 'presentation')

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

/** 递归收集某目录下的生产文件（排除 `__tests__` 与 `*.test/spec`）。 */
function collectProductionFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue
        walk(p)
        continue
      }
      if (!/\.(ts|tsx|mts|vue)$/.test(entry.name)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue
      out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

/**
 * 只保留**代码文本**行（丢掉 `*` / `//` / `/*` 开头的注释行）。
 *
 * 理由：注释里写"旧实现用 requestAnimationFrame"是**有价值**的退役记录，
 * 不能被判红（P1 的同类闸门已确立此口径）。但反过来，把代码藏进注释也骗不过它。
 */
function codeOnlyLines(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line))
}

/** 该行是否**真的调用**了 `requestAnimationFrame`（排除注释行后）。 */
const RAF_CALL = /\brequestAnimationFrame\s*\(/

/** 呈现层不得出现的自驱时间来源。 */
const FORBIDDEN_TIME_SOURCES = [
  { needle: 'requestAnimationFrame', why: '呈现层不得自驱绘制循环（时间必须来自 EvaluationKey.time）' },
  { needle: 'setTimeout', why: '呈现层不得自建定时器（动画推进属于统一动画求值）' },
  { needle: 'setInterval', why: '呈现层不得自建周期推进' },
  { needle: 'Date.now', why: '呈现层不得读全局时钟（§2.1：纯函数不读时钟）' },
  { needle: 'performance.now', why: '呈现层不得读全局时钟（§2.1）' },
  { needle: 'THREE.Clock', why: '呈现层不得自行累计 delta（A27 判据原文禁止累加 delta）' },
]

/**
 * 遗留 RAF 登记表（`src/` 全生产文件的普查结果，逐条可解释）。
 *
 * `kind` 的语义（决定它是否属 §15 第 6 条的违规面）：
 *  - `business-advance`：**推进业务/动画时间** ⇒ 必须改经统一执行协议或统一动画求值，
 *    未退完则 P11 审计不通过；
 *  - `paint-wakeup`：**局部绘制唤醒**（resize / 组件测量）⇒ 判据允许，
 *    只要它不写领域状态；
 *  - `input-coalesce`：**输入合并**（高频事件每帧至多一次）⇒ 同上，
 *    且它只写视图态（Region.state.hover）。
 */
const LEGACY_RAF_SITES = [
  {
    file: 'runtime/renderEngine.ts',
    kind: 'business-advance',
    owner: 'P5',
    issue: 256,
    // 这一条是本批**未**删除的那一半：它是"呈现重写"的核心接缝。
    replacement: '呈现层的按需呈现 + P4 统一动画求值（纹理时间绑定场景时间）',
    exitStage: 'P4 合入后同批删除 renderEngine 自驱 tick（由 Lead 排合并顺序）',
    note:
      '同一个 RAF 里混了两件事：绘制（renderMain/renderOverlay/renderGizmo）与'
      + ' `materialLibrary.tick(clock.getDelta()*1000)`（每材质自行累计时间，§19.3 明令禁止）。'
      + ' 前者需要驱动者、后者需要语义替代 —— 两者都不在本批范围内凭空可得。',
  },
  {
    file: 'runtime/renderEngine.ts',
    kind: 'paint-wakeup',
    owner: 'P5',
    issue: 256,
    replacement: '与 tick 合并为单一呈现驱动，或改由 ResizeObserver 直接驱动',
    exitStage: '与上面 tick 同一处收口（同一个类）',
    note: '合并 resize 事件为每帧一次 GL 尺寸同步；不写领域状态 ⇒ 判据允许。',
  },
  {
    file: 'runtime/hover/pickSchedule.ts',
    kind: 'input-coalesce',
    owner: 'P5',
    issue: 256,
    replacement: 'P7（#258）输入路由的合并策略；本层只保留"每帧至多一次"的合并语义',
    exitStage: 'P7 交付同批（输入路由归口）',
    note:
      '把高频 pointermove 合并为每帧最多一次拾取。消费者是 `handlers/hoverHandler.ts`，'
      + '它写的是 `Region.state.hover`（视图态），**不**写文档/历史 ⇒ 不构成"推进业务"。',
  },
  {
    file: 'workbench/ux/panels/useMaterialAnimation.ts',
    kind: 'business-advance',
    owner: 'P4',
    issue: 255,
    replacement: 'P4 统一动画求值轨道（离散阶跃采样）',
    exitStage: 'P4 交付同批（B5 已定：材质动画并入统一时间）',
    note: '**不是** P5 的区（Lead 裁决：materialAnimation 归 P4）。此处仅登记以便 P11 对账。',
  },
  {
    file: 'embed/components/ToolTipBox.vue',
    kind: 'paint-wakeup',
    owner: 'P8',
    issue: 259,
    replacement: '无（组件本地测量，不涉时间语义）',
    exitStage: '不属退役条目；登记以免被误判为"未登记 RAF"',
    note: '下一帧测量并夹取 tooltip 位置；中立 UI 设施。',
  },
  {
    file: 'logging/LogCenter.ts',
    kind: 'paint-wakeup',
    owner: 'P11',
    issue: 262,
    replacement: '无（诊断面板本地渲染调度）',
    exitStage: '不属退役条目；中立设施（P1 已说明 logging 不算旧权威对象）',
    note: '日志面板轮询渲染；与旧权威对象无关。',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// 一、呈现层纯净性
// ─────────────────────────────────────────────────────────────────────────────

describe('呈现层纯净性：时间必须来自显式求值输入，不得自驱（#249 §2.1/§19.3）', () => {
  const files = collectProductionFiles(PRESENTATION_DIR)

  it('反空洞真：呈现层确实有生产文件与真实导入（否则下面的"0 违规"可能只是"没扫到"）', () => {
    expect(files.length, '呈现层必须有生产文件').toBeGreaterThan(5)
    const importCount = files.reduce((n, f) => {
      const text = fs.readFileSync(f, 'utf8')
      return n + (text.match(/^\s*import\b/gm)?.length ?? 0)
    }, 0)
    expect(importCount, '呈现层必须有真实 import（否则断言器空转）').toBeGreaterThan(5)
  })

  it('呈现层不含任何自驱时间来源', () => {
    const hits = []
    for (const f of files) {
      const rel = path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/')
      const text = fs.readFileSync(f, 'utf8')
      for (const { line, no } of codeOnlyLines(text)) {
        for (const { needle, why } of FORBIDDEN_TIME_SOURCES) {
          if (line.includes(needle)) hits.push(`${rel}:${no} 出现 ${needle} —— ${why}`)
        }
      }
    }
    expect(
      hits,
      `呈现层出现自驱时间来源（时间必须来自 EvaluationKey.time 显式输入）:\n${hits.join('\n')}`,
    ).toEqual([])
  })

  it('**负对照**：同一判据能抓到注入的自驱时间（证明上一条不是空转）', () => {
    const sample = 'const id = requestAnimationFrame(() => { const t = Date.now() })'
    const found = FORBIDDEN_TIME_SOURCES.filter(({ needle }) => sample.includes(needle))
    expect(found.map((f) => f.needle).sort()).toEqual(['Date.now', 'requestAnimationFrame'])
  })

  it('**负对照**：把自驱时间写进注释**不**判红（退役记录必须可写）', () => {
    const sample = '// 旧实现用 requestAnimationFrame + Date.now() 推进；已退役'
    const hits = codeOnlyLines(sample).filter(({ line }) =>
      FORBIDDEN_TIME_SOURCES.some(({ needle }) => line.includes(needle)),
    )
    expect(hits, '注释行必须被排除').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、遗留 RAF 普查（双向登记）
// ─────────────────────────────────────────────────────────────────────────────

describe('#249 §15 第 6 条：遗留 RAF 必须逐条登记（可枚举，供 P11 终局审计）', () => {
  /** 机制性普查：`src/` 全部生产文件里的真实 RAF 调用点。 */
  function censusRafSites() {
    const found = []
    for (const f of collectProductionFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/')
      const text = fs.readFileSync(f, 'utf8')
      for (const { line, no } of codeOnlyLines(text)) {
        if (RAF_CALL.test(line)) found.push({ file: rel, line: no })
      }
    }
    return found
  }

  it('普查结果与登记表**双向一致**（无漏登记、无僵尸登记）', () => {
    const found = censusRafSites()
    const declared = new Set(LEGACY_RAF_SITES.map((s) => s.file))
    const actual = new Set(found.map((h) => h.file))

    const undeclared = [...actual].filter((f) => !declared.has(f))
    expect(
      undeclared,
      `出现未登记的 RAF 调用点（#249 §15 第 6 条要求"业务推进可枚举"）:\n`
        + found
          .filter((h) => undeclared.includes(h.file))
          .map((h) => `  src/${h.file}:${h.line}`)
          .join('\n'),
    ).toEqual([])

    const stale = [...declared].filter((f) => !actual.has(f))
    expect(
      stale,
      `登记表里有已不存在的 RAF 调用点（退役后必须同批更新本表，否则"登记"会变成假象）:\n`
        + stale.map((f) => `  ${f}`).join('\n'),
    ).toEqual([])
  })

  it('每条登记都有归属批次、替代机制与退出阶段（不得只写"待办"）', () => {
    for (const s of LEGACY_RAF_SITES) {
      const where = `${s.file}`
      expect(s.owner, `${where} 必须写归属批次`).toMatch(/^P\d+$/)
      expect(s.issue, `${where} 必须写归属 issue 号`).toBeGreaterThan(0)
      expect(s.replacement?.length ?? 0, `${where} 必须写替代机制`).toBeGreaterThan(0)
      expect(s.exitStage?.length ?? 0, `${where} 必须写退出阶段`).toBeGreaterThan(0)
      expect(['business-advance', 'paint-wakeup', 'input-coalesce']).toContain(s.kind)
      expect(fs.existsSync(path.join(SRC_ROOT, s.file)), `${where} 必须真实存在`).toBe(true)
    }
  })

  it('P5 归属的 RAF 集合 == 本批如实声明的"未退完"集合（不把接缝写成已清）', () => {
    const p5 = LEGACY_RAF_SITES.filter((s) => s.owner === 'P5')
    // 本批（#256）**没有**把 P5 名下的 RAF 全部删除：tick 的自驱动画时间与
    // pickSchedule 的输入合并分别需要 P4 与 P7 的语义替代（见各条 `note`）。
    // 这条断言的作用不是"要求非空"，而是**每当集合变化就逼着改这里** ——
    // 于是"退完了"这件事必须由一个提交显式声明，而不是自然漂移。
    expect(
      p5.map((s) => `${s.file}#${s.kind}`).sort(),
      'P5 名下 RAF 集合变化时必须同批更新本断言（它是 P11 审计的起点）',
    ).toEqual([
      'runtime/hover/pickSchedule.ts#input-coalesce',
      'runtime/renderEngine.ts#business-advance',
      'runtime/renderEngine.ts#paint-wakeup',
    ])
  })

  it('#249 §15 第 6 条的违规面 = business-advance 集合（当前非空 ⇒ 如实记为未退完）', () => {
    const business = LEGACY_RAF_SITES.filter((s) => s.kind === 'business-advance')
    // 违规面当前非空（P4 的材质动画 + P5 的 renderEngine 自驱时间）。
    // 本断言如实固化"未退完"这一事实；P11 终局审计要求它变为空集。
    expect(business.length, '本批仍在存在推进业务的 RAF —— 这是如实记录，不是通过').toBeGreaterThan(0)
    for (const s of business) {
      expect(s.exitStage, `${s.file} 属违规面，必须有明确退出阶段`).not.toMatch(/不属退役条目/)
    }
  })

  it('**负对照**：登记表中出现不存在的文件会被判红（证明存在性检查不是空转）', () => {
    const bogus = { file: 'runtime/does-not-exist-xyz.ts' }
    expect(fs.existsSync(path.join(SRC_ROOT, bogus.file))).toBe(false)
  })
})
