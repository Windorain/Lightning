/**
 * 架构边界规则集（#249 §4 导入规则 / §14 A01 / §15 退役矩阵）。
 *
 * ## 设计立场：闸门规则 vs 遗留债务
 *
 * 把两类事实混在一个"红/绿"里会产生两种错误：
 *  - **假红**：把 #249 §15 明确"由后续批次按退出阶段处理"的既有事实，报成本批不合格；
 *  - **假绿**：因为遗留事实太多而干脆不做检查。
 *
 * 所以本文件把它们分开：
 *
 * | 类别 | 含义 | 判定 |
 * |---|---|---|
 * | **闸门规则 `GATE_RULES`** | 新边界；**必须 0 finding**，否则扫描 FAIL | 见下 |
 * | **债务清单 `collectLegacyDebt`** | 既有待退役事实；**计数 + 归属批次**，不判 FAIL | #249 §15 |
 *
 * ## 一个必须显式说清的陷阱：目录名撞车
 *
 * #249 §4 的目标分层里有 `runtime/`，而 `web/src/runtime/` **当前已存在** —— 但它是
 * **旧实现**（`renderEngine.ts`、`sessionStore.ts`、`chromeBinder.ts` 等，#249 §17 抽查点），
 * 不是新架构的 runtime 层。同理 `presentation/` 目标对应旧 `render/`+`shared/`，
 * `editors/` 对应旧 `workbench/`。
 *
 * ⇒ **不能用 `fs.existsSync(src/runtime)` 推断"新层已建成"**。否则扫描器会在第一秒
 * 就把一整座旧 runtime 当成新层通过（假绿），再对它的每个跨目录 import 报红（假红）。
 * `LAYER_DESTINATIONS` 因此为每个目标分层记录**它的旧对应物**，扫描器只把
 * "由本批之后新建、且未被登记为遗留迁移源"的目录当作闸门执行面。
 *
 * ## 空洞真（vacuous truth）的披露义务
 *
 * 本批（P0）不建新层目录（#249 §4）。闸门规则的执行面因此为 0，其"绿"是空洞真 ——
 * 扫描器必须显式标出（`vacuous: true`），不得让它冒充"边界已生效"。
 * 这是 #251「未实现的测试名称不得报告通过」在本设施上的落地。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * #249 §4 目标分层，及其**当前代码里的旧对应物**。
 *
 * `legacySources` 用于：(1) 判断该层的"新实现"是否已存在；(2) 在报告中说明迁移来源，
 * 供 #249 §15 退役矩阵的批次对账。
 */
export const LAYER_DESTINATIONS = [
  { layer: 'domain', legacySources: ['pure', 'context'], note: '纯业务模型/规则 → 现散在 pure/ + context/' },
  { layer: 'application', legacySources: ['operators', 'handlers', 'events'], note: '命令/查询/属性 → 现散在 operators/ + handlers/' },
  { layer: 'runtime', legacySources: ['runtime'], note: '**撞名**：旧 runtime/ 是求值+会话实现，新 runtime/ 是执行批次/调度' },
  { layer: 'presentation', legacySources: ['render', 'shared'], note: '求值场景→渲染数据 → 现 render/' },
  { layer: 'editors', legacySources: ['workbench', 'viewer', 'embed'], note: '编辑器组件 → 现 workbench/ + viewer/' },
  { layer: 'shells', legacySources: ['workbench', 'embed'], note: '外壳/装配根 → 现混在 workbench/ + embed/' },
  { layer: 'adapters', legacySources: ['util', 'config', 'wiki', 'dev'], note: '宿主端口实现 → 现散在 util/ + wiki/' },
  { layer: 'composition', legacySources: [], note: '装配（无旧对应物，本次新建）' },
  { layer: 'entries', legacySources: ['main*.ts'], note: '薄启动入口 → 现 src/main*.ts 在根' },
]

/** 目标分层的名字（供规则里的层判定使用）。 */
export const LAYERS = LAYER_DESTINATIONS.map((d) => d.layer)

