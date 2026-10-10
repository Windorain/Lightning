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

/** 闸门规则集 —— 全部必须 0 finding。 */
export const GATE_RULES = [
  ruleCoreNoVueThree,
  ruleNoBarrelSmuggling,
  ruleNoPrivateCrossLayer,
  ruleCoreNoDomGlobals,
]

// ─────────────────────────────────────────────────────────────────────────────
// 遗留债务清单（#249 §15）—— 计数与归属，不判 FAIL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #249 §15 十三条退役矩阵的**批次归属**。
 *
 * 键 = 退役条目的稳定 slug；值 = 负责批次（对应执行单）与退出阶段。
 * 与 `docs/retirement-matrix` 附件、Gitea #251 B5 附件同源 —— 三处必须一致，
 * 改动必须同 PR 改（否则又是"规则只存在于评论里 ≈ 不存在"）。
 */
export const RETIREMENT_OWNERS = {
  'raw-authority-object': { batch: 'P1 (#252)', exitStage: 'P1 交付同批', role: 'P1 执行者' },
  'runtime-document-triple-duty': { batch: 'P4 (#255)', exitStage: 'P4 交付同批', role: 'P4 执行者' },
  'ui-proxy-dispatch': { batch: 'P2 (#253)', exitStage: 'P2 交付同批', role: 'P2 执行者' },
  'per-viewport-staging': { batch: 'P1 (#252)', exitStage: 'P1 交付同批', role: 'P1 执行者' },
  'manual-refresh-chain': { batch: 'P5 (#256)', exitStage: 'P5 交付同批', role: 'P5 执行者' },
  'multi-raf-business': { batch: 'P1 (#252)', exitStage: 'P1 交付同批', role: 'P1 执行者' },
  'workbench-embed-fork': { batch: 'P7 (#258)', exitStage: 'P7 交付同批', role: 'P7 执行者' },
  'frame-sequence-as-animation': { batch: 'P4 (#255)', exitStage: 'P4 交付同批', role: 'P4 执行者' },
  'grid-coord-as-identity': { batch: 'P3 (#254)', exitStage: 'P3 交付同批', role: 'P3 执行者' },
  'component-mount-lifetime': { batch: 'P8 (#259)', exitStage: 'P8 交付同批', role: 'P8 执行者' },
  'material-viewport-tick': { batch: 'P4 (#255)', exitStage: 'P4 交付同批', role: 'P4 执行者' },
  'scattered-text-and-global-lang': { batch: 'P9 (#260)', exitStage: 'P9 交付同批', role: 'P9 执行者' },
  'exporter-borrows-live-viewport': { batch: 'P10 (#261)', exitStage: 'P10 交付同批', role: 'P10 执行者' },
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
