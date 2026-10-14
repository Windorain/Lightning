/**
 * **G1 判据① · `composition/` 生产文件绑定旧层的边**（#385 G1 工作包；形态抄
 * `kernel-legacy-isolation.test.ts#APPROVED_LEGACY_TO_KERNEL_EDGES`）。
 *
 * 登记表与判定核在 `./composition-legacy-binding.mjs`（数据/逻辑与测试分开，是为了让
 * **负对照与生产判据共用同一实现** —— 测试里另写一份判定逻辑的形态，负对照绿了也证明不了
 * 生产判据会判红）。本文件是它的可执行半边。
 *
 * ---
 *
 * # 口径改定：`(file, target)` **对键**（2026-10-14；判据缺陷，不是业务缺陷）
 *
 * ## 事故（本判据原先是"行键"口径）
 *
 * 本判据原先把边冻结成 `file:line:target` **三元组**。上游提交 `44030389`
 * （"R2-1a 第4件(接线)：多方块声明进内容权威"）在
 * `web/src/composition/kernelAssembly.ts` 插入了一行 import（`:85` 的
 * `@/adapters/multiblockDeclaration`）连同注释，使**既有的** `@/context/runtimeDocument`
 * import 从 `:87` 漂到 `:90`。行键口径下：
 *
 *  - 同一条边被算成"登记之外的新绑定"（升成第三条例外）；
 *  - 原登记 `:87` 被判"腐烂"；
 *  - `test:arch` **8 failed / 7 passed**（8 条红全部连锁自这一处行漂移）。
 *
 * 判"这是判据缺陷"的依据：**被替代的边集合与目标集合都没变** —— 没有新增或消失任何一条
 * `composition/ → 旧层` 的绑定，变的只是无关编辑造成的行号漂移。**行号不是语义**。
 *
 * **第二例（同一缺陷类，独立复现）**：本树 `08cd99fc`（"G4+G5 S2 第二半(1/2)"）在
 * `web/src/composition/kernelPresentationInputs.ts:61` 插入一行（`@/adapters/tooltipPool`），
 * 使已登记的 `@/runtime/presentationAdapter` 边从 `:61` 漂到 `:62` ⇒ 行键口径下该登记又被判
 * "腐烂"（见"注解漂移不进判定"用例里的活体读数），对键口径下**不可见**（该对登记 1 条、实测 1 条）。
 * 两个不同提交、同一根因（行锚）⇒ 佐证这是**判据缺陷**而非某次编辑的偶然。
 *
 * ## 同族先例（本仓已有，不是本判据的临时发明）
 *
 * `web/src/pure/__tests__/partMaskEnvelopeExemption.test.ts` 明文要求豁免"以**同一标记**匹配
 * （**不绑行号**）"：用例名 `脚本侧的豁免登记唯一，并以同一标记匹配（不绑行号）`，
 * 并有 `expect(block, '豁免登记不得绑行号').not.toMatch(/\bline:\s*\d/)`。
 * 那次（#39 阶段二 `PartBoxMaskEnvelope`）与本条同因：**行锚在无关编辑下产生假红** ⇒ 去行锚。
 *
 * ## 改了什么（只动键，不动强度）
 *
 * 1. **键**：`file:line:target` → `(file, target)`；行号降级为**失败消息里的定位注解**
 *    （人类定位用），**不参与任何断言**；
 * 2. **重数保留**：同一 `(file,target)` 的多条边仍按**出现次数**计（不折叠成集合）——
 *    这是**最小的键成分删除**：去掉的是非语义的行号，保留的是"绑了几条"这个语义分量。
 *    故 `kernelProjection.ts → context/runtimeDocument` 的重数 3 不得掉到 2；
 * 3. **三条检测一条都没弱化**（下节），且都由 `assessCompositionLegacyBinding` 这一份实现把守。
 *
 * ## 一次性等价证明（读数：**28 行 → 21 对**；两个读数都在下面的用例里对账）
 *
 * 把旧口径的**行键读数**按 `(file,target)` 归一后，与新对集**完全相等**
 * （`pairMultisetOfLineKeys` 与 `countCompositionLegacyEdges` 是两条**互相独立**的分组路径）：
 *
 * | 读数 | 旧口径（行键） | 新口径（对键 + 重数） |
 * |---|---|---|
 * | 冻结基线（`9630a39d`） | **28 行**（28 个不同行键） | **21 对 / 28 次出现**（6 对重数 2~3） |
 * | 实测（`44030389`） | **30 行** / 30 个不同行键 / 12 文件 | **23 对 / 30 次出现** / 12 文件 |
 * | `onlyDeclared`（登记腐烂） | **1** 条（`:87`） | **0** 对 |
 * | `onlyObserved`（登记外绑定） | **3** 条（`:90` 假组件 + 2 条合法豁免） | **2** 对（恰为 2 条合法豁免） |
 * | 重数差 | — | **0** |
 *
 * 旧口径的两条假读数（`:87` / `:90`）**归一到同一个对**（该对在基线里本来就有另一条登记 `:76`），
 * 归一后**互相湮灭** ⇒ 红绿差只剩 2 条**真**新绑定（`kernelOutlinePlanPort.ts`，本就在具名豁免里）。
 * **这不是放宽口径**：分量一个没少 —— 重数仍逐条对账（实测 30 次 = 基线 28 次 + 豁免 2 次）。
 *
 * ## 三条判据形态（都不许弱化；负对照逐条证伪）
 *
 * | # | 检测 | 判红条件 | 负对照 |
 * |---|---|---|---|
 * | ① | **未登记即红** | 出现不在冻结集里的**新对**；或既有对**重数溢出**（往同去向上加绑定） | 负对照 A（注入 `@/context/grid` 新对）；负对照 B（把实测存在的对从冻结集移除） |
 * | ② | **登记不得腐烂** | 冻结集里的对**实测消失**；或实测重数少于登记重数 | 负对照 D（往冻结集塞一个不存在的假对） |
 * | ③ | **计数不得增** | 对数 > 冻结上限（21 + 许可 2 = 23）；或重数 > 上限（28 + 2 = 30） | 负对照 E（上限压低 1） |
 *
 * ⚠️ **登记是"可见性与可判定性"，不是允许增长**（#387 评论 7293）。
 * 本判据**严禁直接判零**：装配根把真实文件装配成内核文档、把内核投影回旧形状，
 * 是设计必需的编解码面，判零会立刻假红（实测 30 行 / 23 对）。
 *
 * ## 基线冻结 + 具名豁免清单（Lead 裁决 #385，2026-10-14）
 *
 * 评审当刻本树实测 **12 文件 / 23 对（30 次）**—— 多出来的两条来自**在途的 R1-A C9**
 * （`composition/kernelOutlinePlanPort.ts`）。裁决的处置是：
 *
 * - 基线**冻结在 11 文件 / 21 对 / 28 次**（上一批真值，`BASELINE_COMMIT = '9630a39d'`），
 *   **不抬到**评审当刻的最大值 —— 否则"边登记边做大"就成了合法的反模式
 *   （登记表变成增长的许可证）；
 * - 这 2 条进**具名豁免许可集** `FROZEN_PERMITTED_EXEMPT_GROUPS`（按 `(file, target)` 分组 +
 *   组内**重数**上限 + 总量 2），其形态有四条硬约束：
 *   ① 未登记对仍 ⇒ 红；② 豁免**只允许**这 2 条（新去向 / 超组上限 / 超总量 ⇒ 红）；
 *   ③ 豁免条数作为**可读读数**导出（`exemptionReading(facts)`，测试打进日志，
 *   趋势机器可见）；④ 清单**终态必须为空** —— R1-A 子件②把这 2 条注入化后必须删空本表。
 *
 * 该形态与本仓 `boundary-scan.test.ts` 的 `EXTRA_BATCHES` / `RETIREMENT_OWNERS`
 * 同族：**暂准 + 具名 + 有终态**，而不是"把新绑定直接写进基线"。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractImports } from './module-graph.mjs'
import {
  APPROVED_COMPOSITION_LEGACY_EDGES,
  BASELINE_COMMIT,
  BASELINE_EDGE_OCCURRENCES,
  BASELINE_FILES,
  BASELINE_PAIRS,
  BASELINE_PAIR_COUNT,
  BASELINE_PAIR_OCCURRENCES,
  COMPOSITION_SCOPE,
  EXEMPTION_LEDGER_AT_C9_LANDING,
  EXEMPTION_LEDGER_AT_C9_LANDING_PAIRS,
  FROZEN_PERMITTED_EXEMPT_GROUPS,
  FROZEN_PERMITTED_EXEMPT_TOTAL,
  LINE_KEY_FALSE_READING_AT_44030389,
  PAIR_NORMALIZATION,
  PERMITTED_EXEMPT_OCCURRENCES,
  PERMITTED_EXEMPT_PAIRS,
  REGISTRY_REQUIRED_FIELDS,
  REGISTRY_REPORT_ONLY_FIELDS,
  REGISTRY_SEMANTIC_KEY_FIELDS,
  SRC_ROOT,
  approvedWithExemptions,
  assessCompositionLegacyBinding,
  bindingCountViolations,
  countCompositionLegacyEdges,
  derivePendingExemptions,
  exemptionCeilingViolations,
  exemptionExitStatus,
  exemptionReading,
  exemptionRegistryEntries,
  isOldLayerTarget,
  isProductionRel,
  multisetEntries,
  pairKeyOf,
  pairMultisetOf,
  pairMultisetOfLineKeys,
  readKernelFiles,
  resolveTargetOf,
  rottenRegisteredPairs,
  unregisteredCompositionLegacyEdges,
} from './composition-legacy-binding.mjs'

const makeEdge = (from, line, to) =>
  Object.freeze({ from, line, to, kind: 'import', reason: 'x'.repeat(30), exitStage: 'P11', owner: 'G1' })

const sumOf = (m) => [...m.values()].reduce((a, b) => a + b, 0)
/** Map → 排序条目（断言里对账用；避免 Map 引用相等造成恒真/恒假）。 */
const entriesOf = (m) => multisetEntries(m instanceof Map ? m : new Map(Object.entries(m)))
/** 只取判据键面（对/重数/原因），剥掉含行号的报告文本 —— 用于"行号非键"对账。 */
const keyFace = (rt) => rt.map((r) => ({ pair: r.pair, declared: r.declared, observed: r.observed, reason: r.reason }))

