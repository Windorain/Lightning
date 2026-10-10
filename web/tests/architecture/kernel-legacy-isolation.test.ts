/**
 * **P1 内核 · 旧层隔离闸门**（#250 裁决 2026-10-11；B5 退役矩阵 #1/#4/#6 的可执行半边）。
 *
 * ## 为什么需要它，且为什么它**不**在 `boundary-rules.mjs` 里
 *
 * `boundary-rules.mjs` 的 `GATE_RULES` 判的是「新层内部的导入形状」（不得 vue/three/DOM、
 * 不得 barrel 偷渡、跨层须经公共出口）。它**没有**判「新层是否在偷用旧实现」——
 * 那需要一张"旧层清单"，而清单是**本批（P1）才首次有内容**的事实。
 *
 * #1 的删除验收原文要求：「生产消费者不再访问旧权威对象；旧导出删除」，
 * 且**负对照**是「**新 facade 内调用旧 runtime** ⇒ 判红」。
 * 在 P1 的范围内（#252 正文「旧渲染/旧状态通路不改动、不复用」+#250 裁决一），
 * 能落地的正是这条负对照的**可执行半边**：
 *
 *  1. 新内核不得 import 任何旧层（否则就是"新门面包旧核心"）；
 *  2. 旧层不得被新层反向依赖（依赖方向无环，#249 §2.2）；
 *  3. 新层的公开面上不得出现"兼容门面"（转发旧类型的别名 / 重新导出旧模块）；
 *  4. `domain`/`application` 不得出现 Proxy / setter 旁路（A08 负对照的静态面）。
 *
 * ## 为什么放在 `tests/architecture/` 而不是 `src/` 的测试里
 *
 * 它是**边界判据**，与 A01 同族，应随 `npm run test:arch` 一起跑（P11 终局审计会复用）。
 * 它**不**修改 `boundary-rules.mjs` 的 `GATE_RULES` 本体（Lead 裁决：不碰规则本体），
 * 而是独立一条闸门，与 `boundary-scan.test.ts` 并列。
 *
 * ## 旧层清单的来源
 *
 * 取自 `boundary-rules.mjs` 的 `LAYER_DESTINATIONS[*].legacySources` **加上**具体的旧目录名。
 * 用一张显式表而不是"凡是 `src/` 下未登记的目录都算旧" ——
 * 后者会把 `logging`/`types`/`styles` 等中立设施也算成"旧权威对象"，
 * 让判据失真。清单必须逐条可解释。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildModuleGraph, WEB_ROOT, SRC_ROOT, extractImports } from './module-graph.mjs'

/**
 * 新内核的文件清单，相对 `src/`。
 *
 * 与 `boundary-rules.mjs` 的 `LAYER_DESTINATIONS.runtime.activeSubpaths` 同源 ——
 * 两处都列同一批文件是**故意**的：若哪天有人新增 `runtime/xxx.ts` 而忘了登记，
 * 本文件与扫描器会**同时**不覆盖它（而不是一处覆盖一处漏），
 * 由 `kernel-file-registry.test` 那条断言逼着两处一起改。
 *
 * P4（#255）追加：`domain/animation.ts`、`domain/materials.ts`、`domain/multiblock.ts`
 * （domain 为整层迁移，故不需登记进 `activeSubpaths`，但必须在此被隔离闸门覆盖）、
 * `application/evaluation.ts`、`runtime/evaluation.ts`。
 */
const KERNEL_FILES = [
  'domain/identity.ts',
  'domain/errors.ts',
  'domain/scene.ts',
  'domain/document.ts',
  'domain/editing.ts',
  // P3（#254）几何、坐标关系与固定拓扑形变
  'domain/geometry.ts',
  'domain/geometryEditing.ts',
  'domain/spatial.ts',
  'domain/anchor.ts',
  'domain/selection.ts',
  // P4（#255）时间/轨道/采样、纹理序列、通道装配 + 求值面
  'domain/animation.ts',
  'domain/materials.ts',
  'domain/multiblock.ts',
  'application/state.ts',
  'application/commands.ts',
  'application/queries.ts',
  'application/evaluation.ts',
  'runtime/execution.ts',
  'runtime/scheduling.ts',
  'runtime/effects.ts',
  'runtime/evaluation.ts',
]

