#!/usr/bin/env node
/**
 * #102 收口T5 · 最小实验：证伪「扫描 + 烘焙可在同一 cp 动作内完成」
 * ==========================================================================
 *
 * 背景（`temp/cp-export-prep/migration-design.md` §6 末段）：
 * 「『扫描+烘焙可在同一 cp 动作内完成』依据是『cp 动作跑在 Client thread』这一契约事实
 *  （contract.md:19）与 MeshCaptureService 的 @SideOnly(CLIENT) 标注，**属推断，需在 #102
 *  实现期用最小实验证伪一次**」。
 *
 * 本脚本就做这一件事，分两步（都可独立判红）：
 *
 *   **E1（前置能力）**：`export.session` 能读到「命令通道设的状态」——
 *        即 cmd.exec 在服务端线程设的选区/帧号，经 cp 只读动作在客户端 tick 线程读得回。
 *        （#100 已交付，这里是把它当验收工具用起来。）
 *
 *   **E2（本单的核心推断）**：`export.scene` 一次调用内完成 scan → bake → write：
 *        - 产物的 `geometryPhase` 必须是 `baked`（不是 `scan`）⇒ 烘焙真的跑了；
 *        - `blockPalette` 非空且 `cellTypes`/`worldGrid` 已消失（烘焙终态的硬约束）；
 *        - 产物落进 run 目录并登记 sha256。
 *        若这条红（例如产物停在 `geometryPhase=scan`、或动作报 CP-STATE-001），
 *        则「同一动作内烘焙」的推断被证伪，搬迁方案须改回「网络包投递 + 客户端二段式」。
 *
 * 用法：
 *   node scripts/control-plane/export-minimal-experiment.mjs [--mc-dir <path>] [--json-out <path>]
 *                                                            [--folder cp_export_t5] [--size 3]
 * 退出码：0 = 全绿（推断成立）；1 = 有硬失败（推断被证伪或有缺陷）；2 = 输入不可用。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const failures = [];
const warnings = [];
const steps = [];
const fail = (gate, msg) => failures.push({ gate, msg });
const warn = (gate, msg) => warnings.push({ gate, msg });

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
const folder = args.folder ?? 'cp_export_t5';
const size = Number(args.size ?? 3);

// ---------------------------------------------------------------- cp 客户端

function readServer() {
  const p = path.join(mcDir, 'controlplane', 'server.json');
  if (!fs.existsSync(p)) throw new Error(`找不到 ${p}（控制面未启用或未启动）`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readTokens() {
  const p = path.join(mcDir, 'controlplane', 'tokens.json');
  if (!fs.existsSync(p)) throw new Error(`找不到 ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8')).tokens;
}

const server = readServer();
const tokens = readTokens();
const BASE = `http://${server.bind}:${server.port}/cp/v1`;

async function call(action, params, { tier = 'scene', timeoutMs = 120000, sync = true } = {}) {
  const body = { ...(params ?? {}) };
  if (tier !== 'observe') body.confirm = true;
  const url = `${BASE}/actions/${action}${sync ? `?sync=true&timeoutMs=${timeoutMs}` : ''}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[tier]}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  // 响应信封：`{ok:true, data:{jobId,state,result,...}}`（?sync=true 时 data 是作业对象，
  // 动作的真实返回值在 `data.result`；异步提交时 data 只有 jobId）。
  const job = json?.ok === true ? json.data : null;
  const rec = {
    action,
    tier,
    httpStatus: res.status,
    elapsedMs: Date.now() - t0,
    ok: json?.ok === true && (job?.state === undefined || job.state === 'done'),
    jobState: job?.state ?? null,
    error: json?.ok === false ? json.error
      : job?.state === 'failed' ? job.error
      : null,
    data: job?.result ?? job,
  };
  steps.push(rec);
  return rec;
}

function unwrapEnvelope(doc) {
  if (doc && doc.documentFormat === 'Envelope' && typeof doc.payload === 'string') {
    const buf = Buffer.from(doc.payload, 'base64');
    let inner;
    try { inner = JSON.parse(buf.toString('utf8')); }
    catch { inner = JSON.parse(gunzipSync(buf).toString('utf8')); }
    return { meta: doc.meta ?? {}, inner };
  }
  return { meta: doc ?? {}, inner: doc };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`[exp] cp @ ${BASE}  contractVersion=${server.contractVersion}`);

  // ---- 0) 前置：控制面活着 + 契约版本
  const ping = await call('core.ping', {}, { tier: 'observe' });
  if (!ping.ok) { fail('pre', `core.ping 失败: ${JSON.stringify(ping.error)}`); return report(); }

  // ---- 1) hermetic 起手：虚空重建（#96 §10-C4 纪律）
  const rebuild = await call('world.rebuild', { folder, void: true, seed: 20261007 });
  if (!rebuild.ok) { fail('E0', `world.rebuild 失败: ${JSON.stringify(rebuild.error)}`); return report(); }
  console.log(`[exp] world.rebuild ok（folder=${folder}）`);

  // ---- 2) 用 L1 放一块方块当扫描目标（虚空世界里否则全是空气）
  //      先经 L0 把方块塞进主手槽（9 号快捷栏），再 place_block —— 否则手持物不是方块会被拒。
  const base = rebuild.data?.base ?? rebuild.data?.world?.base ?? null;
  const bx = base?.[0] ?? 64, by = base?.[1] ?? 12, bz = base?.[2] ?? 64;
  await call('scene.inventory.write', { slots: [{ slot: 36 + 8, id: 'minecraft:stone', count: 1 }] });
  await call('player.look', { yaw: 0, pitch: 90 }); // 朝下
  const placed = await call('player.place_block', { pos: [bx, by, bz] });
  if (!placed.ok) {
    warn('E2', `player.place_block 未成功（${JSON.stringify(placed.error)}）——退化为「全空气选区」实验，结论仍有效`);
  } else {
    console.log(`[exp] 已在 (${bx},${by},${bz}) 放置 minecraft:stone`);
  }

  // ---- 3) 命令通道设选区（服务端线程）
  const pos1 = await call('cmd.exec', { command: `/sde pos1` }, { tier: 'scene' });
  const pos2 = await call('cmd.exec', { command: `/sde pos2` }, { tier: 'scene' });
  if (!pos1.ok || !pos2.ok) {
    fail('E1', `cmd.exec pos1/pos2 失败: ${JSON.stringify(pos1.error ?? pos2.error)}`);
    return report();
  }
  console.log(`[exp] pos1 回报: ${String(pos1.data.reply ?? '').trim().split('\n')[0]}`);
  console.log(`[exp] pos2 回报: ${String(pos2.data.reply ?? '').trim().split('\n')[0]}`);

  // 选区可能只有 1 格：用 /sde sel cuboid 保证是 cuboid 模式
  await call('cmd.exec', { command: `/sde sel cuboid` });

  // ---- 4) 开会话 + 录一帧
  await call('cmd.exec', { command: `/sde start` });
  const setframe = await call('cmd.exec', { command: `/sde setframe 0` });
  const rec = await call('cmd.exec', { command: `/sde record` });
  if (!rec.ok) { fail('E1', `record 失败: ${JSON.stringify(rec.error)}`); return report(); }

  // ---- 5) E1：经 export.session 读回「命令通道设的状态」
  const sess = await call('export.session', {}, { tier: 'observe' });
  if (!sess.ok) { fail('E1', `export.session 失败: ${JSON.stringify(sess.error)}`); return report(); }
  const S = sess.data;
  console.log(`[exp] E1 export.session: inSession=${S.inSession} recordedFrames=${JSON.stringify(S.recordedFrames)} activeFrame=${S.activeFrame} selection.complete=${S.selection?.complete}`);
  if (!S.recordedFrames?.includes(0)) fail('E1', `export.session 未看到命令通道录的 F0（recordedFrames=${JSON.stringify(S.recordedFrames)}）`);
  if (!S.selection?.complete) fail('E1', 'export.session 报告的选区不完整——命令设的选区 cp 侧读不到');
  if (S.frameSha256?.length !== S.recordedFrames?.length) {
    fail('E1', `frameSha256 与 recordedFrames 长度不符（${S.frameSha256?.length} vs ${S.recordedFrames?.length}）`);
  } else {
    console.log(`[exp] E1 通过：命令设的状态在 cp 侧可见，frameSha256=[${S.frameSha256}]`);
  }
  // 保存快照供 C2/C3 的「逐帧一致」比对
  const sessionJson = path.join(HERE, '.out', 'export-session-before.json');
  fs.mkdirSync(path.dirname(sessionJson), { recursive: true });
  fs.writeFileSync(sessionJson, JSON.stringify(S, null, 2));

  // ---- 6) E2：export.scene 一次调用内 scan → bake → write
  const scene = await call('export.scene', { name: 'minimal-experiment', shape: 'world', includeFrames: true });
  if (!scene.ok) {
    fail('E2', `export.scene 失败（推断被证伪或实现有缺陷）: ${JSON.stringify(scene.error)}`);
    return report();
  }
  const D = scene.data;
  console.log(`[exp] E2 export.scene ok: path=${D.path} bytes=${D.bytes} shape=${D.shape} frames=${D.frames} runId=${D.runId}`);

  // ---- 7) 读回产物，验证烘焙真的跑了
  const dl = await fetch(`${BASE}/artifacts/${D.runId}/${D.path}`, {
    headers: { Authorization: `Bearer ${tokens.observe}` },
  });
  if (!dl.ok) { fail('E2', `下载产物失败 HTTP ${dl.status}`); return report(); }
  const raw = await dl.text();
  const doc = JSON.parse(raw);
  const { meta, inner } = unwrapEnvelope(doc);
  const frames = Array.isArray(inner.frames) ? inner.frames : [];

  if (frames.length === 0) {
    fail('E2', '产物没有 frames[]（形态不符）');
  } else {
    // 形态口径（format-scene-file.md §2.3）：**World 形态下 blockPalette 被提到根级**
    // （liftBlockPaletteToRoot：跨帧调色板全局去重、cellGrid 重映射为全局下标、帧内 blockPalette 被移除）。
    // 因此「烘焙真的跑了」的判据是「**根级** blockPalette 非空且帧内 cellGrid 在位」，
    // 而不是「帧内 blockPalette 非空」——后者在 World 形态下永远不成立（那是 Structure 形态的形态）。
    const rootPal = inner.blockPalette;
    if (!Array.isArray(rootPal) || rootPal.length === 0) {
      fail('E2', `World 形态缺根级 blockPalette（liftBlockPaletteToRoot 没跑 ⇒ 烘焙未完成）`);
    }
    for (const f of frames) {
      const st = f.structure ?? {};
      const phase = st.geometryPhase;
      if (phase !== 'baked') {
        fail('E2', `帧 F${f.index} 的 geometryPhase=${phase}（应为 baked）——烘焙没跑，推断被证伪`);
      }
      if (!Array.isArray(st.cellGrid)) {
        fail('E2', `帧 F${f.index} 缺 cellGrid（烘焙终态的硬要求）`);
      }
      if (st.cellTypes !== undefined) fail('E2', `帧 F${f.index} 仍带 scan 专有字段 cellTypes（烘焙未清理）`);
      if (st.worldGrid !== undefined) fail('E2', `帧 F${f.index} 仍带 scan 专有字段 worldGrid（烘焙未清理）`);
      if (st.blockPalette !== undefined) {
        // 这一条是 §2.3 的机械面：World 分支必须把帧内调色板提走
        fail('E2', `帧 F${f.index} 仍带帧内 blockPalette（World 分支应经 liftBlockPaletteToRoot 提到根级）`);
      }
    }
    if (failures.length === 0) {
      console.log(
        `[exp] E2 通过：${frames.length} 帧全部 geometryPhase=baked，根级 blockPalette=${rootPal.length} 项，`
          + `scan 专有字段已清理，帧内调色板已提到根级`,
      );
    }
  }

  // ---- 8) 哈希登记（C5）
  const manifest = await fetch(`${BASE}/artifacts/${D.runId}`, { headers: { Authorization: `Bearer ${tokens.observe}` } });
  const man = await manifest.json();
  const entry = (man.data?.artifacts ?? []).find((a) => a.path === D.path);
  if (!entry) {
    fail('C5', `产物 ${D.path} 不在 run ${D.runId} 的清单里`);
  } else if (entry.sha256 !== D.sha256) {
    fail('C5', `清单 sha256 (${entry.sha256}) 与结果声明 (${D.sha256}) 不符`);
  } else {
    console.log(`[exp] C5 通过：清单在位 sha256=${entry.sha256} bytes=${entry.bytes}`);
  }

  // ---- 9) 逐帧明细与 provenance（C3）
  const prov = meta.provenance ?? null;
  if (!prov) {
    fail('C3', '产物 meta 缺 provenance（cp 通道产物必须含它，否则 C3 判据无从落地）');
  } else {
    const ph = prov.frameSha256 ?? {};
    for (const f of frames) {
      if (!(String(f.index) in ph)) fail('C3', `provenance.frameSha256 缺帧 F${f.index}`);
      if (f.exportId !== prov.exportId) fail('C3', `帧 F${f.index} 的 exportId 与 provenance 不一致`);
    }
    if (S.frameSha256?.[0] && ph['0'] && ph['0'] !== S.frameSha256[0]) {
      fail('C2', `F0 内容哈希与录制时不一致：provenance=${ph['0']} export.session=${S.frameSha256[0]}`);
    } else {
      console.log(`[exp] C2/C3 通过：provenance 在位，frameSha256 与 export.session 同源`);
    }
  }

  report({ runId: D.runId, path: D.path, sha256: D.sha256, frames: frames.length });
}

function report(extra = {}) {
  const out = {
    schema: 'lightning.cp-export-minimal-experiment/1',
    generatedAt: new Date().toISOString(),
    mcDir,
    contractVersion: server.contractVersion,
    ...extra,
    steps: steps.map((s) => ({ action: s.action, tier: s.tier, httpStatus: s.httpStatus, ok: s.ok, elapsedMs: s.elapsedMs, error: s.error })),
    failures,
    warnings,
    ok: failures.length === 0,
  };
  if (args['json-out']) {
    const p = path.resolve(args['json-out']);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(out, null, 2));
  }
  console.log(`\n[exp] ${out.ok ? '全绿 —— 「扫描+烘焙可在同一 cp 动作内完成」成立' : '红 —— 见下'}`);
  for (const w of warnings) console.log(`   ! [${w.gate}] ${w.msg}`);
  for (const f of failures) console.log(`   XX [${f.gate}] ${f.msg}`);
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`[exp] 异常: ${e?.stack ?? e}`);
  fail('runtime', String(e?.message ?? e));
  report();
});
