#!/usr/bin/env node
/**
 * bake-truth-acceptance.mjs —— #127「静默失真族收口」的实机验收驱动（可审、可复跑）
 * ============================================================================
 *
 * 它验的是什么（每一条都有正/负对照，缺一不可）：
 *
 *   A. 正对照：**同世界内录完即导** ⇒ 成功，且产物 `provenance.captureWorld` 就是录制世界身份
 *      （folder + dimension），帧内结构也带同一份身份（烘焙没有把它洗掉）。
 *   B. 负对照：#127 的三态复现 —— 录制在世界 A、换到世界 B 后**再导同一帧** ⇒
 *      **必须显式失败**（CP-STATE-001，带 expected/actual/hint），且**不落任何产物**（run 数不增）。
 *   C. 同 folder 内容被清空后导出 ⇒ **不得静默丢块**：按扫描身份产出，非空气格数与 A 一致。
 *   D. 同 folder 同坐标被换成**另一个方块**后导出 ⇒ 必须显式失败（不许静默换块），同样不落产物。
 *   S. #131 的实机回归：`read.run limit:1.5` / `read.capture maxEvents:1.5` /
 *      `capture.diag margin:1.5` ⇒ 必须 CP-VALID-002（改前分别是 exit 0 与静默截断）。
 *
 * 用法：
 *   node scripts/control-plane/bake-truth-acceptance.mjs --out <证据目录> [--mc-dir <run/client>] [--skip-int]
 *
 * 退出码：0 = 全部判据通过；1 = 有判据失败（逐条打印 observed/expected）；2 = 驱动自身错误（前置不满足）。
 *
 * ---------------------------------------------------------------------------
 * 无人值守纪律（AGENTS.md「runClient 窗口纪律」——**先证明这一条再谈其他**）
 * ---------------------------------------------------------------------------
 * 本脚本**不点火 runClient**（点火由调度者授予窗口后另做）；它只对已经在跑的客户端发 HTTP。
 * 因此它先做一条硬前置：
 *   `<mcDir>/options.txt` 里必须已有 `pauseOnLostFocus:false`
 * 否则无人值守的客户端一失焦就弹暂停菜单 ⇒ 不 tick ⇒ 产物永不落盘（表现为本脚本超时）。
 * 这一条不满足时脚本**直接 exit 2**，不进入任何步骤——把「窗口纪律没落实」当成前置错误报出来，
 * 而不是伪装成被测行为失败。禁止「抢焦点 + 周期 ESC」的兜底（那会跟用户抢键盘鼠标）。
 *
 * 零依赖：只用 Node 内置模块（全局 fetch、zlib）。世界会被重建（cp_bt_A / cp_bt_B 两个托管世界），
 * 这是本驱动**故意**的：三态复现要求「换世界」与「同 folder 改内容」两件事都真的发生。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// --------------------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), undefined];
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const mcDir = path.resolve(args['mc-dir'] ?? path.join(REPO_ROOT, 'mod', 'gtnh', 'run', 'client'));
const outDir = path.resolve(args.out ?? path.join(SCRIPT_DIR, '.out', 'bake-truth'));
const skipIntChecks = args['skip-int'] === true;
fs.mkdirSync(outDir, { recursive: true });

const WORLD_A = 'cp_bt_A';
const WORLD_B = 'cp_bt_B';
const SEED = 20261007;
const STONE = { id: 'minecraft:stone', count: 1 };
const DIRT = { id: 'minecraft:dirt', count: 1 };

const R = {
  schema: 'lightning.cp-bake-truth-acceptance/1',
  generatedAt: new Date().toISOString(),
  mcDir,
  outDir,
  contractVersion: null,
  actionCount: null,
  checks: [],
  steps: [],
};
const logStep = (o) => { R.steps.push(o); console.log(`[step] ${JSON.stringify(o)}`); };

function check(id, expect, observed, pass) {
  const c = { id, expect, observed, pass: !!pass };
  R.checks.push(c);
  console.log(`[check] ${pass ? 'PASS' : 'FAIL'} ${id} | expect=${JSON.stringify(expect)} | observed=${JSON.stringify(observed)}`);
  return c.pass;
}

function finish(code, extra = {}) {
  R.verdict = {
    exitCode: code,
    passed: R.checks.filter((c) => c.pass).length,
    failed: R.checks.filter((c) => !c.pass).length,
    failedIds: R.checks.filter((c) => !c.pass).map((c) => c.id),
    ...extra,
  };
  const file = path.join(outDir, 'bake-truth-acceptance.json');
  fs.writeFileSync(file, `${JSON.stringify(R, null, 2)}\n`);
  console.log(`\n[verdict] ${JSON.stringify(R.verdict, null, 2)}`);
  console.log(`[verdict] 证据写入 ${file}`);
  process.exit(code);
}

function fatal(msg, extra = {}) {
  console.error(`[fatal] ${msg}`);
  R.fatal = { message: msg, ...extra };
  finish(2, { fatal: msg });
}

// --------------------------------------------------------------------------- 前置（无人值守纪律）

function assertUnattendedDiscipline() {
  const options = path.join(mcDir, 'options.txt');
  if (!fs.existsSync(options)) {
    fatal(`找不到 ${options}：无法证明「失焦不暂停」这条前置（runClient 尚未启动过？）`, { options });
  }
  const text = fs.readFileSync(options, 'utf8');
  const m = /^pauseOnLostFocus:(true|false)$/m.exec(text);
  const value = m ? m[1] : null;
  const ok = check(
    'S0.unattended.pauseOnLostFocus',
    'options.txt 里 pauseOnLostFocus:false（失焦照跑；否则无人值守客户端不 tick，产物永不落盘）',
    value ?? '(缺这一行)',
    value === 'false');
  if (!ok) {
    fatal('options.txt 的 pauseOnLostFocus 不是 false：先钉死该选项再点火（禁止「抢焦点 + 周期 ESC」兜底）', { options, value });
  }
}

// --------------------------------------------------------------------------- HTTP

const server = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'server.json'), 'utf8'));
const tokens = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'tokens.json'), 'utf8')).tokens;
const BASE = `http://${server.bind ?? '127.0.0.1'}:${server.port}/cp/v1`;
console.log(`[info] ${BASE}（contractVersion=${server.contractVersion ?? '(未报)'}）`);

async function call(action, params, tier = 'scene', timeoutMs = 300000) {
  const body = tier === 'observe' ? { ...params } : { ...params, confirm: true };
  const res = await fetch(`${BASE}/actions/${action}?sync=true&timeoutMs=${timeoutMs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[tier]}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { j = null; }
  if (!j || j.ok === false) return { ok: false, httpStatus: res.status, error: j?.error ?? { code: `HTTP-${res.status}`, message: text.slice(0, 400) } };
  const job = j.data ?? {};
  if (job.state === 'failed') return { ok: false, jobId: job.jobId, error: job.error ?? { code: 'JOB-FAILED', message: '(无 error 字段)' } };
  return { ok: true, data: job.result ?? job, runId: job.runId ?? job.result?.runId ?? null };
}

/** 当前全部 run 的 id 集合（用于「失败不落产物」的机械判据）。 */
async function runIds() {
  const r = await call('read.run', { limit: 200 }, 'observe');
  if (!r.ok) throw new Error(`read.run 失败: ${JSON.stringify(r.error)}`);
  return new Set((r.data.runs ?? []).map((x) => x.runId));
}

