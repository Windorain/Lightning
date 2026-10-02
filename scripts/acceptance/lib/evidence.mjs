/**
 * Phase 3 验收编排 —— 共享工具（哈希 / 目录快照 / 阶段片段 / JSON 读写）。
 *
 * 本目录（`scripts/acceptance/`）是计划 §5「总入口」`npm run acceptance:multiblock` 的实现：
 *   - `run-acceptance.ps1`  编排（进程阶段：构建 / 导出 / playwright / vitest / 互不干扰）
 *   - `volume-curve.mjs`    T3.2 体积曲线机器判定（R1/R2/R3，λ=1.35）+ 曲线图
 *   - `falsification.mjs`   断言有效性证伪（离线负对照，证明判定式非恒绿）
 *   - `interop-check.mjs`   `/sde export` 互不干扰的哈希比对
 *   - `build-report.mjs`    汇总 `acceptance-report.json`（§6 把关清单逐条映射）
 *   - `lib/checklist.mjs`   §6 清单的机器判据定义
 *
 * 本文件的约定（所有阶段的公共契约）：
 *   - 一个「运行目录」`<outRoot>/acceptance-<label>/` 收纳全部证据；
 *   - 每个阶段往 `<run>/stages/<id>.json` 落一个**片段**（stage fragment），字段见 `stageFragment()`；
 *   - 报告只由片段 + 产物哈希 + 各分析工具的输出 JSON 组装，**不重新跑任何东西**。
 *
 * 无第三方依赖（Node 内置 fs/crypto/zlib）。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

export function readJsonIfExists(p) {
  if (!p || !fs.existsSync(p)) return null
  try {
    return readJson(p)
  } catch {
    return null
  }
}

export function writeJson(p, value) {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(value, null, 1) + '\n', 'utf8')
  return p
}

export function writeText(p, text) {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, text, 'utf8')
  return p
}

export function sha256Text(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function sha256File(p) {
  return sha256Buffer(fs.readFileSync(p))
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return String(n)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 仓库根（本文件位于 scripts/acceptance/lib/）。 */
export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

/** POSIX 风格相对路径（报告里统一用它，跨平台可读）。 */
export function rel(p, base = REPO_ROOT) {
  return path.relative(base, p).replace(/\\/g, '/')
}

/** utf8 字节数。 */
export function utf8Bytes(s) {
  return Buffer.byteLength(s, 'utf8')
}

/** gzip 字节数（level 9，确定性；G 的统一口径）。 */
export function gzipBytes(textOrBuf) {
  const buf = Buffer.isBuffer(textOrBuf) ? textOrBuf : Buffer.from(String(textOrBuf), 'utf8')
  return gzipSync(buf, { level: 9 }).length
}

// ---------------------------------------------------------------------------
// 目录快照 / 哈希清单（幂等与互不干扰判据的唯一来源）
// ---------------------------------------------------------------------------

/** 递归列出目录下所有文件。 */
export function listFiles(dir, { filter = null } = {}) {
  const out = []
  if (!fs.existsSync(dir)) return out
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name)
      if (ent.isDirectory()) stack.push(full)
      else if (ent.isFile()) {
        if (!filter || filter(full)) out.push(full)
      }
    }
  }
  return out.sort()
}

/**
 * 目录快照：`[{ file: <相对路径>, bytes, sha256, mtimeMs }]`（按相对路径排序）。
 * 用于「两次运行产物逐字节一致」与「两套产物目录互不影响」的机器判据。
 * **mtimeMs 参与"被改写"判定**：同一路径被逐字节重写（如固定选区的 `/sde export` 复跑）时
 * sha256 不变，但有 mtime 才能证明"本阶段确实写过它"。
 */
export function snapshotDir(dir, { base = dir, filter = null } = {}) {
  return listFiles(dir, { filter }).map((f) => {
    const st = fs.statSync(f)
    return {
      file: path.relative(base, f).replace(/\\/g, '/'),
      bytes: st.size,
      sha256: sha256File(f),
      mtimeMs: Math.round(st.mtimeMs),
    }
  })
}

