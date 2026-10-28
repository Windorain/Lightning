/**
 * 真实 deadline 证据的**逐 case 解析/校验**（纯函数，零依赖）。
 *
 * ## 为什么需要它
 *
 * 之前 runner 用全局正则匹配整段输出："有 [boot-probe:close] / 有 attribution" 就够了。
 * 那会把 case2 的 attribution 当成 case1 的、也数不清"逐 case 恰好一条 close"。
 * 本模块要求：
 *  - 每条用例在 stderr 第一行写 `[deadline-case] caseN <title>`；
 *  - 只在该 case 的 block 内找 close/budget/nav/attribution，**禁止跨 block/全局匹配**；
 *  - 每 block **恰好 1 条** `[boot-probe:close]`，再从它切出 **close 子块**（到下一个
 *    `[boot-probe]` 或下一条 close/case marker 为止）；budget/nav/attribution **必须都在
 *    该子块内**且顺序为 close → budget → nav → attribution。同 case 后续 error message
 *    里的另一组诊断字段**不算**（合法变体），close 只有 header 而 facts 落在后续
 *    `[boot-probe]` 则必须红；
 *  - 每 block 的 close / 预打印条数各自精确（deadline 证据要求 close=1、preprint=0）；
 *  - case1 绑定 `WorkbenchRoot.vue => net::ERR_FAILED` + `starts=1 commits=1`；case2 绑定
 *    `document ... => net::ERR_ABORTED` + `starts=1 commits=0 failures=1`；
 *    source 允许 `headroom|late`、close cause 允许 goto 中止或实际 page/context close
 *    （16 worker 慢加载下不硬绑时序），但上面的具体分类/nav 不放宽；
 *  - 预算行必须是 `basis=anchor-estimate` + `remaining-estimate=` + `actual-remaining=unknown`，
 *    不允许把估算写成实际剩余。
 *
 * ## 合成反例自测
 *
 * {@link syntheticValidatorSelfTest} 内置 6 个反例（case1 缺 attribution 由 case2 补、
 * 重复 close、缺 case、顺序错、close 晚于 budget、close 只有 header 而后继
 * `[boot-probe]` 才给 facts），以及 4 个合法变体（完整 fixture、close 子块完整且后续
 * error message 另有完整诊断、case1 source=late+close 模式、case2 close 模式），
 * **任何一个反例被误判为通过**自测就失败。
 * runner 每次运行都会先跑一遍自测。
 */

/** 两条证据用例的标题与绑定事实（标题与 spec 里的 marker 必须逐字一致）。 */
export const REAL_DEADLINE_CASES = Object.freeze([
  Object.freeze({
    id: 'case1',
    title: 'deadline 在 ready/采集期间：close 兜底须给出分类与预算事实',
    timeout: /Test timeout of 10000ms exceeded/,
    // 16 worker 慢加载下 source 可能是 headroom 或 late：不硬绑时序。
    budgetSource: /source=(?:headroom|late) /,
    nav: /^\[nav\] starts=1 commits=1 failures=0 pending=false$/m,
    attribution: /^\[attribution\].*模块\/入口请求失败 .*WorkbenchRoot\.vue.*net::ERR_FAILED/m,
    // close 可能是 close 事件，也可能是 goto 被 deadline 中止：两者都接受，实际 cause 照录。
    closeCause:
      /(页面在启动 pending 期间被关闭|启动 pending 期间页面被关闭|启动 pending 期间 goto 失败|page\.goto: net\.ERR_ABORTED|Target page, context or browser has been closed|Target closed)/,
    preprints: 0,
  }),
  Object.freeze({
    id: 'case2',
    title: 'deadline 落在 goto 期间：导航已发起未提交也须有 Node 事实',
    timeout: /Test timeout of 4000ms exceeded/,
    budgetSource: /source=(?:headroom|late) /,
    nav: /^\[nav\] starts=1 commits=0 failures=1 pending=false$/m,
    attribution: /^\[attribution\].*模块\/入口请求失败 .*document .*net::ERR_ABORTED/m,
    // close 事件可能先于 goto 的 reject：close 模式与 goto 模式都接受（核心分类不放宽）。
    closeCause:
      /(页面在启动 pending 期间被关闭|启动 pending 期间页面被关闭|启动 pending 期间 goto 失败|page\.goto: net::ERR_ABORTED|Target page, context or browser has been closed|Target closed)/,
    preprints: 0,
  }),
])

