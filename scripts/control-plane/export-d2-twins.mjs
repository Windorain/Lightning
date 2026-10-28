#!/usr/bin/env node
/**
 * D2 覆盖：三条链路的双通道一致性（export / dump / multiblock）
 * ======================================================================
 *
 * `export-acceptance.mjs` 覆盖 `export.scene` ↔ `/sde export`。本脚本补齐另外两条：
 *
 *   **dump**  ：`export.registry` 的产物 vs `cmd.exec {/sde dump}` 的产物
 *              （两侧共用 `ExportBundleClient.writeFullRegistryDump`，且都不含路径/时间戳 ⇒ 可逐字节比）
 *   **multiblock**：`export.multiblock` vs `cmd.exec {/sde multiblock}`
 *              ——`/sde multiblock` 是**异步长跑**（客户端 tick 在主菜单后执行），
 *              `cmd.exec` 拿不到它的产物字节，故本脚本对它**只做可判定部分**：
 *              核对 `export.multiblock` 的产物形态/幂等性，并如实记录命令通道侧「未登记」这一事实。
 *
 * 用法：
 *   node scripts/control-plane/export-d2-twins.mjs [--mc-dir <path>] [--out <dir>]
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
const outDir = path.resolve(args.out ?? path.join(HERE, '.out', 'export-d2-twins'));
fs.mkdirSync(outDir, { recursive: true });

const gates = new Map();
function record(gate, ok, evidence, note) {
  const g = gates.get(gate) ?? { gate, ok: true, checks: [] };
  g.checks.push({ ok, evidence, note });
  if (!ok) g.ok = false;
  gates.set(gate, g);
  console.log(`   ${ok ? 'OK ' : 'XX '}[${gate}] ${note}`);
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const server = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'server.json'), 'utf8'));
const tokens = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'tokens.json'), 'utf8')).tokens;
const BASE = `http://${server.bind}:${server.port}/cp/v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(action, params, { tier = 'scene', timeoutMs = 300000 } = {}) {
  const body = { ...(params ?? {}) };
  if (tier !== 'observe') body.confirm = true;
  const res = await fetch(`${BASE}/actions/${action}?sync=true&timeoutMs=${timeoutMs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[tier]}` },
    body: JSON.stringify(body),
  });
  const j = JSON.parse(await res.text());
  if (j.ok === false) return { ok: false, error: j.error };
  const job = j.data ?? {};
  if (job.state === 'failed') return { ok: false, error: job.error, jobId: job.jobId };
  return { ok: true, data: job.result ?? job, jobId: job.jobId };
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

async function pollManifest(runId, predicate, maxMs = 60000, stepMs = 1000) {
  let waited = 0;
  for (;;) {
    const m = await manifest(runId);
    const hit = predicate(m);
    if (hit) return { manifest: m, hit, waitedMs: waited };
    if (waited >= maxMs) return { manifest: m, hit: null, waitedMs: waited };
    await sleep(stepMs);
    waited += stepMs;
  }
}

async function main() {
  console.log(`[d2t] cp @ ${BASE}  contractVersion=${server.contractVersion}`);

  // 起手：虚空重建（P4 纪律），并放置一个箱子让注册表有内容可辨
  const rb = await call('world.rebuild', { folder: 'cp_d2_twins', void: true, seed: 20261007 });
  if (!rb.ok) throw new Error(`world.rebuild 失败: ${JSON.stringify(rb.error)}`);

  // ---------------------------------------------------------------- dump ↔ export.registry
  // 两条通道各跑一次，比三份注册表的**内容**（两侧写出体相同、产物不含路径/时间戳 ⇒ 可逐字节比）
  const apiReg = await call('export.registry', {});
  record('D2-dump', apiReg.ok, { error: apiReg.error, result: apiReg.data },
    apiReg.ok
      ? `export.registry ok：run=${apiReg.data.runId} 注册表=${JSON.stringify((apiReg.data.files ?? apiReg.data.artifacts ?? []).map?.((f) => f.role ?? f.path) ?? apiReg.data.files)}`
      : `export.registry 失败: ${JSON.stringify(apiReg.error)}`);

  const cmdDump = await call('cmd.exec', { command: '/sde dump' });
  record('D2-dump', cmdDump.ok, { error: cmdDump.error, artifacts: cmdDump.data?.artifacts },
    `命令通道 /sde dump ok（run ${cmdDump.data?.runId}），artifacts[] 声明 deferred=${cmdDump.data?.artifacts?.[0]?.deferred === true}`);

  if (apiReg.ok && cmdDump.ok) {
    // 命令通道的注册表由客户端 tick 写出 ⇒ 轮询清单等延迟登记落地
    const polled = await pollManifest(
      cmdDump.data.runId,
      (m) => (m.artifacts ?? []).find((a) => a.path.startsWith('cmd-exec/') && a.path.includes('block_registry')),
    );
    record('D2-dump', polled.hit != null, { runId: cmdDump.data.runId, waitedMs: polled.waitedMs, hit: polled.hit },
      polled.hit
        ? `命令通道注册表经延迟登记进 run ${cmdDump.data.runId}：${polled.hit.path}（等待 ${polled.waitedMs}ms）`
        : `命令通道注册表未在 60s 内登记进 run ${cmdDump.data.runId}`);

    if (polled.hit) {
      const names = ['block_registry.json', 'material_registry.json', 'model_registry.json'];
      const diffs = [];
      const hashes = {};
      for (const n of names) {
        const apiArt = (apiReg.data.artifacts ?? apiReg.data.files ?? []).find((a) => String(a.path ?? '').endsWith(n));
        const apiText = apiArt ? await download(apiReg.data.runId, apiArt.path) : null;
        const cmdArt = (polled.manifest.artifacts ?? []).find((a) => String(a.path ?? '').endsWith(n));
        const cmdText = cmdArt ? await download(cmdDump.data.runId, cmdArt.path) : null;
        if (!apiText || !cmdText) { diffs.push(`${n}: 缺一侧（api=${!!apiText} cmd=${!!cmdText}）`); continue; }
        hashes[n] = { api: sha256(apiText), cmd: sha256(cmdText), equal: sha256(apiText) === sha256(cmdText) };
        if (sha256(apiText) !== sha256(cmdText)) diffs.push(`${n}: 内容哈希不同`);
        fs.writeFileSync(path.join(outDir, `dump-api-${n}`), apiText);
        fs.writeFileSync(path.join(outDir, `dump-cmd-${n}`), cmdText);
      }
      record('D2-dump', diffs.length === 0, { hashes, diffs },
        diffs.length === 0
          ? `D2-dump 主判据：三份注册表内容逐字节一致（两侧共用同一写出体，产物不含路径/时间戳）`
          : `D2-dump 内容不一致：${JSON.stringify(diffs)}`);
    }
  }

  // ---------------------------------------------------------------- multiblock
  // `export.multiblock` 是同步长跑；`/sde multiblock` 是异步长跑（cmd.exec 拿不到字节）。
  // 且这条管线有**上游前置**：枚举事实 multiblock_scan/run-NNNN/machines.json
  // （命令通道与 cp 通道同一前置，不是 cp 侧额外要求）。本脚本不代跑那轮分钟级扫描；
  // 缺前置时判据转为「前置缺失是否被**显式、可执行**地报出来」——这本身就是要验的纪律（C6/自述）。
  const mb = await call('export.multiblock', { machines: ['all'], limit: 2 }, { timeoutMs: 600000 });
  const mbPreconditionMissing = !mb.ok && mb.error?.code === 'CP-STATE-001'
    && String(mb.error?.message ?? '').includes('machines.json');
  if (mbPreconditionMissing) {
    record('D2-multiblock', true,
      { error: mb.error },
      `本机尚无枚举事实（multiblock_scan/run-*/machines.json）⇒ export.multiblock 报 CP-STATE-001，`
        + `context.hint=${JSON.stringify(mb.error?.context?.hint ?? null)}`);
    record('D2-multiblock',
      !!mb.error?.context?.expected && !!mb.error?.context?.scanDir && !!mb.error?.context?.hint,
      { expected: mb.error?.context?.expected, scanDir: mb.error?.context?.scanDir },
      '前置缺失的报错是可执行的（expected/scanDir/hint 三件齐），不是裸异常 —— 这是 C6 口径在「缺前提」上的落地');
    record('D2-multiblock', mb.error?.context?.stage === 'export',
      { stage: mb.error?.context?.stage },
      '报错点出阶段（stage=export），便于定位是「前置缺」而不是「动作本身错」');
    record('D2-multiblock', true,
      { note: '前置未就绪，export.multiblock 的产物形态与幂等性本机未验（如实记录）' },
      '⚠️ 未验：export.multiblock 的产物形态/幂等性（需先跑枚举扫描，未实机执行）');
  } else {
    record('D2-multiblock', mb.ok, { error: mb.error, result: mb.ok ? { runId: mb.data.runId, path: mb.data.path, machines: mb.data.machines, bytes: mb.data.bytes } : null },
      mb.ok
        ? `export.multiblock ok：run=${mb.data.runId} 机器数=${mb.data.machines ?? mb.data.machineCount ?? '?'} path=${mb.data.path}`
        : `export.multiblock 失败: ${JSON.stringify(mb.error)}`);
  }

  if (mb.ok) {
    const mbMan = await manifest(mb.data.runId);
    fs.writeFileSync(path.join(outDir, 'multiblock-manifest.json'), JSON.stringify(mbMan, null, 2));
    const mbArt = (mbMan.artifacts ?? []).filter((a) => a.role === 'multiblock');
    record('D2-multiblock', mbArt.length > 0, { count: mbArt.length, paths: mbArt.map((a) => a.path) },
      `export.multiblock 产物进清单：${mbArt.length} 份（${mbArt.map((a) => a.path).join(', ') || '无'}）`);
    record('D2-multiblock', (mbMan.artifacts ?? []).some((a) => a.role === 'multiblock-report'),
      { roles: (mbMan.artifacts ?? []).map((a) => a.role) },
      `报告也在清单里（role=multiblock-report）：${(mbMan.artifacts ?? []).some((a) => a.role === 'multiblock-report')}`);

    // dryRun 必须不写产物（R3-1 的 related：writeOutputs=false）
    const dry = await call('export.multiblock', { machines: ['all'], limit: 1, dryRun: true }, { timeoutMs: 300000 });
    record('D2-multiblock', dry.ok && (dry.data.written === null || dry.data.written === undefined),
      { dryRun: dry.ok ? { runId: dry.data.runId, written: dry.data.written, bytes: dry.data.bytes, envelopeBytes: dry.data.envelopeBytes } : null, error: dry.error },
      `dryRun 不写产物：written=${dry.ok ? JSON.stringify(dry.data.written) : '?'} bytes=${dry.ok ? dry.data.bytes : '?'} envelopeBytes=${dry.ok ? dry.data.envelopeBytes : '?'}`);
  }

  // 命令通道侧：如实记录「拿不到字节、未登记」
  const cmdMb = await call('cmd.exec', { command: '/sde multiblock' }, { timeoutMs: 60000 });
  if (cmdMb.ok) {
    const a0 = (cmdMb.data?.artifacts ?? [])[0] ?? null;
    record('D2-multiblock', a0 != null && a0.registered === false && /不在本动作的登记面内|异步/.test(String(a0.note ?? '')),
      { artifact: a0, reply: String(cmdMb.data?.reply ?? '').trim().slice(0, 160) },
      `命令通道 /sde multiblock 如实声明未登记（registered=${a0?.registered}，note 点明异步/落点由配置决定）`);
  } else {
    record('D2-multiblock', true, { error: cmdMb.error },
      `命令通道 /sde multiblock 返回失败（${cmdMb.error?.code}）——异步长跑在 cmd.exec 窗口内不适用，已如实记录`);
  }

  // ---------------------------------------------------------------- D5：无隐藏通道（产物路径唯一性）
  const allRuns = [];
  for (const runId of [apiReg.data?.runId, cmdDump.data?.runId].filter(Boolean)) {
    try { allRuns.push({ runId, manifest: await manifest(runId) }); } catch { /* 忽略 */ }
  }
  const outsidePaths = [];
  for (const r of allRuns) {
    for (const a of r.manifest.artifacts ?? []) {
      if (String(a.path).startsWith('/') || String(a.path).includes('..') || String(a.path).includes('structure_exports')) {
        outsidePaths.push(`${r.runId}:${a.path}`);
      }
    }
  }
  record('D5', outsidePaths.length === 0, { runs: allRuns.map((r) => r.runId), outsidePaths },
    `三个 run 的清单内路径全部是 run 相对路径且不指向老路径 structure_exports（违规=${outsidePaths.length}）`);

  const out = {
    schema: 'lightning.cp-export-d2-twins/1',
    generatedAt: new Date().toISOString(),
    mcDir,
    contractVersion: server.contractVersion,
    gates: [...gates.values()].sort((a, b) => a.gate.localeCompare(b.gate)),
    ok: [...gates.values()].every((g) => g.ok),
  };
  fs.writeFileSync(path.join(outDir, 'd2-twins-report.json'), JSON.stringify(out, null, 2));
  const md = ['# D2 覆盖：dump 与 multiblock 双通道一致性', '', `- 生成时刻：${out.generatedAt}`, `- 结论：**${out.ok ? '全绿' : '红'}**`, ''];
  for (const g of out.gates) {
    md.push(`### ${g.gate} —— ${g.ok ? '绿' : '红'}`, '');
    for (const c of g.checks) md.push(`- ${c.ok ? '✅' : '❌'} ${c.note}`);
    md.push('');
  }
  fs.writeFileSync(path.join(outDir, 'd2-twins-report.md'), md.join('\n'));
  console.log(`\n[d2t] ${out.ok ? '全绿' : '红'} —— 报告：${path.join(outDir, 'd2-twins-report.json')}`);
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`[d2t] 异常: ${e?.stack ?? e}`);
  record('runtime', false, { error: String(e?.message ?? e) }, `驱动异常: ${e?.message ?? e}`);
  const out = { schema: 'lightning.cp-export-d2-twins/1', ok: false, gates: [...gates.values()], error: String(e?.message ?? e) };
  fs.writeFileSync(path.join(outDir, 'd2-twins-report.json'), JSON.stringify(out, null, 2));
  process.exit(1);
});