async function download(runId, rel) {
  const res = await fetch(`${BASE}/artifacts/${runId}/${rel}`, { headers: { Authorization: `Bearer ${tokens.observe}` } });
  if (!res.ok) throw new Error(`下载 ${runId}/${rel} HTTP ${res.status}`);
  return await res.text();
}

/** Envelope → {meta, inner}；Plain → {meta: doc, inner: doc}。 */
function unwrap(doc) {
  if (doc && doc.documentFormat === 'Envelope' && typeof doc.payload === 'string') {
    const buf = Buffer.from(doc.payload, 'base64');
    let inner;
    try { inner = JSON.parse(buf.toString('utf8')); } catch { inner = JSON.parse(gunzipSync(buf).toString('utf8')); }
    return { meta: doc.meta ?? {}, inner };
  }
  return { meta: doc ?? {}, inner: doc };
}

const coordsRe = /[（(]\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/;
const coordsOf = (reply) => { const m = coordsRe.exec(String(reply ?? '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const counts = (grid) => { const m = new Map(); for (const r of grid ?? []) for (const c of r) for (const v of c) m.set(v, (m.get(v) ?? 0) + 1); return Object.fromEntries([...m.entries()].sort((a, b) => a[0] - b[0])); };
const nonAirOf = (grid) => Object.entries(counts(grid)).filter(([k]) => k !== '0').reduce((a, [, v]) => a + v, 0);

// --------------------------------------------------------------------------- 场景原语

const setInventory = (item) => call('scene.inventory.write', { slots: Array.from({ length: 9 }, (_, s) => ({ slot: s, ...item })) });
const poseAbove = (t) => call('scene.player.pose', { pos: [t[0] + 0.5, t[1] + 1.0, t[2] + 0.5], yaw: 0, pitch: 90 });

async function selectCuboid(p1, p2) {
  await call('cmd.exec', { command: '/sde sel cuboid' });
  await poseAbove(p1);
  const r1 = await call('cmd.exec', { command: '/sde pos1' });
  await call('scene.player.pose', { pos: [p2[0] + 0.5, p2[1] + 3.0, p2[2] + 0.5], yaw: 0, pitch: 90 });
  const r2 = await call('cmd.exec', { command: '/sde pos2' });
  return { pos1: coordsOf(r1.data?.reply), pos2: coordsOf(r2.data?.reply), reply1: r1.data?.reply, reply2: r2.data?.reply };
}

/** 导出 F0 并取回「产物内可见的事实」（不抛：把失败也如实带回给判据）。 */
async function exportFrame0(label, extraParams = {}) {
  const before = await runIds();
  const ex = await call('export.scene', { name: `bt-${label}`, shape: 'world', frames: [0], expectFrames: { frames: [0] }, ...extraParams });
  const after = await runIds();
  const newRuns = [...after].filter((x) => !before.has(x));
  const out = { label, ok: ex.ok, runId: ex.runId ?? null, error: ex.error ?? null, newRuns };
  if (!ex.ok) { logStep({ step: `export:${label}`, ...out }); return out; }
  out.resultCaptureWorld = ex.data.captureWorld ?? null;
  out.path = ex.data.path;
  out.bytes = ex.data.bytes;
  const doc = JSON.parse(await download(ex.data.runId, ex.data.path));
  const { meta, inner } = unwrap(doc);
  const f0 = (inner.frames ?? [])[0] ?? null;
  out.provenanceCaptureWorld = meta.provenance?.captureWorld ?? null;
  out.provenanceFrameSha256 = meta.provenance?.frameSha256 ?? null;
  out.structureCaptureWorld = f0?.structure?.captureWorld ?? null;
  out.rootPalette = (inner.blockPalette ?? []).map((p) => p.registryId);
  out.frame0Counts = counts(f0?.structure?.cellGrid);
  out.frame0NonAirCells = nonAirOf(f0?.structure?.cellGrid);
  out.artifactBytes = doc ? Buffer.byteLength(JSON.stringify(doc)) : null;
  logStep({ step: `export:${label}`, ok: true, runId: ex.runId, path: out.path, bytes: out.bytes, nonAirCells: out.frame0NonAirCells, provenanceCaptureWorld: out.provenanceCaptureWorld, palette: out.rootPalette });
  return out;
}

// --------------------------------------------------------------------------- 主流程

async function main() {
  assertUnattendedDiscipline();

  const catalogRes = await fetch(`${BASE}/actions`, { headers: { Authorization: `Bearer ${tokens.observe}` } });
  const catalog = (await catalogRes.json()).data ?? {};
  R.contractVersion = catalog.contractVersion ?? null;
  R.actionCount = catalog.count ?? (catalog.actions ?? []).length;
  console.log(`[info] 契约版本 ${R.contractVersion}，动作数 ${R.actionCount}`);
  check('S0.contract.version', '1.7（不升版本）', R.contractVersion, R.contractVersion === '1.7');
  check('S0.contract.actionCount', '43（动作计数口径不变）', R.actionCount, R.actionCount === 43);

  // ---------------- A. 正对照：世界 A 内录完即导 ----------------
  const rbA = await call('world.rebuild', { folder: WORLD_A, void: true, seed: SEED });
  if (!rbA.ok) fatal(`world.rebuild ${WORLD_A} 失败: ${JSON.stringify(rbA.error)}`);
  const base = rbA.data.base ?? [64, 12, 64];
  const [bx, by, bz] = base;
  logStep({ step: 'rebuild-A', folder: WORLD_A, base });

  await setInventory(STONE);
  const sel = await selectCuboid([bx, by, bz], [bx + 3, by + 3, bz + 3]);
  logStep({ step: 'selection', base, sel });
  await call('cmd.exec', { command: '/sde start' });
  await call('cmd.exec', { command: '/sde setframe 0' });
  const target = sel.pos1;
  await poseAbove(target);
  const placed = await call('player.place_block', { at: target });
  logStep({ step: 'place-stone-in-A', target, ok: placed.ok, error: placed.error ?? null });
  check('A0.place.stone', '在选区内部放下石头（放置点必须在选区内，否则扫不到）', { ok: placed.ok, reply: placed.data?.reply ?? null }, placed.ok);

  const rec = await call('cmd.exec', { command: '/sde record' });
  check('A0.record', 'record 成功', { ok: rec.ok, reply: rec.data?.reply ?? null }, rec.ok);

  const inA = await exportFrame0('A-in-world');
  check('A1.export.sameWorldSucceeds', '同世界内录完即导 ⇒ 成功', { ok: inA.ok, error: inA.error }, inA.ok);
  if (!inA.ok) return finish(1);
  check('A2.provenance.captureWorld.present', '产物 provenance 含录制世界身份', inA.provenanceCaptureWorld, inA.provenanceCaptureWorld != null);
  check('A3.provenance.captureWorld.folder', `录于 ${WORLD_A}`, inA.provenanceCaptureWorld?.folder ?? null, inA.provenanceCaptureWorld?.folder === WORLD_A);
  check('A4.provenance.captureWorld.dimension', '维度 0（主世界）', inA.provenanceCaptureWorld?.dimension ?? null, inA.provenanceCaptureWorld?.dimension === 0);
  check('A5.result.captureWorld.matchesProvenance', '结果里的 captureWorld 与 provenance 一致（机读同源）', inA.resultCaptureWorld, JSON.stringify(inA.resultCaptureWorld) === JSON.stringify(inA.provenanceCaptureWorld));
  check('A6.structure.captureWorld.present', '帧内结构也带同一份身份（烘焙没洗掉它）', inA.structureCaptureWorld, JSON.stringify(inA.structureCaptureWorld) === JSON.stringify(inA.provenanceCaptureWorld));
  check('A7.frame.hasBlock', 'F0 至少一格非空气（否则后面的判据是空转的）', inA.frame0NonAirCells, inA.frame0NonAirCells > 0);
  const hashA = inA.provenanceFrameSha256?.['0'] ?? null;

  // ---------------- B. 负对照：换到世界 B 再导同一帧（#127 三态复现） ----------------
  const rbB = await call('world.rebuild', { folder: WORLD_B, void: true, seed: SEED });
  if (!rbB.ok) fatal(`world.rebuild ${WORLD_B} 失败: ${JSON.stringify(rbB.error)}`);
  logStep({ step: 'rebuild-B', folder: WORLD_B, base: rbB.data.base ?? null });

  const inB = await exportFrame0('B-other-world');
  check('B1.export.crossWorldFails', '换世界再导同一帧 ⇒ 必须显式失败（改造前是静默成功且内容全空气）', { ok: inB.ok, code: inB.error?.code ?? null }, inB.ok === false);
  check('B2.error.code', 'CP-STATE-001', inB.error?.code ?? null, inB.error?.code === 'CP-STATE-001');
  const bCtx = inB.error?.context ?? {};
  check('B3.error.expected', '带 expected（录制世界身份）', bCtx.expected ?? null, !!bCtx.expected && bCtx.expected.folder === WORLD_A);
  check('B4.error.actual', '带 actual（导出时刻活动世界）', bCtx.actual ?? null, !!bCtx.actual && bCtx.actual.folder === WORLD_B);
  check('B5.error.hint', '带 hint（怎么修）', typeof bCtx.hint === 'string' ? bCtx.hint.slice(0, 80) : bCtx.hint ?? null, typeof bCtx.hint === 'string' && bCtx.hint.length > 0);
  check('B6.error.stage', '失败点在烘焙之前（pre-bake：连 run 都不开）', bCtx.stage ?? null, bCtx.stage === 'pre-bake');
  check('B7.noArtifact', '不落任何产物（run 数不增）', inB.newRuns, Array.isArray(inB.newRuns) && inB.newRuns.length === 0);

  // ---------------- C. 同 folder 内容被清空后导出：不得静默丢块 ----------------
  const rbA2 = await call('world.rebuild', { folder: WORLD_A, void: true, seed: SEED });
  if (!rbA2.ok) fatal(`world.rebuild ${WORLD_A}（第二次，同 folder）失败: ${JSON.stringify(rbA2.error)}`);
  logStep({ step: 'rebuild-A-again', folder: WORLD_A, base: rbA2.data.base ?? null });
  const inA2 = await exportFrame0('A-same-folder-cleared');
  check('C1.export.sameFolderChangedSucceeds', '同 folder 内容被清空后导出 ⇒ 成功（世界身份仍相符）', { ok: inA2.ok, error: inA2.error }, inA2.ok);
  if (inA2.ok) {
    check('C2.noSilentBlockLoss', `非空气格数不低于录制时（${inA.frame0NonAirCells} 格）`, inA2.frame0NonAirCells, inA2.frame0NonAirCells >= inA.frame0NonAirCells && inA2.frame0NonAirCells > 0);
    check('C3.scanIdentityKept', '调色板里仍有录制时的方块身份', inA2.rootPalette, inA2.rootPalette.includes('minecraft:stone'));
    check('C4.hashUnchangedIsNowTruthful', 'frameSha256 与 A 一致（缓冲没动），而内容不再随世界变空——哈希不再是谎话', { hashA, hashC: inA2.provenanceFrameSha256?.['0'] ?? null }, (inA2.provenanceFrameSha256?.['0'] ?? null) === hashA);
  }

  // ---------------- D. 同 folder 同坐标换成另一个方块：必须显式失败 ----------------
  await setInventory(DIRT);
  await poseAbove(target);
  const replaced = await call('player.place_block', { at: target });
  logStep({ step: 'place-dirt-in-A', target, ok: replaced.ok, error: replaced.error ?? null });
  const inD = await exportFrame0('A-same-folder-replaced');
  check('D1.export.blockIdentityConflictFails', '同坐标被换成另一个方块 ⇒ 必须显式失败（不许静默换块）', { ok: inD.ok, code: inD.error?.code ?? null }, inD.ok === false);
  check('D2.error.code', 'CP-STATE-001', inD.error?.code ?? null, inD.error?.code === 'CP-STATE-001');
  check('D3.error.cell', '错误上下文点名该格与两侧身份', inD.error?.context ?? null, !!inD.error?.context?.cell && !!inD.error?.context?.expected && !!inD.error?.context?.actual);
  check('D4.noArtifact', '不落任何产物（run 数不增）', inD.newRuns, Array.isArray(inD.newRuns) && inD.newRuns.length === 0);

  // ---------------- S. #131 实机回归（TYPE_INT 不再静默强转） ----------------
  if (!skipIntChecks) {
    const rr = await call('read.run', { limit: 1.5 }, 'observe');
    check('S1.read.run.limit1.5', 'CP-VALID-002（改前 exit 0 且回显 1）', { ok: rr.ok, code: rr.error?.code ?? null }, rr.ok === false && rr.error?.code === 'CP-VALID-002');
    const rc = await call('read.capture', { maxEvents: 1.5 }, 'observe');
    check('S2.read.capture.maxEvents1.5', 'CP-VALID-002（改前静默截断成 1）', { ok: rc.ok, code: rc.error?.code ?? null }, rc.ok === false && rc.error?.code === 'CP-VALID-002');
    const cd = await call('capture.diag', { dump: false, margin: 1.5 }, 'observe');
    check('S3.capture.diag.margin1.5', 'CP-VALID-002（改前截断成 1 后照常执行）', { ok: cd.ok, code: cd.error?.code ?? null }, cd.ok === false && cd.error?.code === 'CP-VALID-002');
    const ok = await call('read.run', { limit: 2 }, 'observe');
    check('S4.read.run.limit2.positiveControl', '整数 limit 照常成功（证明 S1 不是「动作坏了」）', { ok: ok.ok, action: ok.data?.action ?? null }, ok.ok === true);
  } else {
    console.log('[info] --skip-int 已给出：#131 实机回归跳过（离线单测仍覆盖）');
  }

  const failed = R.checks.filter((c) => !c.pass);
  return finish(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  fatal(`驱动异常: ${e.message}`, { stack: String(e.stack ?? '').split('\n').slice(0, 6) });
});