const CASE_MARKER = '[deadline-case] '

/**
 * 按 case marker 切块。marker 可能被 reporter 加上 ANSI/前缀，故用 `indexOf` 取
 * 行内第一次出现的位置；marker 之前的内容（vite 警告等）丢弃，不参与任何断言。
 */
export function parseDeadlineCaseBlocks(text) {
  const blocks = []
  let current = null
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const at = raw.indexOf(CASE_MARKER)
    if (at >= 0) {
      const payload = raw.slice(at + CASE_MARKER.length).trim()
      const space = payload.indexOf(' ')
      current = {
        id: space < 0 ? payload : payload.slice(0, space),
        title: space < 0 ? '' : payload.slice(space + 1),
        lines: [],
      }
      blocks.push(current)
      continue
    }
    if (current !== null) current.lines.push(raw)
  }
  return blocks
}

const findLines = (lines, needle) => lines.filter((line) => line.includes(needle))

/**
 * 从 close 行切出 **close 子块**：到下一个 `[boot-probe]`（后续 error message 的头）
 * 或下一条 `[boot-probe:close]` / case block 末尾为止。
 *
 * 这样事实绑定的是"close 兜底这一次输出"，而不是整个 case block —— 同 case 后面
 * error message 里的完整诊断（合法）不会被误当成 close 子块的事实；反之 close 只有
 * header、facts 落在后续 `[boot-probe]` 的坏形态必须判红。
 */
function closeSubBlockOf(lines, closeIdx) {
  if (closeIdx < 0) return []
  let end = lines.length
  for (let i = closeIdx + 1; i < lines.length; i++) {
    const text = lines[i].trimStart()
    if (text.startsWith('[boot-probe]') || text.startsWith('[boot-probe:close]')) {
      end = i
      break
    }
  }
  return lines.slice(closeIdx, end)
}

/**
 * 校验一个 case block，返回 facts 与错误列表（不抛错，便于 runner 汇总）。
 *
 * 预算/导航/归因只从 **close 子块**里取，并各自要求恰好 1 条、顺序 close→budget→nav→
 * attribution；close 与 preprint 条数按 spec 独立精确。
 */
