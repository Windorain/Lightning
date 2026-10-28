#!/usr/bin/env node
/**
 * 场景文件产物检查器（C1 / C2 / C3 的机器判据）
 * ==========================================================================
 *
 * 用法：
 *   node scripts/control-plane/export-check.mjs <scene-file> [options]
 *   node scripts/control-plane/export-check.mjs --run-dir <runId> --mc-dir <path> [...]
 *
 * 它回答四个问题（每个都可独立判红）：
 *
 *   ① **C1 可用性**：产物能被既有消费方解析吗？—— 本脚本**不自己实现解析器**，
 *      而是调用 `web/src/` 里真实的工作台解析路径（esbuild 现场捆成 ESM，不改 web/ 下任何文件）。
 *      判据 = `readEnvelopeLayers`（解信封）成功 + 形态判别为 World/Structure + `RuntimeDocument` 构造成功。
 *   ② **C2 逐帧一致**：产物含 N 帧，且每帧内容与「录制时的世界状态」一致吗？——
 *      与 `export.session` 的 `frameSha256`（录制那一刻的缓冲文本哈希）逐帧配对比对。
 *   ③ **C3 同会话同缓冲**：全部帧的 `exportId` 一致、根级与帧级一致、
 *      `provenance.frameSha256` 与 `frames[].index` 配对且与 `export.session` 同源。
 *      `--expect-frames 0,1,2` 时额外断言帧集**恰好**是这些（跨会话拼接会在这里判红）。
 *   ④ **形态统一（R1-3）**：`--expect-shape world` 时断言顶层有 `frames`（单帧即 N=1 的文档）——
 *      这是 C1 与 C2 产出同一种文件的可判定面。
 *
 * 退出码：0 = 全绿；1 = 有硬失败；2 = 输入不可用。
 *
 * 关键设计（与 `docs/protocol.md` 的 Envelope 编码口径对齐：解包后语义摘要，不比字节）：
 *   - **不做文件字节比对**：gzip 头含 MTIME，且 cp 通道多了 provenance；
 *   - 语义子树 = `frames[].structure`（World）或整个 inner（Structure）；
 *   - 规范化哈希用**键字典序 + 无空白**的手写序列化器（与 Java 侧 `Json.canonical` 同口径）。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WEB = path.join(REPO, 'web');

const failures = [];
const warnings = [];
const notes = [];
const fail = (gate, msg) => failures.push({ gate, msg });
const warn = (gate, msg) => warnings.push({ gate, msg });

// ---------------------------------------------------------------- 参数

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
const jsonOut = args['json-out'] ? path.resolve(args['json-out']) : null;

// ---------------------------------------------------------------- 规范化哈希（与 Java Json.canonical 同口径）

/** 手写序列化器：键字典序、无空白、数字原样、字符串 JSON 转义。 */
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

/** 解 Envelope（若已解则原样返回）。 */
function unwrap(doc) {
  if (doc && doc.documentFormat === 'Envelope' && typeof doc.payload === 'string') {
    const raw = Buffer.from(doc.payload, 'base64');
    let text;
    try { text = raw.toString('utf8'); }
    catch { text = null; }
    let inner;
    try { inner = JSON.parse(text); }
    catch { inner = JSON.parse(gunzipSync(raw).toString('utf8')); }
    return { envelope: doc, meta: doc.meta ?? {}, inner };
  }
  return { envelope: null, meta: doc ?? {}, inner: doc };
}

// ---------------------------------------------------------------- ① C1：喂给 web 侧真实解析器

/**
 * 用 esbuild 把 web 侧真实模块捆成临时 ESM再调用 —— **不修改 web/ 下任何文件**。
 * 与 `scripts/multiblock-encode/verify-web-parser.mjs` 同一手法（既有约定）。
 */
