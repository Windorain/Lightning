/**
 * **呈现层纯净性 + 遗留 RAF 普查** 闸门。
 *
 * ## 为什么需要它（两条判据各自防什么）
 *
 * ### 一、呈现层不得自驱时间（防止"在新层里重建旧病"）
 *
 * 纯函数不读全局时钟；「各视口**累加 delta**、边界偏移或默认淡入淡出」属**违规**，
 * 且要求「无材质独立 tick」。
 *
 * `src/presentation/**` 是"求值场景 → 渲染数据"的编译层，它的时间**必须**
 * 来自 `EvaluationKey.time`（契约 §4）这一**显式输入**。若哪天有人在呈现层里写
 * `requestAnimationFrame` / `Date.now()` / `new THREE.Clock()`，那就是把旧病
 * （每视口/每材质自行累计 tick）搬进了新层。故本闸门把它钉成不变量。
 *
 * ### 二、遗留 RAF 必须逐条登记（把"接缝"变成可审计事实，而不是汇报里的一句话）
 *
 * 判据是「**所有业务推进可枚举**；**局部绘制唤醒不写领域状态**」。
 * 注意它**不**要求"零 RAF" —— 绘制唤醒与输入合并本身是合法的；
 * 违规的是「多 RAF 分别推进业务」。
 *
 * 因此本闸门的做法是**普查 + 强制登记**，而不是断言数量为零：
 *  - 机制的每一条 `requestAnimationFrame` 都必须在本文件的 `LEGACY_RAF_SITES` 里有条目，
 *    并写明 `kind`（推进业务 / 绘制唤醒 / 输入合并）、归属区与退出阶段；
 *  - 反向也要求：登记表里不得有已不存在的条目（防止"登记了就算退役"的假象）。
 *
 * 只要 `kind: 'business-advance'` 的集合非空，就没退完；退完了这一集合自然为空。
 * 本闸门如实反映该事实，不把它写成已清。
 *
 * ## 为什么不改 `boundary-rules.mjs`
 *
 * 不碰规则本体。本文件与 `kernel-legacy-isolation.test.ts` 并列，
 * 走 `npm run test:arch`（其 include 为 `tests/architecture/**\/*.test.ts`）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEB_ROOT } from './module-graph.mjs'
import { RETIREMENT_AREAS } from './boundary-rules.mjs'

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
 * 不能被判红（同族闸门已确立此口径）。但反过来，把代码藏进注释也骗不过它。
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
 * `kind` 的语义（决定它是否属「业务推进可枚举」的违规面）：
 *  - `business-advance`：**推进业务/动画时间** ⇒ 必须改经统一执行协议或统一动画求值，
 *    未退完则退役审计不通过；
 *  - `paint-wakeup`：**局部绘制唤醒**（resize / 组件测量）⇒ 判据允许，
 *    只要它不写领域状态；
 *  - `input-coalesce`：**输入合并**（高频事件每帧至多一次）⇒ 同上，
 *    且它只写视图态（Region.state.hover）。
 */
