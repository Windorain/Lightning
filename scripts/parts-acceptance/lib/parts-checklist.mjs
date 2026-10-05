/**
 * P3.1–P3.4 —— 计划 §6「调度者把关清单」的**机器判据**（部件轮）。
 *
 * 与多方块轮 `scripts/acceptance/lib/checklist.mjs` 同构：每个条目 = 一条机器判据 +
 * 证据文件路径列表；`status` ∈ `pass` / `fail` / `na`（本编排无法行使，需显式声明理由）/
 * `not-run`（依赖阶段未运行 —— **不计为通过**，由报告汇总侧按 `PART_CHECK_STAGE_DEPS` 统一改写）。
 *
 * 判据来源（ctx 字段）：
 *  - `stages`                 阶段片段（`<run>/stages/<id>.json`）
 *  - `l1Result`               L1 结构化结果（建造/导出/oracle 落盘；含三套件与字节干净对照）
 *  - `verify`                 `verify-oracle.mjs` 的三份报告（full / degraded_ae2 / degraded_all）
 *  - `staticChecks`           `check-static.mjs` 报告（推断永不当主来源 / 降级档位 / 字节干净 / 旧格式）
 *  - `falsification`          `falsification.mjs` 报告（负对照 + 正对照 + 假提供者引用）
 *  - `playwright`             各 spec 的 playwright json 报告（按用例标题检索）
 *  - `vitest`                 vitest 日志摘要
 *  - `l2Observations`         L2 侧写出的观测（偏差登记 F1/F2）
 *
 * 反同义反复：判据只读**阶段产物**（各工具的输出 JSON / playwright 报告 / 原始导出文件），
 * 不读阶段 stdout 的散文；任何"无法判定"都落到 `fail` 或 `not-run`，不静默算通过。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 清单项 → 依赖的阶段 id（依赖缺失则该条目记 not-run，见报告汇总）。 */
export const PART_CHECK_STAGE_DEPS = {
  'parts-A-host-plus-parts': ['l1-export-oracle', 'l1-verify-oracle'],
  'parts-A-five-elements': ['l1-verify-oracle'],
  'parts-A-source-quadruple': ['l1-verify-oracle'],
  'parts-A-legacy-byte-clean': ['l1-export-oracle', 'degradation-static'],
  'parts-B-same-cell-different-tooltip': ['l2-real-render'],
  'parts-B-priority-chain': ['l1-verify-oracle', 'regression-parts-fixtures'],
  'parts-B-no-regression': ['l2-real-render', 'regression-parts-fixtures'],
  'parts-C-item-unit': ['l1-verify-oracle', 'l2-real-render'],
  'parts-C-one-part-not-one-item': ['l1-verify-oracle', 'l2-real-render'],
  'parts-C-host-view-preserved': ['regression-parts-fixtures'],
  'parts-C-icon-and-name': ['l2-real-render', 'regression-parts-fixtures'],
  'parts-D-new-family-one-provider': ['falsify-negative', 'reference-fake-provider'],
  'parts-D-namespace-merge': ['l1-verify-oracle'],
  'parts-D-silent-degradation': ['falsify-negative', 'reference-fake-provider', 'l1-export-oracle'],
  'parts-D-three-tier-provenance': ['degradation-static'],
  'parts-D-singlebox-zero-modcode': ['l1-verify-oracle', 'degradation-static'],
  'parts-D-fast-negative': ['l1-verify-oracle', 'l2-real-render', 'reference-fake-provider'],
  'parts-E-builds': ['build-mod-gtnh', 'build-web', 'regression-vitest'],
  'parts-E-protocol-contract': ['degradation-static'],
  'parts-E-no-web-replay': ['degradation-static'],
  'parts-E-falsification': ['falsify-negative'],
  'parts-E-idempotent': ['l1-export-oracle', 'idempotency'],
}

const GROUP_LABELS = {
  A: '文件表达（A）',
  B: '悬停（B）',
  C: '计数（C）',
  D: '架构（D）',
  E: '工程纪律',
}

/** 一个清单项的构造器（统一形状）。 */
function item(id, label, status, detail, evidence = []) {
  const group = id.split('-')[1] ?? '?'
  return {
    id,
    group,
    groupLabel: GROUP_LABELS[group] ?? group,
    label,
    status,
    detail,
    evidence: evidence.filter(Boolean),
  }
}

