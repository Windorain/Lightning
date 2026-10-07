#!/usr/bin/env node
/**
 * check-criteria-types.mjs —— 判据类型自描述的**三方对账**（#103 G7）
 * ============================================================================
 *
 * 三方是谁（`docs/control-plane/case-file.md §5.1`）：
 *
 *   ① **自描述端点**（唯一权威）：`case.validate` 的 `result.criteriaTypes`
 *      —— 数据源 `CriteriaEngine.typeCatalog()`，经 `POST /cp/v1/actions/case.validate` 取。
 *   ② **注册表**：`CriteriaEngine.TYPES`（判「未知判据类型」用）——由单测
 *      `CaseParserTest#criteriaTypeCatalogContentIsLocked` 机械锁死与 ① 同序同内容。
 *   ③ **契约文档**：`docs/control-plane/case-file.md §5.1` 的两张表（type/since 表 + 判据表）。
 *
 * 本脚本负责 ① ↔ ③（以及 ① ↔ 快照 `test/criteria/criteria-types.json`）的那一半——
 * 单测负责 ① ↔ ②。三方都对齐，才叫「无漂移」。
 *
 * 用法：
 *   node check-criteria-types.mjs --print                    # 从**实机端点**取快照并打印（需客户端在跑）
 *   node check-criteria-types.mjs --check <snapshot.json>    # 快照 ↔ 文档离线对账（不需客户端）
 *   node check-criteria-types.mjs --check <snapshot.json> --live   # 快照 ↔ 文档 ↔ 实机端点三方对账
 *   node check-criteria-types.mjs --help
 *
 * 退出码：0=一致 / 2=有漂移（逐条指名）/ 3=设施错误（读不到端点或文档）。
 *
 * 零依赖：只用 Node 内置模块（Node 18+ 的全局 fetch；本仓 Node 22）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_OK = 0;
const EXIT_DRIFT = 2;
const EXIT_FACILITY = 3;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** 本脚本所在仓的根（test/criteria/ → ../..）。 */
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_MC_DIR = join(REPO_ROOT, 'mod', 'gtnh', 'run', 'client');
const DOC_PATH = join(REPO_ROOT, 'docs', 'control-plane', 'case-file.md');

// --------------------------------------------------------------------------- 文档解析

/**
 * 从 `case-file.md §5.1` 解析出 `{type → since}` 与 `{type → params}`。
 *
 * 解析的是**文档里的两张表**：
 *   - 「判据类型的引入版本」表：`| \`a\` / \`b\` | 1.0 |`
 *   - §5 的判据表：`| \`artifact-exists\` | \`path\` | 语义 |`
 *
 * 刻意用「解析文档」而不是「文档里再写一份 JSON」：要证明的恰恰是**文档本身**没漂。
 */
function parseDoc(text) {
  const lines = text.split(/\r?\n/);
  const since = new Map();
  const params = new Map();
  const order = [];

  // ① 「判据类型的引入版本」表：| `a` / `b` | 1.0 |
  let inSinceTable = false;
  for (const line of lines) {
    if (line.includes('判据类型的引入版本')) {
      inSinceTable = true;
      continue;
    }
    if (inSinceTable) {
      if (!line.trim().startsWith('|')) {
        if (since.size > 0) inSinceTable = false;
        continue;
      }
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 4) continue;
      const names = [...cells[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
      const v = cells[2];
      if (names.length && /^\d+\.\d+$/.test(v)) {
        for (const n of names) since.set(n, v);
      }
    }
  }

  // ② §5 的判据表：| `type` | `params` | 语义 |
  let inCriteriaTable = false;
  for (const line of lines) {
    if (/^\|\s*type\s*\|\s*params\s*\|/.test(line)) {
      inCriteriaTable = true;
      continue;
    }
    if (inCriteriaTable) {
      if (!line.trim().startsWith('|')) {
        inCriteriaTable = false;
        continue;
      }
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 4) continue;
      const m = cells[1].match(/^`([a-z-]+)`/);
      if (!m) continue;
      params.set(m[1], cells[2].replace(/^`|`$/g, ''));
      order.push(m[1]);
    }
  }

  return { since, params, order };
}