/**
 * 两个快照的差异。返回 `null` = 内容与 mtime 都完全一致。
 *   - `added` / `removed`：文件增删
 *   - `changed`：内容变了（sha256 不同）
 *   - `touched`：内容相同但 mtime 变了（**被逐字节重写过**）
 */
export function diffSnapshots(a, b) {
  const mapA = new Map((a ?? []).map((e) => [e.file, e]))
  const mapB = new Map((b ?? []).map((e) => [e.file, e]))
  const added = []
  const removed = []
  const changed = []
  const touched = []
  for (const [f, eb] of mapB) {
    const ea = mapA.get(f)
    if (!ea) {
      added.push(f)
      continue
    }
    if (ea.sha256 !== eb.sha256) changed.push(f)
    else if (ea.mtimeMs !== undefined && eb.mtimeMs !== undefined && ea.mtimeMs !== eb.mtimeMs) touched.push(f)
  }
  for (const f of mapA.keys()) if (!mapB.has(f)) removed.push(f)
  if (added.length === 0 && removed.length === 0 && changed.length === 0 && touched.length === 0) return null
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), touched: touched.sort() }
}

/** 快照汇总（报告里的紧凑形态）。 */
export function snapshotSummary(snap) {
  return {
    files: snap.length,
    bytes: snap.reduce((s, e) => s + e.bytes, 0),
    sha256Joined: sha256Text(snap.map((e) => `${e.file}:${e.bytes}:${e.sha256}`).join('\n')),
  }
}

/** 两个产物清单（pipeline-result.json 的 products[]）的哈希对比。 */
export function compareProducts(a, b) {
  const mapA = new Map((a ?? []).map((p) => [p.file, p.sha256]))
  const mapB = new Map((b ?? []).map((p) => [p.file, p.sha256]))
  const rows = []
  for (const f of [...new Set([...mapA.keys(), ...mapB.keys()])].sort()) {
    rows.push({ file: f, sha256A: mapA.get(f) ?? null, sha256B: mapB.get(f) ?? null, same: mapA.get(f) === mapB.get(f) })
  }
  return { rows, allSame: rows.length > 0 && rows.every((r) => r.same) }
}

// ---------------------------------------------------------------------------
// 阶段片段（orchestrator ↔ 报告 的唯一接口）
// ---------------------------------------------------------------------------

/**
 * 阶段片段。`status`：
 *   - `pass`    阶段跑完且其门禁全绿
 *   - `fail`    阶段跑完但门禁红（或进程非零退出）
 *   - `not-run` 阶段被跳过（缺依赖/被开关关掉/spec 未落地）——**不计为通过**
 *   - `sample`  样例模式（`-SampleFrom`）下用既有产物回放出的片段，**不构成验收结论**
 */
export function stageFragment({
  id,
  name,
  command = null,
  cwd = null,
  startedAt = null,
  endedAt = null,
  durationMs = null,
  exitCode = null,
  status = 'not-run',
  gates = [],
  artifacts = [],
  evidence = [],
  data = {},
  notes = [],
}) {
  return {
    id,
    name,
    command,
    cwd,
    startedAt,
    endedAt,
    durationMs,
    exitCode,
    status,
    gates, // [{ name, ok, detail }]
    artifacts, // 产物路径（repo 相对）
    evidence, // 证据文件路径（repo 相对）
    data, // 阶段特有的机读数据
    notes,
  }
}

export function readStageFragments(runDir) {
  const dir = path.join(runDir, 'stages')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJsonIfExists(path.join(dir, f)))
    .filter(Boolean)
}

export function writeStageFragment(runDir, frag) {
  return writeJson(path.join(runDir, 'stages', `${frag.id}.json`), frag)
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

/** 在文本里找第一个匹配，返回 match 或 null。 */
export function firstMatch(text, re) {
  return re.exec(text)
}

export function countMatches(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let n = 0
  while (g.exec(text) !== null) n++
  return n
}

export function tail(text, lines = 40) {
  const arr = String(text).split(/\r?\n/)
  return arr.slice(Math.max(0, arr.length - lines)).join('\n')
}

/** 当前进程 cwd（POSIX 化）。 */
export function cwd() {
  return process.cwd().replace(/\\/g, '/')
}
