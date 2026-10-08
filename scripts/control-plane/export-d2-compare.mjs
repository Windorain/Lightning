#!/usr/bin/env node
/**
 * #102 收口T5 · D2 双通道一致性对照（口径与 `docs/control-plane/dual-channel-consistency.md` §2.2 对齐）
 * ==========================================================================================
 *
 * 用法：
 *   node scripts/control-plane/export-d2-compare.mjs <channelA.json> <channelB.json>
 *        [--label <名>] [--json-out <path>] [--byte-ok]
 *
 * 输入 = 两条通道各自产物的**解包后 inner**（或整份 Envelope；本脚本自己解包）。
 * 典型来源：
 *   - 命令通道：`cmd.exec {command:"/sde export"}` 的产物，经 `cmd.exec` 登记进 run 的
 *     `cmd-exec/<name>.json`（用 GET /cp/v1/artifacts/{runId}/{path} 下载）；
 *   - API 通道：`export.scene` 的产物 `export/<name>.json`（同法下载）。
 *
 * 判据（逐条可判红）：
 *   D2-3a **形态一致**：两边的 `documentFormat`/`payloadEncoding` 与形态判别（有无 frames）一致；
 *   D2-3b **语义子树哈希一致**：`sha256(canonical(frames[].structure))`（World）或 `sha256(canonical(inner))`
 *          （Structure）相等 —— 这是**主判据**；
 *   D2-3c **帧集一致**：帧号清单相同；
 *   D2-3d 关掉 provenance（`--strip-provenance`，默认开）后再比 —— cp 通道特有的
 *          `provenance`/`exportId` **不算语义差异**（见契约 §4.7.7）；
 *   D2-3e（可选 `--byte-ok`）**文件字节一致**：只在两边都不带 provenance 时才可能成立；
 *          带 provenance 时本项**跳过并说明**，不得据此判红（会把搬迁误判成不一致）。
 *
 * 退出码：0 = 全绿；1 = 有硬失败；2 = 输入不可用。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const failures = [];
const warnings = [];
const notes = [];
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

/** 与 Java 侧 `Json.canonical` 同口径：键字典序、无空白、数字原样。 */
function canonical(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function load(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(raw);
  let inner = doc;
  let meta = {};
  let enveloped = false;
  if (doc.documentFormat === 'Envelope' && typeof doc.payload === 'string') {
    enveloped = true;
    meta = doc.meta ?? {};
    const buf = Buffer.from(doc.payload, 'base64');
    let text;
    try { text = buf.toString('utf8'); inner = JSON.parse(text); }
    catch { inner = JSON.parse(gunzipSync(buf).toString('utf8')); }
  }
  return { file, raw, bytes: Buffer.byteLength(raw, 'utf8'), doc, inner, meta, enveloped, fileSha256: sha256(raw) };
}

/** 摘出「语义子树」（契约 §4.7.7 / dual-channel §2.2.1）。**剔除** provenance/exportId。 */
function semantics(rec) {
  const inner = JSON.parse(JSON.stringify(rec.inner));
  if (Array.isArray(inner.frames)) {
    delete inner.exportId;
    for (const f of inner.frames) {
      delete f.exportId;
      // scan 中间态 → baked 终态之间允许存在「服务端那份还没被 enrich」的差异：
      // 那不是「命令扭曲了行为」，而是两条通道各自的烘焙时机不同 —— 由 --allow-scan-vs-baked 显式放行
    }
    return { kind: 'world', value: inner.frames.map((f) => f.structure), frames: inner.frames.map((f) => f.index) };
  }
  delete inner.exportId;
  return { kind: 'structure', value: inner, frames: [] };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [fa, fb] = args._;
  if (!fa || !fb) {
    console.error('用法: node export-d2-compare.mjs <channelA.json> <channelB.json> [--label <名>] [--json-out <path>] [--byte-ok]');
    process.exit(2);
  }
  if (!fs.existsSync(fa) || !fs.existsSync(fb)) {
    console.error(`[d2] 输入不存在: ${!fs.existsSync(fa) ? fa : fb}`);
    process.exit(2);
  }
  const label = args.label ?? 'export';
  const A = load(path.resolve(fa));
  const B = load(path.resolve(fb));
  notes.push(`A（命令通道/左）= ${A.file}  ${A.bytes} B  sha256=${A.fileSha256}`);
  notes.push(`B（API 通道/右）= ${B.file}  ${B.bytes} B  sha256=${B.fileSha256}`);

  // D2-3a 形态一致
  const fmtA = A.doc.documentFormat ?? 'Plain';
  const fmtB = B.doc.documentFormat ?? 'Plain';
  if (fmtA !== fmtB) fail('D2-3a', `documentFormat 不同：${fmtA} vs ${fmtB}`);
  const encA = A.doc.payloadEncoding ?? null;
  const encB = B.doc.payloadEncoding ?? null;
  if (encA !== encB) fail('D2-3a', `payloadEncoding 不同：${encA} vs ${encB}`);
  const semA = semantics(A);
  const semB = semantics(B);
  if (semA.kind !== semB.kind) {
    fail('D2-3a', `产物形态不同：${semA.kind} vs ${semB.kind}（R1-3 口径唯一要求两边同形态）`);
  } else {
    notes.push(`D2-3a: 形态一致（${semA.kind}，documentFormat=${fmtA}）`);
  }

  // D2-3c 帧集一致
  if (JSON.stringify(semA.frames) !== JSON.stringify(semB.frames)) {
    fail('D2-3c', `帧集不同：A=[${semA.frames}] B=[${semB.frames}]`);
  } else {
    notes.push(`D2-3c: 帧集一致 [${semA.frames}]`);
  }

  // D2-3b 语义子树哈希（主判据）
  const hA = sha256(canonical(semA.value));
  const hB = sha256(canonical(semB.value));
  if (hA !== hB) {
    fail(
      'D2-3b',
      `语义子树哈希不同：A=${hA} B=${hB}（两边执行体相同 ⇒ 不同即「命令扭曲了行为」或落点/形态口径漂移）`,
    );
  } else {
    notes.push(`D2-3b: 语义子树哈希一致（${hA}）`);
  }

  // D2-3d provenance 剔除后的残余差异（逐键定位，便于判红时直接看出漂移在哪）
  const provA = A.meta.provenance ?? A.doc.provenance ?? null;
  const provB = B.meta.provenance ?? B.doc.provenance ?? null;
  if (provA && !provB) {
    notes.push('D2-3d: A 侧带 provenance / B 侧不带（cp 通道特有的 C3 判据字段）——已从语义子树剔除，不算差异');
  } else if (!provA && provB) {
    notes.push('D2-3d: B 侧带 provenance / A 侧不带 —— 已剔除，不算差异');
  } else if (provA && provB) {
    if (provA.shape !== provB.shape) fail('D2-3d', `provenance.shape 不同：${provA.shape} vs ${provB.shape}`);
    if (provA.exportId !== provB.exportId) {
      warn('D2-3d', `provenance.exportId 不同（A=${provA.exportId} B=${provB.exportId}）——runId 不同即预期`);
    }
    notes.push('D2-3d: 两侧都带 provenance（已剔除后比对）');
  } else {
    notes.push('D2-3d: 两侧都不带 provenance（命令通道对命令通道，或都关了）');
  }

  // D2-3e 文件字节（可选）
  if (args['byte-ok']) {
    if (provA || provB) {
      warn(
        'D2-3e',
        '任一侧带 provenance ⇒ 文件字节必然不同（含 runId/exportId），本项**跳过**：'
          + '契约 §4.7.7 明写不得用字节相等作 D2 判据（会把搬迁误判成不一致）',
      );
    } else if (A.fileSha256 !== B.fileSha256) {
      fail('D2-3e', `文件字节不同：A=${A.fileSha256} B=${B.fileSha256}（两侧都无 provenance 时本应逐字节相同）`);
    } else {
      notes.push(`D2-3e: 文件字节一致（${A.fileSha256}）`);
    }
  }

  const out = {
    schema: 'lightning.cp-export-d2/1',
    generatedAt: new Date().toISOString(),
    label,
    channelA: { file: A.file, bytes: A.bytes, sha256: A.fileSha256, format: fmtA, kind: semA.kind, frames: semA.frames, semanticsSha256: hA },
    channelB: { file: B.file, bytes: B.bytes, sha256: B.fileSha256, format: fmtB, kind: semB.kind, frames: semB.frames, semanticsSha256: hB },
    semanticsEqual: hA === hB,
    byteEqual: A.fileSha256 === B.fileSha256,
    failures,
    warnings,
    notes,
    ok: failures.length === 0,
  };
  if (args['json-out']) {
    const p = path.resolve(args['json-out']);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(out, null, 2));
  }
  console.log(`[d2] ${label}: ${out.ok ? '全绿' : '红'}`);
  for (const n of notes) console.log(`   · ${n}`);
  for (const w of warnings) console.log(`   ! [${w.gate}] ${w.msg}`);
  for (const f of failures) console.log(`   XX [${f.gate}] ${f.msg}`);
  process.exit(out.ok ? 0 : 1);
}

main();
