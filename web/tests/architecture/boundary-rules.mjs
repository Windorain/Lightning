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
 * `legacySources` 用于：(1) 在报告中说明迁移来源，供 #249 §15 退役矩阵的批次对账；
 * (2) 判断"目录存在"是否等于"新层已建成"。
 *
 * ## `activeSubpaths` —— 部分迁移层（#250 裁决 2026-10-11，P1 落地）
 *
 * 一个层如果**旧实现与新实现同处一个目录**，就不能再用"整个目录"当执行面。
 * 本工程现有两处：
 *
 * | 层 | 情形 |
 * |---|---|
 * | `domain` | 旧对应物是 `pure/` + `context/`（**不同目录**），故无此问题 |
 * | `application` | 旧对应物是 `operators/` + `handlers/` + `events/`（**不同目录**），同上 |
 * | `runtime` | **撞名**：`web/src/runtime/` 既装旧实现（`renderEngine.ts`/`sessionStore.ts`/`chromeBinder.ts` 等 38 个文件），又要装新的执行/调度/效果三件套 |
 * | `adapters` | 旧对应物是 `util/` + `config/` + `wiki/`（**不同目录**），但 P9（#260）起该层**开始**有实现（保存目标/文件/存储适配），故也登记 `activeSubpaths` |
 *
 * ⇒ 对 `runtime` 这类层，用 `activeSubpaths` **显式列出新实现的路径**；
 * 只有这些路径属于闸门执行面，其余（旧根文件、`host/`、`hover/`…）是遗留债务。
 *
 * ### 为什么是"白名单新路径"而不是"黑名单旧路径"
 *
 * 旧 runtime 根目录下的**文件**与新 runtime 根目录下的**文件**同名空间重叠
 * （都是 `runtime/*.ts`），黑名单无法表达"这些根文件是旧、那三个根文件是新"。
 * 白名单还把"P1 阶段拥有边界扫描清单"（#250）变成显式事实：新增新实现路径必须登记，
 * 不登记的文件默认**不算**已迁移 —— 宁可少判（旧文件不因撞名误红），
 * 也不让一个未登记的文件悄悄冒充新边界。
 */
export const LAYER_DESTINATIONS = [
  { layer: 'domain', legacySources: ['pure', 'context'], note: '纯业务模型/规则 → 现散在 pure/ + context/' },
  { layer: 'application', legacySources: ['operators', 'handlers', 'events'], note: '命令/查询/属性 → 现散在 operators/ + handlers/' },
  {
    layer: 'runtime',
    legacySources: ['runtime'],
    note: '**撞名**：旧 runtime/ 是求值+会话实现，新 runtime/ 是执行批次/调度/效果',
    // 新实现的**显式**路径（P1 登记 execution/scheduling/effects，P4 追加 evaluation，P9 追加 exportJob）
    activeSubpaths: [
      'runtime/execution.ts',
      'runtime/scheduling.ts',
      'runtime/effects.ts',
      'runtime/evaluation.ts',
      'runtime/exportJob.ts',
    ],
    /** 该层的新实现属**纯核心**（不得依赖 Vue/Three/DOM）：执行协议是业务规则，不是呈现。 */
    corePurity: true,
  },
  { layer: 'presentation', legacySources: ['render', 'shared'], note: '求值场景→渲染数据 → 现 render/' },
  { layer: 'editors', legacySources: ['workbench', 'viewer', 'embed'], note: '编辑器组件 → 现 workbench/ + viewer/' },
  { layer: 'shells', legacySources: ['workbench', 'embed'], note: '外壳/装配根 → 现混在 workbench/ + embed/' },
  {
    layer: 'adapters',
    legacySources: ['util', 'config', 'wiki', 'dev'],
    note:
      '宿主端口实现 → 现散在 util/ + wiki/。**P9（#260）起为部分迁移层**：' +
      '本批新建的保存目标适配（写入串行化 + 远端条件版本）与后续文件/存储适配按 activeSubpaths 登记；' +
      '其余 util/ 旧实现仍是遗留债务。',
    // P9 登记：保存目标适配。文件/存储适配路径由后续提交追加（同一 PR）。
    activeSubpaths: ['adapters/saveTarget/coordinator.ts'],
  },
  { layer: 'composition', legacySources: [], note: '装配（无旧对应物，本次新建）' },
  { layer: 'entries', legacySources: ['main*.ts'], note: '薄启动入口 → 现 src/main*.ts 在根' },
]

