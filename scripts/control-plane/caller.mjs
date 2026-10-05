#!/usr/bin/env node
/**
 * caller.mjs —— 控制面契约 v1 的「无先验知识」调用方（PR-1 验收锚之一）
 * ============================================================================
 *
 * 设计约束（不可放宽，写在最前面）：
 *
 *   本脚本**刻意不硬编码任何动作的参数知识**。动作是否存在、有哪些参数、哪个必填、
 *   可选参数的默认值、动作属于哪一级权限、是否需要 confirm —— 全部来自
 *   `GET /cp/v1/actions` 的自描述（contract.md §2）。脚本里唯一与具体动作无关的
 *   常量是**契约级控制字段**（`confirm` / `sync` / `timeoutMs`）与**响应信封**
 *   （`{ok,data}` / `{ok:false,error:{code,message,context}}`），它们由 contract.md
 *   §1.6 与 §2 定义，属于契约而不是动作知识。
 *
 *   因此本脚本可以对着任何按契约 v1 自描述的控制面调用任何动作，包括它从未见过的
 *   动作（PR-2 的 shot.multi / capture.* 也一样）——这正是「自描述即可调用」的验收点。
 *
 * 用法：
 *   node caller.mjs <actionName> [paramsJson] [options]
 *     paramsJson            JSON 对象字面量；以 @ 开头视为「从该文件读取 JSON」
 *   选项：
 *     --tier observe|scene|forensic  强制使用该级 token（默认：动作自描述声明的级）
 *     --sync                         用 ?sync=true&timeoutMs=N 阻塞式提交
 *     --timeoutMs N                  总超时（毫秒），默认 60000；同步提交也用它
 *     --poll-intervalMs N            异步轮询间隔（毫秒），默认 500
 *     --mc-dir <path>                mcDataDir（含 controlplane/)；默认 mod/gtnh/run/client
 *     --no-confirm                   不自动补 confirm:true（负测试用，预期 CP-CONFIRM-001）
 *     --allow-unknown-params         放行自描述未声明的参数（默认直接报错，便于定位契约漂移）
 *     --json-out <path>              把最终作业 JSON（或错误信封）另存一份，供脚本机读
 *     --describe                     只打印该动作的自描述 JSON（纯 JSON 到 stdout）后退出
 *     --actions                      只打印整份动作目录 JSON（纯 JSON 到 stdout）后退出
 *     --help
 *
 * 发现顺序（契约规定的唯一权威来源）：
 *   1. `<mcDataDir>/controlplane/server.json` → `port`（+ `bind`/`contractVersion`/`pid`）
 *   2. `<mcDataDir>/controlplane/tokens.json` → `tokens.{observe,scene,forensic}`
 *
 * 退出码：0 = 作业 done；1 = 调用错误（HTTP 4xx/5xx 或本地用法错误）；2 = 作业 failed；
 *         3 = 超时（作业仍在跑，未取消——契约 §2「超时不是错误」）。
 *
 * 零依赖：只用 Node 内置模块（Node 18+ 的全局 fetch；本仓 Node 22）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_DONE = 0;
const EXIT_CALL_ERROR = 1;
const EXIT_JOB_FAILED = 2;
const EXIT_TIMEOUT = 3;

const TIERS = ['observe', 'scene', 'forensic'];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** 本脚本所在仓的根（scripts/control-plane/ → ../..）。 */
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
/** 默认 mcDataDir（与 scripts/parts-acceptance 的口径一致）。 */
const DEFAULT_MC_DIR = join(REPO_ROOT, 'mod', 'gtnh', 'run', 'client');

// --------------------------------------------------------------------------- 日志

let jsonOnly = false;