function validateCaseBlock(block, spec) {
  const errors = []
  const lines = block.lines
  const closeLines = findLines(lines, '[boot-probe:close]')
  if (closeLines.length !== 1) {
    errors.push(`${spec.id}: [boot-probe:close] 必须恰好 1 条，实际 ${closeLines.length}`)
  }
  const preprintCount = findLines(lines, 'close 前 Node 兜底').length
  if (preprintCount !== spec.preprints) {
    errors.push(`${spec.id}: close 前预打印必须 ${spec.preprints} 条，实际 ${preprintCount}`)
  }
  const closeIdx = lines.findIndex((line) => line.includes('[boot-probe:close]'))
  const sub = closeSubBlockOf(lines, closeIdx)
  const budgetIdxs = sub.flatMap((line, i) => (line.startsWith('[budget] ') ? [i] : []))
  const navIdxs = sub.flatMap((line, i) => (line.startsWith('[nav] ') ? [i] : []))
  const attributionIdxs = sub.flatMap((line, i) => (line.startsWith('[attribution] ') ? [i] : []))
  for (const [label, idxs] of [
    ['[budget]', budgetIdxs],
    ['[nav]', navIdxs],
    ['[attribution]', attributionIdxs],
  ]) {
    if (idxs.length !== 1) {
      errors.push(`${spec.id}: close 子块内 ${label} 必须恰好 1 条，实际 ${idxs.length}`)
    }
  }
  const budgetLine = budgetIdxs.length === 1 ? sub[budgetIdxs[0]] : ''
  const navLine = navIdxs.length === 1 ? sub[navIdxs[0]] : ''
  const attributionLine = attributionIdxs.length === 1 ? sub[attributionIdxs[0]] : ''
  // close 子块内顺序：close(0) < budget < nav < attribution。
  if (budgetIdxs.length === 1 && budgetIdxs[0] === 0) {
    errors.push(`${spec.id}: [budget] 必须在 [boot-probe:close] 之后`)
  }
  if (budgetIdxs.length === 1 && navIdxs.length === 1 && navIdxs[0] <= budgetIdxs[0]) {
    errors.push(`${spec.id}: [nav] 必须晚于 [budget]`)
  }
  if (navIdxs.length === 1 && attributionIdxs.length === 1 && attributionIdxs[0] <= navIdxs[0]) {
    errors.push(`${spec.id}: [attribution] 必须晚于 [nav]`)
  }
  if (closeLines.length === 1 && !spec.closeCause.test(closeLines[0])) {
    errors.push(`${spec.id}: close 行未绑定预期 cause（${spec.closeCause}）`)
  }
  if (budgetLine !== '') {
    if (!/basis=anchor-estimate(?: |$)/.test(budgetLine)) {
      errors.push(`${spec.id}: budget 缺 basis=anchor-estimate`)
    }
    if (!/remaining-estimate=(?:\d+ms|none)(?: |$)/.test(budgetLine)) {
      errors.push(`${spec.id}: budget 缺 remaining-estimate 字段`)
    }
    if (!/actual-remaining=unknown(?: |$)/.test(budgetLine)) {
      errors.push(`${spec.id}: budget 缺 actual-remaining=unknown（不得把估算冒充实际）`)
    }
    if (spec.budgetSource !== null && !spec.budgetSource.test(budgetLine)) {
      errors.push(`${spec.id}: budget source 不符（${spec.budgetSource}）`)
    }
  }
  if (navLine !== '' && !spec.nav.test(navLine)) {
    errors.push(`${spec.id}: [nav] 不符（${spec.nav}): ${navLine}`)
  }
  if (attributionLine !== '' && !spec.attribution.test(attributionLine)) {
    errors.push(`${spec.id}: [attribution] 未绑定本 case 的事实: ${attributionLine}`)
  }
  return {
    ok: errors.length === 0,
    facts: {
      id: spec.id,
      close: closeLines[0] ?? null,
      budget: budgetLine || null,
      nav: navLine || null,
      attribution: attributionLine || null,
    },
    errors,
  }
}

/**
 * 逐 case 校验证据。
 *
 * @param {{ caseText: string, reporterText?: string, cases?: ReadonlyArray<any> }} input
 *   `caseText` = 含 case marker 的 stderr（或合并输出）；`reporterText` = reporter 输出，
 *   用于每条 case 的 `Test timeout` 出现次数。
 */
export function validateDeadlineEvidence({ caseText, reporterText = '', cases = REAL_DEADLINE_CASES }) {
  const blocks = parseDeadlineCaseBlocks(caseText)
  const errors = []
  if (blocks.length !== cases.length) {
    errors.push(`case 分块数必须是 ${cases.length}，实际 ${blocks.length}`)
  }
  const results = []
  for (let i = 0; i < cases.length; i++) {
    const spec = cases[i]
    const block = blocks[i]
    if (block === undefined) {
      results.push({ ok: false, facts: { id: spec.id }, errors: [`${spec.id}: 缺 case block`] })
      continue
    }
    const blockErrors = []
    if (block.id !== spec.id) blockErrors.push(`第 ${i + 1} 块应是 ${spec.id}，实际 ${block.id}（顺序错）`)
    if (block.title !== spec.title) blockErrors.push(`${spec.id}: 标题不符（marker 与 spec 漂移）`)
    const validated = validateCaseBlock(block, spec)
    const caseErrors = [...blockErrors, ...validated.errors]
    // 每条 case 的 Test timeout 恰一次（在 reporter 输出里）。
    const timeoutCount = (String(reporterText).match(new RegExp(spec.timeout.source, 'g')) ?? []).length
    if (timeoutCount !== 1) {
      caseErrors.push(`${spec.id}: reporter 里 Test timeout 必须恰好 1 次，实际 ${timeoutCount}`)
    }
    results.push({ ok: caseErrors.length === 0, facts: validated.facts, errors: caseErrors })
    errors.push(...caseErrors)
  }
  return { ok: errors.length === 0, blocks: blocks.length, cases: results, errors }
}