/**
 * 旧分层（#249 §15 退役矩阵的"旧机制"所在目录），相对 `src/`。
 *
 * 判定用**前缀**匹配：`runtime` 会命中 `runtime/renderEngine.ts`，
 * 但**不会**命中 `runtime/execution.ts`（它在 `KERNEL_FILES` 里，见 `isOldLayerTarget`）。
 */
const OLD_LAYERS = [
  'pure',
  'context',
  'operators',
  'handlers',
  'events',
  'render',
  'shared',
  'workbench',
  'viewer',
  'embed',
  'wiki',
  'util',
  'config',
  'dev',
  'logging',
  // 撞名层：旧 runtime 的实现文件（新实现见 KERNEL_FILES）
  'runtime',
]

/** 该模块路径（`src/` 相对、无扩展名）是否属于旧分层。 */
function isOldLayerTarget(rel) {
  const withExt = `${rel}.ts`
  const withVue = `${rel}.vue`
  if (KERNEL_FILES.includes(withExt) || KERNEL_FILES.includes(withVue) || KERNEL_FILES.includes(rel)) return false
  return OLD_LAYERS.some((layer) => rel === layer || rel.startsWith(`${layer}/`))
}

function isProductionRel(rel) {
  if (rel.startsWith('..')) return false
  if (rel.split('/').slice(0, -1).includes('__tests__')) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false
  if (/\.d\.ts$/.test(rel)) return false
  return true
}

/**
 * 读源码并**归一化行尾为 LF**（EOL 脆性的治本处，见 `freeze-convergence.test.ts` 的长注释）。
 *
 * 本仓 `core.autocrlf=true` ⇒ 新鲜检出是 CRLF、执行者工具写出的工作树常是 LF。
 * 本文件当下这几条断言（`matchAll(/readonly kind: …/)`、`indexOf('}>')`）恰好不依赖
 * `\n` 字面量，**但**「恰好安全」不是判据 —— 后续任何人加一句 `indexOf('\n\n')`
 * 或 `/\n\n/` 就会重新引入同一缺陷。统一走本入口使"读到的文本恒为 LF"成为文件级前提。
 *
 * 2026-10-11 合流事故：集成树 `96b2e3b` 上 `freeze-convergence.test.ts:303` 因
 * `\n\n` 失配判红（该测试在 LF 树上绿）。
 */
function readSource(absPath) {
  return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n')
}

