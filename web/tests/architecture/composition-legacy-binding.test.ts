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
 * ## 基线冻结 + 具名豁免清单（Lead 裁决 #385，2026-10-14）
 *
 * 评审当刻本树实测 **12 文件 / 32 行**（比冻结基线多 1 文件 / 4 行）—— 多出来的四条来自
 * **在途的 R1-A C9**（`composition/kernelOutlinePlanPort.ts`）。裁决的处置是：
 *
 * - 基线**冻结在 11/28**（上一批真值，`BASELINE_COMMIT = '9630a39d'`），**不抬到 12/32**
 *   —— 否则"边登记边做大"就成了合法的反模式（登记表变成增长的许可证）；
 * - 这 4 条进**具名豁免许可集** `FROZEN_PERMITTED_EXEMPT_GROUPS`（按 `(file, target)` 分组 +
 *   组内条数上限 + 总量 4），其形态有四条硬约束：
 *   ① 未登记边仍 ⇒ 红；② 豁免**只允许**这 4 条（新去向 / 超组上限 / 超总量 ⇒ 红）；
 *   ③ 豁免条数作为**可读读数**导出（`exemptionReading(facts)`，测试打进日志，
 *   趋势机器可见）；④ 清单**终态必须为空** —— R1-A 子件②把这 4 条注入化后必须删空本表，
 *   届时基线回到 **≤11/28**（本文件的"豁免不得腐烂"断言强制这一收口）。
 *
 * 该形态与本仓 `boundary-scan.test.ts` 的 `EXTRA_BATCHES` / `RETIREMENT_OWNERS`
 * 同族：**暂准 + 具名 + 有终态**，而不是"把新绑定直接写进基线"。
 *
 * ## 与任务书给定数字的差异（实测口径；铁律 #7「以判据本尊的扫描口径实测」）
 *
 * 任务书写"8 个生产文件 / 13 行"；Lead 已在 #387 更正为**窄口径 + 漏 type-only 的粗估，作废**。
 * 本判据的实测三列基线（口径 = 闸门自身的 `OLD_LAYERS`，`runtime/*` 撞名层计入）：
 *
 * | 提交 | 实测（本判据口径） | 说明 |
 * |---|---|---|
 * | `fb0814d4`（真实基线） | **9 文件 / 23 行** | 不含 C8/C9 的新增接线 |
 * | `9630a39d`（**冻结基线**） | **11 文件 / 28 行** | 含 C8 的 `kernelPickAdapter`/`viewportPick` |
 * | 本批（评审时点，含在途 C9） | **12 文件 / 32 行** = 冻结基线 + 豁免 4 条 | 豁免清单的读数 |
 *
 * **口径差异的来源**：目标落在**撞名层 `runtime/`** 的边（`runtime/gridRead`、`runtime/context`、
 * `runtime/annotationRead`、`runtime/presentationAdapter`）同样计入 —— 这些目标既不在
 * `KERNEL_FILES`，也不在新层，按内核隔离闸门的口径**就是**旧层；另有两条
 * `import('x').T` **类型位置**事实（`kernelProjection.ts:562,569`）与 `:78` 一处。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractImports } from './module-graph.mjs'