/**
 * **闸门执行面**：一个目录只有满足下面两条才算"新层已建成"：
 *  1. 目录存在；
 *  2. 未被登记为任何目标分层的 `legacySources` —— 即它不是旧实现的迁移来源。
 *
 * 例：`runtime/` 存在但被登记为 `runtime` 层的 legacySource ⇒ **不算**闸门执行面。
 * 一个真正的新 `domain/` 目录（无 legacySource 命中）⇒ 算。
 */
export function resolveGateLayers(srcRoot) {
  const legacyNames = new Set()
  for (const d of LAYER_DESTINATIONS) for (const s of d.legacySources) legacyNames.add(s)
  const present = []
  const absent = []
  const legacyCollisions = []
  for (const layer of LAYERS) {
    const dir = path.join(srcRoot, layer)
    if (!fs.existsSync(dir)) {
      absent.push(layer)
      continue
    }
    if (legacyNames.has(layer)) {
      legacyCollisions.push({ layer, because: '目录名与目标分层相同，但已登记为旧实现的迁移来源' })
    } else {
      present.push(layer)
    }
  }
  return { present, absent, legacyCollisions }
}

/** 非相对、非别名说明符 —— 视为**外部包**（node_modules）。 */
export function isExternalSpecifier(spec) {
  return !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')
}

/** 依据外部包名归类。 */
export function classifyExternal(spec) {
  const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  if (pkg === 'vue' || pkg.startsWith('@vue/')) return 'vue'
  if (pkg === 'three' || pkg.startsWith('three/')) return 'three'
  if (pkg.startsWith('node:')) return 'node-io'
  if (['fs', 'path', 'os', 'child_process', 'crypto', 'zlib'].includes(pkg)) return 'node-io'
  return 'other-external'
}

/** 把说明符归一成 `src/` 相对路径（无法静态解析回内部时返回 `null`）。 */
export function resolveInternalTarget(fact, srcRoot) {
  const spec = fact.specifier
  if (spec.startsWith('«')) return null // 不可静态解析的动态导入
  if (isExternalSpecifier(spec)) return null
  const fromDir = path.dirname(fact.fromFile)
  const abs = spec.startsWith('@/')
    ? path.join(srcRoot, spec.slice(2))
    : path.resolve(fromDir, spec)
  const rel = path.relative(srcRoot, abs).replace(/[\\/]+/g, '/')
  if (rel.startsWith('..')) return null
  return rel.replace(/\.(ts|tsx|mts|vue|js)$/, '')
}

/** 取 `src/` 相对路径的顶层目录（`pure/vec` → `pure`）。 */
export function topLayer(relPath) {
  return relPath.split('/')[0]
}