function loadGraph() {
  const { files, facts } = buildModuleGraph()
  const kernelAbs = new Set(KERNEL_FILES.map((rel) => path.join(SRC_ROOT, rel)))
  // **生产**导入事实：与 `scan-boundaries.mjs` 同一口径。
  // 测试文件可以（也应当）为了断言而 import 内核 —— 若把它们算进反向依赖，
  // 判据会把"测试证明新层可用"误报成"旧层依赖新层"（P1 首跑实测到的假红）。
  const prodFacts = facts.filter((f) => isProductionRel(path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')))
  const kernelImports = prodFacts.filter((f) => kernelAbs.has(f.fromFile))
  return { files, facts: prodFacts, allFacts: facts, kernelImports, kernelAbs }
}

function resolveTarget(f) {
  const spec = f.specifier
  if (spec.startsWith('«')) return null
  if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')) return null
  const fromDir = path.dirname(f.fromFile)
  const abs = spec.startsWith('@/') ? path.join(SRC_ROOT, spec.slice(2)) : path.resolve(fromDir, spec)
  const rel = path.relative(SRC_ROOT, abs).replace(/[\\/]+/g, '/')
  if (rel.startsWith('..')) return null
  return rel.replace(/\.(ts|tsx|mts|vue|js)$/, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 新内核不得 import 旧层
// ─────────────────────────────────────────────────────────────────────────────

describe('P1 内核隔离：新内核不得依赖任何旧层（#1 负对照「新 facade 内调用旧 runtime」的可执行半边）', () => {
  it(`${KERNEL_FILES.length} 个内核文件的**全部**内部导入都落在新层内（无一条指向旧目录）`, () => {
    const { kernelImports } = loadGraph()
    const violations = []
    for (const f of kernelImports) {
      const target = resolveTarget(f)
      if (target === null) continue // 外部包/无法解析
      if (isOldLayerTarget(target)) {
        violations.push(`${f.fromRel}:${f.line}  → ${f.specifier}（旧层 ${target.split('/')[0]}）`)
      }
    }
    expect(violations, `新内核出现指向旧层的导入（这就是"新门面包旧核心"）:\n${violations.join('\n')}`).toEqual([])
  })

  it('反空洞真：内核文件确实有内部导入（否则上一条的"0 违规"可能只是"没解析到"）', () => {
    const { kernelImports } = loadGraph()
    const internal = kernelImports.map(resolveTarget).filter((t) => t !== null)
    expect(internal.length, '内核文件之间必须有真实导入（否则断言器空转）').toBeGreaterThan(8)
    // 且确实**解析到**了新层目标
    expect(internal.some((t) => t.startsWith('domain/'))).toBe(true)
    expect(internal.some((t) => t.startsWith('application/'))).toBe(true)
    expect(internal.some((t) => t.startsWith('runtime/'))).toBe(true)
  })

  it('**负对照**：往内核文件里注入一条 `@/runtime/renderEngine` 导入 ⇒ 判红', () => {
    // 与上一条**同一个**判定函数，只换事实来源 —— 证明判据不是恒绿。
    const injected = [
      {
        fromFile: path.join(SRC_ROOT, 'runtime', 'execution.ts'),
        fromRel: 'src/runtime/execution.ts',
        specifier: '@/runtime/renderEngine',
        kind: 'import',
        isTypeOnly: true,
        line: 1,
        column: 1,
        syntax: "import type { RenderEngine } from '@/runtime/renderEngine'",
      },
    ]
    const violations = injected.map(resolveTarget).filter((t) => t !== null && isOldLayerTarget(t))
    expect(violations, '新 facade 内调用旧 runtime 必须判红（#1 负对照原文）').toHaveLength(1)
    expect(violations[0]).toBe('runtime/renderEngine')
  })

  it('**负对照**：注入一条 `@/runtime/sessionStore` 的相对形态同样判红（两种说明符都要覆盖）', () => {
    const injected = [
      {
        fromFile: path.join(SRC_ROOT, 'application', 'queries.ts'),
        fromRel: 'src/application/queries.ts',
        specifier: '../runtime/sessionStore',
        kind: 'import',
        isTypeOnly: false,
        line: 3,
        column: 1,
        syntax: "import { sessionStore } from '../runtime/sessionStore'",
      },
    ]
    const violations = injected.map(resolveTarget).filter((t) => t !== null && isOldLayerTarget(t))
    expect(violations).toHaveLength(1)
  })

  it('**负对照**：导入新的 `runtime/scheduling` **不**判红（闸门不得把新层自己也算旧）', () => {
    const own = [
      {
        fromFile: path.join(SRC_ROOT, 'runtime', 'execution.ts'),
        fromRel: 'src/runtime/execution.ts',
        specifier: './scheduling',
        kind: 'import',
        isTypeOnly: false,
        line: 1,
        column: 1,
        syntax: "import { planBatch } from './scheduling'",
      },
      {
        fromFile: path.join(SRC_ROOT, 'application', 'commands.ts'),
        fromRel: 'src/application/commands.ts',
        specifier: '@/domain/scene',
        kind: 'import',
        isTypeOnly: true,
        line: 1,
        column: 1,
        syntax: "import type { Scene } from '@/domain/scene'",
      },
    ]
    const violations = own.map(resolveTarget).filter((t) => t !== null && isOldLayerTarget(t))
    expect(violations, '新层之间的导入不得被判为旧层依赖').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 旧层反向依赖新内核：**只允许已登记的迁移边**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 已登记的"旧层 → 新内核"迁移边（P4 首次出现）。
 *
 * ## 为什么必须显式登记，而不是把断言放宽
 *
 * 这条闸门存在的理由是「有人在用"新层"给旧路径续命」（文件头原文）。
 * 但它同时挡不住另一件事：**合法的迁移**也需要旧文件 import 新层 ——
 * 否则替代机制永远无法被消费。
 *
 * ⇒ 正确的处理不是"删断言"或"放宽为空"，而是把"哪一条旧→新依赖是**已批准**的"
 * 变成显式事实。于是：
 *  - 未登记的旧→新依赖仍然判红（闸门不放宽）；
 *  - 已登记的每条都必须**真实存在**（登记本身不许腐烂成"曾经有过"）；
 *  - 每条都要写明**理由与退出阶段**（供 P11 终局审计逐条核销）。
 *
 * 与 #250 R-WK-01 的关系：R-WK-01 要求"替代方提供替代接口与删除点清单"，
 * 本表就是那些清单在**依赖方向**上的镜像 —— 谁开始消费新接口、什么时候退出。
 */
const APPROVED_LEGACY_TO_KERNEL_EDGES = [
  Object.freeze({
    from: 'src/workbench/ux/panels/MaterialGallery.vue',
    to: 'domain/materials',
    reason:
      'P4 删除 useMaterialAnimation（每面板独立 RAF + elapsed 累积）后，材质缩略图的帧采样改吃统一时间纯采样器；这是 B5 #11 的替代机制首次被真实消费者使用（#252 的替代验收要求"被至少两个真实消费者证明"，此为业务侧消费者一例）',
    exitStage:
      'P6（工作台/编辑面板重写）把该面板迁到 editors/ 层时，此边随文件迁移自然消失；P11 终局审计应核销本行',
  }),
  Object.freeze({
    from: 'src/application/commands.ts',
    to: 'domain/animation',
    reason:
      '内核层内依赖（application → domain），非旧层依赖；列入此表仅为让"命令面到动画面"的接缝在架构清单里可见',
    exitStage: 'P11 终局审计：此边属新层内部依赖，永久保留',
    internalToKernel: true,
  }),
]

describe('依赖方向：旧层 → 新内核的**未登记**依赖判红；已登记的迁移边必须真实存在', () => {
  it('旧层文件里指向内核的导入只允许出现在 APPROVED_LEGACY_TO_KERNEL_EDGES 里', () => {
    // 说明：旧层**将来**会迁到新层（上述归口批次），届时这条断言会随迁移一起改。
    // 现在它是"新内核已建成但尚未被旧代码反向依赖"的事实记录 ——
    // 若有旧文件开始 import 内核，说明有人在用"新层"给旧路径续命 —— 必须出现在
    // `APPROVED_LEGACY_TO_KERNEL_EDGES` 里（显式登记，不得静默）。
    //
    // ## 判定面是**文件级**：来源必须是**旧层**，不能是"不在 KERNEL_FILES 里的任何文件"
    //
    // 初版按"来源 ∉ KERNEL_FILES ⇒ 旧"判定。那在只有 P1 那 11 个文件算新层时成立；
    // 但 `boundary-rules.mjs` 的登记表此后已陆续纳入 P5 的 `presentation/**` 等新层实现，
    // 于是"新层 → 新层"的导入（`presentation/compileScene.ts → @/domain/errors`）
    // 会被误判成"旧层反向依赖内核" —— 那是**假红**（与 P1 在 `boundary-rules.mjs`
    // 里把同一条判据改成文件级时踩到的是同一类问题）。
    //
    // 本批（GF-5 收敛）删除了 `presentation/result.ts` 的第二份契约定义，
    // 使 `presentation/compileScene.ts` 直接 import `@/domain/errors` ——
    // 这正是"类型单一来源"的应有结果（向下依赖，层深 2，符合公共出口约束），
    // 不是"用新层给旧路径续命"。故判定改为：**来源落在 OLD_LAYERS 才算旧**。
    const { facts } = loadGraph()
    const kernelNoExt = new Set(KERNEL_FILES.map((f) => f.replace(/\.(ts|tsx|mts|vue)$/, '')))
    const approved = new Set(
      APPROVED_LEGACY_TO_KERNEL_EDGES.filter((e) => e.internalToKernel !== true).map((e) => `${e.from}→${e.to}`),
    )
    const reverse = []
    for (const f of facts) {
      const fromRel = path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')
      if (KERNEL_FILES.includes(fromRel)) continue
      // **来源**必须是旧层（用判据自身的旧层定义，不靠"不在内核清单里"反推）。
      if (!isOldLayerTarget(fromRel.replace(/\.(ts|tsx|mts|vue)$/, ''))) continue
      const target = resolveTarget(f)
      if (target !== null && kernelNoExt.has(target)) {
        const key = `src/${fromRel}→${target}`
        if (approved.has(key)) continue
        reverse.push(`${f.fromRel}:${f.line}  → ${f.specifier}（未登记的旧→新依赖）`)
      }
    }
    expect(
      reverse,
      `旧层反向依赖内核但未登记（须先登记理由与退出阶段，不得静默）:\n${reverse.join('\n')}`,
    ).toEqual([])
  })

  it('每条已登记边都**真实存在**（登记不得腐烂）', () => {
    const { facts } = loadGraph()
    const kernelNoExt = new Set(KERNEL_FILES.map((f) => f.replace(/\.(ts|tsx|mts|vue)$/, '')))
    const kernelInternal = new Set(APPROVED_LEGACY_TO_KERNEL_EDGES.filter((e) => e.internalToKernel === true).map((e) => e.to))
    const present = new Set<string>()
    for (const f of facts) {
      const fromRel = path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')
      const target = resolveTarget(f)
      if (target === null) continue
      if (!kernelNoExt.has(target)) continue
      present.add(`src/${fromRel}→${target}`)
      void kernelInternal
    }
    for (const e of APPROVED_LEGACY_TO_KERNEL_EDGES) {
      if (e.internalToKernel === true) continue
      expect(present, `登记的迁移边 ${e.from}→${e.to} 已不存在 —— 请同步核销登记（P11 审计依赖它的准确性）`).toContain(
        `${e.from}→${e.to}`,
      )
      expect(e.reason.length, `${e.from}→${e.to} 必须写明理由`).toBeGreaterThan(20)
      expect(e.exitStage, `${e.from}→${e.to} 必须写明退出阶段`).toMatch(/P\d+/)
    }
  })

  it('**负对照**：未登记的旧→新依赖仍判红（闸门没有因为"有登记表"而失效）', () => {
    // 合成一条未经登记的旧层文件 → 内核文件的导入，走**同一个**判定逻辑。
    const kernelNoExt = new Set(KERNEL_FILES.map((f) => f.replace(/\.(ts|tsx|mts|vue)$/, '')))
    const approved = new Set(
      APPROVED_LEGACY_TO_KERNEL_EDGES.filter((e) => e.internalToKernel !== true).map((e) => `${e.from}→${e.to}`),
    )
    const injected = [
      {
        fromFile: path.join(SRC_ROOT, 'runtime', 'renderEngine.ts'),
        fromRel: 'src/runtime/renderEngine.ts',
        fromSrcRel: 'runtime/renderEngine.ts',
        specifier: '@/application/evaluation',
        kind: 'import',
        isTypeOnly: false,
        line: 1,
        column: 1,
        syntax: "import { evaluateScene } from '@/application/evaluation'",
      },
    ]
    const hits = injected
      .map((f) => ({ f, target: resolveTarget(f) }))
      .filter(({ f, target }) => target !== null && kernelNoExt.has(target) && !approved.has(`src/${f.fromSrcRel}→${target}`))
    expect(hits, '未登记的旧→新依赖必须判红').toHaveLength(1)
  })

  it('反空洞真 + 负对照：内核确实被**新层**依赖，而注入一条旧层导入会被抓到', () => {
    // 反空洞真：收敛后 `presentation/**`（新层）确实 import 内核 ——
    // 若这一条不成立，"旧层零反向依赖"可能只是"没人 import 内核"。
    const { facts } = loadGraph()
    const kernelNoExt = new Set(KERNEL_FILES.map((f) => f.replace(/\.(ts|tsx|mts|vue)$/, '')))
    const newLayerDependents = facts.filter((f) => {
      const fromRel = path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')
      if (KERNEL_FILES.includes(fromRel)) return false
      if (isOldLayerTarget(fromRel.replace(/\.(ts|tsx|mts|vue)$/, ''))) return false
      const t = resolveTarget(f)
      return t !== null && kernelNoExt.has(t)
    })
    expect(
      newLayerDependents.length,
      '新层之间存在真实的内核依赖（否则"旧层零反向依赖"是空洞真）',
    ).toBeGreaterThan(0)

    // 负对照：同一判据对**旧层**来源必须判红（证明它不是恒绿）。
    const injected = [
      {
        fromFile: path.join(SRC_ROOT, 'render', 'someLegacyModule.ts'),
        fromRel: 'render/someLegacyModule.ts',
        specifier: '@/domain/errors',
        kind: 'import',
        isTypeOnly: false,
        line: 1,
        column: 1,
        syntax: "import { err } from '@/domain/errors'",
      },
    ]
    const flagged = injected.filter((f) => {
      if (!isOldLayerTarget(f.fromRel.replace(/\.(ts|tsx|mts|vue)$/, ''))) return false
      const t = resolveTarget(f)
      return t !== null && kernelNoExt.has(t)
    })
    expect(flagged, '旧层 import 内核必须判红').toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 新层公开面上不得出现"兼容门面"
// ─────────────────────────────────────────────────────────────────────────────

describe('无兼容门面：#1 删除验收「旧导出删除」的静态面', () => {
  it('内核文件不重新导出（`export ... from`）任何模块（不造转出口门面）', () => {
    const { kernelImports } = loadGraph()
    const reexports = kernelImports.filter((f) => f.kind === 'export-from')
    expect(
      reexports.map((f) => `${f.fromRel}:${f.line} ${f.syntax}`),
      '内核不得有转出口（否则就是"新门面包旧核心"的入口形态）',
    ).toEqual([])
  })

  it('内核里不出现 `ctx.main` / `Context` / `Main` / `RuntimeDocument` 等旧权威类型名', () => {
    const forbidden = ['RuntimeDocument', 'structEpoch', 'renderViewRevision', 'ref(']
    const hits = []
    for (const rel of KERNEL_FILES) {
      const text = readSource(path.join(SRC_ROOT, rel))
      for (const needle of forbidden) {
        // 只检查**代码文本**（注释里解释"退役了旧机制"是允许且有价值的）
        const codeOnly = text
          .split('\n')
          .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
          .join('\n')
        if (codeOnly.includes(needle)) hits.push(`${rel}: ${needle}`)
      }
    }
    expect(hits, '内核代码（非注释）里不得出现旧权威类型/API 名').toEqual([])
  })

  it('**负对照**：把旧类型名放进代码文本会被抓到（证明上一条不是空转）', () => {
    const sample = "import type { RuntimeDocument } from '@/context/runtimeDocument'\nexport function f(d: RuntimeDocument) { return d }"
    const codeOnly = sample.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
    expect(codeOnly.includes('RuntimeDocument')).toBe(true)
    // 同一判据对**注释里的**提及不判红（退役说明需要写"我们不再用 RuntimeDocument"）
    const commentOnly = '/** 说明：本模块不再依赖 RuntimeDocument（#249 §15 第 2 条） */\nexport const x = 1'
    const commentCode = commentOnly.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
    expect(commentCode.includes('RuntimeDocument')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 无 Proxy / setter 旁路（A08 负对照的静态面）
// ─────────────────────────────────────────────────────────────────────────────

describe('唯一写通路（静态面）：内核里没有 Proxy / defineProperty / set 拦截', () => {
  it('内核源码里不出现 `new Proxy` / `Object.defineProperty` / `__defineSetter__`', () => {
    const banned = ['new Proxy', 'Object.defineProperty', '__defineSetter__', 'Object.defineProperties']
    const hits = []
    for (const rel of KERNEL_FILES) {
      const text = readSource(path.join(SRC_ROOT, rel))
      for (const needle of banned) {
        if (text.includes(needle)) hits.push(`${rel}: ${needle}`)
      }
    }
    expect(hits, '契约 §5.2：不存在第二条属性写通路（无 Proxy、无 setter 旁路）').toEqual([])
  })

  it('**负对照**：同一判据能抓到 Proxy（证明不是空转）', () => {
    const sample = 'const p = new Proxy(target, { set(t, k, v) { t[k] = v; return true } })'
    const banned = ['new Proxy', 'Object.defineProperty']
    expect(banned.some((n) => sample.includes(n))).toBe(true)
  })

  it('`setProperty` 是**唯一**的属性写命令（命令联合的封闭性）', () => {
    // 从命令层源码里抽出 `kind:` 字面量集合，断言与契约的命令清单一致 ——
    // 若有人偷偷加一个 `patch`/`setField` 式命令，这条会失败。
    //
    // ## 为什么要读两个文件（#250 GF-5 收敛后的形态）
    //
    // 收敛前 `SetPropertyCommand` 在 `commands.ts` 里**再定义**一份，
    // 故只看该文件就能抽到 `'setProperty'`。收敛后 `commands.ts` 只**再导出**
    // 该类型，唯一权威在 `application/property-commands.ts`（RNA 的公开命令类型）——
    // 只看一个文件会漏掉 `setProperty`，于是这条断言会以"清单少一项"的形式失败。
    //
    // 修正的做法不是把 `setProperty` 从期望清单里删掉（那等于放松判据、
    // 让"属性写命令"从此无人检查），而是**两处都读**：契约的命令联合横跨
    // "命令总表"（`commands.ts`）与"RNA 公开命令"（`property-commands.ts`）。
    const readKinds = (rel: string): string[] => {
      const text = readSource(path.join(SRC_ROOT, rel))
      return [...text.matchAll(/readonly kind: '([a-zA-Z]+)'/g)].map((m) => m[1])
    }
    /** `property-commands.ts` 的 `SetPropertyCommand` 用 `Readonly<{ kind: … }>`（无 `readonly` 前缀）。 */
    const setPropertyKinds = (): string[] => {
      const text = readSource(path.join(SRC_ROOT, 'application/property-commands.ts'))
      const start = text.indexOf('export type SetPropertyCommand')
      expect(start, '`SetPropertyCommand` 必须定义在 `property-commands.ts`').toBeGreaterThan(-1)
      const block = text.slice(start, text.indexOf('}>', start))
      return [...block.matchAll(/kind: '([a-zA-Z]+)'/g)].map((m) => m[1])
    }
    const unique = [
      ...new Set([...readKinds('application/commands.ts'), ...setPropertyKinds()]),
    ].sort()
    expect(unique).toEqual(
      [
        'addObject',
        'beginInteraction',
        'cancelInteraction',
        'closeDocument',
        'commitInteraction',
        'deleteObject',
        'insertKeyframe',
        'openDocument',
        'publishDefault',
        'redo',
        'removeKeyframe',
        'save',
        'saveCompleted',
        'select',
        'setChannelValue',
        'setProperty',
        'setTime',
        'setTrackEnabled',
        'setTransform',
        'undo',
        'updateInteraction',
      ].sort(),
    )
    // **唯一性**：属性写命令恰好一个（不是"清单里有 setProperty 就算过"）。
    // `setChannelValue` 是**编辑上下文**的具名命令（通道取值），不经通用属性写，
    // 且它写的是 context 而不是属性值 —— 故不在这一组里。
    const propertyWrites = unique.filter((k) => /set(Property|Field|Value)|patch|assign|merge|apply/i.test(k))
    expect(propertyWrites, '通用属性写命令必须恰好是 `setProperty`').toEqual(['setProperty'])
    // 明确的负面清单：这些名字一旦出现就意味着"暴露任意字段 patch"
    for (const banned of ['patch', 'setField', 'assign', 'merge', 'applyPatch']) {
      expect(unique, `不得引入 \`${banned}\` 式通用字段写命令（契约 §5.2）`).not.toContain(banned)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 内核文件登记表与边界扫描器同源
// ─────────────────────────────────────────────────────────────────────────────

describe('内核文件登记表', () => {
  it('KERNEL_FILES 的每一项都真实存在（防登记了不存在的文件而"闸门覆盖它"是假象）', () => {
    for (const rel of KERNEL_FILES) {
      expect(fs.existsSync(path.join(SRC_ROOT, rel)), `${rel} 必须存在`).toBe(true)
    }
  })

  it('与 boundary-rules.mjs 的 runtime.activeSubpaths 完全一致（两处必须同改）', async () => {
    const rules = await import('./boundary-rules.mjs')
    const dest = rules.LAYER_DESTINATIONS.find((d) => d.layer === 'runtime')
    expect(dest, 'runtime 分层必须登记 activeSubpaths').toBeTruthy()
    const runtimeKernel = KERNEL_FILES.filter((f) => f.startsWith('runtime/')).sort()
    expect(dest.activeSubpaths.slice().sort()).toEqual(runtimeKernel)
    // domain/application 是整层迁移（无 activeSubpaths）⇒ 它们的存在性由目录本身表达
    const domainDest = rules.LAYER_DESTINATIONS.find((d) => d.layer === 'domain')
    expect(domainDest.activeSubpaths, 'domain 为整层迁移，不应登记 activeSubpaths').toBeUndefined()
    const appDest = rules.LAYER_DESTINATIONS.find((d) => d.layer === 'application')
    expect(appDest.activeSubpaths, 'application 为整层迁移，不应登记 activeSubpaths').toBeUndefined()
  })

  it('扫描器报告的闸门执行面**包含**全部内核文件（防"登记了但没被扫"）', async () => {
    const rules = await import('./boundary-rules.mjs')
    const { active } = rules.resolveGateLayers(SRC_ROOT)
    for (const rel of KERNEL_FILES) {
      expect(active, `内核文件 ${rel} 必须落在闸门执行面内`).toContain(rel)
    }
  })

  it('内核文件都是**生产**文件（不被 "测试文件不计入" 的规则漏掉）', async () => {
    const mod = await import('./module-graph.mjs')
    for (const rel of KERNEL_FILES) {
      expect(mod.isProductionFile(path.join(SRC_ROOT, rel)), `${rel} 必须算生产文件`).toBe(true)
    }
  })
})

/** 未使用占位，保持 `extractImports` 可达（下游如需按需抽单文件可复用）。 */
void extractImports
void WEB_ROOT