import {
  APPROVED_COMPOSITION_LEGACY_EDGES,
  BASELINE_COMMIT,
  BASELINE_FILES,
  BASELINE_LINES,
  COMPOSITION_SCOPE,
  EXEMPTION_LEDGER_AT_C9_LANDING,
  FROZEN_PERMITTED_EXEMPT_GROUPS,
  FROZEN_PERMITTED_EXEMPT_TOTAL,
  REGISTRY_REQUIRED_FIELDS,
  SRC_ROOT,
  approvedWithExemptions,
  countCompositionLegacyEdges,
  derivePendingExemptions,
  exemptionCeilingViolations,
  exemptionReading,
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

  it('未登记即红：`composition/` 生产文件指向旧层的每一条边都必须登记，或落在具名豁免许可集内', async () => {
    const facts = await loadFacts()
    // 判据：实测边必须 ⊆ (冻结基线登记 ∪ 实测导出的豁免)。
    // 因为豁免是实测导出的，本断言等价于"超出许可集的绑定不存在" ——
    // 超许可的实际判红由下面的刚性 ② 用例承担（这里先保证集合自洽）。
    const violations = unregisteredCompositionLegacyEdges(facts, approvedWithExemptions(facts))
    expect(
      violations,
      `composition/ 生产文件绑定了旧层但既未登记、也不在具名豁免许可集内:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('登记不得腐烂：冻结基线的每一条登记都真实存在（文件 + 行 + 目标全对）', async () => {
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

  it('登记数不得增：冻结基线 11/28 **不得抬高**，超出部分必须落在豁免许可集内', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    const exemptions = derivePendingExemptions(facts)
    // ① 基线与登记表**冻结**在 9630a39d 的真值（不得随在途批次抬高）
    expect(BASELINE_COMMIT, '基线必须锚定在真值提交上').toBe('9630a39d')
    expect(
      { files: BASELINE_FILES, lines: BASELINE_LINES },
      '冻结基线必须是 9630a39d 的 11/28 —— 不得抬到 12/32（#385 裁决：登记表不是增长的许可证）',
    ).toEqual({ files: 11, lines: 28 })
    expect(APPROVED_COMPOSITION_LEGACY_EDGES.length, '冻结登记表长度必须等于基线行数 28').toBe(BASELINE_LINES)
    // ② 实测 = 基线 + 豁免；豁免是**唯一的**合法增量通道，且它自己有条数上限
    expect(
      { files: counted.files, lines: counted.lines },
      `实测必须恰好等于 基线{${BASELINE_FILES},${BASELINE_LINES}} + 实测豁免${exemptions.length} 条`
        + `（新增绑定必须先改基线并写明理由 —— "可见性与可判定性"不等于"允许增长"，#387 评论 7293）`
        + `。实测:${JSON.stringify({ files: counted.files, lines: counted.lines })}`,
    ).toEqual({ files: counted.files, lines: BASELINE_LINES + exemptions.length })
    expect(exemptions.length, '豁免条数必须 ≤ 许可上限 4').toBeLessThanOrEqual(FROZEN_PERMITTED_EXEMPT_TOTAL)
    // 只要存在豁免，就必然多出恰好 1 个文件（C9 的 kernelOutlinePlanPort.ts）
    expect(counted.files).toBe(exemptions.length > 0 ? BASELINE_FILES + 1 : BASELINE_FILES)
  })

  it('豁免刚性 ②：豁免必须落在**冻结许可集**内、条数不超上限（多一条即红）', async () => {
    const facts = await loadFacts()
    const exemptions = derivePendingExemptions(facts)
    // ② 许可上限 = C9 落地时实测的 4 条绑定（按 (file,target) 分组计数，
    //    行号漂移不改判 —— 闸门判的是"绑定的数量与去向不得新增"，不是"位置不得移动"）。
    expect(FROZEN_PERMITTED_EXEMPT_TOTAL, '许可上限总量冻结在 C9 落地时的 4 条').toBe(4)
    expect(
      FROZEN_PERMITTED_EXEMPT_GROUPS.map((g) => `${g.file.replace('src/composition/', '')}→${g.target}`),
      '许可组必须是 C9 的那三条去向',
    ).toEqual([
      'kernelOutlinePlanPort.ts→runtime/context',
      'kernelOutlinePlanPort.ts→runtime/gridRead',
      'kernelOutlinePlanPort.ts→pure/partMask',
    ])
    // 机械检测核：超许可集 / 超组上限 / 超总量 ⇒ 非空 ⇒ 判红
    const ceilingViolations = exemptionCeilingViolations(exemptions)
    expect(
      ceilingViolations,
      `豁免超出冻结许可集 ⇒ 判红（"只允许这 4 条"）:\n${ceilingViolations.join('\n')}`,
    ).toEqual([])
    // ④ 终态声明：每条豁免都带 terminalBatch（豁免消失时条目自动消失，不存在空壳）
    const missingTerminal = exemptions.filter((e) => typeof e.terminalBatch !== 'string' || e.terminalBatch.length === 0)
    expect(missingTerminal.map((e) => `${e.from}:${e.line}`), '每条豁免必须带终态批次声明').toEqual([])
  })

  it('豁免条数是**可读读数** ③：导出并被打印（趋势机器可见；终态为空 ⇒ 0）', async () => {
    const facts = await loadFacts()
    const reading = exemptionReading(facts)
    expect(reading.exemptionCount, '③ 豁免条数必须作为读数导出（实测）').toBe(derivePendingExemptions(facts).length)
    expect(reading.terminal, '④ 终态必须声明为 empty（空的）').toBe('empty')
    expect(reading.permittedCeiling, '③ 读数必须同时给出许可上限（显示收缩进度）').toBe(4)
    expect(reading.baseline, '读数必须带基线三元组（供每批合流登记趋势）').toEqual({
      files: 11,
      lines: 28,
      commit: '9630a39d',
    })
    expect(EXEMPTION_LEDGER_AT_C9_LANDING, 'C9 落地时的读数快照必须留档（4 条）').toHaveLength(4)
    // eslint-disable-next-line no-console
    console.log(`[G1 读数] 豁免条数=${reading.exemptionCount}/${reading.permittedCeiling}（终态=${reading.terminal}），基线=${reading.baseline.files}/${reading.baseline.lines}@${reading.baseline.commit}，终端批次=${reading.terminalBatch}，当前豁免=${JSON.stringify(reading.ids)}`)
    expect(typeof reading.exemptionCount).toBe('number')
  })

  it('**豁免终态为空** ④：豁免随注入化自动收缩（绑定消失 ⇒ 条目消失），不得留空壳', async () => {
    const facts = await loadFacts()
    const exemptions = derivePendingExemptions(facts)
    // ④ 的机械半边：豁免是**实测导出**，故"绑定消失但条目还在"这种空壳在构造上不可能出现。
    // 本用例把这条性质**断言**出来：每一条豁免都必须对应一条当前真实存在的边。
    const counted = countCompositionLegacyEdges(facts)
    const present = new Set(counted.rows.map((r) => `${r.file}:${r.line}:${r.target}`))
    const stale = exemptions.filter((e) => !present.has(`${e.from}:${e.line}:${e.to}`)).map(
      (e) => `${e.from}:${e.line} → ${e.to}`,
    )
    expect(stale, '豁免必须是实测导出（不存在已消失的空壳条目）').toEqual([])
    // 终态判据：当 R1-A 子件②把这 4 条全部注入化后，豁免长度归 0、相对读数回到基线 11/28。
    // 这里给出终态的**可判定形式**：豁免为 0 时，实测必须恰等于冻结基线。
    if (exemptions.length === 0) {
      expect(countCompositionLegacyEdges(facts).lines, '终态：豁免为空 ⇒ 实测回到冻结基线 28').toBe(BASELINE_LINES)
    }
  })

  it('**校准自检**：基线读数与判据实测读数逐条一致（对称差为空，且两个数都由判定核数出）', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    const exemptions = derivePendingExemptions(facts)
    const observed = new Set(counted.rows.map((r) => `${r.file}:${r.line}:${r.target}`))
    const declared = new Set([
      ...APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => `${e.from}:${e.line}:${e.to}`),
      ...exemptions.map((e) => `${e.from}:${e.line}:${e.to}`),
    ])
    const onlyDeclared = [...declared].filter((k) => !observed.has(k)).sort()
    const onlyObserved = [...observed].filter((k) => !declared.has(k)).sort()
    expect({ onlyDeclared, onlyObserved }, '冻结登记 + 实测豁免 与实测边的对称差必须为空').toEqual({
      onlyDeclared: [],
      onlyObserved: [],
    })
    // 读数一致性：基线 28 + 实测豁免数 == 判定核数出的行数（不是手写常量对齐手写常量）
    expect({ lines: BASELINE_LINES + exemptions.length }).toEqual({ lines: counted.lines })
    // 且冻结基线自身必须是 28 条（读数与常量一致）
    expect(APPROVED_COMPOSITION_LEGACY_EDGES.length).toBe(BASELINE_LINES)
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

  it('登记字段完备性：冻结基线的每条登记都写明 文件/行/目标/类别/理由/退出归属/负责人', () => {
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
    const exemptions = derivePendingExemptions(facts)
    expect(counted.lines, '判定核必须真实命中边 —— 否则上一条的 0 违规只是"没扫到"').toBeGreaterThan(0)
    expect(counted.files).toBeGreaterThan(1)
    // 实测必须 = 冻结基线 + 实测豁免（豁免是实测导出，故这条是"读数自洽"而非"恒真"：
    // 若实测数**小于**基线，说明基线的 28 条里已有条目消失 ⇒ 登记腐烂，下面的断言会红）
    expect(counted.lines, '实测必须 = 基线 28 + 实测豁免').toBe(BASELINE_LINES + exemptions.length)
  })

  it('**负对照 A**：往 `composition/` 注入一条未登记的新边 ⇒ 判红', async () => {
    // 走**生产**扫描器（`extractImports`）+ **生产**判定核（`unregisteredCompositionLegacyEdges`），
    // 不是手造 fact object（手造会绕过 AST 通路 = "宿主复刻被测算法"）。
    const facts = await loadFacts()
    const approved = approvedWithExemptions(facts)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-comp-neg-'))
    try {
      const srcRoot = path.join(dir, 'src')
      const comp = path.join(srcRoot, 'composition')
      fs.mkdirSync(comp, { recursive: true })
      const probe = path.join(comp, 'probeAssembly.ts')
      fs.writeFileSync(probe, "import { slotsOf } from '@/context/grid'\n", 'utf8')
      const probeFacts = extractImports(probe, dir)
      const kernelFiles = readKernelFiles()
      const violations = unregisteredCompositionLegacyEdges(probeFacts, approved, { srcRoot, kernelFiles })
      expect(violations, '未登记的新边必须判红（注入 `@/context/grid`）').toHaveLength(1)
      // 正对照：同一条边**登记后**判绿（证明判红来自登记表，而不是别的什么）
      const registry = [...approved, makeEdge('src/composition/probeAssembly.ts', 1, 'context/grid')]
      expect(
        unregisteredCompositionLegacyEdges(probeFacts, registry, { srcRoot, kernelFiles }),
        '登记之后必须判绿（否则负对照证明不了登记表在起作用）',
      ).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('**负对照 A′（豁免刚性 ②/③/④）**：塞进许可集外的新豁免 ⇒ 判红；同组超上限 ⇒ 判红；许可上限恒 4', async () => {
    const facts = await loadFacts()
    const exemptions = derivePendingExemptions(facts)
    const mk = (line, to, from = 'src/composition/kernelAssembly.ts') => ({
      from,
      line,
      to,
      kind: 'import',
      reason: 'x'.repeat(30),
      exitStage: 'P11',
      owner: 'G1',
      terminalBatch: 'P11',
    })
    // ② 塞一条**许可集外**的（新文件 + 新去向）豁免 ⇒ 检测核非空 ⇒ 红
    const tampered = [...exemptions, mk(76, 'context/runtimeDocument')]
    const violations = exemptionCeilingViolations(tampered)
    expect(violations, '往豁免清单塞许可集外的新绑定必须被判红').not.toEqual([])
    expect(violations.some((v) => v.includes('kernelAssembly.ts')), '判红必须点名那条越界绑定').toBe(true)
    // 正面：在同一许可组里**超上限**也要红（gridRead 许可 2 条，塞到 3 条即越界）
    const overGroup = [900, 901, 902].map((n) => mk(n, 'runtime/gridRead', 'src/composition/kernelOutlinePlanPort.ts'))
    expect(exemptionCeilingViolations(overGroup), '同组条数超上限即红').not.toEqual([])
    // ③ 许可上限恒 4（读数不得被人为抬高以容纳新豁免）
    expect(FROZEN_PERMITTED_EXEMPT_TOTAL, '许可上限恒为 4').toBe(4)
    // ④ 已消失的豁免必然不在实测导出里（空壳在构造上不可能出现）
    expect(
      exemptions.filter((e) => e.line === 9999),
      '实测导出不得包含任何已消失的空壳条目',
    ).toEqual([])
    // 正对照：当前实测导出必须通过许可集检测（证明检测本身不是在恒红）
    expect(exemptionCeilingViolations(exemptions), '当前豁免必须通过许可集检测').toEqual([])
  })

  it('**负对照 B**：删掉一条登记 ⇒ 判红', async () => {
    const facts = await loadFacts()
    // 删掉 `kernelAssembly.ts:82`（`@/context/multiblock`）这条登记，其余不动。
    const approved = approvedWithExemptions(facts)
    const baselineViolations = unregisteredCompositionLegacyEdges(facts, approved)
    const removed = approved.filter((e) => !(e.from === 'src/composition/kernelAssembly.ts' && e.line === 82))
    expect(removed.length, '负对照必须真的删掉了一条').toBe(approved.length - 1)
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
    expect(removed.length).not.toBe(BASELINE_LINES)
    expect(APPROVED_COMPOSITION_LEGACY_EDGES.length - 1).not.toBe(BASELINE_LINES)
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
