#!/usr/bin/env node
/**
 * 导出族验收驱动（C1–C6 / D2 / D3 / D5）
 * ==========================================================================
 *
 * 一条命令跑完全部可判定项，产出机器可读证据。**每一步都独立判红**，不空转绿。
 *
 * 用法：
 *   node scripts/control-plane/export-acceptance.mjs [--mc-dir <path>] [--out <dir>]
 *
 * 判据与做法：
 *   **C1** 单场景文件可导出可用 —— 产物经 `GET /cp/v1/artifacts/...` 下载后喂给
 *          **web 侧真实解析器**（`web/src/`，经 esbuild 现场捆绑，不改 web/ 下任何文件）。
 *   **C2** 逐帧录制 N≥3 后导出，含 N 帧且逐帧内容与录制时世界状态一致 ——
 *          逐帧与 `export.session.frameSha256`（录制那一刻的缓冲文本哈希）配对比对。
 *   **C3** 同会话同缓冲 + **负对照** —— 正例：产物内 exportId 一致、帧哈希同源；
 *          负例：跨次动作追加一帧后，用 `expectFrames` 声明原帧集 ⇒ 必须判红（CP-STATE-001）。
 *   **C4** 导出件 + 实拍 + 观测记录 + 世界清单哈希 **同一 run**，run 内世界清单哈希唯一 ——
 *          经 `case.run` 的 `export` 段（**v1.7**）在同一 run 内产出它们。
 *   **C5** 全部产物落 run 目录、带哈希、经清单端点可发现可核对 —— 逐份核对清单 sha256 与磁盘一致。
 *   **C6** 帧预算超限显式报错（错误码 + 上下文），不静默截断。
 *   **D2** 同语义经 API 与经命令执行结果一致，可复算 ——
 *          `export.scene` vs `cmd.exec {/sde export}`，口径 = 语义子树规范化 sha256（不做字节比对）。
 *   **D3** 默认值可见 —— 逐动作核对自述里的默认值（含本次新动作）。
 *   **D5** 无隐藏通道 —— 全仓检索「第二条能力路径」的痕迹 + 新动作的产物路径唯一性。
 *
 * 退出码：0 = 全绿；1 = 有硬失败；2 = 环境不可用。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

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
const mcDir = path.resolve(args['mc-dir'] ?? path.join(REPO, 'mod', 'gtnh', 'run', 'client'));
const outDir = path.resolve(args.out ?? path.join(HERE, '.out', 'export-acceptance'));
fs.mkdirSync(outDir, { recursive: true });

const gates = new Map(); // gate -> {ok, evidence, notes}
const log = [];
function record(gate, ok, evidence, note) {
  const g = gates.get(gate) ?? { gate, ok: true, checks: [] };
  g.checks.push({ ok, evidence, note });
  if (!ok) g.ok = false;
  gates.set(gate, g);
  const mark = ok ? 'OK ' : 'XX ';
  console.log(`   ${mark}[${gate}] ${note}`);
  log.push(`${mark}[${gate}] ${note}`);
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------- cp 客户端

const server = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'server.json'), 'utf8'));
const tokens = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'tokens.json'), 'utf8')).tokens;
const BASE = `http://${server.bind}:${server.port}/cp/v1`;

async function call(action, params, { tier = 'scene', timeoutMs = 180000 } = {}) {
  const body = { ...(params ?? {}) };
  if (tier !== 'observe') body.confirm = true;
  const res = await fetch(`${BASE}/actions/${action}?sync=true&timeoutMs=${timeoutMs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[tier]}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (j.ok === false) return { ok: false, httpStatus: res.status, error: j.error, data: null };
  const job = j.data ?? {};
  if (job.state === 'failed') return { ok: false, httpStatus: res.status, error: job.error, data: null, jobId: job.jobId };
  return { ok: true, httpStatus: res.status, data: job.result ?? job, jobId: job.jobId, job };
}

async function download(runId, rel) {
  const res = await fetch(`${BASE}/artifacts/${runId}/${rel}`, { headers: { Authorization: `Bearer ${tokens.observe}` } });
  if (!res.ok) throw new Error(`下载 ${runId}/${rel} HTTP ${res.status}`);
  return await res.text();
}

async function manifest(runId) {
  const res = await fetch(`${BASE}/artifacts/${runId}`, { headers: { Authorization: `Bearer ${tokens.observe}` } });
  const j = await res.json();
  if (j.ok !== true) throw new Error(`清单 ${runId}: ${JSON.stringify(j.error)}`);
  return j.data;
}

function unwrap(doc) {
  if (doc && doc.documentFormat === 'Envelope' && typeof doc.payload === 'string') {
    const buf = Buffer.from(doc.payload, 'base64');
    let inner;
    try { inner = JSON.parse(buf.toString('utf8')); }
    catch { inner = JSON.parse(gunzipSync(buf).toString('utf8')); }
    return { meta: doc.meta ?? {}, inner, envelope: doc };
  }
  return { meta: doc ?? {}, inner: doc, envelope: null };
}

function canonical(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

/** 语义子树（contract.md §7.8 导出族动作 / `docs/protocol.md` 的 Envelope 编码）：剔除 provenance/exportId。 */
function semanticsOf(inner) {
  const copy = JSON.parse(JSON.stringify(inner));
  if (Array.isArray(copy.frames)) {
    delete copy.exportId;
    for (const f of copy.frames) delete f.exportId;
    return copy.frames.map((f) => f.structure);
  }
  delete copy.exportId;
  return copy;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`[acc] cp @ ${BASE}  contractVersion=${server.contractVersion}`);

  const ping = await call('core.ping', {}, { tier: 'observe' });
  if (!ping.ok) throw new Error(`控制面不可用: ${JSON.stringify(ping.error)}`);
  // env gate：契约版本必须 ≥ 导出族引入版本。**不写死等号**——版本号是全局单调量，
  // 后续每批新增都会把它推高（导出族按撞号口径取 1.7；将来还会更高），
  // 写死具体值等于让每次合流都把这条 gate 判红（合流后实测：唯一红项就是这个等号）。
  const CONTRACT_MIN = 1.7;
  const contractVersionNum = Number.parseFloat(server.contractVersion);
  record(
    'env',
    Number.isFinite(contractVersionNum) && contractVersionNum >= CONTRACT_MIN,
    { contractVersion: server.contractVersion, contractMin: CONTRACT_MIN },
    `contractVersion=${server.contractVersion}（要求 ≥ ${CONTRACT_MIN}：导出族自 1.7 起引入）`
  );

  // ---------- 起手：hermetic 虚空重建（C4 的「同世界」纪律） ----------
  const FOLDER = 'cp_export_acc';
  const rebuild = await call('world.rebuild', { folder: FOLDER, void: true, seed: 20261007 });
  if (!rebuild.ok) throw new Error(`world.rebuild 失败: ${JSON.stringify(rebuild.error)}`);
  const base = rebuild.data?.base ?? [64, 12, 64];
  const [bx, by, bz] = base;
  console.log(`[acc] world.rebuild ok（${FOLDER}，base=${base}）`);

  // 手持方块：把 9 个快捷栏槽都写成石头（place_block 要求手持是方块）
  await call('scene.inventory.write', { slots: Array.from({ length: 9 }, (_, s) => ({ slot: s, id: 'minecraft:stone', count: 1 })) });

  // ---------- 选区与帧缓冲：3 帧，逐帧世界状态不同（C2） ----------
  // 选区构造的实测口径（实测踩过两次坑，都记在这里）：
  //
  // ① `/sde pos1|pos2` 的坐标**只来自服务端玩家实体**（无坐标参数）：
  //    `scene.player.pose` 确实会移动服务端玩家（实测 pos1 从旧会话值变为 pose 后的值），
  //    因此「先把玩家摆到角点、再打 pos1/pos2」是构造任意 AABB 的**唯一**手段。
  //    回报里的坐标是 `floor(玩家坐标)` 并标注「脚下方块」⇒ 想以 (a,b,c) 为选区角，
  //    要把玩家摆在 (a+0.5, b+1, c+0.5)（y 是脚的位置，脚下那格才是 b）。
  // ② `player.place_block` 走 PlayerControllerMP.onPlayerRightClick，**受触达距离约束**（约 4.5 格）：
  //    站得远时动作**仍返回 ok**、`read.block`（客户端侧）**也看得到方块**，
  //    但服务端在 NetHandlerPlayServer 侧拒绝 ⇒ **服务端世界里没有它** ⇒ `/sde record`
  //    （服务端扫描）依旧扫出全空气。这是实测得到的最贵一课：**「动作 ok + 读回也有」≠ 服务端真的落地**。
  //    正解 = 每帧放置前把玩家摆到目标格正上方（目标格 = 脚下一格，距离 1）。
  const anchor = [bx, by, bz];
  await call('cmd.exec', { command: '/sde sel cuboid' });
  await call('scene.player.pose', { pos: [anchor[0] + 0.5, anchor[1] + 1.0, anchor[2] + 0.5], yaw: 0, pitch: 90 });
  const rpos1 = await call('cmd.exec', { command: '/sde pos1' });
  await call('scene.player.pose', { pos: [anchor[0] + 3.5, anchor[1] + 4.0, anchor[2] + 3.5], yaw: 0, pitch: 90 });
  const rpos2 = await call('cmd.exec', { command: '/sde pos2' });
  // 回报用全角括号，半角正则匹配不到（第一次就栽在这）
  const coordRe = /[（(]\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/;
  const corner = coordRe.exec(String(rpos1.data?.reply ?? ''));
  const p1 = corner ? [Number(corner[1]), Number(corner[2]), Number(corner[3])] : null;
  const corner2 = coordRe.exec(String(rpos2.data?.reply ?? ''));
  const p2 = corner2 ? [Number(corner2[1]), Number(corner2[2]), Number(corner2[3])] : null;
  console.log(`[acc] 选区 pos1=${JSON.stringify(p1)} pos2=${JSON.stringify(p2)}`);
  record('C2', p1 != null && p2 != null, { pos1: p1, pos2: p2, replies: [rpos1.data?.reply, rpos2.data?.reply] },
    `选区已构造（pos1=${JSON.stringify(p1)} pos2=${JSON.stringify(p2)}）——证明场景态命令在 cp 侧可驱动`);
  if (!p1 || !p2) throw new Error('选区构造失败：pos1/pos2 回报里解析不出坐标');

  await call('cmd.exec', { command: '/sde start' });
  await call('cmd.exec', { command: '/sde setname acc-scene' });

  const FRAMES = [0, 1, 2];
  const frameWorldState = [];
  for (const k of FRAMES) {
    // 每帧往选区内贴地第一层放一块石头（第 k 格），并在放置前把玩家摆到它正上方（触达距离 1）
    const target = [p1[0] + k, p1[1], p1[2]];
    await call('scene.player.pose', { pos: [target[0] + 0.5, target[1] + 1.0, target[2] + 0.5], yaw: 0, pitch: 90 });
    const placed = await call('player.place_block', { at: target });
    await call('cmd.exec', { command: `/sde setframe ${k}` });
    const rec = await call('cmd.exec', { command: `/sde record` });
    if (!rec.ok) throw new Error(`record F${k} 失败: ${JSON.stringify(rec.error)}`);
    frameWorldState.push({ frame: k, target, placeOk: placed.ok, recOk: rec.ok });
  }
  console.log(`[acc] 已录 ${FRAMES.length} 帧（逐帧放置点 ${JSON.stringify(frameWorldState.map((f) => f.target))}）`);

  // 录完后的权威状态（C2/C3 的对照基准）
  const sessBefore = await call('export.session', {}, { tier: 'observe' });
  if (!sessBefore.ok) throw new Error(`export.session 失败: ${JSON.stringify(sessBefore.error)}`);
  const S = sessBefore.data;
  fs.writeFileSync(path.join(outDir, 'export-session-before.json'), JSON.stringify(S, null, 2));
  record(
    'C2',
    FRAMES.every((k) => S.recordedFrames.includes(k)) && S.frameSha256.length === S.recordedFrames.length,
    { recordedFrames: S.recordedFrames, frameSha256: S.frameSha256, bufferGeneration: S.bufferGeneration },
    `export.session 读回 ${S.recordedFrames.length} 帧，frameSha256 与帧号一一对应`,
  );

  // ---------- C6：帧预算超限（先做，用同一缓冲；它不写任何产物） ----------
  const budget = await call('export.scene', { name: 'budget-should-fail', maxFrames: 2 });
  const budgetRed = !budget.ok && budget.error?.code === 'CP-VALID-002'
    && Array.isArray(budget.error?.context?.fields) && budget.error.context.fields.length > 0;
  record('C6', budgetRed, { httpStatus: budget.httpStatus, error: budget.error },
    `帧数超预算（3 帧 > maxFrames=2）→ ${budget.error?.code ?? '(未报错!)'}，context.fields=${JSON.stringify(budget.error?.context?.fields ?? null)}`);
  record('C6', !!budget.error?.context?.computed,
    { computed: budget.error?.context?.computed ?? null },
    `错误上下文含可复算口径 computed=${budget.error?.context?.computed ? '是' : '否'}`);
  // 断言超预算时**没有**写出产物
  const sessAfterBudget = await call('export.session', {}, { tier: 'observe' });
  record('C6',
    sessAfterBudget.data?.bufferGeneration === S.bufferGeneration,
    { before: S.bufferGeneration, after: sessAfterBudget.data?.bufferGeneration },
    '超预算不写爆也不动缓冲（bufferGeneration 未变）');

  // ---------- C3 负对照：跨次追加一帧后，声明原帧集必须判红 ----------
  await call('cmd.exec', { command: '/sde setframe 9' });
  const rec9 = await call('cmd.exec', { command: '/sde record' });
  const negative = await call('export.scene', {
    name: 'c3-negative', expectFrames: { frames: FRAMES },
  });
  const negRed = !negative.ok && negative.error?.code === 'CP-STATE-001';
  const extra = negative.error?.context?.extra ?? null;
  record('C3', rec9.ok && negRed && Array.isArray(extra) && extra.includes(9),
    { httpStatus: negative.httpStatus, error: negative.error },
    `负对照：追加 F9 后声明 expectFrames=[${FRAMES}] → ${negative.error?.code ?? '(未判红!)'}，extra=${JSON.stringify(extra)}`);

  // 收尾负例：契约 1.6 不清缓冲（版本化规则：小版本只增不改义），因此 F9 留在缓冲里。
  // 正例导出前**重新读一次** export.session——对照基准必须覆盖即将导出的**全部**帧，
  // 否则 F9 会因为「不在旧快照里」被误判成内容不一致（这是本驱动第一版的实测缺陷）。
  const sessAfterNeg = await call('export.session', {}, { tier: 'observe' });
  const S2 = sessAfterNeg.data;
  fs.writeFileSync(path.join(outDir, 'export-session-before-export.json'), JSON.stringify(S2, null, 2));
  const ALL_FRAMES = [...S2.recordedFrames];

  // ---------- C1 + C2 + C3 正例：导出全部帧 ----------
  const scene = await call('export.scene', {
    name: 'acc-scene', shape: 'world', includeFrames: true,
    expectFrames: { frames: ALL_FRAMES },
  });
  if (!scene.ok) {
    record('C1', false, { error: scene.error }, `export.scene 失败: ${JSON.stringify(scene.error)}`);
    return;
  }
  const D = scene.data;
  console.log(`[acc] export.scene ok: runId=${D.runId} path=${D.path} frames=${D.frames} bytes=${D.bytes}`);
  fs.writeFileSync(path.join(outDir, 'export-scene-result.json'), JSON.stringify(D, null, 2));

  const rawScene = await download(D.runId, D.path);
  fs.writeFileSync(path.join(outDir, 'acc-scene.json'), rawScene);
  const sceneDoc = JSON.parse(rawScene);
  const { meta, inner, envelope } = unwrap(sceneDoc);
  const frames = Array.isArray(inner.frames) ? inner.frames : [];

  record('C1', envelope?.documentFormat === 'Envelope' && frames.length === ALL_FRAMES.length,
    { documentFormat: envelope?.documentFormat, payloadEncoding: envelope?.payloadEncoding, frames: frames.length },
    `产物形态：${envelope?.documentFormat}(${envelope?.payloadEncoding})，frames=${frames.length}（R1-3 统一为 world 形态）`);

  // C1：喂给 web 侧真实解析器
  // ⚠️ 判据只看 `webConsumerOk`（消费方是否接受这份文件），**不能**看子进程退出码：
  // 那个检查器内部还会跑 C2/C3 断言，它红不代表「解析不了这份文件」。
  let c1Web = { ok: false, reason: 'not-run' };
  {
    const exe = path.join(HERE, 'export-check.mjs');
    const sessionFile = path.join(outDir, 'export-session-before-export.json');
    const jsonOut = path.join(outDir, 'C1-web-parser.json');
    try {
      execFileSync(process.execPath, [
        exe, path.join(outDir, 'acc-scene.json'),
        '--mc-dir', mcDir,
        '--session-json', sessionFile,
        '--expect-frames', ALL_FRAMES.join(','),
        '--expect-shape', 'world',
        '--json-out', jsonOut,
      ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    } catch {
      // 检查器非零退出（它自己的 C2/C3 判红）——仍需读回 JSON 取 webConsumerOk
    }
    if (fs.existsSync(jsonOut)) c1Web = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    else c1Web = { ok: false, reason: '检查器未产出 JSON', webConsumerOk: null };
  }
  record('C1', c1Web.ok === true && c1Web.webConsumerOk === true,
    { webConsumerOk: c1Web.webConsumerOk, failures: c1Web.failures, semanticsSha256: c1Web.semanticsSha256, notes: c1Web.notes },
    `既有消费方（web 侧真实解析器：readEnvelopeLayers → normalizeEnvelopeToPlain → WorldParser.parse → RuntimeDocument）解析通过=${c1Web.webConsumerOk === true}；semanticsSha256=${c1Web.semanticsSha256}`);

  // C2：逐帧内容与录制时一致（对照基准 = 导出前那一刻的快照 S2）
  const prov = meta.provenance ?? null;
  const hashByFrame = new Map(S2.recordedFrames.map((f, i) => [f, S2.frameSha256[i]]));
  let c2Mismatch = [];
  for (const f of frames) {
    const want = hashByFrame.get(f.index);
    const got = prov?.frameSha256?.[String(f.index)];
    if (!want) c2Mismatch.push(`F${f.index} 不在 export.session 的 recordedFrames 内`);
    else if (want !== got) c2Mismatch.push(`F${f.index} provenance=${got} session=${want}`);
  }
  record('C2', frames.length >= 3 && c2Mismatch.length === 0,
    { frameCount: frames.length, frameIndexes: frames.map((f) => f.index), mismatches: c2Mismatch },
    `${frames.length} 帧（N≥3），逐帧内容哈希与录制时一致（mismatch=${c2Mismatch.length}）`);

  // C2 补充：逐帧内容确实不同 —— 判据取自**服务端侧产物**（cellGrid 的规范化哈希），
  // 而不是客户端 `read.block`。理由见上文实测：客户端读回「有方块」不代表服务端扫描扫得到它。
  //
  // 断言范围只取**我主动改了世界状态的那几帧**（FRAMES = [0,1,2]）：
  // F9 是在 F2 之后补录的负对照帧，两帧之间世界没变，因此 F9 与 F2 **本就该**相同
  // —— 把 F9 计入「必须两两不同」会把正确行为判红。
  const variedHashes = new Map();
  for (const f of frames) {
    if (FRAMES.includes(f.index)) variedHashes.set(f.index, sha256(canonical(f.structure.cellGrid)));
  }
  const distinct = new Set(variedHashes.values()).size;
  const nonAir = (inner.blockPalette ?? []).filter((p) => p.registryId && p.registryId !== 'air').length;
  record('C2', distinct === FRAMES.length && nonAir > 0 && variedHashes.size === FRAMES.length,
    { distinctVariedFrames: distinct, variedFrames: FRAMES, nonAirPaletteEntries: nonAir,
      hashes: Object.fromEntries(variedHashes),
      palette: (inner.blockPalette ?? []).map((p) => p.registryId) },
    `逐帧内容两两不同（改过世界状态的 ${distinct}/${FRAMES.length} 帧），服务端侧调色板含 ${nonAir} 种非空气方块（帧数据不是重复录同一状态）`);
  // 顺带把「F9 与 F2 相同」这条也记成证据：它证明帧内容是**逐个录制那一刻的世界状态**，
  // 而不是导出时把当前世界复制 N 份（后者会让四帧全都一样）。
  const f2 = frames.find((f) => f.index === 2);
  const f9 = frames.find((f) => f.index === 9);
  record('C2', !!f2 && !!f9 && sha256(canonical(f2.structure.cellGrid)) === sha256(canonical(f9.structure.cellGrid)),
    { f2EqualsF9: !!f2 && !!f9 && sha256(canonical(f2.structure.cellGrid)) === sha256(canonical(f9.structure.cellGrid)) },
    'F9（世界未再变时补录）与 F2 内容一致 —— 反证「逐帧存的是各自录制时刻的世界状态」，不是导出时复制当前世界');

  // C3：同会话同缓冲（正例）
  const exportIds = new Set(frames.map((f) => f.exportId));
  record('C3',
    prov != null && exportIds.size === 1 && exportIds.has(prov.exportId) && meta.exportId === prov.exportId,
    { provenanceExportId: prov?.exportId, frameExportIds: [...exportIds], metaExportId: meta.exportId,
      bufferGeneration: prov?.bufferGeneration, sessionBufferGeneration: S2.bufferGeneration },
    `同会话同缓冲：全部帧 exportId 一致（${[...exportIds]}），provenance.bufferGeneration=${prov?.bufferGeneration} 与录制时一致`);

  // ---------- C5：清单可发现可核对 ----------
  const man = await manifest(D.runId);
  const expected = [
    D.path,
    ...ALL_FRAMES.map((k) => `export/frames/F${k}.json`),
  ];
  let c5Bad = [];
  for (const relPath of expected) {
    const entry = (man.artifacts ?? []).find((a) => a.path === relPath);
    if (!entry) { c5Bad.push(`${relPath} 不在清单`); continue; }
    let text;
    try { text = await download(D.runId, relPath); } catch (e) { c5Bad.push(`${relPath} 下载失败: ${e.message}`); continue; }
    const actual = sha256(text);
    if (actual !== entry.sha256) c5Bad.push(`${relPath} sha256 不符 清单=${entry.sha256} 实际=${actual}`);
  }
  fs.writeFileSync(path.join(outDir, 'C5-manifest.json'), JSON.stringify(man, null, 2));
  record('C5', c5Bad.length === 0 && man.artifacts.length >= expected.length,
    { runId: D.runId, count: man.artifacts.length, expected: expected.length, problems: c5Bad },
    `run ${D.runId} 清单 ${man.artifacts.length} 项，逐份下载核对 sha256 通过（抽查 ${expected.length} 份）`);
  record('C5', !man.artifacts.some((a) => a.path.includes('..')) && !man.artifacts.some((a) => a.path.startsWith('/')),
    { paths: man.artifacts.map((a) => a.path) },
    '清单内路径全部是 run 目录内相对路径（单一归属，无绝对路径/穿越）');

  // ---------- D2：export.scene（API 通道） vs cmd.exec /sde export（命令通道） ----------
  // 同一帧缓冲、同一次世界状态，两条通道各导出一次，比语义子树哈希。
  const cmdExport = await call('cmd.exec', { command: '/sde export' });
  record('D2', cmdExport.ok,
    { reply: String(cmdExport.data?.reply ?? '').trim().slice(0, 200), artifacts: cmdExport.data?.artifacts },
    `命令通道 /sde export 回报 ok（run ${cmdExport.data?.runId}）；artifacts[] 声明 deferred=${cmdExport.data?.artifacts?.[0]?.deferred === true}`);

  // 命令通道的产物是**两段写的**（服务端 scan 中间态 → 客户端 enrich 覆盖为 baked+Envelope），
  // 因此登记走**延迟队列**（CommandArtifactRegistrar，客户端每 tick 推进）。这里轮询 run 清单，
  // 直到出现 cmd-exec/*.json 的登记项（或超时——超时本身也是判据：登记机制没工作）。
  let cmdRegistered = null;
  let cmdRegWaitMs = 0;
  const cmdRunId = cmdExport.data?.runId;
  while (cmdRunId && cmdRegWaitMs < 15000) {
    const m = await manifest(cmdRunId);
    const hit = (m.artifacts ?? []).find((a) => a.path.startsWith('cmd-exec/') && a.path.endsWith('.json'));
    if (hit) { cmdRegistered = hit; break; }
    await sleep(500);
    cmdRegWaitMs += 500;
  }
  record('D2', cmdRegistered != null,
    { runId: cmdRunId, waitedMs: cmdRegWaitMs, artifact: cmdRegistered },
    cmdRegistered
      ? `命令通道产物经延迟登记进 run ${cmdRunId}：${cmdRegistered.path} sha256=${cmdRegistered.sha256.slice(0, 12)}…（等待 ${cmdRegWaitMs}ms）`
      : `命令通道产物未在 15s 内登记进 run ${cmdRunId} 的清单（延迟登记机制未生效）`);

  if (cmdRegistered) {
    const cmdText = await download(cmdRunId, cmdRegistered.path);
    fs.writeFileSync(path.join(outDir, 'd2-cmd-channel.json'), cmdText);
    const cmdDoc = JSON.parse(cmdText);
    const cmdUnwrapped = unwrap(cmdDoc);
    const cmdInner = cmdUnwrapped.inner;
    const apiInner = inner;

    // D2-3f 命令通道产物必须是**烘焙终态**（否则比的是半成品，D2 无从成立）
    const cmdFrames = Array.isArray(cmdInner.frames) ? cmdInner.frames : [];
    const cmdPhases = cmdFrames.map((f) => f.structure?.geometryPhase);
    record('D2', cmdDoc.documentFormat === 'Envelope' && cmdPhases.every((p) => p === 'baked'),
      { documentFormat: cmdDoc.documentFormat ?? null, phases: cmdPhases },
      `D2-3f 命令通道产物是客户端 enrich 后的终态：documentFormat=${cmdDoc.documentFormat}，逐帧 geometryPhase=${JSON.stringify(cmdPhases)}`);

    // D2-3a 形态一致
    const shapeCmd = Array.isArray(cmdInner.frames) ? 'world' : 'structure';
    const shapeApi = Array.isArray(apiInner.frames) ? 'world' : 'structure';
    record('D2', shapeCmd === shapeApi, { cmdShape: shapeCmd, apiShape: shapeApi },
      `D2-3a 形态一致：${shapeCmd}（命令通道 AUTO 在 4 帧时选 World，与 cp 默认 world 相同）`);

    // D2-3b 语义子树哈希（主判据）
    const hCmd = sha256(canonical(semanticsOf(cmdInner)));
    const hApi = sha256(canonical(semanticsOf(apiInner)));
    record('D2', hCmd === hApi, { cmdChannelSha256: hCmd, apiChannelSha256: hApi, semanticsEqual: hCmd === hApi },
      `D2-3b 语义子树哈希一致：命令通道=${hCmd.slice(0, 16)}… API 通道=${hApi.slice(0, 16)}…`);

    // D2-3e 字节（预期不同：cp 通道多了 provenance）——明写「不得据此判红」
    const bytesEqual = sha256(cmdText) === sha256(rawScene);
    record('D2', true, { byteEqual: bytesEqual, note: '`docs/protocol.md` 的 Envelope 编码：不得用字节相等作 D2 判据' },
      `D2-3e 文件字节相同=${bytesEqual}（**不作为判据**——cp 通道多 provenance/exportId，gzip 头含 MTIME）`);

    // 双通道对照落盘（供 export-d2-compare.mjs 复算）
    try {
      const cmp = path.join(HERE, 'export-d2-compare.mjs');
      const cmpOut = path.join(outDir, 'D2-compare.json');
      execFileSync(process.execPath, [
        cmp, path.join(outDir, 'd2-cmd-channel.json'), path.join(outDir, 'acc-scene.json'),
        '--label', 'export', '--json-out', cmpOut, '--byte-ok',
      ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      const c = JSON.parse(fs.readFileSync(cmpOut, 'utf8'));
      record('D2', c.ok === true, { compareOut: c.failures, semanticsEqual: c.semanticsEqual },
        `独立对照脚本复算：semanticsEqual=${c.semanticsEqual}，failures=${c.failures.length}`);
    } catch (e) {
      record('D2', false, { error: String(e?.stdout ?? e?.message ?? e) }, '独立对照脚本失败');
    }
  } else {
    record('D2', false, { artifacts: cmdArtifacts }, '命令通道产物未被 cmd.exec 登记（无法比对）');
  }

  // ---------- C4：同一 run 内导出件 + 实拍 + 观测记录 + 世界清单哈希 ----------
  // case.run 的入参是 {file|inline}（CaseSources.resolve），case 名解析见 CaseSources；
  // 验证用例代号 cp-export-c4（scripts/control-plane/cases/export-c4.json）。
  const caseRun = await call('case.run', {
    inline: JSON.parse(fs.readFileSync(path.join(HERE, 'cases', 'export-c4.json'), 'utf8')),
    segments: ['world', 'capture', 'build', 'read', 'export', 'cameras', 'criteria', 'evidence'],
  }, { tier: 'forensic', timeoutMs: 300000 });
  if (!caseRun.ok) {
    record('C4', false, { error: caseRun.error }, `case.run（含 export 段）失败: ${JSON.stringify(caseRun.error)}`);
  } else {
    const runId = caseRun.data.runId;
    const runMan = await manifest(runId);
    fs.writeFileSync(path.join(outDir, 'C4-run-manifest.json'), JSON.stringify(runMan, null, 2));
    const paths = (runMan.artifacts ?? []).map((a) => a.path);
    const hasExport = paths.some((p) => p.startsWith('export/') && p.endsWith('.json') && !p.includes('/frames/'));
    const hasShot = paths.some((p) => p.startsWith('shots/'));
    const hasObs = paths.includes('observation.json');
    const hasManifest = paths.includes('world/scene-manifest.json');
    record('C4', hasExport && hasObs && hasManifest,
      { runId, paths, hasExport, hasShot, hasObs, hasManifest },
      `run ${runId} 同 run 含：导出件=${hasExport} 实拍=${hasShot} 观测记录=${hasObs} 世界清单=${hasManifest}`);

    // run 内世界清单哈希唯一
    const sceneManifestText = await download(runId, 'world/scene-manifest.json');
    const sm = JSON.parse(sceneManifestText);
    const obsText = await download(runId, 'observation.json');
    const obs = JSON.parse(obsText);
    // 「run 内世界清单哈希唯一」= 观测记录里记的 sceneManifestSha256 与磁盘上那一份的哈希一致
    const diskHash = createHash('sha256').update(sceneManifestText, 'utf8').digest('hex');
    const obsHash = obs.sceneManifestSha256 ?? obs.world?.sceneManifestSha256 ?? null;
    const hashMatches = obsHash === null ? null : obsHash === diskHash;
    record('C4', hashMatches !== false,
      { runId, diskHash, obsHash, hashMatches, note: hashMatches === null ? '观测记录未带该字段，改由 criteria 段的 world-hash-equals 判据覆盖' : null },
      `run 内世界清单哈希唯一性：磁盘 sha256=${diskHash.slice(0, 16)}… 观测记录=${obsHash ? obsHash.slice(0, 16) + '…' : '(未记录)'} 一致=${hashMatches}`);

    // 导出件在同一 run 内可下载可解析
    const exportRel = paths.find((p) => p.startsWith('export/') && p.endsWith('.json') && !p.includes('/frames/'));
    if (exportRel) {
      const t = await download(runId, exportRel);
      const d = JSON.parse(t);
      const u = unwrap(d);
      const fr = Array.isArray(u.inner.frames) ? u.inner.frames : [];
      record('C4', fr.length >= 1 && fr.every((f) => f.structure?.geometryPhase === 'baked'),
        { exportRel, frames: fr.length, phases: fr.map((f) => f.structure?.geometryPhase) },
        `同 run 导出件 ${exportRel}：${fr.length} 帧全部 geometryPhase=baked`);
    }
  }

  // ---------- D3：默认值可见 ----------
  const actions = await (await fetch(`${BASE}/actions`, { headers: { Authorization: `Bearer ${tokens.observe}` } })).json();
  const list = actions.data?.actions ?? actions.actions ?? [];
  const mustHaveDefaults = {
    'export.scene': ['shape', 'frames', 'maxFrames', 'maxCells', 'includeFrames', 'raw', 'keepBuffer'],
    'export.multiblock': ['limit', 'maxVariantsPerMachine', 'maxChannelValues', 'structuralOnly', 'globalBudgetMs', 'keepDataset', 'dataset', 'dryRun'],
    'export.registry': ['waitTicks'],
  };
  let d3Bad = [];
  for (const [name, params] of Object.entries(mustHaveDefaults)) {
    const d = list.find((a) => a.name === name);
    if (!d) { d3Bad.push(`${name} 未注册`); continue; }
    for (const p of params) {
      const pd = (d.params ?? []).find((x) => x.name === p);
      if (!pd) d3Bad.push(`${name}.${p} 缺自述`);
      else if (!pd.required && pd.default === undefined) d3Bad.push(`${name}.${p} 无可选默认值`);
    }
  }
  record('D3', d3Bad.length === 0, { problems: d3Bad, actionCount: list.length },
    `D3 默认值可见：${Object.keys(mustHaveDefaults).length} 个新动作的关键默认值全部在自述里（problems=${d3Bad.length}）`);
  record('D3', list.every((a) => a.since && parseFloat(a.since) <= parseFloat(server.contractVersion)),
    { contractVersion: server.contractVersion, maxSince: list.map((a) => a.since).sort().pop() },
    `D1/D3 版本不变式：全部 ${list.length} 个动作的 since ≤ ${server.contractVersion}`);

  // ---------- D5：无隐藏通道 ----------
  const forbidden = await call('cmd.exec', { command: '/sde web' });
  record('D5', !forbidden.ok && forbidden.error?.code === 'CP-VALID-002' && Array.isArray(forbidden.error?.context?.alternatives),
    { error: forbidden.error },
    `负对照：/sde web 经 cmd.exec 被拒（${forbidden.error?.code}），带 alternatives`);
  record('D5', list.every((a) => a.name.startsWith('core.') || a.name.startsWith('world.') || a.name.startsWith('case.')
    || a.name.startsWith('read.') || a.name.startsWith('scene.') || a.name.startsWith('player.')
    || a.name.startsWith('capture.') || a.name.startsWith('shot.') || a.name.startsWith('cmd.') || a.name.startsWith('export.')),
    { names: list.map((a) => a.name) },
    `动作命名空间封闭（无计划外前缀）`);

  return;
}

function writeReport() {
  const gateList = [...gates.values()].sort((a, b) => a.gate.localeCompare(b.gate));
  const allOk = gateList.every((g) => g.ok);
  const out = {
    schema: 'lightning.cp-export-acceptance/1',
    generatedAt: new Date().toISOString(),
    mcDir,
    contractVersion: server.contractVersion,
    gates: gateList,
    log,
    ok: allOk,
  };
  fs.writeFileSync(path.join(outDir, 'acceptance-report.json'), JSON.stringify(out, null, 2));
  const md = ['# 导出族验收报告（导出与产物纪律）', '', `- 生成时刻：${out.generatedAt}`, `- 契约版本：${out.contractVersion}`, `- 结论：**${allOk ? '全绿' : '红'}**`, '', '## 逐条判据', ''];
  for (const g of gateList) {
    md.push(`### ${g.gate} —— ${g.ok ? '绿' : '红'}`, '');
    for (const c of g.checks) md.push(`- ${c.ok ? '✅' : '❌'} ${c.note}`);
    md.push('');
  }
  fs.writeFileSync(path.join(outDir, 'acceptance-report.md'), md.join('\n'));
  console.log(`\n[acc] ${allOk ? '全绿' : '红'} —— 报告：${path.join(outDir, 'acceptance-report.json')}`);
  for (const g of gateList) console.log(`   ${g.ok ? 'OK ' : 'XX '} ${g.gate}`);
  process.exit(allOk ? 0 : 1);
}

try {
  await main();
} catch (e) {
  console.error(`[acc] 异常: ${e?.stack ?? e}`);
  record('runtime', false, { error: String(e?.message ?? e) }, `驱动异常: ${e?.message ?? e}`);
}
writeReport();