/** 文档里在 §5.1 声明的 since 表（含分组写法），按文档顺序展开成逐类型表。 */
function docSinceMap(doc) {
  const out = new Map();
  // §5.1 的引入版本表把同 since 的类型写在一行（`a` / `b` / ...）
  for (const [type, v] of doc.since) out.set(type, v);
  return out;
}

// --------------------------------------------------------------------------- 端点

async function fetchFromEndpoint(mcDir) {
  const serverPath = join(mcDir, 'controlplane', 'server.json');
  const tokensPath = join(mcDir, 'controlplane', 'tokens.json');
  if (!existsSync(serverPath)) {
    throw new FacilityError(`server.json 不存在: ${serverPath}（客户端没起，或控制面未启用）`);
  }
  if (!existsSync(tokensPath)) {
    throw new FacilityError(`tokens.json 不存在: ${tokensPath}`);
  }
  const server = JSON.parse(readFileSync(serverPath, 'utf8'));
  const tokens = JSON.parse(readFileSync(tokensPath, 'utf8'));
  const port = server.port;
  const token = tokens.tokens && tokens.tokens.observe;
  if (!port || !token) {
    throw new FacilityError(`server.json 缺 port，或 tokens.json 缺 observe token`);
  }
  const base = `http://127.0.0.1:${port}/cp/v1`;

  // case.validate 是 observe 级同步动作，用最小内联用例即可（它不碰世界）
  const inline = {
    schema: 'lightning.case/1',
    id: 'criteria-types-probe',
    world: { folder: 'cp_criteria_types_probe', seed: 1, void: true },
    criteria: [
      {
        id: 'noop',
        type: 'artifact-exists',
        params: { path: 'manifest.json' },
      },
    ],
    evidence: { expect: [] },
  };
  const url = `${base}/actions/case.validate?sync=true&timeoutMs=10000`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inline }),
    });
  } catch (e) {
    throw new FacilityError(`连不上控制面 ${url}：${e.message}`);
  }
  const body = await resp.json();
  if (!body.ok) {
    throw new FacilityError(`case.validate 失败：${JSON.stringify(body.error)}`);
  }
  const types = body.data && body.data.criteriaTypes;
  if (!Array.isArray(types)) {
    throw new FacilityError('case.validate 的返回里没有 criteriaTypes 数组（契约漂移？）');
  }
  return { types, contractVersion: body.data.contractVersion || server.contractVersion || null };
}

class FacilityError extends Error {}

// --------------------------------------------------------------------------- 对账

/** 比较两个逐类型表，产出逐条差异。 */
function diffTypes(labelA, a, labelB, b) {
  const problems = [];
  const namesA = a.map((x) => x.type);
  const namesB = b.map((x) => x.type);
  if (namesA.join(',') !== namesB.join(',')) {
    problems.push(`类型集合/顺序不同：\n    ${labelA}=[${namesA.join(', ')}]\n    ${labelB}=[${namesB.join(', ')}]`);
  }
  const mapB = new Map(b.map((x) => [x.type, x]));
  for (const item of a) {
    const other = mapB.get(item.type);
    if (!other) continue;
    if (item.since !== other.since) {
      problems.push(`${item.type} 的 since 不同：${labelA}=${item.since} ${labelB}=${other.since}`);
    }
    if (item.params !== other.params) {
      problems.push(`${item.type} 的 params 不同：\n    ${labelA}=${JSON.stringify(item.params)}\n    ${labelB}=${JSON.stringify(other.params)}`);
    }
  }
  return problems;
}

// --------------------------------------------------------------------------- CLI

