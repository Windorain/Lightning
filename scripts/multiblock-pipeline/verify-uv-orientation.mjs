#!/usr/bin/env node
/**
 * 纹理朝向门禁（BUG: 多方块产物覆盖层图标上下颠倒 / UV 不正确）。
 *
 * ## 判据（根因与 GT5U 5.09.52.283 源码一致）
 *
 * GT 的图标覆盖层分两类：
 *  - **基础贴图**（`TextureFactory.builder().addIcon(icon).build()`，`useExtFacing=false`）→
 *    `GTRenderedTexture#getExtendedFacing` 直接短路成 `ExtendedFacing.DEFAULT` → 不翻转；
 *  - **`.extFacing()` 覆盖层**（控制器正面图标 = 扳手、维护仓 OVERLAY_MAINTENANCE、GT++ controllerFaces 等）
 *    → 会去 `player.getEntityWorld()` 查机器朝向；查得到（`IAlignment`）→ 按真实朝向绘制；
 *    **查不到 → 回退分支 `getFlipped(side, null, icon)`：NORTH 面 flipV、EAST/DOWN 面 flipU**。
 *
 * 探针把方块建在 `ProbeDummyWorld`、玩家却在会话世界 → 回退分支 → 覆盖层在 NORTH 面被 `v → 1-v`。
 * 所以门禁判据是**同面手性一致**：
 *
 *   > 同一轴对齐面上，「.extFacing() 覆盖层四边形」的面内 UV 手性（du/dA、dv/dB 的符号）
 *   > 必须与该面上基础贴图四边形的手性一致。
 *
 * 这条判据不依赖「哪个产物是修复前/后」，也不依赖亮度/颜色 —— 它直接对应「覆盖层相对底层纹理是否被镜像」，
 * 即用户看到的「扳手图标上下颠倒」。
 *
 * ## 用法
 *
 *   node scripts/multiblock-pipeline/verify-uv-orientation.mjs <产物文件或目录>...
 *     --expect clean     全部产物必须无镜像覆盖层（默认）
 *     --expect mirrored  全部产物必须存在镜像覆盖层（证伪对照用）
 *     --json             输出机器可读结果
 *
 * 退出码：0 = 符合期望；1 = 不符合；2 = 用法错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const AXES = ['x', 'y', 'z']

export function decodeProduct(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (raw && typeof raw.payload === 'string' && raw.payloadEncoding === 'gzip+base64') {
    return JSON.parse(zlib.gunzipSync(Buffer.from(raw.payload, 'base64')).toString('utf8'))
  }
  return raw
}

/** 覆盖层材质判定（GT 图标覆盖层：iconsets/OVERLAY_*、GT++ iconsets/controllerFaces/*）。 */
export function isOverlayMaterial(locator) {
  const s = String(locator ?? '')
  return /OVERLAY/i.test(s) || /controllerFaces\//i.test(s)
}

const avg = (arr, k) => arr.reduce((a, v) => a + v[k], 0) / arr.length

/**
 * 一个四边形的「面 + 面内 UV 手性签名」。
 * 面内每个轴给出 `du/dA`、`dv/dA` 的符号（-1/0/1）。竖直面（X/Z 面）的 `dv/dy` 即「贴图上下方向」。
 */
export function faceUvSense(quad) {
  const vs = quad?.vertices
  if (!Array.isArray(vs) || vs.length < 4) return null
  for (const axis of AXES) {
    const vals = vs.map((v) => v[axis])
    if (!vals.every((t) => Math.abs(t - vals[0]) < 1e-9)) continue
    const signs = {}
    for (const a of AXES.filter((x) => x !== axis)) {
      const lo = vs.filter((v) => v[a] < 0.5)
      const hi = vs.filter((v) => v[a] > 0.5)
      if (lo.length === 0 || hi.length === 0) return null
      const du = avg(hi, 'u') - avg(lo, 'u')
      const dv = avg(hi, 'v') - avg(lo, 'v')
      signs[`du/d${a}`] = Math.abs(du) < 1e-9 ? 0 : Math.sign(du)
      signs[`dv/d${a}`] = Math.abs(dv) < 1e-9 ? 0 : Math.sign(dv)
    }
    return { face: `${vals[0] > 0.5 ? 'POS' : 'NEG'}_${axis.toUpperCase()}`, signs }
  }
  return null
}

const sigOf = (signs) => Object.entries(signs).map(([k, v]) => `${k}=${v}`).join(',')