/** 目标分层的名字（供规则里的层判定使用）。 */
export const LAYERS = LAYER_DESTINATIONS.map((d) => d.layer)

/**
 * **闸门执行面的判定**。
 *
 * 三态（#250 裁决 2026-10-11 起）：
 *  1. `active`：该层的新实现**路径集合**（`src/<层>/…` 或 `activeSubpaths`）；
 *  2. `absent`：目录不存在，无执行面；
 *  3. `collision`：目录存在但**整个目录都不是**新实现（纯撞名，例如 P0 时的 `runtime/`）。
 *
 * ## `activeSubpaths` 的语义（部分迁移层）
 *
 * 未声明 `activeSubpaths` 的层：目录存在 ⇒ 整层是执行面（`domain`/`application` 的常态）。
 * 已声明 `activeSubpaths` 的层：**只有列出的路径**是执行面；目录下的其余文件是遗留债务。
 * 这样 `runtime/` 的 38 个旧文件不会因撞名被判红，而 `runtime/execution.ts` 等真实新实现
 * **确实**受 `core-no-vue-three` / `core-no-dom-globals` / `no-private-cross-layer` 约束。
 *
 * 返回 `{ active, absent, legacyCollisions, collisionLayers }`。
 * `active` 是**文件路径集合**（相对 `src/`，`'domain/scene.ts'`），
 * 因为"执行面"的粒度已经不能总是"一整层"。
 */
export function resolveGateLayers(srcRoot) {
  const active = []
  const absent = []
  const legacyCollisions = []
  const collisionLayers = []
  for (const dest of LAYER_DESTINATIONS) {
    const layer = dest.layer
    const dir = path.join(srcRoot, layer)
    if (!fs.existsSync(dir)) {
      absent.push(layer)
      continue
    }
    const subpaths = Array.isArray(dest.activeSubpaths) ? dest.activeSubpaths : null
    if (subpaths === null) {
      // 整层迁移完成（或本无旧对应物）⇒ 目录内全部生产文件是执行面
      for (const rel of collectLayerFiles(srcRoot, layer)) active.push(rel)
      continue
    }
    if (subpaths.length === 0) {
      // 目录存在但尚未开始迁移：整个目录是旧实现（这正是 P0 时 runtime/ 的情形）
      legacyCollisions.push({ layer, because: '目录名与目标分层相同，但已登记为旧实现的迁移来源' })
      collisionLayers.push(layer)
      continue
    }
    // 部分迁移：只把登记的路径纳入执行面
    const present = []
    for (const p of subpaths) if (fs.existsSync(path.join(srcRoot, p))) present.push(p)
    if (present.length === 0) {
      legacyCollisions.push({ layer, because: '目录名与目标分层相同，但已登记的 activeSubpaths 均不存在' })
      collisionLayers.push(layer)
      continue
    }
    active.push(...present)
  }
  return { active, absent, legacyCollisions, collisionLayers }
}

/** 递归列出 `src/<layer>/` 下的生产源文件（相对 `src/`，正斜杠）。 */
function collectLayerFiles(srcRoot, layer) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue
        walk(full)
      } else if (/\.(ts|tsx|mts|vue)$/.test(e.name)) {
        if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue
        out.push(path.relative(srcRoot, full).replace(/[\\/]+/g, '/'))
      }
    }
  }
  walk(path.join(srcRoot, layer))
  return out
}

/**
 * 「纯核心」层的**前缀**集合。
 *
 * 不是所有闸门执行面都要禁 Vue/Three/DOM：`runtime` 里将来会有 `runtime/evaluation`
 * 的接线（P4），`presentation`/`editors` 层**必须**能用 Three/Vue。
 * ⇒ 「禁 Vue/Three/DOM」的判定面由 `LAYER_DESTINATIONS[*].corePurity` 显式声明，
 * 而不是把所有新层一刀切。
 */
export function corePurityFileSet(srcRoot) {
  const { active } = resolveGateLayers(srcRoot)
  const core = []
  for (const dest of LAYER_DESTINATIONS) {
    if (dest.corePurity !== true && dest.layer !== 'domain' && dest.layer !== 'application') continue
    for (const rel of active) {
      if (rel === dest.layer || rel.startsWith(`${dest.layer}/`)) core.push(rel)
    }
  }
  return new Set(core)
}