/** 一条闸门规则统一结构。 */
function mkFinding(rule, fact, detail, extra = {}) {
  return {
    rule: rule.id,
    title: rule.title,
    criterion: rule.criterion,
    file: fact.fromRel,
    line: fact.line,
    column: fact.column,
    specifier: fact.specifier,
    kind: fact.kind,
    isTypeOnly: fact.isTypeOnly,
    syntax: fact.syntax,
    detail,
    ...extra,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 闸门规则 1：纯核心层不得依赖 Vue / Three
// ─────────────────────────────────────────────────────────────────────────────

export const ruleCoreNoVueThree = {
  id: 'gate/core-no-vue-three',
  title: '纯核心层（domain/application）不得依赖 Vue / Three',
  criterion: '#249 §4 导入规则 1/2/6；§14 A01',
  layerDependent: true,
  check(facts, ctx) {
    const bad = []
    for (const f of facts) {
      if (f.kind === 'parse-error') continue
      // 关键：层由**发起导入的文件**决定，不是由导入目标决定。
      // 目标可能是外部包（`vue`），此时 resolveInternalTarget 返回 null ——
      // 若用"目标层"判定就会把最常见的一种违规（从 domain 直接 import vue）
      // 整类漏掉。这条 bug 正是由 A01 负对照测试抓出来的。
      const layer = topLayer(f.fromSrcRel)
      if (layer !== 'domain' && layer !== 'application') continue
      const cls = classifyExternal(f.specifier)
      if (cls === 'vue' || cls === 'three') {
        bad.push(
          mkFinding(
            ruleCoreNoVueThree,
            f,
            `${layer} 层导入了 ${cls}${f.isTypeOnly ? '（**类型导入**，同样计入 —— §4 规则 6）' : ''}`,
          ),
        )
      }
    }
    return bad
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 闸门规则 2：纯核心层不得引用 DOM / 浏览器全局（AST 级）
// ─────────────────────────────────────────────────────────────────────────────

const DOM_GLOBALS = new Set([
  'document',
  'window',
  'localStorage',
  'sessionStorage',
  'navigator',
  'location',
  'indexedDB',
  'requestAnimationFrame',
  'performance',
  'HTMLElement',
  'EventTarget',
  'Node',
  'getComputedStyle',
])

export const ruleCoreNoDomGlobals = {
  id: 'gate/core-no-dom-globals',
  title: '纯核心层（domain/application）不得引用 DOM / 浏览器全局',
  criterion: '#249 §4 规则 1/2；§14 A02「注入全局时间读取」',
  needsAst: true,
  layerDependent: true,
  check() {
    return []
  },
  checkWithAst(astIndex, ctx) {
    const bad = []
    for (const rec of astIndex) {
      // 层由**文件相对 ctx.srcRoot 的位置**决定，而不是 rec.rel ——
      // 后者取决于建索引时传入的 webRoot，临时树与真实树会给出不同形态，
      // 从而让规则在测试里静默失配（这条正是被 A01 负对照抓出来的）。
      const srcRel = path.relative(ctx.srcRoot, rec.abs).replace(/[\\/]+/g, '/')
      const layer = topLayer(srcRel)
      if (layer !== 'domain' && layer !== 'application') continue
      for (const hit of rec.globalRefs) {
        if (!DOM_GLOBALS.has(hit.name)) continue
        bad.push({
          rule: ruleCoreNoDomGlobals.id,
          title: ruleCoreNoDomGlobals.title,
          criterion: ruleCoreNoDomGlobals.criterion,
          file: `src/${srcRel}`,
          line: hit.line,
          column: hit.column,
          specifier: hit.name,
          kind: 'global-reference',
          isTypeOnly: false,
          syntax: hit.syntax,
          detail: `${layer} 层引用了浏览器全局 ${hit.name}`,
        })
      }
    }
    return bad
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 闸门规则 3：新分层内不得有未登记的 barrel 转出口（跨目录偷渡）
// ─────────────────────────────────────────────────────────────────────────────

/** 已批准的出口白名单（相对 `web/`）。本批为空：尚无任何新出口需要批准。 */
export const APPROVED_BARRELS = []

export const ruleNoBarrelSmuggling = {
  id: 'gate/no-barrel-smuggling',
  title: '新分层内禁止经 barrel 转出口偷偷跨层',
  criterion: '#249 §4 导入规则 6',
  layerDependent: true,
  check(facts, ctx) {
    const bad = []
    for (const f of facts) {
      if (f.kind !== 'export-from') continue
      if (APPROVED_BARRELS.some((b) => b.file === f.fromRel)) continue
      const target = resolveInternalTarget(f, ctx.srcRoot)
      if (target === null) continue
      const fromLayer = topLayer(f.fromSrcRel)
      const toLayer = topLayer(target)
      // 只在**新分层**上判定（旧目录的转出口计入债务清单，不在此判红）。
      if (!ctx.gateLayers.includes(fromLayer) && !ctx.gateLayers.includes(toLayer)) continue
      const fromDir = path.dirname(f.fromRel)
      const toDir = path.dirname(`src/${target}`).replace(/[\\/]+/g, '/')
      if (fromDir === toDir) continue
      bad.push(
        mkFinding(
          ruleNoBarrelSmuggling,
          f,
          `跨目录 barrel 转出口（${fromDir} → ${toDir}）未登记在 APPROVED_BARRELS`,
        ),
      )
    }
    return bad
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 闸门规则 4：跨层导入必须经公共出口（不得钻进别的层的私有实现）
// ─────────────────────────────────────────────────────────────────────────────

/** 公共出口允许的最大路径深度：`domain/scene.ts`(2) 可以，`domain/scene/internal/x.ts`(4) 不行。 */
export const MAX_PUBLIC_EXPORT_DEPTH = 2

export const ruleNoPrivateCrossLayer = {
  id: 'gate/no-private-cross-layer',
  title: '跨层导入必须经公共出口，禁止钻进别的层的私有实现',
  criterion: '#249 §4 导入规则 6',
  layerDependent: true,
  check(facts, ctx) {
    const bad = []
    for (const f of facts) {
      const t = resolveInternalTarget(f, ctx.srcRoot)
      if (t === null) continue
      const layer = topLayer(t)
      if (!ctx.gateLayers.includes(layer)) continue
      const fromLayer = topLayer(f.fromSrcRel)
      if (fromLayer === layer) continue // 层内导入不受此规则约束
      const depth = t.split('/').length
      if (depth > MAX_PUBLIC_EXPORT_DEPTH) {
        bad.push(
          mkFinding(
            ruleNoPrivateCrossLayer,
            f,
            `跨层导入了 ${layer} 层深于公共出口的实现（${t}，深度 ${depth} > ${MAX_PUBLIC_EXPORT_DEPTH}）`,
          ),
        )
      }
    }
    return bad
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 闸门规则 5：外部内容只能经受控呈现边界进 DOM（P8 / #259 A32）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 允许出现标记注入的**唯一**位置白名单（`web/` 相对路径）。
 *
 * 为什么这条规则必须存在：`inspection of innerHTML/v-html` 是**唯一**能
 * 静态判定的"外部内容直通"指纹。P8 把 6 条直通路径收编后，全仓应只剩
 * `editors/TrustedIcon.vue` 一处 —— 它的输入是品牌类型 `TrustedIconTemplate`
 * （只能由 `domain/trustedIcon.ts` 的可信构造口产出），不是外部文本。
 *
 * 这条白名单是**精确**的（不是"某目录下都可以"）：新增一条即必须在
 * 本文件显式登记理由，否则扫描判红。这正是 #259「不允许组件各自选路径」
 * 的静态执行面。
 */
export const CONTENT_MARKUP_ALLOWLIST = [
  {
    file: 'src/editors/TrustedIcon.vue',
    because: '可信编译期图标（品牌类型 TrustedIconTemplate 的唯一消费者）；内联 SVG 必须经标记注入才能渲染',
  },
]

/** 匹配 `v-html` 绑定 / `innerHTML` / `outerHTML` / `insertAdjacentHTML` 赋值。 */
const MARKUP_INJECTION_RE = /\bv-html\b|\.\s*innerHTML\s*=|\.\s*outerHTML\s*=|insertAdjacentHTML\s*\(/

export const ruleContentBoundary = {
  id: 'gate/content-boundary',
  title: '外部内容只能经受控呈现边界进 DOM（不收编即判红）',
  criterion: '#259 A32「未处理字符串直传 innerHTML/v-html 判红」；#249 §19.6',
  layerDependent: false,
  /**
   * **必须为 true**：`scan-boundaries.mjs` 只对 `needsAst` 的规则调用
   * `checkWithAst`。少了这一行，规则在报告里会显示"受检文件 0"式的**假绿**
   * —— 本规则初版正是如此（扫描器报绿，而同批的负对照测试却抓到真违规，
   * 两者不一致才暴露出来）。`boundary-scan.test.ts` 因此额外断言
   * "每条 needsAst 规则都真的被判据覆盖"。
   */
  needsAst: true,
  check() {
    return []
  },
  /**
   * 扫标记注入点。
   *
   * 覆盖面：`v-html`（模板指令）与 `innerHTML` / `outerHTML` /
   * `insertAdjacentHTML`（脚本里的命令式注入）。前者只在 `.vue` 模板里，
   * 后两者在脚本里 —— 所以本规则按**整文件**扫，而不是只看 script 块。
   *
   * 注释处理是本规则的关键细节：
   *  - **必须**剥掉注释，否则"文档里说明旧机制叫什么"会被判违规，
   *    逼着实现者删掉交接信息（把治理手段变成知识损失）；
   *  - 剥注释要**跨行**（块注释、HTML 注释），逐行判断 `trim().startsWith('*')`
   *    会漏掉 `<!-- \n v-html \n -->` 这类跨行注释（实测假红）。
   */
  checkWithAst(_astIndex, ctx) {
    const bad = []
    for (const rel of collectProductionSourceFiles(ctx.srcRoot)) {
      if (CONTENT_MARKUP_ALLOWLIST.some((a) => a.file === `src/${rel}`)) continue
      const text = fs.readFileSync(path.join(ctx.srcRoot, rel), 'utf8')
      const code = stripCommentsForScan(text)
      const lines = code.split('\n')
      lines.forEach((line, i) => {
        if (!MARKUP_INJECTION_RE.test(line)) return
        const trimmed = line.trim()
        bad.push({
          rule: ruleContentBoundary.id,
          title: ruleContentBoundary.title,
          criterion: ruleContentBoundary.criterion,
          file: `src/${rel}`,
          line: i + 1,
          column: 1,
          specifier: 'v-html/innerHTML',
          kind: 'markup-injection',
          isTypeOnly: false,
          syntax: trimmed.slice(0, 160),
          detail:
            '外部内容必须以受控呈现边界（editors/ContentText）+ 允许列表（domain/textContent）呈现；'
            + '若确需保留标记注入，在 boundary-rules.mjs 的 CONTENT_MARKUP_ALLOWLIST 登记理由',
        })
      })
    }
    return bad
  },
}

/**
 * 剥掉注释，让扫描只看**可执行/可渲染的代码**。
 *
 * 必须跨行处理三类注释：
 *  - `/* … *​/`（块注释，本项目文档块大量使用）；
 *  - `// …`（行注释，注意别误伤 `https://`）；
 *  - `<!-- … -->`（`.vue` 模板注释）。
 *
 * 为什么不能逐行 `trim().startsWith('*')`：那会漏掉模板里的多行 HTML 注释
 * （`<!--` 与 `-->` 各占一行、内容行不以 `*` 开头），既产生假红，又让
 * "在注释里保留交接说明"这条正当做法失效。替换字符保留换行，
 * 因此报告里的行号仍对得上真实文件。
 */
function stripCommentsForScan(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/** 收集 `src/` 下的生产源文件（相对 `src/`，正斜杠）—— 排除测试与声明文件。 */
function collectProductionSourceFiles(srcRoot) {
  const out = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue
        walk(path.join(dir, e.name), childRel)
        continue
      }
      if (!/\.(ts|tsx|mts|vue)$/.test(e.name)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) continue
      if (/\.d\.ts$/.test(e.name)) continue
      out.push(childRel)
    }
  }
  walk(srcRoot, '')
  return out.sort()
}

/**
 * 闸门规则集 —— 全部必须 0 finding。
 *
 * 规则 5（`content-boundary-gate`）由 **P8（#259）** 新增：它是"新层目录成为闸门
 * 执行面后 0 finding"这条要求的落地观察点之一 —— P8 建了 `domain/`、`application/`、
 * `editors/`，于是前四条规则从"空洞真"变成真实执行面，同时新增本规则把
 * "外部内容只能经受控边界进 DOM"变成静态事实。
 */
export const GATE_RULES = [
  ruleCoreNoVueThree,
  ruleNoBarrelSmuggling,
  ruleNoPrivateCrossLayer,
  ruleCoreNoDomGlobals,
  ruleContentBoundary,
]

// ─────────────────────────────────────────────────────────────────────────────
// 遗留债务清单（#249 §15）—— 计数与归属，不判 FAIL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #249 §15 十三条退役矩阵的**批次归属**。
 *
 * 键 = 退役条目的稳定 slug；`entries` = 该 slug 覆盖的 §15 行号（1–13）；
 * `owners` = 负责批次列表（每条含 `p` / `issue` / 职责面 `scope`）。
 *
 * ## P 编号 ↔ issue 号的权威对应（**不得凭记忆写**）
 *
 * #250「执行单与依赖」表 + 各执行单标题共同确定：**`P<N> = #(251+N)`**。
 * 实测（2026-10-11 经 Gitea API 逐单核对标题）：
 *
 * | P | issue | 职责 |
 * |---|---|---|
 * | P0 | #251 | 基线盘点、契约冻结、边界设施 |
 * | P1 | #252 | 文档状态域与统一执行协议 |
 * | P2 | #253 | RNA：属性描述、寻址与受控命令读面 |
 * | P3 | #254 | 几何、坐标关系与固定拓扑形变 |
 * | P4 | #255 | 统一动画求值、依赖图与纹理序列 |
 * | P5 | #256 | 呈现编译、GPU 合批与资源生命周期 |
 * | P6 | #257 | **工作区、Area 生命周期与模块装配** |
 * | P7 | #258 | **输入路由、焦点与文本草稿** |
 * | P8 | #259 | 内容边界、实例配置隔离与结构化诊断 |
 * | P9 | #260 | 持久化、固定快照导出与恢复 |
 * | P10 | #261 | 集成闭环与交叉验收 |
 * | P11 | #262 | 退役审计、全量回归、性能门槛与复杂度对账 |
 *
 * **本映射由 `boundary-scan.test.ts` 逐条断言 `P<N>` 与 `#(251+N)` 一致**：
 * 初版曾把若干条写错（#7/#10 误记 P7/#258；#12 的两个面互换；#13 误记 P10/#260），
 * 属"凭记忆填编号"的错位。加断言后该类错误无法再通过测试（这正是 #249 §14
 * 「负对照必须证明确实破坏了目标保证」在**文档对账**上的同类应用）。
 *
 * 文档侧同源副本见 #251 B5 附件；两者互为镜像，改动必须同批双改。
 */
export const RETIREMENT_OWNERS = {
  'raw-authority-object': {
    entries: [1],
    owners: [{ p: 'P1', issue: 252, duty: '文档状态域与统一执行协议', scope: '只读查询能力 + 命令客户端' }],
    exitStage: 'P1 交付同批',
    role: 'P1 执行者',
  },
  'runtime-document-triple-duty': {
    entries: [2],
    owners: [
      { p: 'P4', issue: 255, duty: '统一动画求值、依赖图与纹理序列', scope: '求值面（类型化文档 + 求值场景）' },
      { p: 'P9', issue: 260, duty: '持久化、固定快照导出与恢复', scope: '文件面（文件适配、持久化）' },
    ],
    exitStage: 'P9 交付同批（求值面 P4 分离，文件面 P9 收口）',
    role: 'P4 执行者（求值与文档解耦）；P9 执行者（文件适配收口）',
  },
  'ui-proxy-dispatch': {
    entries: [3],
    owners: [{ p: 'P2', issue: 253, duty: 'RNA：属性描述、寻址与受控命令读面', scope: 'RNA 引用 + 受控纯属性命令' }],
    exitStage: 'P2 交付同批',
    role: 'P2 执行者',
  },
  'per-viewport-staging': {
    entries: [4],
    owners: [{ p: 'P1', issue: 252, duty: '文档状态域与统一执行协议', scope: 'EditContext 与有效读面' }],
    exitStage: 'P1 交付同批',
    role: 'P1 执行者',
  },
  'manual-refresh-chain': {
    entries: [5],
    owners: [{ p: 'P5', issue: 256, duty: '呈现编译、GPU 合批与资源生命周期', scope: '依赖图自动失效' }],
    exitStage: 'P5 交付同批',
    role: 'P5 执行者',
  },
  'multi-raf-business': {
    entries: [6],
    owners: [
      { p: 'P1', issue: 252, duty: '文档状态域与统一执行协议', scope: '业务推进收敛到统一执行协议' },
      { p: 'P4', issue: 255, duty: '统一动画求值、依赖图与纹理序列', scope: '材质独立 RAF 播放循环并入统一时间' },
    ],
    exitStage: 'P1 交付同批（材质 RAF 由 P4 收口）',
    role: 'P1 执行者（业务 RAF）；P4 执行者（useMaterialAnimation 独立循环）',
  },
  'workbench-embed-fork': {
    entries: [7],
    owners: [{ p: 'P6', issue: 257, duty: '工作区、Area 生命周期与模块装配', scope: '公共功能模块 + profile + 外壳' }],
    exitStage: 'P6 交付同批',
    role: 'P6 执行者',
  },
  'frame-sequence-as-animation': {
    entries: [8],
    owners: [{ p: 'P4', issue: 255, duty: '统一动画求值、依赖图与纹理序列', scope: '场景 + 通用动画轨道' }],
    exitStage: 'P4 交付同批',
    role: 'P4 执行者',
  },
  'grid-coord-as-identity': {
    entries: [9],
    owners: [{ p: 'P3', issue: 254, duty: '几何、坐标关系与固定拓扑形变', scope: '对象/元素引用与来源映射' }],
    exitStage: 'P3 交付同批',
    role: 'P3 执行者',
  },
  'component-mount-lifetime': {
    entries: [10],
    owners: [
      { p: 'P6', issue: 257, duty: '工作区、Area 生命周期与模块装配', scope: 'Area/EditorInstance 生命周期（A13 为其验收）' },
      { p: 'P8', issue: 259, duty: '内容边界、实例配置隔离与结构化诊断', scope: '挂载期全局写入属实例配置隔离' },
    ],
    // 主责归 P6：A13（分割/切换/关闭/恢复 100 次、状态不靠隐藏组件存活）是 P6 的验收。
    // P8 副责仅覆盖 shellSettings.setLang 这类"挂载期写全局配置"，故不作为退出阶段。
    exitStage: 'P6 交付同批（实例配置面由 P8 收口）',
    role: 'P6 执行者（生命周期主责）；P8 执行者（实例配置面）',
  },
  'material-viewport-tick': {
    entries: [11],
    owners: [{ p: 'P4', issue: 255, duty: '统一动画求值、依赖图与纹理序列', scope: '统一时间绑定与纹理序列纯采样' }],
    exitStage: 'P4 交付同批',
    role: 'P4 执行者',
  },
  'scattered-text-and-global-lang': {
    entries: [12],
    owners: [
      { p: 'P8', issue: 259, duty: '内容边界、实例配置隔离与结构化诊断', scope: '公共文本边界与实例配置隔离' },
      { p: 'P7', issue: 258, duty: '输入路由、焦点与文本草稿', scope: '纯输入路由' },
    ],
    exitStage: 'P8 交付同批（输入路由面由 P7 收口）',
    role: 'P8 执行者（文本/配置）；P7 执行者（输入路由）',
  },
  'exporter-borrows-live-viewport': {
    entries: [13],
    owners: [{ p: 'P9', issue: 260, duty: '持久化、固定快照导出与恢复', scope: '固定快照导出作业、共同求值与呈现' }],
    exitStage: 'P9 交付同批',
    role: 'P9 执行者',
  },
}

/** `P<N> = #(251+N)` —— 权威映射公式（#250 表格 + 各执行单标题）。 */
export const P_TO_ISSUE_OFFSET = 251

/**
 * 权威**职责名**表（逐字取自 #250「执行单与依赖」表 / 各执行单标题）。
 *
 * 为什么必须把职责名也编码进来：P↔issue 的**算术**一致并不能发现"职责写错批"。
 * 初版的 #7（工作台/嵌入分叉）写作 `P7 (#258)` —— 算术上 P7=#258 成立，
 * 但 P7 的职责是**输入路由**而非 Area 生命周期，属"P 与 issue 配对正确、职责张冠李戴"。
 * 只有把"哪个 P 负责什么"也变成断言对象，这类错位才能被测出来。
 */
export const P_DUTIES = {
  P1: '文档状态域与统一执行协议',
  P2: 'RNA：属性描述、寻址与受控命令读面',
  P3: '几何、坐标关系与固定拓扑形变',
  P4: '统一动画求值、依赖图与纹理序列',
  P5: '呈现编译、GPU 合批与资源生命周期',
  P6: '工作区、Area 生命周期与模块装配',
  P7: '输入路由、焦点与文本草稿',
  P8: '内容边界、实例配置隔离与结构化诊断',
  P9: '持久化、固定快照导出与恢复',
  P10: '集成闭环与交叉验收',
  P11: '退役审计、全量回归、性能门槛与复杂度对账',
}

/** 从 `'P6'` 解析出编号 6（供断言核对 issue 号）。 */
export function parsePBatch(p) {
  const m = /^P(\d+)$/.exec(p)
  return m ? Number(m[1]) : null
}

/**
 * 采集遗留债务事实（#249 §15 的**可测量面**）。
 *
 * 本设施只测量**能静态判定**的那几类：
 *  - `legacy-barrel-reexport`：旧目录之间的跨目录转出口（"新门面包旧核心保活"的静态指纹）；
 *  - `layer-name-collision`：目录名与目标分层撞车（见文件头陷阱说明）；
 *  - `dynamic-import-opaque`：参数不可静态解析的动态导入（边界无法静态证明，留给能力隔离测试）。
 *
 * 其余各条（手推 refresh 链、多 RAF、每视口暂存…）需要**语义**判据，不是模块图能测的 ——
 * 由负责批次的验收（A05/A11/A13 等）承担，本设施不假装覆盖，只在报告里列出归属。
 */
export function collectLegacyDebt(facts, ctx, astIndex) {
  const debt = {
    'legacy-barrel-reexport': [],
    'layer-name-collision': [],
    'dynamic-import-opaque': [],
  }
  for (const f of facts) {
    if (f.kind === 'export-from') {
      const target = resolveInternalTarget(f, ctx.srcRoot)
      if (target === null) continue
      const fromLayer = topLayer(f.fromRel.replace(/^src\//, ''))
      const toLayer = topLayer(target)
      const fromDir = path.dirname(f.fromRel)
      const toDir = path.dirname(`src/${target}`).replace(/[\\/]+/g, '/')
      if (fromDir === toDir) continue
      // 闸门规则已覆盖新层；这里只收旧目录的。
      if (ctx.gateLayers.includes(fromLayer) || ctx.gateLayers.includes(toLayer)) continue
      debt['legacy-barrel-reexport'].push({
        file: f.fromRel,
        line: f.line,
        specifier: f.specifier,
        fromLayer,
        toLayer,
        syntax: f.syntax,
      })
    } else if (f.kind === 'dynamic-import' && f.specifier.startsWith('«')) {
      debt['dynamic-import-opaque'].push({
        file: f.fromRel,
        line: f.line,
        syntax: f.syntax,
        reason: '动态导入参数不可静态解析 ⇒ 边界无法由模块图证明，需能力隔离测试',
      })
    }
  }
  for (const c of ctx.layerCollisions) debt['layer-name-collision'].push(c)
  // 稳定排序，使报告可逐次对账。
  for (const k of Object.keys(debt)) {
    debt[k].sort((a, b) => (a.file + a.line).localeCompare(b.file + b.line))
  }
  return debt
}