/** 分析一份产物：返回每个面上的手性直方图（基础贴图 / 覆盖层分开），以及镜像覆盖层清单。 */
export function analyzeProduct(doc, label) {
  const blocks = doc.blockPalette ?? []
  const mats = doc.materialPalette ?? []
  /** face → { base: Map<sig,count>, overlay: Map<sig,count> } */
  const byFace = new Map()
  for (let i = 0; i < blocks.length; i++) {
    const quads = blocks[i]?.geometry?.quads ?? []
    for (let qi = 0; qi < quads.length; qi++) {
      const sense = faceUvSense(quads[qi])
      if (!sense) continue
      const locator = mats[quads[qi].materialIndex]?.locator ?? '?'
      if (!byFace.has(sense.face)) byFace.set(sense.face, { base: new Map(), overlay: new Map() })
      const bucket = byFace.get(sense.face)
      const target = isOverlayMaterial(locator) ? bucket.overlay : bucket.base
      const key = sigOf(sense.signs)
      const cur = target.get(key) ?? { count: 0, samples: [] }
      cur.count++
      if (cur.samples.length < 3) cur.samples.push(`${blocks[i].registryId}:${blocks[i].meta} q${qi} ${locator}`)
      target.set(key, cur)
    }
  }

  const mirrored = []
  const faces = {}
  for (const [face, b] of [...byFace.entries()].sort()) {
    const baseSigs = new Set(b.base.keys())
    const overlaySigs = new Set(b.overlay.keys())
    const mirroredSigs = [...overlaySigs].filter((s) => baseSigs.size > 0 && !baseSigs.has(s))
    for (const s of mirroredSigs) {
      const e = b.overlay.get(s)
      mirrored.push({ face, signature: s, count: e.count, samples: e.samples })
    }
    faces[face] = {
      base: Object.fromEntries([...b.base.entries()].map(([k, v]) => [k, v.count])),
      overlay: Object.fromEntries([...b.overlay.entries()].map(([k, v]) => [k, v.count])),
      mirroredOverlayQuads: mirroredSigs.reduce((n, s) => n + b.overlay.get(s).count, 0),
      overlayQuads: [...b.overlay.values()].reduce((n, v) => n + v.count, 0),
    }
  }
  const overlayQuads = Object.values(faces).reduce((n, f) => n + f.overlayQuads, 0)
  const mirroredOverlayQuads = Object.values(faces).reduce((n, f) => n + f.mirroredOverlayQuads, 0)
  return { label, faces, mirrored, overlayQuads, mirroredOverlayQuads }
}

/** 收集输入（文件或目录里的 *.multiblock.json）。 */
export function collectProducts(inputs) {
  const out = []
  for (const input of inputs) {
    const st = fs.statSync(input)
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(input).sort()) {
        if (f.endsWith('.multiblock.json')) out.push(path.join(input, f))
      }
    } else {
      out.push(input)
    }
  }
  return out
}

function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const expectIdx = argv.indexOf('--expect')
  const expect = expectIdx >= 0 ? argv[expectIdx + 1] : 'clean'
  if (!['clean', 'mirrored'].includes(expect)) {
    console.error(`--expect 只能是 clean | mirrored（实际 ${expect}）`)
    process.exit(2)
  }
  const inputs = argv.filter((a, i) => !a.startsWith('--') && i !== expectIdx + 1)
  if (inputs.length === 0) {
    console.error('用法: node scripts/multiblock-pipeline/verify-uv-orientation.mjs <文件或目录>... [--expect clean|mirrored] [--json]')
    process.exit(2)
  }

  const results = []
  let violations = 0
  for (const file of collectProducts(inputs)) {
    let doc
    try {
      doc = decodeProduct(file)
    } catch (e) {
      console.error(`  读取失败 ${file}: ${e.message}`)
      violations++
      continue
    }
    if (!Array.isArray(doc.blockPalette)) continue // 跳过展开文件/报告等
    const a = analyzeProduct(doc, path.basename(file))
    results.push(a)
    // 没有任何 .extFacing() 覆盖层的产物（如纯砖高炉）对两条期望都「不适用」，不计入违规。
    const applicable = a.overlayQuads > 0
    const mirrored = a.mirroredOverlayQuads > 0
    if (applicable && ((expect === 'clean' && mirrored) || (expect === 'mirrored' && !mirrored))) violations++
    if (!json) {
      const mark = !applicable ? '·' : mirrored === (expect === 'mirrored') ? '✓' : '✗'
      console.log(
        `${mark} ${a.label}：覆盖层四边形 ${a.overlayQuads} 个，镜像 ${a.mirroredOverlayQuads} 个` +
          (applicable ? '' : '（无 extFacing 覆盖层，不适用）'),
      )
      for (const m of a.mirrored) {
        console.log(`    面 ${m.face} 手性 ${m.signature} ×${m.count}（与同面基础贴图手性不一致）`)
        for (const s of m.samples) console.log(`       样例：${s}`)
      }
    }
  }

  const totalMirrored = results.reduce((n, r) => n + r.mirroredOverlayQuads, 0)
  const totalOverlay = results.reduce((n, r) => n + r.overlayQuads, 0)
  if (json) {
    console.log(JSON.stringify({ expect, violations, totalOverlay, totalMirrored, products: results }, null, 2))
  } else {
    console.log(
      `\n== --expect ${expect}：${results.length} 份产物 / 覆盖层四边形 ${totalOverlay} 个 / 镜像 ${totalMirrored} 个 → ` +
        (violations === 0 ? '通过' : `${violations} 份不符合期望`),
    )
  }
  process.exit(violations === 0 ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURLSafe(process.argv[1])) main()

function pathToFileURLSafe(p) {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href
}