/** 某个 `src/` 相对路径是否落在闸门执行面内（两侧都剥离扩展名后比较）。 */
export function isGateFile(rel, gateFiles) {
  const strip = (p) => p.replace(/\.(ts|tsx|mts|vue)$/, '')
  const want = strip(rel)
  for (const g of gateFiles) {
    if (g === rel) return true
    if (strip(g) === want) return true
  }
  return false
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
  title: '纯核心层（domain/application，及声明 corePurity 的新执行面）不得依赖 Vue / Three',
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
      //
      // P1：判定面从"层名前缀"升级为 `ctx.coreFiles`（**文件级**白名单）——
      // 因为 runtime/ 是部分迁移层，只有登记的新文件属纯核心，
      // 旧根文件（renderEngine 等）不得因撞名被判红。
      if (!ctx.coreFiles.has(f.fromSrcRel)) continue
      const cls = classifyExternal(f.specifier)
      if (cls === 'vue' || cls === 'three') {
        bad.push(
          mkFinding(
            ruleCoreNoVueThree,
            f,
            `${topLayer(f.fromSrcRel)} 层（新实现）导入了 ${cls}${f.isTypeOnly ? '（**类型导入**，同样计入 —— §4 规则 6）' : ''}`,
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
  title: '纯核心层（domain/application，及声明 corePurity 的新执行面）不得引用 DOM / 浏览器全局',
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
      if (!ctx.coreFiles.has(srcRel)) continue
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
          detail: `${topLayer(srcRel)} 层（新实现）引用了浏览器全局 ${hit.name}`,
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
      const fromIsGate = isGateFile(f.fromSrcRel, ctx.gateFiles)
      const toIsGate = isGateFile(`${target}.ts`, ctx.gateFiles) || isGateFile(target, ctx.gateFiles)
      // 只在**新分层**上判定（旧目录的转出口计入债务清单，不在此判红）。
      //
      // P1 起判定面是**文件级**：一个"旧→旧"的转出口（例如 workbench/ux/types/index.ts
      // 转出口旧的 runtime/）不得因 `runtime` 层名而判红 —— 它的两端都是旧实现。
      // 反之，"新文件 → 任意跨目录转出口"必须判红。
      if (!fromIsGate && !toIsGate) continue
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
  title: '新实现跨层导入必须经公共出口，禁止钻进别的层的私有实现',
  criterion: '#249 §4 导入规则 6；契约 §7.3 规则 2（公共出口最大深度 2）',
  layerDependent: true,
  check(facts, ctx) {
    const bad = []
    for (const f of facts) {
      const t = resolveInternalTarget(f, ctx.srcRoot)
      if (t === null) continue
      const fromLayer = topLayer(f.fromSrcRel)
      const toLayer = topLayer(t)
      if (fromLayer === toLayer) continue // 层内导入不受此规则约束
      // **判定面在"发起方"**：只有新实现（登记在案的执行面文件）才受公共出口约束。
      // 旧→旧 的深导入是 #249 §15 的遗留债务（由负责批次退役，见 RETIREMENT_OWNERS），
      // 不是本批新边界的 finding —— 否则撞名的 runtime/ 会凭空产生假红
      // （P0/P1 实测：`embed/EmbedRoot.vue`、`workbench/WorkbenchRoot.vue`、
      //  `workbench/components/WorkbenchViewport.vue` 导入 `runtime/host/*`）。
      if (!isGateFile(f.fromSrcRel, ctx.gateFiles)) continue
      const depth = t.split('/').length
      if (depth > MAX_PUBLIC_EXPORT_DEPTH) {
        bad.push(
          mkFinding(
            ruleNoPrivateCrossLayer,
            f,
            `新实现跨层导入了 ${toLayer} 层深于公共出口的实现（${t}，深度 ${depth} > ${MAX_PUBLIC_EXPORT_DEPTH}）`,
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
 * 键 = 退役条目的稳定 slug；`entries` = 该 slug 覆盖的 §15 行号（1–13）；
 * `owners` = 负责批次列表（每条含 `p` / `issue` / 职责面 `scope`）。
 *
 * ## P1（#252）退出阶段的修正（#250 裁决 2026-10-11）
 *
 * 契约与执行单原本把 `#1`/`#4`/`#6`（业务面）的退出阶段写成「P1 交付同批」。
 * 实测后由 Lead 裁决修正为：**替代机制 P1 交付 + 消费者归口批次同批删除 +
 * P11（#262）终局零引用审计**。理由（P1 实测证据）：
 *
 *  - `web/src/runtime/main.ts` 的 `structEpoch`/`currentFrameIndex`/`framesPlaybackIsPlaying`
 *    等 Ref 有 **72 个生产文件、74 处 `.main.*` 访问**（其中 13 处是真·裸 Ref 读写）；
 *  - 这些消费者读的是旧 `RuntimeDocument`（frames/grid/parts/playback），
 *    而 P1 的新 scene 模型只有 block/annotation/camera 三类对象（#252 明文），
 *    **无法承载**旧文档语义 ⇒ 任何"迁移"都只能是新门面包旧核心，
 *    恰是 `#171` 明令禁止、且 `#1` 自身负对照（「新 facade 内调用旧 runtime ⇒ 判红」）要判红的形态。
 *  - 同理 `#4`（`shared/viewport/useMultiblockChannels.ts` 每视口暂存）的消费者是
 *    `WorkbenchViewport.vue`/`EmbedViewport.vue` 与 multiblock e2e 族（P6/P4 领地）；
 *    `#6` 的业务 RAF 是 `runtime/renderEngine.ts`（P5）与
 *    `workbench/ux/panels/useMaterialAnimation.ts`（P4，B5 已定）。
 *
 * ⇒ P1 承担的可执行形式是：**替代机制建成且被两个真实消费者证明**
 * + `kernel-legacy-isolation.test.ts` 闸门（新层零 import 旧层、无兼容门面）
 * + 本表列明暂存登记供 #262 对账。终局判据（B5）不变。
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
 * 文档侧同源副本见 #251 B5 附件；两者互为镜像，改动必须同批双改（B5 修正由 P1 同步）。
 */
export const RETIREMENT_OWNERS = {
  'raw-authority-object': {
    entries: [1],
    owners: [
      { p: 'P4', issue: 255, duty: '统一动画求值、依赖图与纹理序列', scope: '材质/通道的 ctx.main 消费者退出' },
      { p: 'P5', issue: 256, duty: '呈现编译、GPU 合批与资源生命周期', scope: '渲染链的 structEpoch/Ref 消费者退出' },
      { p: 'P6', issue: 257, duty: '工作区、Area 生命周期与模块装配', scope: '工作台/嵌入组件与 Context 消费者退出' },
      { p: 'P11', issue: 262, duty: '退役审计、全量回归、性能门槛与复杂度对账', scope: 'Main/Context 旧导出零引用终局审计' },
    ],
    exitStage: 'P1 交付替代（EditorClient 读面 + 命令客户端，消费者归口 P4/P5/P6）→ P11 终局审计',
    role: 'P1 执行者（替代机制）；P4/P5/P6 执行者（消费者删除）；P11 执行者（终局审计）',
    // 「替代机制 P1 交付」这一半在本批完成，故标记为部分交付（#250 裁决 2026-10-11）。
    p1Delivered: '替代机制',
  },
  'runtime-document-triple-duty': {
    entries: [2],
    owners: [
      { p: 'P4', issue: 255, duty: '统一动画求值、依赖图与纹理序列', scope: '求值面（类型化文档 + 求值场景）' },
      { p: 'P9', issue: 260, duty: '持久化、固定快照导出与恢复', scope: '文件面（文件适配、持久化）' },
      { p: 'P10', issue: 261, duty: '集成闭环与交叉验收', scope: '旧 RuntimeDocument 生产消费者的接线退出（R-WK-03）' },
    ],
    // P9（#260）执行登记：文件面**适配器**已交付（`adapters/files` 的工程/发布/旧格式编解码 +
    // A20 验收），但旧 `RuntimeDocument` 的**生产消费者**（`runtime/context.getDoc()`、
    // `workbench/**` 读写链、序列化调用点）退出需要内核先接线进生产 ——
    // 该前置由 R-WK-03（#250 裁决 2026-10-11）归入 **P10/#261**，故本条的终局删除不在 P9 同批。
    exitStage: 'P9 交付同批（求值面 P4 分离，文件面 P9 适配器收口）→ 生产消费者接线退出归 P10/#261（R-WK-03）→ P11 终局审计',
    role: 'P4 执行者（求值与文档解耦）；P9 执行者（文件适配器，不桥接旧路径）；P10 执行者（生产接线后删除旧序列化/读取链）；P11 执行者（终局审计）',
  },
  'ui-proxy-dispatch': {
    entries: [3],
    owners: [{ p: 'P2', issue: 253, duty: 'RNA：属性描述、寻址与受控命令读面', scope: 'RNA 引用 + 受控纯属性命令' }],
    exitStage: 'P2 交付同批',
    role: 'P2 执行者',
  },
  'per-viewport-staging': {
    entries: [4],
    owners: [
      { p: 'P4', issue: 255, duty: '统一动画求值、依赖图与纹理序列', scope: '通道取值/暂存并入 EditContext' },
      { p: 'P6', issue: 257, duty: '工作区、Area 生命周期与模块装配', scope: 'useMultiblockChannels 的每视口副本退出' },
      { p: 'P11', issue: 262, duty: '退役审计、全量回归、性能门槛与复杂度对账', scope: '每视口暂存零残留终局审计' },
    ],
    exitStage: 'P1 交付替代（EditContext 与有效读面，消费者归口 P4/P6）→ P11 终局审计',
    role: 'P1 执行者（替代机制）；P4/P6 执行者（消费者删除）；P11 执行者（终局审计）',
    p1Delivered: '替代机制',
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
      { p: 'P5', issue: 256, duty: '呈现编译、GPU 合批与资源生命周期', scope: 'renderEngine tick/layoutResizeRAF 归口渲染批次' },
      { p: 'P4', issue: 255, duty: '统一动画求值、依赖图与纹理序列', scope: 'useMaterialAnimation 独立播放循环并入统一时间' },
      { p: 'P11', issue: 262, duty: '退役审计、全量回归、性能门槛与复杂度对账', scope: '业务 RAF 零残留终局审计' },
    ],
    exitStage: 'P1 交付替代（统一执行协议与完成事件，消费者归口 P4/P5）→ P11 终局审计',
    role: 'P1 执行者（替代机制）；P4/P5 执行者（消费者删除）；P11 执行者（终局审计）',
    p1Delivered: '替代机制',
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
    owners: [
      { p: 'P9', issue: 260, duty: '持久化、固定快照导出与恢复', scope: '固定快照导出作业、共同求值与呈现' },
      { p: 'P10', issue: 261, duty: '集成闭环与交叉验收', scope: '旧导出器（workbench/export* + exportIsometricImage + GIF/OBJ 命令）删除' },
    ],
    // P9（#260）执行登记：**内核侧替代机制已交付且可加载**（`domain/captureSpec` +
    // `application/exportPlan` + `runtime/exportJob`，静态证据见
    // `tests/architecture/export-purity.test.ts`：离屏端口方法集合封闭、导出层不得 import
    // 实时视口/相机实现、不得 import 旧导出器）。
    //
    // 但**旧导出器的删除**不在 P9 同批：其消费面在生产旧路径上（`operators/builtin/exportOperators.ts`、
    // `operators/builtin/materialOperators.ts`、`workbench/components/ExportWorkspace.vue`
    // 与 `workbench/export/` 48 文件），而按 R-WK-03（#250 裁决 2026-10-11）内核未接线进生产时
    // 删除旧路径 = 能力停摆且无替代。⇒ 删除归 P10/#261 与接线同批。
    exitStage: 'P9 交付同批（内核侧固定快照导出机制）→ 旧导出器删除随生产接线归 P10/#261（R-WK-03）→ P11 终局审计',
    role: 'P9 执行者（替代机制）；P10 执行者（接线后删除旧导出器）；P11 执行者（终局审计）',
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
      const fromIsGate = isGateFile(f.fromSrcRel, ctx.gateFiles)
      const toIsGate = isGateFile(`${target}.ts`, ctx.gateFiles) || isGateFile(target, ctx.gateFiles)
      if (fromIsGate || toIsGate) continue // 闸门规则已覆盖（见 ruleNoBarrelSmuggling）
      const fromDir = path.dirname(f.fromRel)
      const toDir = path.dirname(`src/${target}`).replace(/[\\/]+/g, '/')
      if (fromDir === toDir) continue
      debt['legacy-barrel-reexport'].push({
        file: f.fromRel,
        line: f.line,
        specifier: f.specifier,
        fromLayer: topLayer(f.fromSrcRel),
        toLayer: topLayer(target),
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
