#!/usr/bin/env node
/**
 * #102 · 找出「逐帧世界状态不同」的可用配方（诊断，非判据）。
 *
 * 已知事实（本单实测）：
 *   - `/sde pos1|pos2` 的坐标来自**服务端玩家实体**（无坐标参数），值 = `floor(玩家坐标)`，
 *     回报里标注「脚下方块」；
 *   - `scene.player.pose` **确实**移动服务端玩家（实测 pos1 从旧会话的 64,13,64 变成 pose 后的 513,6,-647）；
 *   - `player.place_block` 走 PlayerControllerMP.onPlayerRightClick，**受触达距离约束**；
 *     动作回报 ok + `read.block`（客户端侧）看得到，**不等于服务端世界真的有**
 *     —— 服务端拒绝时，`/sde record`（服务端扫描）扫出来仍是空气。
 *
 * 本脚本对候选配方逐个实测，用**服务端侧证据**（导出产物的 blockPalette/cellGrid）判定：
 * 「选区包住了放置点，且放置点在触达距离内」时，服务端世界里才会真的有那块方块。
 *
 * 用法：node scripts/control-plane/frame-recipe-probe.mjs [--mc-dir <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
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
const srv = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'server.json'), 'utf8'));
const tokens = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'tokens.json'), 'utf8')).tokens;
const BASE = `http://${srv.bind}:${srv.port}/cp/v1`;

async function call(action, params, tier = 'scene') {
  const body = tier === 'observe' ? { ...params } : { ...params, confirm: true };
  const res = await fetch(`${BASE}/actions/${action}?sync=true&timeoutMs=180000`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[tier]}` },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (j.ok !== true) return { ok: false, error: j.error };
  const job = j.data ?? {};
  if (job.state === 'failed') return { ok: false, error: job.error };
  return { ok: true, data: job.result ?? job };
}

// 回报用**全角**括号（SDE: pos1 已记录（513, 6, -647，脚下方块））——半角正则匹配不到
const coordRe = /[（(]\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/;
function coordsOf(reply) {
  const m = coordRe.exec(String(reply ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

async function exportRaw(name) {
  const ex = await call('export.scene', { name, shape: 'world', raw: true });
  if (!ex.ok) return { ok: false, error: ex.error };
  const res = await fetch(`${BASE}/artifacts/${ex.data.runId}/${ex.data.path}`, {
    headers: { Authorization: `Bearer ${tokens.observe}` },
  });
  const doc = JSON.parse(await res.text());
  const inner = doc.documentFormat === 'Envelope'
    ? JSON.parse(gunzipSync(Buffer.from(doc.payload, 'base64')).toString('utf8'))
    : doc;
  return { ok: true, inner, runId: ex.data.runId, path: ex.data.path };
}

const FOLDER = 'cp_recipe_probe';
await call('world.rebuild', { folder: FOLDER, void: true, seed: 20261007 });
const info = await call('world.info', {}, 'observe');
const spawn = info.data?.world?.spawn ?? [0, 0, 0];
console.log(`[probe] spawn=${JSON.stringify(spawn)}`);

await call('scene.inventory.write', { slots: Array.from({ length: 9 }, (_, s) => ({ slot: s, id: 'minecraft:stone', count: 1 })) });
await call('cmd.exec', { command: '/sde sel cuboid' });

// ① 固定选区：pos1 = floor(下方锚点)，pos2 = pos1 + [3,3,3]
const ax = spawn[0], ay = spawn[1], az = spawn[2];
await call('scene.player.pose', { pos: [ax + 0.5, ay + 1.0, az + 0.5], yaw: 0, pitch: 90 });
const rp1 = await call('cmd.exec', { command: '/sde pos1' });
const p1 = coordsOf(rp1.data?.reply);
await call('scene.player.pose', { pos: [ax + 3.5, ay + 4.0, az + 3.5], yaw: 0, pitch: 90 });
const rp2 = await call('cmd.exec', { command: '/sde pos2' });
const p2 = coordsOf(rp2.data?.reply);
console.log(`[probe] pos1=${JSON.stringify(p1)} pos2=${JSON.stringify(p2)}`);
if (!p1 || !p2) { console.log('[probe] 坐标解析失败，退出'); process.exit(2); }

await call('cmd.exec', { command: '/sde start' });

// ② 逐帧：站到选区内某格正上方，在**脚下一格**（选区内）放石头
const FRAMES = [0, 1, 2];
const results = [];
for (const k of FRAMES) {
  const target = [p1[0] + k, p1[1], p1[2]]; // 选区内、贴地第一层
  // 站到目标格正上方 → 目标格在触达距离 1
  const poseRes = await call('scene.player.pose', { pos: [target[0] + 0.5, target[1] + 1.0, target[2] + 0.5], yaw: 0, pitch: 90 });
  const pl = await call('player.place_block', { at: target });
  await call('cmd.exec', { command: `/sde setframe ${k}` });
  const rec = await call('cmd.exec', { command: `/sde record` });
  results.push({ frame: k, target, poseOk: poseRes.ok, placeOk: pl.ok, placeErr: pl.ok ? null : pl.error?.code, recOk: rec.ok });
}

const ex = await exportRaw('recipe');
if (!ex.ok) {
  console.log(`[probe] export 失败: ${JSON.stringify(ex.error)}`);
} else {
  const pal = (ex.inner.blockPalette ?? []).map((p) => p.registryId);
  console.log(`[probe] ★ 根级 blockPalette = ${JSON.stringify(pal)}`);
  for (const f of ex.inner.frames ?? []) {
    console.log(`   F${f.index} cellGrid=${JSON.stringify(f.structure?.cellGrid)}`);
  }
  const nonAir = pal.filter((r) => r && r !== 'air').length;
  const distinct = new Set((ex.inner.frames ?? []).map((f) => JSON.stringify(f.structure?.cellGrid))).size;
  console.log(`[probe] ★ 判定：服务端世界里 ${nonAir} 种非空气方块；帧内容两两不同数 = ${distinct}/${(ex.inner.frames ?? []).length}`);
  console.log(`[probe] 逐步结果: ${JSON.stringify(results)}`);
}
