/**
 * **G1 判据① · `composition/` 生产文件绑定旧层的边**（#385 G1 工作包；形态抄
 * `kernel-legacy-isolation.test.ts#APPROVED_LEGACY_TO_KERNEL_EDGES`）。
 *
 * 登记表与判定核在 `./composition-legacy-binding.mjs`（数据/逻辑与测试分开，是为了让
 * **负对照与生产判据共用同一实现** —— 测试里另写一份判定逻辑的形态，负对照绿了也证明不了
 * 生产判据会判红）。本文件是它的可执行半边。
 *
 * ## 为什么需要它（已实测的**无判据**缺口）
 *
 * `kernel-legacy-isolation.test.ts` 的判定面只有 `KERNEL_FILES`（domain / application /
 * 新 runtime / adapters 的登记文件）。`composition/`（装配根）与 `presentation/`（呈现侧）
 * **不在判定面内** —— 于是「装配根在生产路径上把真实文件装配成内核文档、再把内核投影回
 * 旧形状」这条**设计必需**的编解码面，在闸门上完全不可见：它既不被"内核不得依赖旧层"覆盖
 * （它不在 `KERNEL_FILES`），也不被"旧层 → 内核"覆盖（它不在 `OLD_LAYERS`）。
 *
 * ## 判定面（覆盖形式声明）
 *
 * | 参与 | 不参与 |
 * |---|---|
 * | `src/composition/**` 下**生产**文件（`__tests__/` 与 `*.test.ts` 除外） | `composition/__tests__/**`、`*.test.ts`（它们是夹具与断言，允许绑旧层） |
 * | **全部**内部导入事实：`import` / `export ... from` / `import('x')` / `import('x').T` / 动态 `import()` / `require` | 外部包（`vue`/`three`/`zod`…）与非相对说明符 |
 * | 目标落在**旧分层**（`OLD_LAYERS`，与内核隔离闸门同表）的边 | 目标落在 `KERNEL_FILES`（新层）或 `composition/` 自身的边 |
 *
 * **口径 = AST 全量**（`module-graph.mjs#buildModuleGraph` → TypeScript 编译器 API）。
 * 本判据**不做任何文本扫描**：没有正则、没有 `indexOf`、不读源码正文做匹配
 * —— 因此注释与字符串字面量**天然不可能**误报（`seams.ts` 把符号写在字符串里的坑在此不适用）。
 * 唯一的文本读取是"从 `kernel-legacy-isolation.test.ts` 里取出 `KERNEL_FILES` 字面量"，
 * 那也走 TS 的 AST（见 `composition-legacy-binding.mjs#readKernelFiles`），不是正则。
 *
 * ## 三条判据形态（与 #387 评论 7293 的归档纪律一致）
 *
 * 1. **未登记即红**：扫描出的每一条边都必须逐条在 `APPROVED_COMPOSITION_LEGACY_EDGES` 里；
 * 2. **登记不得腐烂**：每条登记都必须**真实存在**（文件 + 行 + 目标全对）；
 * 3. **登记数不得增**：`files` / `lines` 与 `BASELINE_FILES` / `BASELINE_LINES` 逐数对齐
 *    —— 多一条即红（新增绑定必须先改基线并给出理由），少一条**也**红（须同批核销）。
 *
 * ⚠️ **登记是"可见性与可判定性"，不是允许增长**（#387 评论 7293）。
 * 本判据**严禁直接判零**：装配根把真实文件装配成内核文档、把内核投影回旧形状，
 * 是设计必需的编解码面，判零会立刻假红（实测 32 行）。
 *
 * ## 与任务书给定数字的差异（实测口径；铁律 #7「以判据本尊的扫描口径实测」）
 *
 * 任务书写"8 个生产文件 / 13 行"，且其逐条列举**自加**为 7 文件 / 17 行（把
 * `kernelAssembly.ts:92` 那处 `import type { … }` **多行语句的结束行**当成导入行，
 * 而 AST 报的是语句起点 `:87`）—— 三组数字互不相符。本判据的实测三列基线：
 *
 * | 提交 | 实测（本判据口径） | 说明 |
 * |---|---|---|
 * | `fb0814d4`（真实基线） | **9 文件 / 23 行** | 不含 C8/C9 的新增接线 |
 * | `9630a39d`（任务书写明的 HEAD） | **11 文件 / 28 行** | 含 C8 的 `kernelPickAdapter`/`viewportPick` |
 * | 本批（`e453ea8f`+ R1-A C9 已落地） | **12 文件 / 32 行** | 含 C9 的 `kernelOutlinePlanPort` 四条 |
 *
 * **口径差异的来源**（相对任务书那张窄清单）：本判据按闸门自身的 `OLD_LAYERS` 判"目标是不是旧层"，
 * 故目标落在**撞名层 `runtime/`** 的边（`runtime/gridRead`、`runtime/context`、
 * `runtime/annotationRead`、`runtime/presentationAdapter`）同样计入 —— 这些目标既不在
 * `KERNEL_FILES`，也不在新层，按内核隔离闸门的口径**就是**旧层；另有两条
 * `import('x').T` **类型位置**事实（`kernelProjection.ts:562,569`）与 `:78` 一处。
 * 只看 `@/context/*` + `@/pure/*` 目标时读数 = **7 文件 / 21 行**（报告里给出，供对照）。
 *
 * ## 基线为何是 12/32 而不是 11/28（基线**修订**的显式记录）
 *
 * 本批评审时，R1-A C9（`f50f6011` / `e453ea8f`）已落在本分支上并新增四条装配根 → 旧层绑定。
 * 按本仓 `APPROVED_LEGACY_TO_KERNEL_EDGES` 的既有形态，"新绑定逐条登记"正是闸门要求的处置
 * （登记是可见性与可判定性），故同批登记这四条并把基线改为 12/32 ——
 * 这是一次**显式的、可复核的**基线修订（`git log` 可查），每条新登记都写明理由与退出归属。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractImports } from './module-graph.mjs'
import {
  APPROVED_COMPOSITION_LEGACY_EDGES,
  BASELINE_FILES,
  BASELINE_LINES,
  COMPOSITION_SCOPE,
  REGISTRY_REQUIRED_FIELDS,
  SRC_ROOT,
  countCompositionLegacyEdges,
  isOldLayerTarget,
  isProductionRel,
  readKernelFiles,
  resolveTargetOf,
  unregisteredCompositionLegacyEdges,
} from './composition-legacy-binding.mjs'

const makeEdge = (from, line, to) =>
  Object.freeze({ from, line, to, kind: 'import', reason: 'x'.repeat(30), exitStage: 'P11', owner: 'G1' })

describe('G1 ①：`composition/` 生产文件绑定旧层的边 —— 逐条登记，未登记即红，登记数不得增', () => {
  /** 判据执行面：AST 扫全部生产模块图（与生产扫描器同源）。 */
  // 全树扫描对本配置约 4s：模块内 memo 一次，避免每个用例各扫一遍
  // （判据强度不变 —— 同一次运行内的树是同一份，memo 不影响任何断言）。
  let factsPromise = null
  function loadFacts() {
    if (factsPromise === null) factsPromise = import('./module-graph.mjs').then((m) => m.buildModuleGraph().facts)
    return factsPromise
  }

  it('未登记即红：`composition/` 生产文件指向旧层的每一条边都必须逐条登记', async () => {
    const facts = await loadFacts()
    const violations = unregisteredCompositionLegacyEdges(facts, APPROVED_COMPOSITION_LEGACY_EDGES)
    expect(
      violations,
      `composition/ 生产文件绑定了旧层但未登记（须逐条登记"文件:行 + 目标层 + 理由 + 退出归属"）:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('登记不得腐烂：每条登记都真实存在（文件 + 行 + 目标全对）', async () => {
    const facts = await loadFacts()
    const kernelFiles = readKernelFiles()
    const present = new Set()
    for (const f of facts) {
      const fromRel = path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')
      const target = resolveTargetOf(f, SRC_ROOT)
      if (target === null) continue
      if (!isOldLayerTarget(target, kernelFiles)) continue
      present.add(`src/${fromRel}:${f.line}:${target}`)
    }
    const rotted = APPROVED_COMPOSITION_LEGACY_EDGES.filter((e) => !present.has(`${e.from}:${e.line}:${e.to}`)).map(
      (e) => `${e.from}:${e.line} → ${e.to}`,
    )
    expect(
      rotted,
      `登记的边已不存在或行号漂移（请同批核销/更正 —— 建筑在腐烂登记上的闸门等于没有闸门）:\n${rotted.join('\n')}`,
    ).toEqual([])
  })

  it('登记数不得增（也不得静默减）：文件数与行数与基线逐数对齐', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    expect(
      { files: counted.files, lines: counted.lines },
      `绑定旧层的边数偏离基线 {files:${BASELINE_FILES}, lines:${BASELINE_LINES}}。`
        + '新增绑定必须先改基线与登记表并写明理由（"可见性与可判定性"不等于"允许增长"，#387 评论 7293）；'
        + `减少则须同批核销登记。实测:${JSON.stringify({ files: counted.files, lines: counted.lines })}`,
    ).toEqual({ files: BASELINE_FILES, lines: BASELINE_LINES })
    expect(APPROVED_COMPOSITION_LEGACY_EDGES.length, '登记表长度必须等于实测行数').toBe(BASELINE_LINES)
  })

  it('**校准自检**：登记表自身读数与判据实测读数逐条一致（表里每一行都对应一条真实边）', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    const observed = new Set(counted.rows.map((r) => `${r.file}:${r.line}:${r.target}`))
    const registered = new Set(APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => `${e.from}:${e.line}:${e.to}`))
    const onlyRegistered = [...registered].filter((k) => !observed.has(k)).sort()
    const onlyObserved = [...observed].filter((k) => !registered.has(k)).sort()
    expect({ onlyRegistered, onlyObserved }, '登记表与实测边的对称差必须为空').toEqual({ onlyRegistered: [], onlyObserved: [] })
    // 基线数与判据自身读数一致（手写的 12/32 必须等于判定核数出来的 12/32）
    expect({ files: BASELINE_FILES, lines: BASELINE_LINES }).toEqual({ files: counted.files, lines: counted.lines })
  })

  it('覆盖形式被测：判定面确实覆盖了 `composition/` 的全部生产文件，且无解析失败', async () => {
    const { buildModuleGraph } = await import('./module-graph.mjs')
    const { files, facts } = buildModuleGraph()
    // ⚠️ 判"是否进判定面"必须用扫描器返回的 `files`（被解析的文件清单），
    // **不能**用 `facts` 的来源集合：一个文件可以合法地**没有任何导入**
    // （`composition/seams.ts` 正是如此 —— 它只在字符串里写符号名），
    // 用 facts 反推会把"零导入的文件"误判成"没被扫"（本测试首跑实测的假红）。
    const scanned = new Set(files.map((f) => path.relative(SRC_ROOT, f).replace(/[\\/]+/g, '/')))
    const srcFiles = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'node_modules') continue
          walk(full)
        } else if (/\.(ts|tsx|mts|vue)$/.test(e.name)) {
          srcFiles.push(path.relative(SRC_ROOT, full).replace(/[\\/]+/g, '/'))
        }
      }
    }
    walk(path.join(SRC_ROOT, COMPOSITION_SCOPE))
    const uncovered = srcFiles.filter((rel) => isProductionRel(rel) && !scanned.has(rel)).sort()
    expect(uncovered, 'composition/ 的生产文件必须全部进判定面（否则"未登记即红"有洞）').toEqual([])
    expect(srcFiles.length, '判定面非空转').toBeGreaterThan(10)
    expect(
      facts.filter((f) => f.kind === 'parse-error').map((f) => f.fromRel),
      '解析失败会让判据静默漏边',
    ).toEqual([])
  })

  it('登记字段完备性：每条登记都写明 文件/行/目标/类别/理由/退出归属/负责人', () => {
    const incomplete = APPROVED_COMPOSITION_LEGACY_EDGES.filter((e) => {
      if (REGISTRY_REQUIRED_FIELDS.some((k) => e[k] === undefined || e[k] === null || e[k] === '')) return true
      if (String(e.reason).length < 20) return true
      if (String(e.exitStage).length < 5) return true
      return false
    }).map((e) => `${e.from}:${e.line}`)
    expect(incomplete, `登记项必须写全 ${REGISTRY_REQUIRED_FIELDS.join('/')}（理由 ≥20 字）`).toEqual([])
  })

  it('反空洞真：判定面里**确实**有边被扫到（否则"未登记即红"是空转）', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    expect(counted.lines, '判定核必须真实命中边 —— 否则上一条的 0 违规只是"没扫到"').toBeGreaterThan(0)
    expect(counted.files).toBeGreaterThan(1)
  })

  it('**负对照 A**：往 `composition/` 注入一条未登记的新边 ⇒ 判红', () => {
    // 走**生产**扫描器（`extractImports`）+ **生产**判定核（`unregisteredCompositionLegacyEdges`），
    // 不是手造 fact 对象（手造会绕过 AST 通路 = "宿主复刻被测算法"）。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-comp-neg-'))
    try {
      const srcRoot = path.join(dir, 'src')
      const comp = path.join(srcRoot, 'composition')
      fs.mkdirSync(comp, { recursive: true })
      const probe = path.join(comp, 'probeAssembly.ts')
      fs.writeFileSync(probe, "import { slotsOf } from '@/context/grid'\n", 'utf8')
      const facts = extractImports(probe, dir)
      const kernelFiles = readKernelFiles()
      const violations = unregisteredCompositionLegacyEdges(facts, APPROVED_COMPOSITION_LEGACY_EDGES, { srcRoot, kernelFiles })
      expect(violations, '未登记的新边必须判红（注入 `@/context/grid`）').toHaveLength(1)
      // 正对照：同一条边**登记后**判绿（证明判红来自登记表，而不是别的什么）
      const registry = [...APPROVED_COMPOSITION_LEGACY_EDGES, makeEdge('src/composition/probeAssembly.ts', 1, 'context/grid')]
      expect(
        unregisteredCompositionLegacyEdges(facts, registry, { srcRoot, kernelFiles }),
        '登记之后必须判绿（否则负对照证明不了登记表在起作用）',
      ).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('**负对照 B**：删掉一条登记 ⇒ 判红', async () => {
    const facts = await loadFacts()
    // 删掉 `kernelAssembly.ts:82`（`@/context/multiblock`）这条登记，其余不动。
    const baselineViolations = unregisteredCompositionLegacyEdges(facts, APPROVED_COMPOSITION_LEGACY_EDGES)
    const removed = APPROVED_COMPOSITION_LEGACY_EDGES.filter(
      (e) => !(e.from === 'src/composition/kernelAssembly.ts' && e.line === 82),
    )
    expect(removed.length, '负对照必须真的删掉了一条').toBe(APPROVED_COMPOSITION_LEGACY_EDGES.length - 1)
    const violations = unregisteredCompositionLegacyEdges(facts, removed)
    // 判据：删一条登记，未登记集合必须在**原集合**上恰好多出**那一条**
    // （这样写法在工作树另有他人在途改动时依然精确 —— 多余项不被吞掉，也不会把
    //  别人的未登记边误算成本次删除的效果）。
    expect(
      violations.length,
      `删掉一条登记后未登记集合必须恰好 +1（原 ${baselineViolations.length} ⇒ 期望 ${baselineViolations.length + 1}）`,
    ).toBe(baselineViolations.length + 1)
    const added = violations.filter((v) => !baselineViolations.includes(v))
    expect(added, '新增的那一条必须正是被删登记对应的真实边').toHaveLength(1)
    expect(added[0]).toContain('kernelAssembly.ts:82')
    // 同时基线断言也必须红（登记数减少 = 未同批核销）
    const counted = countCompositionLegacyEdges(facts)
    expect(counted.lines).not.toBe(removed.length)
  })

  it('**负对照 C**：注入一条**目标在新层**的边不判红（闸门不得把新层也算旧）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-comp-neg3-'))
    try {
      const srcRoot = path.join(dir, 'src')
      const comp = path.join(srcRoot, 'composition')
      fs.mkdirSync(comp, { recursive: true })
      const probe = path.join(comp, 'probeNewLayer.ts')
      fs.writeFileSync(probe, "import { evaluateScene } from '@/application/evaluation'\n", 'utf8')
      const facts = extractImports(probe, dir)
      expect(
        unregisteredCompositionLegacyEdges(facts, [], { srcRoot, kernelFiles: readKernelFiles() }),
        '指向内核文件（`KERNEL_FILES` 内）的边不是"绑旧层"',
      ).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