// ---------------------------------------------------------------------------
// 合成反例自测
// ---------------------------------------------------------------------------

const CLOSE1 =
  '[boot-probe:close] 启动 pending 期间页面被关闭（test deadline / 外部 close）⇒ 仅 Node 侧事实；未尝试 page.evaluate；原错误：页面在启动 pending 期间被关闭（test deadline / 外部 close）'
const BUDGET1 =
  '[budget] source=headroom anchor=first-goto basis=anchor-estimate test-timeout=10000ms elapsed=0ms wait-elapsed=1800ms entry-remaining-estimate=10000ms remaining-estimate=5200ms actual-remaining=unknown wait=1000ms page-probe=2000ms headroom=30000ms floor-broken=false exhausted=false'
// case1 的 late 合法变体：锚点仍晚（elapsed=0），等待开始已耗 7s ⇒ 剩余估算 3s。
const BUDGET1_LATE =
  '[budget] source=late anchor=first-goto basis=anchor-estimate test-timeout=10000ms elapsed=0ms wait-elapsed=7000ms entry-remaining-estimate=10000ms remaining-estimate=3000ms actual-remaining=unknown wait=250ms page-probe=2000ms headroom=30000ms floor-broken=true exhausted=false'
const NAV1 = '[nav] starts=1 commits=1 failures=0 pending=false'
const ATTR1 =
  '[attribution] 模块/入口请求失败 ×1（首个：script http://workbench.example/src/workbench/WorkbenchRoot.vue => net::ERR_FAILED）'
const CLOSE2 =
  '[boot-probe:close] 启动 pending 期间 goto 失败（页面关闭或导航中止）⇒ 仅 Node 侧事实；未尝试 page.evaluate；原错误：page.goto: net::ERR_ABORTED; maybe frame was detached?'
// case2 也可能先收到 close 事件（close 早于 goto 的 reject）：同一 case 的合法变体。
const CLOSE2_CLOSE =
  '[boot-probe:close] 启动 pending 期间页面被关闭（test deadline / 外部 close）⇒ 仅 Node 侧事实；未尝试 page.evaluate；原错误：页面在启动 pending 期间被关闭（test deadline / 外部 close）'
const BUDGET2 =
  '[budget] source=late anchor=first-goto basis=anchor-estimate test-timeout=4000ms elapsed=0ms wait-elapsed=8700ms entry-remaining-estimate=4000ms remaining-estimate=0ms actual-remaining=unknown wait=0ms page-probe=0ms headroom=30000ms floor-broken=true exhausted=true'
const NAV2 = '[nav] starts=1 commits=0 failures=1 pending=false'
const ATTR2 =
  '[attribution] 模块/入口请求失败 ×1（首个：document http://workbench.example/ => net::ERR_ABORTED）'

const marker = (spec) => `[deadline-case] ${spec.id} ${spec.title}`
const line = (...xs) => xs.join('\n')
const reporter = `${REAL_DEADLINE_CASES[0].timeout.source}\n${REAL_DEADLINE_CASES[1].timeout.source}`

/**
 * 构造合成 stderr 证据（仅供自测/单测；`opts` 用于制造反例）。
 *
 * @param {{ omitCase1Attribution?: boolean, duplicateClose?: boolean, omitCase2?: boolean,
 *   swap?: boolean, budgetBeforeClose?: boolean, closeHeaderOnlyThenFullDiagnostic?: boolean,
 *   closeFactsPlusLaterDiagnostic?: boolean, case1LateCloseMode?: boolean,
 *   case2CloseMode?: boolean }} [opts]
 */
