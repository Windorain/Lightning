#!/usr/bin/env node
/**
 * 证据快照：把「契约自述面」落成可复核的 JSON（D1/D3 的静态证据）。
 *
 * 用法：node scripts/control-plane/evidence-catalog.mjs --out <目录>
 *
 * 抓取：`GET /cp/v1/actions` 全量自述（名称/级/since/参数与默认值/返回/示例计数），
 * 以及导出族三动作的完整自述。**这是可复核证据**：复核者用它对着
 * `GET /cp/v1/actions` 就能验证「39 个动作、导出族 since=1.6、默认值可见」，
 * 不必重跑实机验收。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
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
const outDir = path.resolve(args.out ?? path.join(HERE, '.out'));
fs.mkdirSync(outDir, { recursive: true });

const srv = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'server.json'), 'utf8'));
const tokens = JSON.parse(fs.readFileSync(path.join(mcDir, 'controlplane', 'tokens.json'), 'utf8')).tokens;
const BASE = `http://${srv.bind}:${srv.port}/cp/v1`;
const H = { Authorization: `Bearer ${tokens.observe}` };

const actsRaw = await (await fetch(`${BASE}/actions`, { headers: H })).json();
const actions = actsRaw.data?.actions ?? actsRaw.actions ?? [];
const count = actsRaw.data?.count ?? actsRaw.count ?? actions.length;

// 导出族的完整自述（含默认值），供 D3「默认值可见」逐项复核
const exportFull = {};
for (const name of ['export.scene', 'export.registry', 'export.multiblock']) {
  const one = await (await fetch(`${BASE}/actions/${name}`, { headers: H })).json();
  exportFull[name] = one.data ?? one;
}

const catalog = {
  schema: 'lightning.cp-export-catalog/1',
  generatedAt: new Date().toISOString(),
  server: { port: srv.port, bind: srv.bind, contractVersion: srv.contractVersion, boundAt: srv.boundAt },
  actionCount: count,
  /** 全部动作名（D5：命名空间封闭的可审面）。 */
  actionNames: actions.map((a) => a.name).sort(),
  /** 版本不变式（D1/D3）：每个动作的 since 必须 ≤ 契约版本。 */
  sinceHistogram: actions.reduce((m, a) => { m[a.since] = (m[a.since] ?? 0) + 1; return m; }, {}),
  /** 导出族摘要（D3 的机械面）。 */
  exportActions: actions.filter((a) => a.name.startsWith('export.'))
    .map((a) => ({
      name: a.name,
      since: a.since,
      tier: a.tier,
      writable: a.writable,
      params: (a.params ?? []).map((p) => ({ name: p.name, type: p.type, required: p.required, default: p.default })),
      returns: a.returns,
      exampleCount: (a.examples ?? []).length,
      description: a.description,
    })),
  /** 三个导出动作的完整自述（原样）。 */
  exportFullDescriptors: exportFull,
};
fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify(catalog, null, 2));

console.log(`[cat] contractVersion=${catalog.server.contractVersion} actionCount=${catalog.actionCount}`);
console.log(`[cat] since 分布 = ${JSON.stringify(catalog.sinceHistogram)}`);
for (const a of catalog.exportActions) {
  console.log(`   ${a.name} since=${a.since} tier=${a.tier} params=${a.params.length} examples=${a.exampleCount}`);
}
console.log(`[cat] 写入 ${path.join(outDir, 'catalog.json')}`);