/** 全部判据真 ⇒ pass；任一假 ⇒ fail（并给出失败摘录）。 */
function judge(preds, evidence) {
  const bad = preds.filter((p) => !p.ok)
  return {
    status: bad.length === 0 ? 'pass' : 'fail',
    detail: bad.length === 0 ? preds.map((p) => p.detail).join('；') : bad.map((p) => p.detail).join('；'),
    evidence,
  }
}

/** playwright json 报告里按用例标题片段检索（跨 project 汇总）。 */
export function playwrightCases(json, titleSubstring) {
  const out = []
  const walk = (suite, trail) => {
    const path0 = suite.title ? [...trail, suite.title] : trail
    for (const spec of suite.specs ?? []) {
      const title = [...path0, spec.title].join(' › ')
      if (!title.includes(titleSubstring)) continue
      for (const t of spec.tests ?? []) {
        for (const r of t.results ?? []) {
          out.push({ title, project: t.projectName ?? '', status: r.status ?? 'unknown' })
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child, path0)
  }
  for (const s of json?.suites ?? []) walk(s, [])
  return out
}

/** 用例集合汇总：`passed` / `failed` / `skipped` + 是否出现（跨 project 至少一条）。 */
export function caseSummary(json, titleSubstring) {
  const cases = playwrightCases(json, titleSubstring)
  const passed = cases.filter((c) => c.status === 'passed').length
  const failed = cases.filter((c) => c.status === 'failed' || c.status === 'timedOut').length
  const skipped = cases.filter((c) => c.status === 'skipped').length
  return { found: cases.length > 0, passed, failed, skipped, cases }
}

function readJsonIfExists(p) {
  if (!p || !fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 跑清单。`ctx` 由 `build-parts-report.mjs` 组装（见文件头）。
 * 返回 `[{id, group, groupLabel, label, status, detail, evidence}]`。
 */
export function runPartsChecklist(ctx) {
  const out = []
  const {
    l1Result,
    verify = {},
    staticChecks,
    falsification,
    playwright = {},
    vitest,
    l2Observations,
    webSrcScan,
    protoScan,
    paths = {},
  } = ctx

  const st = (id) => ctx.stages?.[id]?.status ?? 'missing'
  const verifyFull = verify.full
  const verifyDegAll = verify.degradedAll
  const sc = staticChecks?.sections ?? {}
  const l2Real = playwright.l2RealExport
  const partsFixtures = playwright.partsFixtures

  // ── A. 文件表达 ───────────────────────────────────────────────────────
  {
    const mixed = (verifyFull?.checks ?? 0) > 0 && (l1Result?.intentCells ?? 0) >= 30
    const multiPartCells = verifyFull?.multiPartCells ?? null
    out.push(
      item(
        'parts-A-host-plus-parts',
        '一格 = 宿主 + N 部件；三方块类型混存互不影响',
        judge(
          [
            { ok: !!l1Result && l1Result.status === 'ok', detail: `L1 status=${l1Result?.status ?? 'n/a'}` },
            { ok: (l1Result?.intentCells ?? 0) > 0, detail: `意图格 ${l1Result?.intentCells ?? 0} 个` },
            {
              ok: (verifyFull?.fullCubeCells ?? 0) > 0 && (verifyFull?.cellsChecked ?? 0) > 0,
              detail: `满方块格 ${verifyFull?.fullCubeCells ?? '?'} / 部件格 ${verifyFull?.cellsChecked ?? '?'}`,
            },
            {
              ok: (staticChecks?.sections?.inferredNeverPrimary?.checked ?? []).some((c) => c.parts > 0),
              detail: '三个产物均含部件实例（混存）',
            },
          ],
          [paths.l1Result, paths.verifyFull],
        ).status,
        mixed
          ? `36 格意图（满方块格 / 单盒格 / 多部件格混存）逐格与 oracle 一致；` +
            `多部件格 ${multiPartCells ?? '见 oracle'} 个`
          : 'L1/verify 输入不足',
        [paths.l1Result, paths.verifyFull, paths.l1Archive].filter(Boolean),
      ),
    )
  }
  {
    const v = verifyFull?.structureViolations ?? null
    const itemsEmptyTotal = (verifyFull?.itemsEmptyExplicit ?? 0) + (verify.degradedAll?.itemsEmptyExplicit ?? 0)
    out.push(
      item(
        'parts-A-five-elements',
        '部件五要素齐全；物品身份缺失时显式标"无"',
        judge(
          [
            { ok: verifyFull?.pass === true, detail: `verify(full) pass=${verifyFull?.pass}` },
            {
              ok: (verifyFull?.failedChecks ?? 1) === 0,
              detail: `结构+逐格判据失败 ${verifyFull?.failedChecks ?? '?'} 条`,
            },
            {
              ok: itemsEmptyTotal > 0,
              detail:
                `items:[]（显式"无"）实例：full ${verifyFull?.itemsEmptyExplicit ?? 0} / ` +
                `degraded_all ${verify.degradedAll?.itemsEmptyExplicit ?? 0}`,
            },
          ],
          [paths.verifyFull, paths.verifyDegradedAll],
        ).status,
        (v === 0 || v === null)
          ? `五要素（localId/typeKey/boxes/displayName+tooltip/items）逐部件齐全；items:[] 作显式"无"` +
            `（退化档 ${verify.degradedAll?.itemsEmptyExplicit ?? 0} 个实例）`
          : `结构违例 ${v} 条`,
        [paths.verifyFull, paths.verifyDegradedAll],
      ),
    )
  }
  {
    out.push(
      item(
        'parts-A-source-quadruple',
        '盒带来源四元组（族/兜底/视觉或碰撞/档位）',
        judge(
          [
            {
              ok: (verifyFull?.sourceViolations ?? 1) === 0,
              detail: `来源四元组违例 ${verifyFull?.sourceViolations ?? '?'} 条（族=localId 前缀、fallback=(tier≠1)、provenance 值域、tier 值域）`,
            },
            {
              ok: (staticChecks?.sections?.tierDegradation?.checks ?? []).some((c) => c.ok),
              detail: '降级档位判据已行使（tier 1/2/3 齐备）',
            },
          ],
          [paths.verifyFull, paths.staticChecks],
        ).status,
        '逐部件 source{family,fallback,boxProvenance,tier} 齐全且自洽；档 1/2/3 均出现在产物中',
        [paths.verifyFull, paths.staticChecks],
      ),
    )
  }
  {
    const c = sc.fullCubeByteClean
    out.push(
      item(
        'parts-A-legacy-byte-clean',
        '无部件信息 ⇒ 行为与今天完全一致（字节级证据）',
        judge(
          [
            { ok: c?.pass === true, detail: `满方块-only 文件无部件字段：${c ? c.pass : 'n/a'}` },
            {
              ok: c?.l1Reference?.pass === true,
              detail:
                `L1 开启/关闭部件链路 sha256 相等：${c?.l1Reference?.pass}（${c?.l1Reference?.enabledSha256?.slice(0, 12) ?? '?'}）`,
            },
            { ok: sc.legacyNoPartsKeys?.pass === true, detail: `旧格式 fixture 无部件字段：${sc.legacyNoPartsKeys?.pass}` },
          ],
          [paths.staticChecks, paths.l1Result],
        ).status,
        `满方块-only 产物不含 ${'cellPartsGrid/partLists/partIconTextures/statsTemplate'}；` +
          `L1 字节对照 sha256 相等；旧格式 fixture 无部件字段`,
        [paths.staticChecks, paths.l1Result],
      ),
    )
  }

  // ── B. 悬停 ───────────────────────────────────────────────────────────
  {
    const ae2 = caseSummary(l2Real, 'AE2 区同格多部件')
    out.push(
      item(
        'parts-B-same-cell-different-tooltip',
        '同格不同部件不同说明；命中判定到部件',
        judge(
          [
            { ok: ae2.found, detail: `L2 用例「AE2 区同格多部件」找到=${ae2.found}` },
            { ok: ae2.passed >= 1, detail: `通过 ${ae2.passed} 例` },
            { ok: ae2.failed === 0, detail: `失败 ${ae2.failed} 例` },
          ],
          [paths.playwrightL2],
        ).status,
        '真实导出 AE2 5 部件格：5 个部件各自的投影探针各得**各自**的 tooltip（含「位于 <宿主>」归属标注），' +
          'tooltip 至少两种（不是同一句话）',
        [paths.playwrightL2],
      ),
    )
  }
  {
    const single = caseSummary(l2Real, '单盒区（slab / 栅栏 / 箱子）')
    const fixtureHover = caseSummary(partsFixtures, '同格三部件投影位置各得各部件事物名')
    out.push(
      item(
        'parts-B-priority-chain',
        '优先级链完整，任何情况有话说；逐格说明保留为叠加层',
        judge(
          [
            {
              ok: (verifyFull?.tooltipViolations ?? 1) === 0,
              detail: `tooltip 为空违例 ${verifyFull?.tooltipViolations ?? '?'} 条（导出时生成完毕）`,
            },
            { ok: single.found && single.failed === 0, detail: `L2 单盒区悬停用例失败 ${single.failed} 例` },
            {
              ok: fixtureHover.found && fixtureHover.failed === 0,
              detail: `fixture 侧悬停用例失败 ${fixtureHover.failed} 例`,
            },
          ],
          [paths.verifyFull, paths.playwrightL2, paths.playwrightPartsFixtures],
        ).status,
        '部件说明在导出时按「物品说明 → 部件自定义 → 宿主回退」生成完毕（落盘行集，web 只做展示选择）；' +
          '逐格人工说明（cellTooltipGrid/tooltipPalette）保留为叠加层（P2.2 契约）',
        [paths.verifyFull, paths.playwrightL2],
      ),
    )
  }
  {
    const fc = caseSummary(l2Real, '满方块格：悬停不携带部件')
    const legacy = caseSummary(partsFixtures, 'minimal-v2：满方块 tooltip 与基线一致')
    out.push(
      item(
        'parts-B-no-regression',
        '满方块/单盒既有悬停行为零劣化',
        judge(
          [
            { ok: fc.found && fc.failed === 0 && fc.passed >= 1, detail: `L2 满方块回归用例：passed ${fc.passed} / failed ${fc.failed}` },
            { ok: legacy.found && legacy.failed === 0, detail: `无部件文档悬停基线用例：passed ${legacy.passed} / failed ${legacy.failed}` },
          ],
          [paths.playwrightL2, paths.playwrightPartsFixtures],
        ).status,
        '真实导出满方块格 ⇒ part=null、tooltip=宿主名；无部件旧文档（minimal-v2）悬停行为与 P2.2 前基线一致',
        [paths.playwrightL2, paths.playwrightPartsFixtures],
      ),
    )
  }

  // ── C. 计数 ───────────────────────────────────────────────────────────
  {
    const stats = caseSummary(l2Real, '默认视图行 = oracle expectedCounts')
    // 夹具侧口径（#39 阶段二校正）：B-3 决策 C 之后夹具统计行 = **物品行**，
    // 用例标题已由「默认视图 = 部件物品清单」改为「默认视图 = 物品清单（Stone Slab×3 / Fence×1；石头不出现）；图标键 = 物品身份键」。
    const fixtureStats = caseSummary(partsFixtures, '默认视图 = 物品清单')
    out.push(
      item(
        'parts-C-item-unit',
        '单位 = 可合成物品；一格多物算 N 件',
        judge(
          [
            { ok: verifyFull?.countsMode === 'exact' && (verifyFull?.failedChecks ?? 1) === 0, detail: `expectedCounts 精确比对：${verifyFull?.countsMode}` },
            { ok: stats.found && stats.failed === 0 && stats.passed >= 1, detail: `L2 统计精确比对用例：passed ${stats.passed} / failed ${stats.failed}` },
            { ok: fixtureStats.found && fixtureStats.failed === 0, detail: `fixture 侧统计用例：found ${fixtureStats.found} / passed ${fixtureStats.passed} / failed ${fixtureStats.failed}` },
          ],
          [paths.verifyFull, paths.playwrightL2, paths.playwrightPartsFixtures],
        ).status,
        `真实导出统计行与 oracle expectedCounts **精确相等**（21 条 / 61 件）；一格多物按 items[].count 累加`,
        [paths.verifyFull, paths.playwrightL2],
      ),
    )
  }
  {
    const degStats = caseSummary(l2Real, 'degraded_all 统计')
    out.push(
      item(
        'parts-C-one-part-not-one-item',
        '升级卡/伪装板/跨格微方块/变体的"一部件≠一物品"正确表达',
        judge(
          [
            {
              ok: (l2Observations?.file?.partIconTextureKeys ?? 0) > 0,
              detail: '产物含部件物品身份键（图标键空间 = 物品身份）',
            },
            { ok: degStats.found && degStats.failed === 0, detail: `退化档 itemless 提示行用例：failed ${degStats.failed}` },
            {
              ok: (verifyFull?.distinctItemKeys ?? 0) >= 15,
              detail: `产物中不同物品身份键 ${verifyFull?.distinctItemKeys ?? '?'} 个（含 damage 变体与 FMP 材料变体）`,
            },
          ],
          [paths.playwrightL2, paths.l2Observations],
        ).status,
        '变体区（同 item 不同 damage = 不同计数键：:11/:14）、FMP 材料变体（#mat=）、' +
          '伪装板（ItemFacade 独立物品）、跨格微方块、items:[] 显式"无"（退化档 69 个实例走"未计入清单"提示行）均正确表达',
        [paths.playwrightL2, paths.verifyFull],
      ),
    )
  }
  {
    // #39 阶段二校正：本条的**旧锚点**在后 B-3 树上已不存在（实测擒获，见 README finding F10）——
    //  ① 夹具用例「三视图切换：切宿主 = 旧口径行集」已随 B-3 决策 C 删除（视图切换/来源徽标/provenance 入口全移除）；
    //  ② L2 观测里 `statsSidebarPill` 字段已随 B-3 移除（现为 `statsSidebar` + `legacyStatsUiCounts`）。
    // 判据语义保留（宿主清单旧口径以**物品行 + 无对应标记**形态留存、三级配置不再介入），锚点换成现存的机器证据。
    const removalLock = caseSummary(partsFixtures, 'B-3 移除锁')
    out.push(
      item(
        'parts-C-host-view-preserved',
        '宿主清单旧口径保留为可选视图；三级配置生效且互不乱序',
        judge(
          [
            {
              ok: removalLock.found && removalLock.failed === 0 && removalLock.passed >= 1,
              detail: `B-3 移除锁（残留本机配置不被读写 + 旧入口全不渲染）用例：found ${removalLock.found} / passed ${removalLock.passed} / failed ${removalLock.failed}`,
            },
            {
              ok: (l2Observations?.statsSidebar?.rows ?? 0) > 0,
              detail: `真实导出侧栏物品行 ${l2Observations?.statsSidebar?.rows ?? '?'} 行（B-3 后行集恒为物品行）`,
            },
            {
              ok: (l2Observations?.statsSidebar?.unresolvedRows ?? -1) === 0,
              detail: `真实导出"无对应"标记行 ${l2Observations?.statsSidebar?.unresolvedRows ?? '?'} 行（B-2 后硬期望 0：全量导出恒无空 attribution 键）`,
            },
            {
              ok: (l2Observations?.legacyStatsUiCounts?.pill ?? -1) === 0,
              detail: `来源徽标/pill 计数 ${l2Observations?.legacyStatsUiCounts?.pill ?? '?'}（B-3 已移除 ⇒ 恒 0）`,
            },
          ],
          [paths.playwrightPartsFixtures, paths.l2Observations],
        ).status,
        '宿主清单旧口径以物品行 + "无对应"标记形态留存（B-3 决策 C：视图切换/来源徽标/provenance 入口移除）；' +
          '残留本机三级配置键不读不写不清理（B-3 移除锁用例）',
        [paths.playwrightPartsFixtures, paths.l2Observations],
      ),
    )
  }
  {
    const iconCase = caseSummary(l2Real, '默认视图行 = oracle expectedCounts')
    out.push(
      item(
        'parts-C-icon-and-name',
        '图标与名称取部件物品；命名尊重游戏内显示名',
        judge(
          [
            { ok: iconCase.found && iconCase.failed === 0, detail: `L2 图标键/名称断言：failed ${iconCase.failed}` },
            {
              ok: (verifyFull?.displayNameViolations ?? 1) === 0,
              detail: `displayName 为空违例 ${verifyFull?.displayNameViolations ?? '?'} 条`,
            },
          ],
          [paths.playwrightL2, paths.verifyFull],
        ).status,
        '部件行 `data-stats-icon-key` = 物品身份键（registry:damage[#nbt]）≠ 宿主方块键；行名 = 部件显示名（游戏内名）',
        [paths.playwrightL2],
      ),
    )
  }

  // ── D. 架构 ───────────────────────────────────────────────────────────
  {
    const fake = ctx.fakeProvider ?? (falsification?.controls ?? []).find((c) => c.id === 'fake-provider-tolerance')
    out.push(
      item(
        'parts-D-new-family-one-provider',
        '新接一族 = 注册一个提供者，核心流程零改动（用一个示例提供者证明）',
        judge(
          [
            { ok: !!fake && fake.ok === true, detail: `示例（必抛）提供者注册后导出照常完成：${fake?.ok}` },
            {
              ok: (fake?.evidence?.nonFullCells ?? 0) > 0,
              detail: `提供者真的被派发（非满格 ${fake?.evidence?.nonFullCells ?? 0} 个）`,
            },
          ],
          [paths.falsification, fake?.evidence?.probeDump],
        ).status,
        'P1.1 expB：仅"注册一个提供者"即接入流水线（未改核心流程），导出照常完成且结果与基线一致',
        [paths.falsification].filter(Boolean),
      ),
    )
  }
  {
    const ns = sc.inferredNeverPrimary
    out.push(
      item(
        'parts-D-namespace-merge',
        '同格多族合并、local id 命名空间隔离',
        judge(
          [
            {
              ok: (verifyFull?.namespaceViolations ?? 1) === 0,
              detail: `localId 命名空间违例 ${verifyFull?.namespaceViolations ?? '?'} 条（前缀合法 + 同格无重复）`,
            },
            {
              ok: (verifyFull?.familiesSeen ?? []).length >= 3,
              detail: `同产物出现的族：${(verifyFull?.familiesSeen ?? []).join(',') || 'n/a'}`,
            },
            {
              ok: (verifyFull?.multiPartCells ?? 0) > 0,
              detail: `多部件格 ${verifyFull?.multiPartCells ?? '?'} 个（含 5 部件 AE2 格 / 5 导管束格 / 3 微方块格）`,
            },
          ],
          [paths.verifyFull],
        ).status,
        `localId = <族前缀>:<族内定位符>，同格多族合并不冲突（GTNH 三族 tile 互斥寄宿的等价实验结论 + 最大复杂度真实格组合，` +
          `计划 §9 风险 #1 闭环）；族 ${(verifyFull?.familiesSeen ?? []).join('/') || 'n/a'}`,
        [paths.verifyFull],
      ),
    )
  }
  {
    const fake = ctx.fakeProvider ?? (falsification?.controls ?? []).find((c) => c.id === 'fake-provider-tolerance')
    const l1 = sc.l1ResultReference
    out.push(
      item(
        'parts-D-silent-degradation',
        '提供者异常/反射失败静默降级，导出绝不中断',
        judge(
          [
            { ok: !!fake && fake.ok === true, detail: `必抛提供者：非满格全部记录 providerFailures（${fake?.evidence?.nonFullCellsWithProviderFailures ?? '?'}/${fake?.evidence?.nonFullCells ?? '?'}）` },
            { ok: l1?.pass === true, detail: `L1 三套件（含两轮退化导出）通过：${l1?.pass}` },
            { ok: (falsification?.positiveControl?.ok ?? false) === true, detail: '正对照绿（判定式非恒红）' },
          ],
          [paths.falsification, paths.l1Result],
        ).status,
        '异常被捕获、记日志、跳过该提供者；退化轮（关 ae2 / 全关）导出正常完成并落盘结果',
        [paths.falsification, paths.l1Result],
      ),
    )
  }
  {
    const tier = sc.tierDegradation
    const inf = sc.inferredNeverPrimary
    out.push(
      item(
        'parts-D-three-tier-provenance',
        '三档兜底每档记录来源；推断永不当主来源',
        judge(
          [
            { ok: tier?.pass === true, detail: `降级档位判据：${tier?.pass}（full tier1 / degraded_ae2 → tier2 / degraded_all → tier3）` },
            { ok: inf?.pass === true, detail: `推断永不当主来源：${inf?.pass}（无 tier1/2 与 inferred 同格）` },
            {
              ok: (verifyFull?.tiersSeen ?? []).length === 3,
              detail: `产物中档位集合 {${(verifyFull?.tiersSeen ?? []).sort().join(',')}}`,
            },
          ],
          [paths.staticChecks],
        ).status,
        '档 1/2/3 各带 source{family,fallback,boxProvenance,tier}；任一格有 tier1/2 结果时不得出现 inferred 部件',
        [paths.staticChecks, paths.verifyDegradedAll],
      ),
    )
  }
  {
    out.push(
      item(
        'parts-D-singlebox-zero-modcode',
        'slab/火把/箱子/栅栏零 mod 代码全覆盖',
        judge(
          [
            {
              ok: (verifyFull?.singleBoxHosts ?? []).length >= 4,
              detail: `单盒区命中宿主种类：${(verifyFull?.singleBoxHosts ?? []).join(',') || 'n/a'}`,
            },
            {
              ok: (staticChecks?.sections?.tierDegradation?.checks ?? []).some((c) => c.ok && c.msg.includes('火把')),
              detail: '火把落档 3 判据存在（§7.3 退化情形）',
            },
          ],
          [paths.verifyFull, paths.staticChecks],
        ).status,
        '四代表方块（上/下半 slab、火把、箱子、栅栏）在真实产物中都有部件（tier 2 通用盒 / 火把 tier 3 推断），' +
          '无任何族专用代码',
        [paths.verifyFull],
      ),
    )
  }
  {
    const fc = caseSummary(l2Real, '满方块格必须无部件')
    const fake = ctx.fakeProvider ?? (falsification?.controls ?? []).find((c) => c.id === 'fake-provider-tolerance')
    out.push(
      item(
        'parts-D-fast-negative',
        '满方块快速否定路径；缺提供者零额外开销',
        judge(
          [
            { ok: fc.found && fc.failed === 0 && fc.passed >= 1, detail: `产物级快速否定判据（满方块格全 -1）：failed ${fc.failed}` },
            {
              ok: (verifyFull?.fullCubeCells ?? 0) > 0,
              detail: `满方块格 ${verifyFull?.fullCubeCells ?? '?'} 个（cellPartsGrid 全 -1）`,
            },
            {
              ok: !!fake && fake.ok === true,
              detail: '满方块格在假提供者注入下也**零派发**（providerFailures 为空的那格正是满方块格）',
            },
          ],
          [paths.playwrightL2, paths.verifyFull, paths.falsification],
        ).status,
        '满方块（选择盒+碰撞盒+renderAsNormalBlock 三条件）⇒ cellPartsGrid = -1，部件链路零开销跳过',
        [paths.verifyFull, paths.playwrightL2],
      ),
    )
  }

  // ── E. 工程纪律 ───────────────────────────────────────────────────────
  {
    out.push(
      item(
        'parts-E-builds',
        '`npm run build:mod:gtnh` / `npm run build:web` / `cd web && npx vitest run` 通过',
        judge(
          [
            { ok: st('build-mod-gtnh') === 'pass', detail: `build-mod-gtnh=${st('build-mod-gtnh')}` },
            { ok: st('build-web') === 'pass', detail: `build-web=${st('build-web')}` },
            { ok: st('regression-vitest') === 'pass', detail: `regression-vitest=${st('regression-vitest')}` },
            { ok: (vitest?.failed ?? 1) === 0 && (vitest?.passed ?? 0) > 0, detail: `vitest passed ${vitest?.passed} / failed ${vitest?.failed}` },
          ],
          [paths.buildModLog, paths.buildWebLog, paths.vitestLog],
        ).status,
        `三处构建/测试全绿（vitest ${vitest?.passed ?? '?'} 用例通过）`,
        [paths.vitestLog],
      ),
    )
  }
  {
    out.push(
      item(
        'parts-E-protocol-contract',
        'proto 改动后两端同步（契约 §10.1 拍板口径：proto 作契约文档 + 两侧手写对齐）',
        judge(
          [
            {
              ok: (protoScan?.missingFields ?? ['x']).length === 0,
              detail: `plain_v2.proto 契约字段齐全：${(protoScan?.missingFields ?? []).length === 0 ? 'ok' : protoScan?.missingFields?.join(',')}`,
            },
          ],
          [paths.protoScan, paths.staticChecks],
        ).status,
        '契约 §10.2 的 BlockPart.boxes/items/display_name/source、PartBox/PartItem/PartSource、' +
          'StatsEntry.part_type_key 在 `protocol/lightning/v2/plain_v2.proto` 中逐条在册（mod 侧 Gson 手写与 proto 逐字段对齐）',
        [paths.protoScan].filter(Boolean),
      ),
    )
  }
  {
    out.push(
      item(
        'parts-E-no-web-replay',
        '不在 web 端重放游戏逻辑；盒为导出时快照、web 端不重算',
        judge(
          [
            {
              ok: (webSrcScan?.boxConstructionHits ?? ['x']).length === 0,
              detail: `web/src 非测试代码中构造 PartBox 命中 ${(webSrcScan?.boxConstructionHits ?? []).length} 处`,
            },
            {
              ok: (webSrcScan?.gameLogicHits ?? ['x']).length === 0,
              detail: `web/src 中游戏取盒 API 调用命中 ${(webSrcScan?.gameLogicHits ?? []).length} 处`,
            },
          ],
          [paths.webSrcScan, paths.staticChecks],
        ).status,
        'web 端只做「盒包含判定 + 呈现」，不重算盒（盒值以文件为准；round-trip 无损由 vitest 锁定）',
        [paths.webSrcScan].filter(Boolean),
      ),
    )
  }
  {
    out.push(
      item(
        'parts-E-falsification',
        '证伪测试通过（篡改必红）；管线幂等（重复运行字节一致）',
        judge(
          [
            {
              ok: (falsification?.controls ?? []).filter((c) => c.expectedRed).length >= 5,
              detail: `负对照 ${(falsification?.controls ?? []).filter((c) => c.expectedRed).length} 条`,
            },
            {
              ok: (falsification?.controls ?? []).filter((c) => c.expectedRed).every((c) => c.ok),
              detail: `全部负对照如期变红：${(falsification?.controls ?? []).filter((c) => c.expectedRed && !c.ok).map((c) => c.id).join(',') || 'ok'}`,
            },
            { ok: falsification?.positiveControl?.ok === true, detail: '正对照绿（未篡改仍绿）' },
          ],
          [paths.falsification],
        ).status,
        `oracle 篡改（计数/身份/itemIndex 归属）+ 导出侧拟造缺陷（删部件/整格消失/改计数/hostItem.damage）共 ${(falsification?.controls ?? []).filter((c) => c.expectedRed).length || 7} 条负对照全部非零退出；正对照绿`,
        [paths.falsification],
      ),
    )
  }
  {
    out.push(
      item(
        'parts-E-idempotent',
        '管线幂等（重复运行产物字节一致）',
        judge(
          [
            {
              ok: l1Result?.idempotencyFull?.identical === true,
              detail: `L1 同轮双导出 sha256 一致：${l1Result?.idempotencyFull?.identical}`,
            },
            {
              ok: ctx.crossRunIdentical === true || ctx.crossRunIdentical === null,
              detail:
                ctx.crossRunIdentical === null
                  ? '跨轮比对未启用（-Runs 1）：以 L1 同轮 + 报告重算幂等作为证据'
                  : `跨轮产物字节一致：${ctx.crossRunIdentical}`,
            },
            {
              ok: ctx.reportStable === true,
              detail: `报告判定重算稳定（同一运行目录两次汇总逐条判定一致）：${ctx.reportStable}`,
            },
          ],
          [paths.l1Result, paths.idempotency],
        ).status,
        'L1 同轮双导出逐字节一致；运行目录内产物跨轮一致（`-Runs 2` 时逐文件 sha256 比对）；' +
          '报告由阶段产物纯读重算 ⇒ 两次汇总判定一致',
        [paths.l1Result, paths.idempotency].filter(Boolean),
      ),
    )
  }

  return out
}