export function buildSyntheticDeadlineFixture(opts = {}) {
  const {
    omitCase1Attribution = false,
    duplicateClose = false,
    omitCase2 = false,
    swap = false,
    budgetBeforeClose = false,
    closeHeaderOnlyThenFullDiagnostic = false,
    closeFactsPlusLaterDiagnostic = false,
    case1LateCloseMode = false,
    case2CloseMode = false,
  } = opts
  const FULL_DIAG = line(
    '[boot-probe] ready 等待失败：预算 1000ms（显式指定）；原错误：page.waitForFunction: Timeout 1000ms exceeded.',
    BUDGET1,
    NAV1,
    ATTR1,
  )
  let case1Full
  if (case1LateCloseMode) {
    // 合法变体：case1 source=late + close 模式（timeout 仍 10s，锚点仍晚）。
    case1Full = line(marker(REAL_DEADLINE_CASES[0]), CLOSE1, BUDGET1_LATE, NAV1, ATTR1)
  } else if (closeHeaderOnlyThenFullDiagnostic) {
    // 反例：close 子块只有 header；同 case 后续 [boot-probe] 才提供完整 facts。
    case1Full = line(marker(REAL_DEADLINE_CASES[0]), CLOSE1, FULL_DIAG)
  } else if (closeFactsPlusLaterDiagnostic) {
    // 合法变体：close 子块自身完整；后续 error message 另有完整诊断（不得据此假红）。
    case1Full = line(
      marker(REAL_DEADLINE_CASES[0]),
      CLOSE1,
      BUDGET1,
      NAV1,
      ATTR1,
      FULL_DIAG,
    )
  } else {
    const case1Head = budgetBeforeClose
      ? line(marker(REAL_DEADLINE_CASES[0]), BUDGET1, CLOSE1)
      : line(marker(REAL_DEADLINE_CASES[0]), CLOSE1, BUDGET1)
    case1Full = line(
      case1Head,
      duplicateClose ? CLOSE1 : '',
      NAV1,
      omitCase1Attribution ? '' : ATTR1,
    )
  }
  const close2 = case2CloseMode ? CLOSE2_CLOSE : CLOSE2
  const case2 = line(marker(REAL_DEADLINE_CASES[1]), close2, BUDGET2, NAV2, ATTR2)
  return swap ? line(case2, case1Full) : line(case1Full, omitCase2 ? '' : case2)
}

/**
 * 内置反例自测：4 个合法变体必须通过；6 个合成反例必须全部被判红。
 * 返回 `{ ok, checks: [{ name, ok, detail }] }`。
 */
export function syntheticValidatorSelfTest() {
  const checks = []
  const run = (name, opts, expectedOk) => {
    const verdict = validateDeadlineEvidence({
      caseText: buildSyntheticDeadlineFixture(opts),
      reporterText: reporter,
    })
    const ok = verdict.ok === expectedOk
    checks.push({
      name,
      ok,
      detail: ok ? '' : `expected ok=${expectedOk}, got ok=${verdict.ok}; errors=${verdict.errors.join(' | ')}`,
    })
  }
  run('valid', {}, true)
  run(
    '合法变体：close 子块完整，后续 error message 另有完整诊断',
    { closeFactsPlusLaterDiagnostic: true },
    true,
  )
  run('合法变体：case1 source=late + close 模式', { case1LateCloseMode: true }, true)
  run('合法变体：case2 close 模式（close 先于 goto reject）', { case2CloseMode: true }, true)
  run('case1 缺 attribution 但 case2 有（全局匹配会误绿）', { omitCase1Attribution: true }, false)
  run('case1 重复 close', { duplicateClose: true }, false)
  run('缺 case2', { omitCase2: true }, false)
  run('case 顺序错', { swap: true }, false)
  run('close 晚于 budget（顺序错）', { budgetBeforeClose: true }, false)
  run(
    'close 只有 header，同 case 后续完整 [boot-probe] 提供 facts',
    { closeHeaderOnlyThenFullDiagnostic: true },
    false,
  )
  return { ok: checks.every((c) => c.ok), checks }
}