function usage() {
  return `用法:
  node check-criteria-types.mjs --print [--mc-dir <path>]         从实机端点取快照并打印 JSON
  node check-criteria-types.mjs --check <snapshot.json> [--live]  快照 ↔ 文档（↔ 实机端点）对账

对账三方见 docs/control-plane/case-file.md §5.1。
退出码：0=一致 / 2=有漂移 / 3=设施错误。`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--print') out.print = true;
    else if (a === '--check') out.check = argv[++i];
    else if (a === '--live') out.live = true;
    else if (a === '--mc-dir') out.mcDir = argv[++i];
    else {
      process.stderr.write(`未知参数: ${a}\n${usage()}\n`);
      process.exit(EXIT_FACILITY);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.print && !args.check)) {
    process.stdout.write(`${usage()}\n`);
    process.exit(args.help ? EXIT_OK : EXIT_FACILITY);
  }
  const mcDir = args.mcDir
    ? (isAbsolute(args.mcDir) ? args.mcDir : resolve(args.mcDir))
    : DEFAULT_MC_DIR;

  if (args.print) {
    const live = await fetchFromEndpoint(mcDir);
    const doc = { types: live.types };
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    process.stderr.write(`[criteria-types] 从实机端点取到 ${live.types.length} 条（contractVersion=${live.contractVersion}）\n`);
    process.exit(EXIT_OK);
  }

  // --check：快照 ↔ 文档（↔ 实机）
  const snapPath = isAbsolute(args.check) ? args.check : resolve(args.check);
  if (!existsSync(snapPath)) {
    process.stderr.write(`设施错误：快照不存在: ${snapPath}\n`);
    process.exit(EXIT_FACILITY);
  }
  if (!existsSync(DOC_PATH)) {
    process.stderr.write(`设施错误：契约文档不存在: ${DOC_PATH}\n`);
    process.exit(EXIT_FACILITY);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`设施错误：快照不是合法 JSON: ${e.message}\n`);
    process.exit(EXIT_FACILITY);
  }
  const snapTypes = snapshot.types;
  if (!Array.isArray(snapTypes)) {
    process.stderr.write(`设施错误：快照缺 types 数组\n`);
    process.exit(EXIT_FACILITY);
  }

  const docText = readFileSync(DOC_PATH, 'utf8');
  const parsed = parseDoc(docText);
  const sinceMap = docSinceMap(parsed);
  const docTypes = snapTypes.map((t) => ({
    type: t.type,
    since: sinceMap.get(t.type) || null,
    params: parsed.params.get(t.type) || null,
  }));

  const problems = [];
  problems.push(...diffTypes('快照', snapTypes, '文档', docTypes));

  // 文档里出现但快照没有的判据类型（文档多写了）
  for (const t of parsed.params.keys()) {
    if (!snapTypes.some((s) => s.type === t)) {
      problems.push(`文档 §5 的判据表里有 \`${t}\`，但快照（= 自描述端点）里没有——文档多写了一条`);
    }
  }

  let liveNote = '';
  if (args.live) {
    const live = await fetchFromEndpoint(mcDir);
    problems.push(...diffTypes('快照', snapTypes, '实机端点', live.types));
    liveNote = `；实机端点 ${live.types.length} 条（contractVersion=${live.contractVersion}）`;
  }

  process.stdout.write(`判据类型三方对账：快照 ${snapTypes.length} 条、文档 §5/§5.1 ${parsed.params.size} 条${liveNote}\n`);
  if (problems.length === 0) {
    process.stdout.write('  [GREEN] 无漂移（逐条 type/since/params 一致）\n');
    process.exit(EXIT_OK);
  }
  for (const p of problems) {
    process.stdout.write(`  [ RED ] ${p}\n`);
  }
  process.stdout.write(`\n共 ${problems.length} 处漂移。修法：以自描述端点为权威，改文档与快照向它对齐。\n`);
  process.exit(EXIT_DRIFT);
}

main().catch((e) => {
  if (e instanceof FacilityError) {
    process.stderr.write(`设施错误：${e.message}\n`);
    process.exit(EXIT_FACILITY);
  }
  process.stderr.write(`未预期错误：${e.stack || e.message}\n`);
  process.exit(EXIT_FACILITY);
});
