#!/usr/bin/env node
/**
 * cp 产物检视器（诊断用，非判据）。
 *
 * 用法：
 *   node scripts/control-plane/inspect-artifact.mjs <runId> <runRelativePath> [--mc-dir <path>]
 *   node scripts/control-plane/inspect-artifact.mjs --file <本地文件>
 *
 * 打印：顶层键 / inner 键 / 根级 blockPalette 长度 / 帧结构键 / 帧级 blockPalette /
 * meta 键 / exportId 配对 / 帧数与 index。用于人工核对产物形态（判据在 export-check.mjs）。
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

async function fetchArtifact(runId, rel) {
  const tok = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'tokens.json'), 'utf8')).tokens.observe;
  const srv = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'server.json'), 'utf8'));
  const url = `http://${srv.bind}:${srv.port}/cp/v1/artifacts/${runId}/${rel}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return JSON.parse(await res.text());
}

async function main() {
  let doc;
  if (args.file) {
    doc = JSON.parse(fs.readFileSync(path.resolve(args.file), 'utf8'));
  } else {
    const [runId, rel] = args._;
    if (!runId || !rel) {
      console.error('用法: inspect-artifact.mjs <runId> <runRelativePath> | --file <path>');
      process.exit(2);
    }
    doc = await fetchArtifact(runId, rel);
  }
  const { meta, inner, envelope } = unwrap(doc);
  console.log(`documentFormat = ${envelope ? 'Envelope(' + envelope.payloadEncoding + ')' : 'Plain'}`);
  console.log(`顶层键 = ${Object.keys(doc).sort().join(', ')}`);
  console.log(`meta 键 = ${Object.keys(meta).sort().join(', ')}`);
  console.log(`inner 键 = ${Object.keys(inner ?? {}).sort().join(', ')}`);
  const rootPal = Array.isArray(inner?.blockPalette) ? inner.blockPalette.length : '(absent)';
  console.log(`根级 blockPalette = ${rootPal}`);
  const frames = Array.isArray(inner?.frames) ? inner.frames : [];
  console.log(`帧数 = ${frames.length}`);
  for (const f of frames) {
    const st = f.structure ?? {};
    console.log(`  F${f.index}: key=${Object.keys(st).sort().join(',')}`);
    console.log(`        geometryPhase=${st.geometryPhase} blockPalette=${Array.isArray(st.blockPalette) ? st.blockPalette.length : '(absent)'} cellGrid=${Array.isArray(st.cellGrid) ? 'yes' : '(absent)'}`);
    console.log(`        exportId=${f.exportId ?? '(none)'}`);
  }
  const prov = meta.provenance ?? inner?.provenance ?? null;
  if (prov) {
    console.log(`provenance.exportId = ${prov.exportId}`);
    console.log(`provenance.shape = ${prov.shape}  bufferGeneration = ${prov.bufferGeneration}`);
    console.log(`provenance.frameSha256 = ${JSON.stringify(prov.frameSha256)}`);
    console.log(`provenance.recordedFrames = ${JSON.stringify(prov.recordedFrames)}`);
  } else {
    console.log('provenance = (absent)');
  }
  if (!Array.isArray(inner?.frames)) {
    console.log(`裸结构: geometryPhase=${inner?.geometryPhase} cellGrid=${Array.isArray(inner?.cellGrid) ? 'yes' : '(absent)'} cellTypes=${inner?.cellTypes !== undefined ? 'PRESENT(未烘焙!)' : 'absent'}`);
  }
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(2); });