const LEGACY_RAF_SITES = [
  {
    file: 'composition/kernelRuntime.ts',
    kind: 'business-advance',
    area: 'integration-closeout',
    // ## 这一条为什么**如实**标为 `business-advance`
    //
    // 它确实是"推进业务"的 RAF —— 每帧把经过的秒数作为 `advancePlayback` 命令
    // 注入内核，于是时间（进而通道动画/纹理动画的采样）随之前进。
    // 把它标成 `paint-wakeup` 才是**错**的：那会让"业务推进可枚举"这条判据
    // 失去它要防的东西。
    //
    // ## 那它与被判违规的旧形态差在哪（判据的实质，不是标签）
    //
    // 退役矩阵第 6 条要退役的是「**多** RAF 分别推进业务」，判据原文是
    // 「所有业务推进可枚举；局部绘制唤醒不写领域状态」。旧形态有两个病灶：
    //  1. **多**条业务推进路径（`renderEngine` 的 tick + `drwMeshPipeline` 的
    //     `setTimeout` 自续 + `pickSchedule` 的合并 + Promise 回调直接写状态）
    //     ⇒ "下一次状态变化从哪来"没有唯一答案；
    //  2. 业务推进与**绘制**混在同一个 RAF 里 ⇒ 无法区分"这一帧画了什么"
    //     与"这一帧算了什么"。
    //
    // 当前实际形态：**全树只有本文件一条业务推进路径**，且它
    //   - 只做一件事（算 delta → 交内核命令），**不**绘制、不直接改状态；
    //   - 与绘制循环（`renderEngine` 的 `drawFrame`）**分离**；
    //   - 其推进对象是**值**（不可变状态 + 纯转移），因此可重放（A04）。
    //
    // ⇒ 它不是"又一个推进业务的 RAF"，而是**唯一**的那一条，且其可枚举性
    // 由 `retirementRegistry`（旧路径全部 executed）+ `seams`（接线点唯一）
    // 两条机器断言把守。退役审计应核对的正是"是否只剩这一条"，
    // 而不是"这一条也消失"（内核不自跑是设计，不是缺陷）。
    replacement:
      '无（它是替代物本身）：旧的多条业务推进路径（renderEngine 自驱 tick、drwMeshPipeline 的 setTimeout 自续播放、材质库 accMs 累加）全部删除，本文件是唯一剩下的业务推进点',
    exitStage:
      '集成闭环区落地并长期保留（宿主按帧注入时间输入是接线要求）；退役审计核对"业务推进路径恰好一条"',
    note:
      '宿主帧时钟：`performance.now()` 差值 → `KernelSession.frame(delta)` →'
      + ' `advancePlayback` 命令。不绘制、不直接改状态、不读 Vue。'
      + ' 单帧 delta 有上限（切标签页/休眠不瞬移）。',
  },
  {
    file: 'runtime/renderEngine.ts',
    kind: 'paint-wakeup',
    area: 'integration-closeout',
    // 本条从 `business-advance` **降级为 `paint-wakeup`** ——
    // 这不是"把违规改个标签"，而是 `materialLibrary.tick(clock.getDelta()*1000)`
    // 与 `const clock = new THREE.Clock()` **真的被删掉了**（见 `renderEngine.ts`
    // 的 `drawFrame`）。剩下的 RAF 只做绘制（renderMain/renderOverlay/renderGizmo
    // + 内容组重挂），不读时钟、不推进任何领域状态。
    //
    // 判据的机械依据：`FORBIDDEN_TIME_SOURCES` 里的 `THREE.Clock` 在本文件已零出现，
    // 而 `requestAnimationFrame` 仍在（绘制唤醒本身是判据**允许**的）。
    replacement: '时间推进已迁至宿主帧时钟（`composition/kernelRuntime`）：按帧把经过秒数注入内核 `advancePlayback` 命令；本 RAF 只做绘制',
    exitStage: '呈现区已完成业务面剥离；本行作为"绘制唤醒"长期保留（退役矩阵第 6 条不要求零 RAF）',
    note:
      '绘制循环 + 内容组重挂。`materialLibrary.tick(…)` 与 `THREE.Clock` 已删除 ⇒'
      + ' 本文件不再持有时间语义，不构成"推进业务"。',
  },
  {
    file: 'runtime/renderEngine.ts',
    kind: 'paint-wakeup',
    area: 'integration-closeout',
    replacement: '与绘制循环合并（同一处 resize 唤醒），或改由 ResizeObserver 直接驱动',
    exitStage: '呈现区已与绘制合并为单一呈现驱动；本行长期保留（局部绘制唤醒）',
    note: '合并 resize 事件为每帧一次 GL 尺寸同步；不写领域状态 ⇒ 判据允许。',
  },
  {
    file: 'runtime/hover/pickSchedule.ts',
    kind: 'input-coalesce',
    area: 'presentation-rendering',
    replacement: '输入区的路由合并策略；本层只保留"每帧至多一次"的合并语义',
    exitStage: '输入区交付（输入路由归口）',
    note:
      '把高频 pointermove 合并为每帧最多一次拾取。消费者是 `handlers/hoverHandler.ts`，'
      + '它写的是 `Region.state.hover`（视图态），**不**写文档/历史 ⇒ 不构成"推进业务"。',
  },
  // `workbench/ux/panels/useMaterialAnimation.ts` 的登记已**核销**（求值区收口时）：
  // 该文件已在求值区交付中删除，其 RAF 与 `elapsed += delta` 累积由统一场景时间 + 纯采样
  // 替代（退役矩阵第 11 条）。本表的 `stale` 断言（"退役后必须同时更新本表"）正是抓到这一点的机制 ——
  // 保留一条指向已删文件的登记会让审计拿着过期清单去核对不存在的依赖。
  // 同时 `MaterialGallery.vue` 也不再持 RAF：它改为事件驱动（帧下标 watch），
  // 故本表**不含**新增项。
  {
    file: 'shared/viewport/ToolTipBox.vue',
    kind: 'paint-wakeup',
    area: 'content-boundary',
    replacement: '无（组件本地测量，不涉时间语义）',
    exitStage: '不属退役条目；登记以免被误判为"未登记 RAF"',
    note: '下一帧测量并夹取 tooltip 位置；中立 UI 设施。',
  },
  {
    file: 'logging/LogCenter.ts',
    kind: 'paint-wakeup',
    area: 'retirement-audit',
    replacement: '无（诊断面板本地渲染调度）',
    exitStage: '不属退役条目；中立设施（日志不属于旧权威对象）',
    note: '日志面板轮询渲染；与旧权威对象无关。',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// 一、呈现层纯净性
// ─────────────────────────────────────────────────────────────────────────────

describe('呈现层纯净性：时间必须来自显式求值输入，不得自驱', () => {
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

describe('退役矩阵第 6 条：遗留 RAF 必须逐条登记（可枚举，供退役审计核对）', () => {
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
      `出现未登记的 RAF 调用点（退役矩阵第 6 条要求"业务推进可枚举"）:\n`
        + found
          .filter((h) => undeclared.includes(h.file))
          .map((h) => `  src/${h.file}:${h.line}`)
          .join('\n'),
    ).toEqual([])

    const stale = [...declared].filter((f) => !actual.has(f))
    expect(
      stale,
      `登记表里有已不存在的 RAF 调用点（退役后必须同时更新本表，否则"登记"会变成假象）:\n`
        + stale.map((f) => `  ${f}`).join('\n'),
    ).toEqual([])
  })

  it('每条登记都有归属区、替代机制与退出阶段（不得只写"待办"）', () => {
    for (const s of LEGACY_RAF_SITES) {
      const where = `${s.file}`
      // 归属必须是 `RETIREMENT_AREAS` 里的**在册退役区**（自造区名 ⇒ 判红），
      // 且登记项**不得**再带工单号字段（编号回流是第二映射的入口）。
      expect(Object.keys(RETIREMENT_AREAS), `${where} 的归属区 ${JSON.stringify(s.area)} 未登记`).toContain(s.area)
      expect(Object.keys(s), `${where} 不得携带 issue 之类的编号字段`).not.toContain('issue')
      expect(s.replacement?.length ?? 0, `${where} 必须写替代机制`).toBeGreaterThan(0)
      expect(s.exitStage?.length ?? 0, `${where} 必须写退出阶段`).toBeGreaterThan(0)
      expect(['business-advance', 'paint-wakeup', 'input-coalesce']).toContain(s.kind)
      expect(fs.existsSync(path.join(SRC_ROOT, s.file)), `${where} 必须真实存在`).toBe(true)
    }
  })

  it('**业务推进路径恰好一条**，且它就是替代物本身（退役审计的判据）', () => {
    const business = LEGACY_RAF_SITES.filter((s) => s.kind === 'business-advance')
    // ## 本断言的相位变化（如实登记，不是"放宽"）
    //
    // 本文件（呈现区建立）原先断言 `business.length > 0` 并注明
    // 「仍有推进业务的 RAF —— 这是如实记录，不是通过」。
    //
    // 旧路径删除后，业务推进的**数量**从"多条"降到"一条"，
    // 而那一条是 R-WK-03 要求的新形态（宿主按帧注入时间输入）。
    // ⇒ 判据从"必须非空"改为"**恰好一条**且必须是登记的那个替代物"。
    //
    // 为什么不是"必须为空"：退役矩阵第 6 条要求的是「所有业务推进**可枚举**」，
    // 不是"零业务推进"。宿主必须有一个帧时钟（否则时间永远不走，那是功能停摆），
    // 而它的位置必须**唯一且已知** —— 这正是本条断言在钉的事。
    expect(
      business.map((s) => `${s.file}#${s.kind}`),
      '业务推进路径必须恰好一条（多条 ⇒ 回到"多 RAF 分别推进业务"的旧形态）',
    ).toEqual(['composition/kernelRuntime.ts#business-advance'])

    // 机械证据（不靠标签）：旧自驱时间的两个符号在 `renderEngine` 里零出现。
    const renderEngine = codeOnlyLines(
      fs.readFileSync(path.join(SRC_ROOT, 'runtime/renderEngine.ts'), 'utf8'),
    )
    expect(
      renderEngine.filter(({ line }) => line.includes('THREE.Clock')).length,
      '`renderEngine` 不得再持有 `THREE.Clock`（旧自驱时间的机械证据）',
    ).toBe(0)
    expect(
      renderEngine.filter(({ line }) => line.includes('materialLibrary.tick')).length,
      '`renderEngine` 不得再调 `materialLibrary.tick`（旧每材质累加的机械证据）',
    ).toBe(0)

    // 反空洞真：绘制唤醒**仍在**（判据不是"把所有 RAF 都算成业务推进"）
    expect(
      LEGACY_RAF_SITES.filter((s) => s.kind === 'paint-wakeup').length,
      '绘制唤醒必须仍有登记（退役矩阵第 6 条不要求零 RAF）',
    ).toBeGreaterThan(0)
  })

  it('**负对照**：登记表中出现不存在的文件会被判红（证明存在性检查不是空转）', () => {
    const bogus = { file: 'runtime/does-not-exist-xyz.ts' }
    expect(fs.existsSync(path.join(SRC_ROOT, bogus.file))).toBe(false)
  })
})