describe('G1 ①：`composition/` 生产文件绑定旧层的**对** `(file, target)` —— 逐对登记，未登记即红，登记数不得增', () => {
  /** 判据执行面：AST 扫全部生产模块图（与生产扫描器同源）。 */
  // 全树扫描对本配置约 4s：模块内 memo 一次，避免每个用例各扫一遍
  // （判据强度不变 —— 同一次运行内的树是同一份，memo 不影响任何断言）。
  let factsPromise = null
  function loadFacts() {
    if (factsPromise === null) factsPromise = import('./module-graph.mjs').then((m) => m.buildModuleGraph().facts)
    return factsPromise
  }

  it('未登记即红 ①：`composition/` 生产文件指向旧层的每一个**对**都必须登记，或落在具名豁免许可集内', async () => {
    const facts = await loadFacts()
    // 判据：实测的对多重集必须 ⊆ (冻结基线登记 ∪ 实测导出的豁免)。
    // 因为豁免是实测导出的，本断言等价于"超出许可集的绑定不存在" ——
    // 超许可的实际判红由下面的刚性 ② 用例承担（这里先保证集合自洽）。
    const violations = unregisteredCompositionLegacyEdges(facts, approvedWithExemptions(facts))
    expect(
      violations,
      `composition/ 生产文件绑定了旧层但既未登记、也不在具名豁免许可集内:\n${violations.join('\n')}`,
    ).toEqual([])
    // 生产判定核（三检测合一）同样必须判绿 —— 判据只有一份实现。
    expect(assessCompositionLegacyBinding(facts).violations, '生产判定核必须判绿').toEqual([])
  })

  it('登记不得腐烂 ②：冻结基线的每一个**对**都真实存在，且实测重数不得少于登记重数', async () => {
    const facts = await loadFacts()
    const rotted = rottenRegisteredPairs(facts)
    expect(
      rotted.map((r) => r.message),
      `登记的**对**已不存在或重数不足（请同批核销 —— 建筑在腐烂登记上的闸门等于没有闸门）:\n${rotted.map((r) => r.message).join('\n')}`,
    ).toEqual([])
    // 行号漂移（旧口径的假红来源）不得进入腐烂判定：只看对 + 重数。
    expect(keyFace(rotted)).toEqual([])
  })

  it('登记数不得增 ③：冻结读数 **11 文件 / 21 对 / 28 次** 不得抬高，超出部分必须落在豁免许可集内', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    const exemptions = derivePendingExemptions(facts)
    // ① 基线与登记表**冻结**在 9630a39d 的真值（不得随在途批次抬高）
    expect(BASELINE_COMMIT, '基线必须锚定在真值提交上').toBe('9630a39d')
    expect(
      { files: BASELINE_FILES, pairs: BASELINE_PAIR_COUNT, occurrences: BASELINE_EDGE_OCCURRENCES },
      '冻结基线必须是 9630a39d 的 11/21/28（= 旧行键口径的 11/28）—— 不得抬高（#385 裁决：登记表不是增长的许可证）',
    ).toEqual({ files: 11, pairs: 21, occurrences: 28 })
    expect(APPROVED_COMPOSITION_LEGACY_EDGES.length, '冻结登记表长度必须等于基线边重数 28').toBe(
      BASELINE_EDGE_OCCURRENCES,
    )
    expect(BASELINE_PAIRS.length, '冻结基线对集必须是 21 对').toBe(BASELINE_PAIR_COUNT)
    expect(
      sumOf(new Map(Object.entries(BASELINE_PAIR_OCCURRENCES))),
      '冻结基线对重数合计必须等于边重数 28',
    ).toBe(BASELINE_EDGE_OCCURRENCES)
    // ② 实测 = 基线 + 豁免；豁免是**唯一的**合法增量通道，且它自己有条数上限
    expect(
      { files: counted.files, pairs: counted.pairs, occurrences: counted.occurrences },
      `实测必须恰好等于 基线{${BASELINE_FILES}文件,${BASELINE_PAIR_COUNT}对,${BASELINE_EDGE_OCCURRENCES}次}`
        + ` + 实测豁免${exemptions.length} 对（新增绑定必须先改基线并写明理由 —— `
        + '"可见性与可判定性"不等于"允许增长"，#387 评论 7293）'
        + `。实测:${JSON.stringify({ files: counted.files, pairs: counted.pairs, occurrences: counted.occurrences })}`,
    ).toEqual({
      files: BASELINE_FILES + new Set(exemptions.map((e) => e.from)).size,
      pairs: BASELINE_PAIR_COUNT + exemptions.length,
      occurrences: BASELINE_EDGE_OCCURRENCES + exemptions.reduce((n, e) => n + e.occurrences, 0),
    })
    expect(exemptions.length, '豁免**对**数必须 ≤ 许可上限 2').toBeLessThanOrEqual(FROZEN_PERMITTED_EXEMPT_TOTAL)
    // ③ 计数上限检测（生产上限）必须判绿
    expect(bindingCountViolations(counted), '生产计数上限下必须判绿').toEqual([])
    expect(BASELINE_PAIR_COUNT + PERMITTED_EXEMPT_PAIRS, '生产对上限 = 21 + 2').toBe(23)
    expect(BASELINE_EDGE_OCCURRENCES + PERMITTED_EXEMPT_OCCURRENCES, '生产重数上限 = 28 + 2').toBe(30)
  })

  it('**等价证明**：旧「行键读数」按 (file,target) 归一后与新对集**逐对逐重数相等**（28 行 → 21 对）', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)

    // ── 冻结基线：28 行键 → 21 对 / 28 次（两条独立分组路径的读数必须一致） ──
    const baselineLineKeys = APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => `${e.from}:${e.line}:${e.to}`)
    expect(baselineLineKeys, '冻结基线的行键读数必须是 28 行').toHaveLength(28)
    expect(new Set(baselineLineKeys).size, '28 行 = 28 个不同行键（无重复）').toBe(28)
    const normalizedBaseline = pairMultisetOfLineKeys(baselineLineKeys)
    expect(
      entriesOf(normalizedBaseline),
      '冻结基线：把 28 个行键按 (file,target) 归一，必须与冻结对多重集**逐对逐重数相等**',
    ).toEqual(entriesOf(BASELINE_PAIR_OCCURRENCES))
    expect(normalizedBaseline.size, '冻结基线 28 行 → 21 对').toBe(21)
    expect(sumOf(normalizedBaseline), '归一后重数合计仍为 28（分量守恒 —— 去掉的是键成分，不是分量）').toBe(28)
    // "对集完全相等"的另一半：**键集**必须与冻结对键集逐条相同（不只是多重集碰巧相等）
    expect([...normalizedBaseline.keys()].sort(), '归一后的对键集必须等于冻结基线对键集').toEqual([...BASELINE_PAIRS].sort())

    // ── 实测：30 行 → 23 对 / 30 次 ──
    const observedLineKeys = counted.rows.map((r) => `${r.file}:${r.line}:${r.target}`)
    const normalizedObserved = pairMultisetOfLineKeys(observedLineKeys)
    expect(
      entriesOf(normalizedObserved),
      '实测：把 30 个行键归一，必须与判定核分组出的对多重集**逐对逐重数相等**',
    ).toEqual(entriesOf(counted.pairCounts))
    expect(
      { lines: observedLineKeys.length, lineKeys: new Set(observedLineKeys).size, pairs: normalizedObserved.size, occurrences: sumOf(normalizedObserved), files: counted.files },
      '实测读数（对键口径）必须与 PAIR_NORMALIZATION.after 逐项一致',
    ).toEqual({
      lines: PAIR_NORMALIZATION.before.measured_lines,
      lineKeys: PAIR_NORMALIZATION.before.measured_distinct_line_keys,
      pairs: PAIR_NORMALIZATION.after.measured_pairs,
      occurrences: PAIR_NORMALIZATION.after.measured_pair_occurrences,
      files: PAIR_NORMALIZATION.after.measured_files,
    })
    // 分量守恒：去掉行锚前后，**边的条数一个没少**
    expect(PAIR_NORMALIZATION.before.measured_lines, '改口径前 30 行').toBe(30)
    expect(PAIR_NORMALIZATION.after.measured_pair_occurrences, '改口径后 30 次出现（分量没少）').toBe(30)

    // ── 事故账：旧口径的两条假读数归一到**同一个对**，且该对在基线里本来就有登记 ──
    const phantomDeclared = pairMultisetOfLineKeys([LINE_KEY_FALSE_READING_AT_44030389.declared_line_key])
    const phantomObserved = pairMultisetOfLineKeys([LINE_KEY_FALSE_READING_AT_44030389.observed_line_key])
    expect([...phantomDeclared.keys()], '事故前的"腐烂"读数归一到').toEqual([LINE_KEY_FALSE_READING_AT_44030389.pair])
    expect([...phantomObserved.keys()], '事故后的"新绑定"读数归一到同一个对').toEqual([LINE_KEY_FALSE_READING_AT_44030389.pair])
    expect(LINE_KEY_FALSE_READING_AT_44030389.baseline_pair_occurrences, '该对在冻结基线里的重数（事故账）').toBe(2)
    // 判定核直接分组出来的重数必须与事故账一致 —— 说明该对在基线里本来就有 2 条登记，
    // 旧口径把其中一条（`:87`）判成"腐烂"纯属行漂移。
    expect(
      BASELINE_PAIR_OCCURRENCES[LINE_KEY_FALSE_READING_AT_44030389.pair],
      '冻结基线里该对的重数必须等于事故账的 2（归一后"腐烂"与"新绑定"是同一条边的两个行号）',
    ).toBe(LINE_KEY_FALSE_READING_AT_44030389.baseline_pair_occurrences)
    // ⇒ 归一后两条假读数互相湮灭：实测的登记外**对**只剩 2 条合法豁免，登记腐烂**对**为 0
    const declaredPairs = pairMultisetOf(BASELINE_PAIRS)
    const observedPairs = counted.pairCounts
    const onlyDeclared = [...declaredPairs.keys()].filter((k) => !observedPairs.has(k))
    const onlyObserved = [...observedPairs.keys()].filter((k) => !declaredPairs.has(k))
    expect(onlyDeclared, '归一后：登记腐烂的对 = 0（旧口径是 1 条行键）').toEqual([])
    expect(onlyObserved, '归一后：登记外的对 = 恰好那 2 条已具名豁免的对').toEqual(
      derivePendingExemptions(facts).map((e) => e.pair),
    )
    expect(onlyObserved, `那 2 对必须正是具名豁免（PAIR_NORMALIZATION.after.onlyObserved_pairs=${PAIR_NORMALIZATION.after.onlyObserved_pairs}）`).toHaveLength(
      PAIR_NORMALIZATION.after.onlyObserved_pairs,
    )

    // ── 第二处等价证明（历史账）：C9 落地时的豁免 4 行 → 3 对（gridRead 重数 2） ──
    const ledgerPairs = pairMultisetOfLineKeys(EXEMPTION_LEDGER_AT_C9_LANDING)
    expect(EXEMPTION_LEDGER_AT_C9_LANDING, 'C9 落地读数快照为 4 行').toHaveLength(4)
    expect(entriesOf(ledgerPairs), 'C9 读数：4 行归一到 3 对').toEqual(entriesOf(EXEMPTION_LEDGER_AT_C9_LANDING_PAIRS))
    expect(
      Object.fromEntries(entriesOf(ledgerPairs)),
      'C9 读数归一后：runtime/gridRead 重数 2，另两对各 1',
    ).toEqual({
      [pairKeyOf('src/composition/kernelOutlinePlanPort.ts', 'runtime/context')]: 1,
      [pairKeyOf('src/composition/kernelOutlinePlanPort.ts', 'runtime/gridRead')]: 2,
      [pairKeyOf('src/composition/kernelOutlinePlanPort.ts', 'pure/partMask')]: 1,
    })
  })

  it('**行号非键**：把登记表全部行号扰动（+1000 / 全置 1），三条检测的判定读数逐项不变', async () => {
    const facts = await loadFacts()
    // 判据键字段 vs 报告注解字段的法定切分（可机械复核）
    expect(REGISTRY_SEMANTIC_KEY_FIELDS, '判据键只有 (file, target)').toEqual(['from', 'to'])
    expect(REGISTRY_REPORT_ONLY_FIELDS, '行号是报告注解字段').toEqual(['line'])
    expect(REGISTRY_REQUIRED_FIELDS).toContain('line')

    // 用一个**会判红**的登记集做对照（否则"两边都是空"的相等是恒真、没有区分力）：
    // 往冻结集塞一个现实中不存在的假对 ⇒ ② 腐烂必须红。
    const fakePair = makeEdge('src/composition/kernelProjection.ts', 1, 'runtime/doesNotExist')
    const withFake = [...APPROVED_COMPOSITION_LEGACY_EDGES, fakePair]
    const asIs = assessCompositionLegacyBinding(facts, { registry: withFake })
    const shifted = assessCompositionLegacyBinding(facts, {
      registry: withFake.map((e) => ({ ...e, line: e.line + 1000 })),
    })
    const allOnes = assessCompositionLegacyBinding(facts, { registry: withFake.map((e) => ({ ...e, line: 1 })) })
    // 对照前提：这个登记集**确实是红的**（证明下面的"不变"不是恒绿）
    expect(asIs.rotted, '塞假对后必须判红（腐烂）').toHaveLength(1)
    expect(asIs.violations.length).toBeGreaterThan(0)
    // 行号扰动 ⇒ 判据键面的读数**逐项不变**（键/重数/原因全同）
    expect(keyFace(shifted.rotted), '行号 +1000 后腐烂读数逐项不变').toEqual(keyFace(asIs.rotted))
    expect(keyFace(allOnes.rotted), '行号全置 1 后腐烂读数逐项不变').toEqual(keyFace(asIs.rotted))
    expect(shifted.unregistered).toEqual(asIs.unregistered)
    expect(shifted.growth).toEqual(asIs.growth)
    expect(shifted.ceiling).toEqual(asIs.ceiling)
    expect(shifted.rotted.map((r) => r.pair), '被点名腐烂的仍是那个假对').toEqual([
      pairKeyOf('src/composition/kernelProjection.ts', 'runtime/doesNotExist'),
    ])
    // 而**行号仍然出现在失败消息里**（人类定位用）—— 只是不参与判定
    expect(asIs.rotted[0].message, '腐烂消息必须带登记注解行号，供人类定位').toMatch(/kernelProjection\.ts:1\b/)
  })

  it('**注解漂移不进判定**（真实树活体读数）：登记注解行 ≠ 实测行的对，判定仍绿；而按行锚就会判红', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    // 真实树上"登记注解行与实测行不一致"的条目（历史实例：`44030389` 使 kernelAssembly :87→:90；
    // `08cd99fc` 使 kernelPresentationInputs :61→:62）。读数打进日志供复核/趋势 —— 不打行号以外的东西。
    const staleEntries = APPROVED_COMPOSITION_LEGACY_EDGES.filter((e) => {
      const row = counted.pairRows.get(pairKeyOf(e.from, e.to))
      return row !== undefined && !row.lines.includes(e.line)
    })
    const staleReading = staleEntries.map((e) => {
      const row = counted.pairRows.get(pairKeyOf(e.from, e.to))
      return `${pairKeyOf(e.from, e.to)}：注解行 :${e.line} / 实测行 ${row.lines.map((l) => `:${l}`).join('、')}`
    })
    // eslint-disable-next-line no-console
    console.log(`[G1 注解漂移] ${staleEntries.length} 条登记的注解行与实测行不一致（判定不受影响 —— 行号不是键）：\n  ${staleReading.join('\n  ')}`)

    // ① 对键口径：真实树上的判定必须判绿（注解漂移不得判红）
    const asFrozen = assessCompositionLegacyBinding(facts)
    expect(asFrozen.violations, '冻结注解下必须判绿（注解漂移不是腐烂）').toEqual([])
    // ② 把注解刷新到实测行后，判定读数逐项不变（注解不进键面）
    const refreshed = APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => {
      const row = counted.pairRows.get(pairKeyOf(e.from, e.to))
      return row === undefined ? e : { ...e, line: row.lines[0] }
    })
    const asRefreshed = assessCompositionLegacyBinding(facts, { registry: refreshed })
    expect(asRefreshed.violations, '注解刷新到实测行后同样判绿（同一个对集）').toEqual([])
    expect(keyFace(asRefreshed.rotted), '两种注解下的腐烂读数逐项相同').toEqual(keyFace(asFrozen.rotted))
    expect(asRefreshed.unregistered).toEqual(asFrozen.unregistered)
    expect(asRefreshed.growth).toEqual(asFrozen.growth)
    expect(asRefreshed.ceiling).toEqual(asFrozen.ceiling)
    // ③ **有区分力的半边**：鉴于此树确有漂移条目，同一棵树用**行锚**（旧口径的做法）就会判红 ——
    //    证明上面的绿不是恒绿，"去掉行锚"确实消掉了这条假红。无漂移条目时本段空转（不制造恒绿断言）。
    const observedLineKeys = new Set(counted.rows.map((r) => `${r.file}:${r.line}:${r.target}`))
    const rottedByLineKey = APPROVED_COMPOSITION_LEGACY_EDGES.filter((e) => !observedLineKeys.has(`${e.from}:${e.line}:${e.to}`))
    expect(rottedByLineKey.length, '行锚口径下被判"腐烂"的登记条数 = 注解漂移的条数').toBe(staleEntries.length)
    for (const e of staleEntries) {
      expect(
        observedLineKeys.has(`${e.from}:${e.line}:${e.to}`),
        `行锚口径会把 ${e.from}:${e.line} 判成腐烂（实测已不在该行）`,
      ).toBe(false)
      expect(
        counted.pairCounts.has(pairKeyOf(e.from, e.to)),
        `对键口径下 ${pairKeyOf(e.from, e.to)} 仍实测存在 ⇒ 不得判红`,
      ).toBe(true)
    }
    expect(observedLineKeys.size, '实测行键读数非空（否则上面是空转）').toBeGreaterThan(0)
  })

  it('豁免刚性 ②：豁免必须落在**冻结许可集**内、重数不超上限（多一条即红）', async () => {
    const facts = await loadFacts()
    const exemptions = derivePendingExemptions(facts)
    // ② 许可上限随 R1-A C10 从 4 收敛到 2（C10 把值导入清零，只剩 type-only）——
    //    只降不升：留余量会让"再塞回一条值导入"不判红。
    expect(FROZEN_PERMITTED_EXEMPT_TOTAL, '许可上限必须在 C10 后收敛为 2').toBe(2)
    expect(
      FROZEN_PERMITTED_EXEMPT_GROUPS.map((g) => `${g.file.replace('src/composition/', '')}→${g.target}:${g.permitted}`),
      '许可组必须是"C10 收敛后"的三组（其中 pure/partMask 已收敛为 0）',
    ).toEqual([
      'kernelOutlinePlanPort.ts→runtime/context:1',
      'kernelOutlinePlanPort.ts→runtime/gridRead:1',
      'kernelOutlinePlanPort.ts→pure/partMask:0',
    ])
    // 机械检测核：超许可集 / 超组上限 / 超总量 ⇒ 非空 ⇒ 判红
    const ceilingViolations = exemptionCeilingViolations(exemptions)
    expect(
      ceilingViolations,
      `豁免超出冻结许可集 ⇒ 判红（"只允许这 2 条"）:\n${ceilingViolations.join('\n')}`,
    ).toEqual([])
    // 值的部分必须已经清零（C10 的成果）—— 本判据按闸门口径把 type-only 也算边，
    // 故"值导入为 0"要用模块图事实单独断言（不许把值导入混在 type-only 里蒙过）。
    const valueEdges = exemptions.filter((e) => e.isTypeOnly !== true)
    expect(
      valueEdges.map((e) => `${e.from}:${e.line} → ${e.to}`),
      'C10 之后该文件不得再有**值导入**形态的绑旧层边（值导入必须清零）',
    ).toEqual([])
    // ④ 终态声明：每条豁免都带 terminalBatch
    const missingTerminal = exemptions.filter((e) => typeof e.terminalBatch !== 'string' || e.terminalBatch.length === 0)
    expect(missingTerminal.map((e) => `${e.from}:${e.line}`), '每条豁免必须带终态批次声明').toEqual([])
  })

  it('豁免条数是**可读读数** ③：导出并被打印（趋势机器可见；终态为空 ⇒ 0）', async () => {
    const facts = await loadFacts()
    const reading = exemptionReading(facts)
    const exemptions = derivePendingExemptions(facts)
    expect(reading.exemptionPairs, '③ 豁免**对**数必须作为读数导出（实测）').toBe(exemptions.length)
    expect(reading.exemptionOccurrences, '③ 读数必须同时给出重数（否则重数增长看不见）').toBe(
      exemptions.reduce((n, e) => n + e.occurrences, 0),
    )
    expect(reading.terminal, '④ 终态必须声明为 empty（空的）').toBe('empty')
    expect(reading.permittedCeiling, '③ 读数必须同时给出许可上限（显示收缩进度：C9=4 ⇒ C10=2）').toBe(2)
    expect(reading.baseline, '读数必须带基线（供每批合流登记趋势；对键口径含 pairs/occurrences 两列）').toEqual({
      files: 11,
      pairs: 21,
      occurrences: 28,
      commit: '9630a39d',
    })
    expect(EXEMPTION_LEDGER_AT_C9_LANDING, 'C9 落地时的读数快照必须留档（4 行）').toHaveLength(4)
    // eslint-disable-next-line no-console
    console.log(`[G1 读数] 豁免=${reading.exemptionPairs}对/${reading.exemptionOccurrences}次（许可上限=${reading.permittedCeiling}，终态=${reading.terminal}），基线=${reading.baseline.files}文件/${reading.baseline.pairs}对/${reading.baseline.occurrences}次@${reading.baseline.commit}，终端批次=${reading.terminalBatch}，当前豁免=${JSON.stringify(reading.ids)}，行号注解=${JSON.stringify(reading.lineHints)}`)
    expect(typeof reading.exemptionPairs).toBe('number')
  })

  it('**豁免终态为空** ④：释放条件**可机械判定**（T1 边消失 / T2 目标不再属旧层）', async () => {
    const facts = await loadFacts()
    const exemptions = derivePendingExemptions(facts)
    // ④ 的机械半边：豁免是**实测导出**，故"绑定消失但条目还在"这种空壳在构造上不可能出现。
    const counted = countCompositionLegacyEdges(facts)
    const present = new Set(counted.pairCounts.keys())
    const stale = exemptions.filter((e) => !present.has(e.pair)).map((e) => e.pair)
    expect(stale, '豁免必须是实测导出（不存在已消失的空壳条目）').toEqual([])

    // ④ 的**可判定**半边：释放条件不是注释里的承诺，而是两条可观测触发，且已接线。
    const status = exemptionExitStatus(facts)
    expect(
      status.triggers.map((t) => `${t.id}:${t.kind}`),
      '释放条件必须显式声明为可观测触发（T1 边消失 / T2 目标不再属旧层）',
    ).toEqual(['T1:edge-absent', 'T2:target-not-old-layer'])
    expect(status.violations, '释放条件已成立的条目必须已被移除（否则判红）').toEqual([])
    // 每条仍在的豁免都必须给出**它凭什么还在**（T1/T2 均未成立的显式证据）
    for (const r of status.reasons) {
      expect(r.holdingBecause, `${r.id} 必须给出"凭什么还在"`).toMatch(/T1 未成立/)
      expect(r.targetStillOldLayer, `${r.id} 的目标今天仍须确实属于旧层（否则 T2 成立 ⇒ 必消失）`).toBe(true)
    }
    // **触发条件确实接线**（证伪式校准）：把触发打成成立 ⇒ 条目必须自动消失。
    //  T2：把两个目标登记进 KERNEL_FILES ⇒ 它们不再是旧层 ⇒ 导出集为空。
    const fakeKernelFiles = [...readKernelFiles(), 'runtime/context.ts', 'runtime/gridRead.ts']
    expect(
      derivePendingExemptions(facts, { kernelFiles: fakeKernelFiles }),
      'T2 成立（目标登记进 KERNEL_FILES）时豁免必须自动为空 —— 证明"何时必须为空"是接线的，不是承诺',
    ).toEqual([])
    //  T1：把该文件的边从事实集里去掉 ⇒ 导出集为空。
    expect(
      derivePendingExemptions(facts.filter((f) => !f.fromSrcRel.includes('kernelOutlinePlanPort'))),
      'T1 成立（边消失）时豁免必须自动为空',
    ).toEqual([])
    // 终态判据：豁免为 0 时，实测必须恰等于冻结基线（回到 11/21/28）
    if (exemptions.length === 0) {
      const end = countCompositionLegacyEdges(facts)
      expect({ pairs: end.pairs, occurrences: end.occurrences }, '终态：豁免为空 ⇒ 实测回到冻结基线 21 对 / 28 次').toEqual(
        { pairs: BASELINE_PAIR_COUNT, occurrences: BASELINE_EDGE_OCCURRENCES },
      )
    }
  })

  it('**剩余 2 条豁免的定性**：全部 type-only、对数 ≤2、指向核销批次（不是"已知并存边界"结账）', async () => {
    const facts = await loadFacts()
    const exemptions = derivePendingExemptions(facts)
    const status = exemptionExitStatus(facts)
    expect(status.count, '当前豁免对数').toBeLessThanOrEqual(2)
    expect(
      exemptions.map(
        (e) => `${e.from.replace('src/composition/', '')}:${e.line}→${e.to}${e.isTypeOnly ? ' [type-only]' : ' [值导入]'}`,
      ),
      '当前两条豁免必须都是 type-only（C10 已把值导入清零）',
    ).toEqual([
      'kernelOutlinePlanPort.ts:56→runtime/context [type-only]',
      'kernelOutlinePlanPort.ts:57→runtime/gridRead [type-only]',
    ])
    expect(status.allTypeOnly, '豁免必须全是 type-only（值导入不得借豁免存活）').toBe(true)
    expect(exemptions.every((e) => e.occurrences === 1), '每条豁免当前各 1 条边（重数溢出会另行判红）').toBe(true)
    // ⚠️ 立场断言：这两条**不是**"已知并存边界"，而是待核销欠账 ——
    // 闸门口径对类型导入同计（`no-private-cross-layer` 对 `import { type X }` 同样产出 finding），
    // 故不许拿 isTypeOnly 当"无所谓"的理由。
    expect(
      exemptions.every((e) => e.terminalBatch && e.terminalBatch.includes('R1-A')),
      '每条豁免必须指向核销它的批次（欠账有 owner，不是永久边界）',
    ).toBe(true)
  })

  it('**校准自检**：冻结对集与实测对集逐对逐重数一致（对称差为空，且两个数都由判定核数出）', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    const exemptions = derivePendingExemptions(facts)
    const observed = counted.pairCounts
    const declared = pairMultisetOf([
      ...APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => pairKeyOf(e.from, e.to)),
      ...exemptions.flatMap((e) => Array.from({ length: e.occurrences }, () => e.pair)),
    ])
    const onlyDeclared = [...declared.keys()].filter((k) => !observed.has(k)).sort()
    const onlyObserved = [...observed.keys()].filter((k) => !declared.has(k)).sort()
    expect({ onlyDeclared, onlyObserved }, '冻结登记 + 实测豁免 与实测对的对称差必须为空').toEqual({
      onlyDeclared: [],
      onlyObserved: [],
    })
    // 重数面也必须一致（集合相等不足以证明"条数没变"）
    expect(entriesOf(declared), '冻结登记 + 实测豁免 与实测对的多重集必须逐对逐重数相等').toEqual(entriesOf(observed))
    // 读数一致性：基线 28 次 + 实测豁免重数 == 判定核数出的边数（不是手写常量对齐手写常量）
    expect({ occurrences: BASELINE_EDGE_OCCURRENCES + exemptions.reduce((n, e) => n + e.occurrences, 0) }).toEqual({
      occurrences: counted.occurrences,
    })
    // 且冻结基线自身必须是 21 对 / 28 次（读数与常量一致）
    expect(BASELINE_PAIRS.length).toBe(BASELINE_PAIR_COUNT)
    expect(APPROVED_COMPOSITION_LEGACY_EDGES.length).toBe(BASELINE_EDGE_OCCURRENCES)
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

  it('登记字段完备性：冻结基线的每条登记都写明 文件/行(注解)/目标/类别/理由/退出归属/负责人', () => {
    const incomplete = APPROVED_COMPOSITION_LEGACY_EDGES.filter((e) => {
      if (REGISTRY_REQUIRED_FIELDS.some((k) => e[k] === undefined || e[k] === null || e[k] === '')) return true
      if (String(e.reason).length < 20) return true
      if (String(e.exitStage).length < 5) return true
      return false
    }).map((e) => `${e.from}:${e.line}`)
    expect(incomplete, `登记项必须写全 ${REGISTRY_REQUIRED_FIELDS.join('/')}（理由 ≥20 字）`).toEqual([])
    // 登记表的判据键必须唯一可数：对键由 (from, to) 派生，行号不参与
    expect(
      APPROVED_COMPOSITION_LEGACY_EDGES.every((e) => e.from.startsWith('src/composition/')),
      '登记的文件必须在判定面内',
    ).toBe(true)
  })

  it('反空洞真：判定面里**确实**有边被扫到（否则"未登记即红"是空转）', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    const exemptions = derivePendingExemptions(facts)
    expect(counted.occurrences, '判定核必须真实命中边 —— 否则上一条的 0 违规只是"没扫到"').toBeGreaterThan(0)
    expect(counted.pairs, '对计数必须 > 1（单对会让"对键"口径退化）').toBeGreaterThan(1)
    expect(counted.files).toBeGreaterThan(1)
    // 实测必须 = 冻结基线 + 实测豁免（豁免是实测导出，故这条是"读数自洽"而非"恒真"：
    // 若实测数**小于**基线，说明基线的 28 次里已有条目消失 ⇒ 登记腐烂，下面的断言会红）
    expect(counted.occurrences, '实测必须 = 基线 28 次 + 实测豁免重数').toBe(
      BASELINE_EDGE_OCCURRENCES + exemptions.reduce((n, e) => n + e.occurrences, 0),
    )
  })

  it('**负对照 A**：往 `composition/` 注入一条未登记的新边（新对）⇒ 判红', async () => {
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
      // ① 的失败消息必须带**行号**（人类定位用）—— 行号只在消息里，不在键里
      expect(violations[0], '判红消息必须带行号供人类定位').toContain('src/composition/probeAssembly.ts:1')
      expect(violations[0], '判红消息必须点明未登记的**对**').toContain('(file, target) 对未登记')
      // 正对照：同一条边**登记后**判绿（证明判红来自登记表，而不是别的什么）
      const registry = [...approved, makeEdge('src/composition/probeAssembly.ts', 1, 'context/grid')]
      expect(
        unregisteredCompositionLegacyEdges(probeFacts, registry, { srcRoot, kernelFiles }),
        '登记之后必须判绿（否则负对照证明不了登记表在起作用）',
      ).toEqual([])
      // 重数溢出也必须红：同一对登记 1 条、实测 2 条 ⇒ 判红（对键口径不弱化"往同去向上加绑定"）
      const dupProbe = path.join(comp, 'probeDup.ts')
      fs.writeFileSync(dupProbe, "import { slotsOf } from '@/context/grid'\nimport { other } from '@/context/grid'\n", 'utf8')
      const dupFacts = extractImports(dupProbe, dir)
      expect(
        unregisteredCompositionLegacyEdges(
          dupFacts,
          [...approved, makeEdge('src/composition/probeDup.ts', 1, 'context/grid')],
          { srcRoot, kernelFiles },
        ),
        '同对重数溢出（登记 1 条、实测 2 条）必须判红',
      ).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('**负对照 A′（豁免刚性 ②/③/④）**：塞进许可集外的新豁免 ⇒ 判红；同组超上限 ⇒ 判红；许可上限恒 2', async () => {
    const facts = await loadFacts()
    const exemptions = derivePendingExemptions(facts)
    const mk = (line, to, from = 'src/composition/kernelAssembly.ts') => ({
      from,
      line,
      to,
      pair: pairKeyOf(from, to),
      occurrences: 1,
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
    // 正面：在同一许可组里**超上限**也要红（gridRead 许可 1 条，塞到 2 条即越界）
    const overGroup = [
      mk(900, 'runtime/gridRead', 'src/composition/kernelOutlinePlanPort.ts'),
      mk(901, 'runtime/gridRead', 'src/composition/kernelOutlinePlanPort.ts'),
    ]
    expect(exemptionCeilingViolations(overGroup), '同组条数超上限即红').not.toEqual([])
    // 重数溢出同罪：一条豁免条目声称重数 2，而该组只许可 1 ⇒ 也要红
    expect(
      exemptionCeilingViolations([{ ...mk(56, 'runtime/context', 'src/composition/kernelOutlinePlanPort.ts'), occurrences: 2 }]),
      '同组重数超上限即红（重数不能被折叠成集合蒙过）',
    ).not.toEqual([])
    // 许可为 0 的组（pure/partMask）出现一条即红
    expect(
      exemptionCeilingViolations([mk(65, 'pure/partMask', 'src/composition/kernelOutlinePlanPort.ts')]),
      '许可上限为 0 的去向出现一条即红',
    ).not.toEqual([])
    // ③ 许可上限随 C10 收敛为 2（读数不得被人为抬高以容纳新豁免）
    expect(FROZEN_PERMITTED_EXEMPT_TOTAL, '许可上限在 C10 后为 2（只降不升）').toBe(2)
    // ④ 已消失的豁免必然不在实测导出里（空壳在构造上不可能出现）
    expect(
      exemptions.filter((e) => e.line === 9999),
      '实测导出不得包含任何已消失的空壳条目',
    ).toEqual([])
    // 正对照：当前实测导出必须通过许可集检测（证明检测本身不是在恒红）
    expect(exemptionCeilingViolations(exemptions), '当前豁免必须通过许可集检测').toEqual([])
  })

  it('**负对照 B**：从冻结集移除一个**实测存在**的对 ⇒ 判红（未登记 + 豁免越界，两条路都拦）', async () => {
    const facts = await loadFacts()
    // 移除 `kernelAssembly.ts → context/multiblock`（实测存在、且只登记一条）这一**对**。
    const removedPair = pairKeyOf('src/composition/kernelAssembly.ts', 'context/multiblock')
    const removed = APPROVED_COMPOSITION_LEGACY_EDGES.filter((e) => pairKeyOf(e.from, e.to) !== removedPair)
    expect(removed.length, '负对照必须真的少了一条登记').toBe(APPROVED_COMPOSITION_LEGACY_EDGES.length - 1)

    // 路径一（生产模式的 ①）：豁免集是"实测 − 冻结集"，故被移除的对会冒进豁免 ⇒ 许可集外 ⇒ 红。
    const prod = assessCompositionLegacyBinding(facts, { registry: removed })
    expect(prod.ceiling, '被移除的对冒进豁免后必须被许可集拦下（豁免不是登记表的后门）').not.toEqual([])
    expect(prod.ceiling.join('\n'), '判红必须点名那条被移除登记的对').toContain('context/multiblock')
    expect(prod.violations.length, '整体判定必须判红（移除登记不得静默通过）').toBeGreaterThan(0)
    expect(prod.rotted, '移除登记不是"腐烂"（腐烂 = 登记了但实测没有）—— 它该走未登记/越界两条路').toEqual([])

    // 路径二（把豁免通道关掉的严格 ①）：被移除的对必须直接落进"未登记"。
    const strict = assessCompositionLegacyBinding(facts, { includeExemptions: false })
    const strictRemoved = assessCompositionLegacyBinding(facts, { registry: removed, includeExemptions: false })
    const added = strictRemoved.unregistered.filter((v) => !strict.unregistered.includes(v))
    expect(
      strictRemoved.unregistered.length,
      `移除一条登记后未登记集合必须恰好 +1（原 ${strict.unregistered.length} ⇒ 期望 ${strict.unregistered.length + 1}）`,
    ).toBe(strict.unregistered.length + 1)
    expect(added, '新增的那一条必须正是被移除登记对应的真实对').toHaveLength(1)
    expect(added[0], '判红消息必须带实测行号').toContain('kernelAssembly.ts:82')
    // 同时冻结读数也必须红（登记数减少 = 未同批核销）
    expect(removed.length).not.toBe(BASELINE_EDGE_OCCURRENCES)
    expect(APPROVED_COMPOSITION_LEGACY_EDGES.length - 1).not.toBe(BASELINE_EDGE_OCCURRENCES)
  })

  it('**负对照 D**：往冻结集塞一个现实中不存在的假对 ⇒ 腐烂检测判红', async () => {
    const facts = await loadFacts()
    const fake = makeEdge('src/composition/kernelRenderView.ts', 7777, 'runtime/doesNotExist')
    const verdict = assessCompositionLegacyBinding(facts, { registry: [...APPROVED_COMPOSITION_LEGACY_EDGES, fake] })
    expect(verdict.rotted, '塞假对 ⇒ 腐烂检测必须点名它').toHaveLength(1)
    expect(verdict.rotted[0].pair).toBe(pairKeyOf('src/composition/kernelRenderView.ts', 'runtime/doesNotExist'))
    expect(verdict.rotted[0].observed, '该对实测出现 0 次').toBe(0)
    expect(verdict.violations.length, '整体判定必须判红').toBeGreaterThan(0)
    // 反向对照（同一检测的另一面，两种腐烂理由各测一次）：
    //  ① 整个对消失 ⇒ pair-absent
    const gonePair = pairKeyOf('src/composition/kernelRenderView.ts', 'context/runtimeDocument')
    const dropped = facts.filter((f) => !(f.fromSrcRel === 'composition/kernelRenderView.ts' && resolveTargetOf(f, SRC_ROOT) === 'context/runtimeDocument'))
    expect(
      rottenRegisteredPairs(dropped).map((r) => `${r.reason}:${r.pair}`),
      '实测里整个对消失必须报 pair-absent',
    ).toContain(`pair-absent:${gonePair}`)
    //  ② 只少一条边（登记 2 条、实测剩 1 条）⇒ occurrence-shortfall（重数面没有退化成集合）
    let seen = 0
    const oneShort = facts.filter((f) => {
      if (f.fromSrcRel !== 'composition/kernelRenderView.ts') return true
      if (resolveTargetOf(f, SRC_ROOT) !== 'context/runtimeDocument') return true
      seen += 1
      return seen !== 1
    })
    expect(seen, '该对在实测里确实有 2 条边（否则这条对照无意义）').toBe(
      BASELINE_PAIR_OCCURRENCES[gonePair],
    )
    const shortfall = rottenRegisteredPairs(oneShort).filter((r) => r.pair === gonePair)
    expect(shortfall.map((r) => `${r.reason}:${r.declared}/${r.observed}`), '少一条边必须报 occurrence-shortfall').toEqual([
      'occurrence-shortfall:2/1',
    ])
    expect(shortfall[0].message, '重数不足的消息必须给出"登记 N 条、实测剩 M 条"').toContain('实测只剩 1 条')
    // 消息必须**同时**给出登记注解行与**实测行**（注解是冻结快照里的历史值，定位要看实测行）
    const remainingLines = oneShort
      .filter((f) => f.fromSrcRel === 'composition/kernelRenderView.ts' && resolveTargetOf(f, SRC_ROOT) === 'context/runtimeDocument')
      .map((f) => f.line)
      .sort((a, b) => a - b)
    expect(remainingLines, '该对实测只剩 1 条').toHaveLength(1)
    expect(shortfall[0].message, '腐烂消息必须带**实测行**（报告面，人类定位）').toContain(
      `实测行 src/composition/kernelRenderView.ts:${remainingLines[0]}`,
    )
    // 正对照：不塞假对时检测为空（证明检测不是恒红）
    expect(rottenRegisteredPairs(facts), '生产登记集下腐烂检测必须为空').toEqual([])
  })

  it('**负对照 E**：计数上限压低 1 ⇒ 增长检测判红（两个上限各自独立成立）', async () => {
    const facts = await loadFacts()
    const counted = countCompositionLegacyEdges(facts)
    // 正对照：生产上限（21+2 对 / 28+2 次）下判绿
    expect(bindingCountViolations(counted), '生产上限下必须判绿').toEqual([])
    // 压低 1（对上限 23→22）：实测 23 对 ⇒ 必须红
    const pairLowered = bindingCountViolations(counted, { pairCap: 23 - 1 })
    expect(pairLowered, '对上限压低 1 必须判红').not.toEqual([])
    expect(pairLowered.join('\n')).toContain('超出冻结上限 22 对')
    // 压低 1（重数上限 30→29）：实测 30 次 ⇒ 必须红
    const occLowered = bindingCountViolations(counted, { occurrenceCap: 30 - 1 })
    expect(occLowered, '重数上限压低 1 必须判红').not.toEqual([])
    expect(occLowered.join('\n')).toContain('超出冻结上限 29 次')
    // 两个上限都压低 ⇒ 两条都报（各自独立，不互相掩盖）
    expect(bindingCountViolations(counted, { pairCap: 22, occurrenceCap: 29 })).toHaveLength(2)
    // 生产判定核里也接线（不是"只在测试里可用"）
    const verdict = assessCompositionLegacyBinding(facts, { pairCap: 22, occurrenceCap: 29 })
    expect(verdict.growth, '生产判定核必须把增长检测接进 violations').toHaveLength(2)
    expect(verdict.violations.length).toBeGreaterThan(0)
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
      // 且该边确实进了判定面（否则上面的 [] 只是"没扫到"）
      expect(isOldLayerTarget('application/evaluation', readKernelFiles()), '新层目标不得被算作旧层').toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('登记表 ↔ 豁免集的登记项形态一致（豁免经 exemptionRegistryEntries 进集合运算）', async () => {
    const facts = await loadFacts()
    const exemptions = derivePendingExemptions(facts)
    const entries = exemptionRegistryEntries(exemptions)
    expect(entries).toHaveLength(exemptions.length)
    expect(
      entries.every((e) => typeof e.from === 'string' && typeof e.line === 'number' && typeof e.to === 'string'),
      '豁免登记项必须带 (from, line(注解), to)',
    ).toBe(true)
    // 生产集合 = 冻结基线 + 豁免；两侧对键不得重叠（重叠会让重数被重复计）
    const frozen = new Set(APPROVED_COMPOSITION_LEGACY_EDGES.map((e) => pairKeyOf(e.from, e.to)))
    expect(
      entries.filter((e) => frozen.has(pairKeyOf(e.from, e.to))),
      '（实测 − 冻结集）的差集按定义不得与冻结集重叠',
    ).toEqual([])
  })
})