async function loadWebConsumers() {
  const esbuildEntry = pathToFileURL(path.join(WEB, 'node_modules', 'esbuild', 'lib', 'main.js')).href;
  let esbuild;
  try {
    esbuild = await import(esbuildEntry);
  } catch (e) {
    return { ok: false, reason: `web/node_modules 缺失（先 cd web && pnpm install --frozen-lockfile）: ${e}` };
  }
  const outDir = path.join(HERE, '.out');
  fs.mkdirSync(outDir, { recursive: true });
  const bundlePath = path.join(outDir, 'web-consumers-bundle.mjs');
  try {
    await esbuild.build({
      stdin: {
        contents: `
export { readEnvelopeLayers, isEnvelopeDocument, normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'
export { isWorldDocument } from '@/render/data/bundleResolve'
export { StructureDataParser, WorldParser, createParserRegistry, createEnvelopeParser } from '@/context/parsers/builtinParsers'
`,
        resolveDir: WEB,
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: bundlePath,
      logLevel: 'silent',
      alias: { '@': path.join(WEB, 'src') },
    });
  } catch (e) {
    return { ok: false, reason: `esbuild 捆绑失败: ${e}` };
  }
  return { ok: true, module: await import(pathToFileURL(bundlePath).href) };
}

// ---------------------------------------------------------------- 主流程

function frames0(inner) {
  return Array.isArray(inner?.frames) ? inner.frames : [];
}

function readSession() {
  // 可选的 export.session 快照（C2/C3 的对照基准）：调用方先存到文件
  if (!args['session-json']) return null;
  const p = path.resolve(args['session-json']);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function resolveSceneFile() {
  if (args._[0]) return path.resolve(args._[0]);
  if (!args['run-dir']) return null;
  const runDir = path.join(mcDir, 'controlplane', 'runs', args['run-dir']);
  const exportDir = path.join(runDir, 'export');
  if (!fs.existsSync(exportDir)) return null;
  const names = fs.readdirSync(exportDir).filter((f) => f.endsWith('.json'));
  if (names.length === 0) return null;
  // 优先 `--name`，否则取第一份非 frames/ 下的（主产物）
  if (args.name) {
    const p = path.join(exportDir, `${args.name}.json`);
    return fs.existsSync(p) ? p : null;
  }
  return path.join(exportDir, names[0]);
}

async function main() {
  const sceneFile = await resolveSceneFile();
  if (!sceneFile || !fs.existsSync(sceneFile)) {
    console.error(`[export-check] 找不到场景文件（${sceneFile ?? '(未给定)'}）`);
    process.exit(2);
  }
  notes.push(`场景文件: ${sceneFile}`);

  const rawText = fs.readFileSync(sceneFile, 'utf8');
  let doc;
  try { doc = JSON.parse(rawText); }
  catch (e) { fail('C1', `产物不是合法 JSON: ${e}`); return report({ sceneFile, bytes: rawText.length }); }

  const { envelope, meta, inner } = unwrap(doc);
  const fileSha256 = sha256(rawText);

  // 形态判别（判别式 = 顶层/ inner 有 frames）
  const hasFrames = !!(inner && Array.isArray(inner.frames));
  const shape = hasFrames ? 'world' : 'structure';
  notes.push(`形态: ${shape}（documentFormat=${doc.documentFormat ?? '(无)'}）`);

  if (args['expect-shape']) {
    if (args['expect-shape'] !== shape) {
      fail('R1-3', `形态不符：期望 ${args['expect-shape']}，实际 ${shape}（口径唯一要求单帧也是 world）`);
    } else {
      notes.push(`R1-3 通过：形态 = ${shape}`);
    }
  }

  // ---- ① C1：喂给 web 侧真实解析器 ----
  const consumers = await loadWebConsumers();
  let webOk = null;
  if (!consumers.ok) {
    warn('C1', `未调用 web 侧解析器：${consumers.reason}`);
  } else {
    const M = consumers.module;
    try {
      // 既有消费方的真实入口是「先归一化成 Plain，再按形态分派」：
      // Envelope 的 `id`/`label`/`playback` 等**在 meta 里**，inner（payload）只有 frames/palette 等体数据，
      // 因此直接对 inner 调 `WorldParser.detect` 必然 false（detect 要求 `typeof d.id === 'string'`）。
      // 正解 = `normalizeEnvelopeToPlain`（它把 meta 折进 inner 并标 documentFormat:Plain）。
      let plain = doc;
      if (envelope) {
        const layers = await M.readEnvelopeLayers(envelope);
        if (!layers || !layers.inner) throw new Error('readEnvelopeLayers 返回空 inner');
        notes.push('C1: readEnvelopeLayers 解包成功');
        plain = await M.normalizeEnvelopeToPlain(envelope);
        if (plain === envelope) throw new Error('normalizeEnvelopeToPlain 未把 Envelope 归一化成 Plain');
        if (plain.documentFormat !== 'Plain') {
          notes.push(`C1: normalizeEnvelopeToPlain 得到 documentFormat=${plain.documentFormat}（非 Plain，但已可判别）`);
        } else {
          notes.push('C1: normalizeEnvelopeToPlain → documentFormat=Plain（meta 已折入根）');
        }
        if (typeof plain.id !== 'string') {
          throw new Error(`归一化后仍缺根级 id（实际 ${typeof plain.id}）——工作台的 World 判别器会拒绝它`);
        }
      }
      const isWorld = Array.isArray(plain.frames);
      if (isWorld) {
        const ok = M.WorldParser.detect(plain);
        if (!ok) throw new Error('WorldParser.detect(plain) 为 false');
        notes.push('C1: WorldParser.detect = true');
        const rt = await M.WorldParser.parse(plain);
        if (!rt) throw new Error('WorldParser.parse(plain) 返回 null（工作台会拒绝这份文件）');
        const fc = typeof rt.frameCount === 'function' ? rt.frameCount() : null;
        if (fc !== null && fc !== plain.frames.length) {
          throw new Error(`RuntimeDocument.frameCount()=${fc} 与 frames 长度 ${plain.frames.length} 不符`);
        }
        notes.push(`C1: RuntimeDocument 构造成功（frameCount=${fc ?? '?'}）`);
      } else {
        const ok = M.StructureDataParser.detect(plain);
        if (!ok) throw new Error('StructureDataParser.detect(plain) 为 false');
        notes.push('C1: StructureDataParser.detect = true');
        const rt = await M.StructureDataParser.parse(plain);
        if (!rt) throw new Error('StructureDataParser.parse(plain) 返回 null（工作台会拒绝这份文件）');
        notes.push('C1: RuntimeDocument 构造成功');
      }
      webOk = true;
    } catch (e) {
      webOk = false;
      fail('C1', `既有消费方解析失败: ${e}`);
    }
  }

  // ---- 帧解析 ----
  const frames = hasFrames ? inner.frames : [];
  const frameIndexes = frames.map((f) => f.index);
  const frameExportIds = frames.map((f) => f.exportId ?? null);

  // ---- ④ 形态与帧 ----
  if (args['expect-frames']) {
    const want = String(args['expect-frames']).split(',').map((s) => Number(s.trim())).sort((a, b) => a - b);
    const got = [...frameIndexes].sort((a, b) => a - b);
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      fail('C2', `帧集不符：期望 [${want}]，实际 [${got}]`);
    } else {
      notes.push(`C2: 帧集 = [${got}]（N=${got.length}）`);
    }
    if (want.length < 3 && !args['allow-few-frames']) {
      warn('C2', `验收要求 N≥3，本次 N=${want.length}（--allow-few-frames 可压制）`);
    }
  }

  // ---- ③ C3：同会话同缓冲 ----
  const prov = meta.provenance ?? (hasFrames ? null : doc.provenance);
  const rootExportId = meta.exportId ?? (hasFrames ? inner.exportId ?? null : doc.exportId ?? null);

  if (prov) {
    notes.push(`C3: provenance 在位（exportId=${prov.exportId}）`);
    if (hasFrames && frames.length > 0) {
      const uniq = new Set(frameExportIds.filter((x) => x !== null));
      if (uniq.size > 1) {
        fail('C3', `frames[].exportId 不一致（${[...uniq]}）——跨次导出拼接的产物`);
      } else if (uniq.size === 1 && rootExportId && !uniq.has(rootExportId)) {
        fail('C3', `根级 exportId (${rootExportId}) 与帧级 (${[...uniq]}) 不一致`);
      } else if (uniq.size === 1 && !frameExportIds.every((x) => x === null || uniq.has(x))) {
        fail('C3', '部分帧缺 exportId（同一产物内必须全有或全无）');
      } else {
        notes.push('C3: 根级与全部帧级 exportId 一致');
      }
    }
    // provenance.frameSha256 与 frames[].index 配对
    const ph = prov.frameSha256 ?? {};
    const phKeys = Object.keys(ph).map(Number).sort((a, b) => a - b);
    const missingInProv = frameIndexes.filter((i) => !(String(i) in ph));
    if (missingInProv.length > 0) {
      fail('C3', `provenance.frameSha256 缺帧: [${missingInProv}]（帧与哈希必须一一对应）`);
    } else {
      notes.push(`C3: provenance.frameSha256 覆盖全部 ${frameIndexes.length} 帧`);
    }
    const extraInProv = phKeys.filter((i) => !frameIndexes.includes(i));
    if (extraInProv.length > 0) {
      warn('C3', `provenance.frameSha256 含未导出帧 [${extraInProv}]（provenance 记的是快照全集，不一定是缺陷）`);
    }
  } else {
    warn('C3', '产物不含 provenance（命令通道产物即如此；cp 通道产物必须含它，否则 C3 判据无从落地）');
  }

  // ---- ② C2：与 export.session 的录制哈希逐帧配对 ----
  const session = readSession();
  if (session) {
    const recorded = session.recordedFrames ?? [];
    const hashes = session.frameSha256 ?? [];
    const byFrame = new Map();
    for (let i = 0; i < recorded.length; i++) byFrame.set(recorded[i], hashes[i]);

    if (prov && prov.frameSha256) {
      let mismatch = 0;
      for (const [k, v] of Object.entries(prov.frameSha256)) {
        const f = Number(k);
        if (!byFrame.has(f)) {
          fail('C2', `帧 F${f} 不在 export.session 的 recordedFrames [${recorded}] 内`);
          mismatch++;
          continue;
        }
        if (byFrame.get(f) !== v) {
          fail('C2', `帧 F${f} 内容哈希与录制时不一致：provenance=${v} export.session=${byFrame.get(f)}`);
          mismatch++;
        }
      }
      if (mismatch === 0) {
        notes.push(`C2: ${Object.keys(prov.frameSha256).length} 帧内容哈希与 export.session 同源同序`);
      }
    } else {
      warn('C2', '无法做逐帧内容比对：产物缺 provenance.frameSha256');
    }
    // 世代号一致（廉价「同一次快照」判据）
    if (prov && session.bufferGeneration !== undefined && prov.bufferGeneration !== undefined) {
      if (prov.bufferGeneration !== session.bufferGeneration) {
        warn(
          'C2',
          `bufferGeneration 不同（产物 ${prov.bufferGeneration} / 当前快照 ${session.bufferGeneration}）——` +
            `若两次读之间又 record 过，这是预期的（产物记的是导出那一刻的快照）`,
        );
      } else {
        notes.push(`C2: bufferGeneration 一致（${prov.bufferGeneration}）`);
      }
    }
  } else {
    warn('C2', '未提供 --session-json：跳过「逐帧内容与录制时一致」的比对');
  }

  return report({
    sceneFile,
    bytes: rawText.length,
    fileSha256,
    shape,
    documentFormat: doc.documentFormat ?? null,
    metaKeys: Object.keys(meta).sort(),
    frameIndexes,
    frameCount: frames.length,
    exportId: rootExportId,
    provenanceExportId: prov ? prov.exportId : null,
    provenanceFrameSha256: prov ? Object.keys(prov.frameSha256 ?? {}).length : 0,
    semanticsSha256: hasFrames
      ? sha256(canonical(frames.map((f) => f.structure)))
      : sha256(canonical(inner)),
    webConsumerOk: webOk,
  });
}

function report(extra) {
  const out = {
    schema: 'lightning.cp-export-check/1',
    generatedAt: new Date().toISOString(),
    mcDir,
    ...extra,
    failures,
    warnings,
    notes,
    ok: failures.length === 0,
  };
  if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
  }
  console.log(`[export-check] ${out.ok ? '全绿' : '红'}  ${extra.sceneFile ?? ''}`);
  for (const n of notes) console.log(`   · ${n}`);
  for (const w of warnings) console.log(`   ! [${w.gate}] ${w.msg}`);
  for (const f of failures) console.log(`   XX [${f.gate}] ${f.msg}`);
  console.log(`   semanticsSha256 = ${extra.semanticsSha256 ?? '-'}`);
  process.exit(out.ok ? 0 : 1);
}

await main();