/** 人类可读的关键事实（--describe/--actions 模式下走 stderr，保证 stdout 是纯 JSON）。 */
function say(msg) {
  const line = `[cp-caller] ${msg}`;
  if (jsonOnly) {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

function sayErr(msg) {
  process.stderr.write(`[cp-caller] ${msg}\n`);
}

function usage() {
  return `用法: node caller.mjs <actionName> [paramsJson] [options]
  paramsJson  JSON 对象字面量，或 @<file> 从文件读取
  --tier observe|scene|forensic   强制权限级（默认取动作自描述声明的级）
  --sync                          同步提交（?sync=true&timeoutMs=N）
  --timeoutMs N                   总超时毫秒（默认 60000）
  --poll-intervalMs N             异步轮询间隔毫秒（默认 500）
  --mc-dir <path>                 mcDataDir（默认 ${DEFAULT_MC_DIR}）
  --no-confirm                    不自动补 confirm:true（负测试）
  --allow-unknown-params          放行自描述未声明的参数
  --json-out <path>               最终作业 JSON 另存路径
  --describe                      打印动作自描述 JSON 后退出
  --actions                       打印动作目录 JSON 后退出
  --help
退出码: 0=done 1=调用错误 2=作业 failed 3=超时`;
}

// --------------------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const opts = {
    tier: null,
    sync: false,
    timeoutMs: 60000,
    pollIntervalMs: 500,
    mcDir: null,
    noConfirm: false,
    allowUnknownParams: false,
    jsonOut: null,
    describe: false,
    actions: false,
    help: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (name) => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`选项 ${name} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--tier':
        opts.tier = next(a);
        break;
      case '--sync':
        opts.sync = true;
        break;
      case '--timeoutMs':
        opts.timeoutMs = intArg(a, next(a));
        break;
      case '--poll-intervalMs':
      case '--pollIntervalMs':
        opts.pollIntervalMs = intArg(a, next(a));
        break;
      case '--mc-dir':
      case '--mcDir':
        opts.mcDir = next(a);
        break;
      case '--no-confirm':
        opts.noConfirm = true;
        break;
      case '--allow-unknown-params':
        opts.allowUnknownParams = true;
        break;
      case '--json-out':
      case '--jsonOut':
        opts.jsonOut = next(a);
        break;
      case '--describe':
        opts.describe = true;
        break;
      case '--actions':
        opts.actions = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (a.startsWith('--')) throw new Error(`未知选项: ${a}`);
        positionals.push(a);
    }
  }
  if (opts.tier !== null && !TIERS.includes(opts.tier)) {
    throw new Error(`--tier 只接受 ${TIERS.join('|')}，收到 ${opts.tier}`);
  }
  if (opts.timeoutMs < 0 || opts.pollIntervalMs < 0) throw new Error('超时/轮询间隔不得为负');
  opts.action = positionals[0] ?? null;
  opts.paramsArg = positionals[1] ?? null;
  if (positionals.length > 2) throw new Error(`多余的参数: ${positionals.slice(2).join(' ')}`);
  return opts;
}

function intArg(name, v) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`选项 ${name} 需要整数，收到 ${v}`);
  return n;
}

/** 解析调用参数：JSON 字面量或 @file。 */
function readParams(paramsArg) {
  if (paramsArg === null || paramsArg === undefined || paramsArg.trim() === '') return {};
  let text = paramsArg;
  if (paramsArg.startsWith('@')) {
    const f = paramsArg.slice(1);
    text = readFileSync(f, 'utf8');
  }
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`paramsJson 不是合法 JSON: ${e.message}`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('paramsJson 须为 JSON 对象（{...}）');
  }
  return v;
}

// --------------------------------------------------------------------------- 发现

function readJsonFile(file, what) {
  if (!existsSync(file)) throw new Error(`找不到 ${what}: ${file}`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`读取 ${what} 失败: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} 不是合法 JSON: ${e.message}`);
  }
}

/** 读 tokens.json（契约 §1.4；兼容 {tokens:{...}} 与扁平两种形态，与 TokenStore 一致）。 */
function loadTokens(mcDir) {
  const file = join(mcDir, 'controlplane', 'tokens.json');
  const root = readJsonFile(file, 'tokens.json');
  const src = root && typeof root.tokens === 'object' && root.tokens !== null ? root.tokens : root;
  const out = {};
  for (const t of TIERS) {
    const v = src?.[t];
    out[t] = typeof v === 'string' ? v.trim() : '';
  }
  say(`tokens.json: schema=${root?.schema ?? '(无)'} 三级 token: ` +
    TIERS.map((t) => `${t}=${out[t] ? '有' : '缺'}`).join(' '));
  return out;
}

/** 读 server.json 并算出 base URL（契约 §1.3：port 是权威来源）。 */
function loadServer(mcDir) {
  const file = join(mcDir, 'controlplane', 'server.json');
  const s = readJsonFile(file, 'server.json');
  const port = s.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`server.json 的 port 非法: ${JSON.stringify(s.port)}`);
  }
  let host = typeof s.bind === 'string' && s.bind.trim() !== '' ? s.bind.trim() : '127.0.0.1';
  if (host === '0.0.0.0' || host === '::' || host === '::0' || host === '*') host = '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`; // IPv6 字面量
  say(`server.json: port=${port} bind=${s.bind ?? '(无)'} contractVersion=${s.contractVersion ?? '(无)'} ` +
    `pid=${s.pid ?? '(无)'} boundAt=${s.boundAt ?? '(无)'} → ${`http://${host}:${port}`}`);
  return { base: `http://${host}:${port}`, port, raw: s };
}

// --------------------------------------------------------------------------- HTTP

/** 单一请求；返回 {status, ok, body, text}。网络层异常向上抛。 */
async function request(url, { token, method = 'GET', body, timeoutMs = 20000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
  } catch (e) {
    const err = new Error(`请求失败 ${method} ${url}: ${e.name === 'TimeoutError' ? '客户端超时' : e.message}`);
    err.network = true;
    throw err;
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, ok: res.ok, body: parsed, text };
}

/** 取信封里的 error（契约 §2）。 */
function envelopeError(res) {
  const err = res.body?.error;
  if (err && typeof err === 'object') return err;
  return { code: `HTTP-${res.status}`, message: (res.text || '').slice(0, 400) || '(无响应体)' };
}

// --------------------------------------------------------------------------- 自描述

function describeAction(catalog, name) {
  const list = Array.isArray(catalog?.actions) ? catalog.actions : [];
  return list.find((a) => a?.name === name) ?? null;
}

function paramNames(desc) {
  return (Array.isArray(desc?.params) ? desc.params : []).map((p) => `${p.name}:${p.type}${p.required ? '(必填)' : ''}`);
}

/**
 * 按自描述构造调用体：校验动作存在 → 校验必填参数 → 未提供的选填参数补默认值。
 * 任何「参数名不在自描述里」都直接报错，避免把契约漂移伪装成服务端 CP-VALID-002。
 */
function buildBody(desc, provided, opts) {
  const declared = Array.isArray(desc.params) ? desc.params : [];
  const byName = new Map(declared.map((p) => [p.name, p]));
  const body = { ...provided };

  const missing = declared.filter((p) => p.required && !(p.name in body)).map((p) => p.name);
  if (missing.length > 0) {
    throw new Error(`缺少必填参数 ${missing.join(', ')}；自描述参数: ${paramNames(desc).join(', ') || '(无)'}`);
  }

  const filled = [];
  for (const p of declared) {
    if (!(p.name in body) && Object.prototype.hasOwnProperty.call(p, 'default') && p.default !== null) {
      body[p.name] = p.default;
      filled.push(p.name);
    }
  }
  if (filled.length > 0) say(`选填参数按自描述默认值补齐: ${filled.join(', ')}`);

  const unknown = Object.keys(body).filter((k) => k !== 'confirm' && !byName.has(k));
  if (unknown.length > 0 && !opts.allowUnknownParams) {
    throw new Error(
      `参数未在自描述中声明: ${unknown.join(', ')}；自描述参数: ${paramNames(desc).join(', ') || '(无)'}` +
      '（确需直传请加 --allow-unknown-params）');
  }
  if (unknown.length > 0) sayErr(`WARN 自描述未声明的参数将被直传: ${unknown.join(', ')}`);

  // 类型粗检（只告警不阻断：服务端才是权威校验者）
  for (const [k, v] of Object.entries(body)) {
    const p = byName.get(k);
    if (!p) continue;
    const t = p.type;
    const bad =
      (t === 'array' && !Array.isArray(v)) ||
      (t === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) ||
      (t === 'string' && typeof v !== 'string') ||
      (t === 'path' && typeof v !== 'string') ||
      (t === 'boolean' && typeof v !== 'boolean') ||
      ((t === 'int' || t === 'number') && typeof v !== 'number');
    if (bad) sayErr(`WARN 参数 ${k} 声明类型 ${t}，实传 ${Array.isArray(v) ? 'array' : typeof v}`);
  }
  return body;
}

// --------------------------------------------------------------------------- 作业

function jobIdOf(data) {
  const id = data?.jobId ?? data?.id ?? null;
  return typeof id === 'string' && id !== '' ? id : null;
}

function isFinished(state) {
  return state === 'done' || state === 'failed';
}

/** 结果里的判据结论摘要（有就打印，没有就跳过——不假设任何动作的返回结构）。 */
function summarizeVerdicts(data) {
  const found = [];
  const walk = (n) => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const i of n) walk(i);
      return;
    }
    if (typeof n.verdict === 'string' && (typeof n.id === 'string' || typeof n.criteriaId === 'string')) {
      found.push({ id: n.id ?? n.criteriaId, verdict: n.verdict });
    }
    for (const v of Object.values(n)) walk(v);
  };
  walk(data);
  if (found.length === 0) return;
  const counts = {};
  for (const f of found) counts[f.verdict] = (counts[f.verdict] ?? 0) + 1;
  say(`结果中的判据结论 ${found.length} 条: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  for (const f of found) say(`  - ${f.id} → ${f.verdict}`);
}

function writeJsonOut(file, payload) {
  if (!file) return;
  const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  say(`作业 JSON 已另存: ${abs}`);
}

/** 收尾：打印关键事实 + 最后打印作业 JSON，并决定退出码。 */
function finish(job, { timedOut = false, jsonOut = null } = {}) {
  const state = job?.state ?? '(未知)';
  const code = job?.error?.code ?? null;
  say(`终态: state=${state}${code ? ` errorCode=${code}` : ''} runId=${job?.runId ?? '(无)'} ` +
    `progress=${job?.progress ?? '(无)'}${timedOut ? '  【客户端超时，作业未取消】' : ''}`);
  if (job?.error) say(`错误: ${JSON.stringify(job.error)}`);
  if (job?.result) summarizeVerdicts(job.result);
  const payload = timedOut ? { ...(job ?? {}), callerTimeout: true } : job;
  writeJsonOut(jsonOut, payload);
  if (!jsonOnly) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (timedOut) return EXIT_TIMEOUT;
  if (state === 'failed') return EXIT_JOB_FAILED;
  return EXIT_DONE;
}

// --------------------------------------------------------------------------- 主流程

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_DONE;
  }
  if (!opts.action && !opts.actions) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_CALL_ERROR;
  }
  jsonOnly = opts.describe || opts.actions;

  const mcDir = opts.mcDir ? resolve(opts.mcDir) : DEFAULT_MC_DIR;
  say(`mcDataDir=${mcDir}`);
  const tokens = loadTokens(mcDir);
  const server = loadServer(mcDir);

  // 读动作目录：先挑一个能用的 token（自描述端点是 observe 级，任何一级都够）
  const discoveryTier = opts.tier ?? (tokens.observe ? 'observe' : TIERS.find((t) => tokens[t]) ?? null);
  if (!discoveryTier || !tokens[discoveryTier]) {
    throw new Error(`tokens.json 里没有任何可用 token（${TIERS.join('/')} 全空），无法读取 /cp/v1/actions`);
  }
  const catalogRes = await request(`${server.base}/cp/v1/actions`, { token: tokens[discoveryTier], timeoutMs: 15000 });
  if (!catalogRes.body?.ok) {
    const e = envelopeError(catalogRes);
    return callError(opts, catalogRes.status, e);
  }
  const catalog = catalogRes.body.data ?? {};
  say(`契约版本 contractVersion=${catalog.contractVersion ?? '(未报)'} 动作数=${catalog.count ?? (catalog.actions ?? []).length}`);

  if (opts.actions) {
    writeJsonOut(opts.jsonOut, catalog);
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    return EXIT_DONE;
  }

  const desc = describeAction(catalog, opts.action);
  if (!desc) {
    const names = (catalog.actions ?? []).map((a) => a.name).join(', ') || '(空)';
    throw new Error(`未知动作 ${opts.action}（CP-VALID-001）；自描述里的动作: ${names}`);
  }
  say(`动作 ${desc.name}: tier=${desc.tier} confirmRequired=${desc.confirmRequired === true} ` +
    `since=${desc.since ?? '(无)'} writable=${desc.writable === true}`);
  say(`自描述参数: ${paramNames(desc).join(', ') || '(无)'}`);

  if (opts.describe) {
    writeJsonOut(opts.jsonOut, desc);
    process.stdout.write(`${JSON.stringify(desc, null, 2)}\n`);
    return EXIT_DONE;
  }

  const tier = opts.tier ?? desc.tier ?? 'observe';
  if (!TIERS.includes(tier)) throw new Error(`动作自描述声明的 tier 非法: ${tier}`);
  const token = tokens[tier];
  if (!token) throw new Error(`tokens.json 缺 ${tier} 级 token（动作 ${desc.name} 需要该级）`);
  if (opts.tier && opts.tier !== desc.tier) {
    say(`注意: --tier ${opts.tier} 覆盖了自描述声明的 ${desc.tier}（负测试用；预期服务端按权限级裁决）`);
  }

  const provided = readParams(opts.paramsArg);
  const body = buildBody(desc, provided, opts);

  // confirm 要求由**权限级**派生（contract.md §1.6），不是动作私有知识
  const writable = desc.confirmRequired === true || desc.writable === true || tier === 'scene' || tier === 'forensic';
  if (writable && !opts.noConfirm) {
    body.confirm = true;
    say(`可写动作：已自动补 "confirm": true（${tier} 级）`);
  } else if (writable && opts.noConfirm) {
    say('可写动作但 --no-confirm：不补 confirm（预期 CP-CONFIRM-001）');
  }

  const qs = opts.sync ? `?sync=true&timeoutMs=${opts.timeoutMs}` : '';
  const url = `${server.base}/cp/v1/actions/${encodeURIComponent(desc.name)}${qs}`;
  const started = Date.now();
  say(`POST ${url} body=${JSON.stringify(body)}`);
  const res = await request(url, {
    token,
    method: 'POST',
    body,
    timeoutMs: opts.sync ? opts.timeoutMs + 15000 : 20000,
  });
  if (!res.body?.ok) {
    const e = envelopeError(res);
    return callError(opts, res.status, e, { action: desc.name, tier });
  }

  let job = res.body.data ?? {};
  let id = jobIdOf(job);
  say(`已受理: httpStatus=${res.status} jobId=${id ?? '(无)'} state=${job.state ?? '(无)'}` +
    `${job.timedOut === true ? ' timedOut=true（同步等待超时，转异步轮询）' : ''}`);

  const deadline = started + opts.timeoutMs;
  let lastState = job.state ?? null;
  while (id && !isFinished(job.state)) {
    if (Date.now() >= deadline) {
      return finish(job, { timedOut: true, jsonOut: opts.jsonOut });
    }
    await sleep(Math.min(opts.pollIntervalMs, Math.max(0, deadline - Date.now())));
    const jr = await request(`${server.base}/cp/v1/jobs/${encodeURIComponent(id)}`, { token, timeoutMs: 15000 });
    if (!jr.body?.ok) {
      const e = envelopeError(jr);
      return callError(opts, jr.status, e, { action: desc.name, jobId: id });
    }
    job = jr.body.data ?? {};
    if (job.state !== lastState) {
      say(`作业 ${id}: ${lastState} → ${job.state} progress=${job.progress ?? '(无)'}` +
        `${job.progressMessage ? ` (${job.progressMessage})` : ''}`);
      lastState = job.state;
    }
  }

  if (!id && !isFinished(job.state)) {
    sayErr('WARN 响应里没有 jobId，也没有终态：按调用错误处理（契约 §2 要求 POST 返回 jobId）');
    return finish(job, { jsonOut: opts.jsonOut });
  }

  return finish(job, { jsonOut: opts.jsonOut });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 调用错误（HTTP 4xx/5xx）：打印错误码与逐字段上下文，退出码 1。 */
function callError(opts, httpStatus, e, extra = {}) {
  say(`调用错误: httpStatus=${httpStatus} code=${e.code ?? '(无)'} message=${e.message ?? ''}`);
  if (e.context !== undefined) {
    say(`错误上下文 context=${JSON.stringify(e.context)}`);
  }
  const payload = { ok: false, httpStatus, error: e, ...extra };
  writeJsonOut(opts.jsonOut, payload);
  if (!jsonOnly) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return EXIT_CALL_ERROR;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    sayErr(`本地错误: ${e.message}`);
    process.exitCode = EXIT_CALL_ERROR;
  });
