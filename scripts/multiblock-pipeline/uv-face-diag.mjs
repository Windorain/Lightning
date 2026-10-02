#!/usr/bin/env node
/**
 * 深度 UV 诊断（BUG: 纹理上下颠倒 / UV 不正确）。
 *
 * 对产物里每个四边形：
 *  1. 判定它所在的轴对齐面（哪一轴坐标恒定、恒定值是 0 还是 1 → NEG/POS 面）；
 *  2. 在该面的两个面内轴上，计算 u / v 随坐标变化的**符号**（face-local UV 手性）；
 *  3. 按「材质是否 GT 覆盖层（OVERLAY_* / controllerFaces）」「面」聚合统计。
 *
 * 判据（GT5U 5.09.52.283 的 GTRenderedTexture#getFlipped）：
 *  - 基础贴图（useExtFacing=false）恒走 ExtendedFacing.DEFAULT 分支 → U/V 均不翻转；
 *  - extFacing 覆盖层在 extendedFacing==null（探针世界查不到对齐）时走 fallback：
 *      NORTH → flipV；EAST → flipU；DOWN → flipU；其余不翻。
 *  因此「同面覆盖层 vs 同面基础贴图」的手性差异应恰好落在这些面/轴上。
 *
 * 用法：
 *   node scripts/multiblock-pipeline/uv-face-diag.mjs <file>... [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

export function loadAny(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (raw && typeof raw.payload === 'string' && raw.payloadEncoding === 'gzip+base64') {
    return JSON.parse(zlib.gunzipSync(Buffer.from(raw.payload, 'base64')).toString('utf8'))
  }
  return raw
}

const AXES = ['x', 'y', 'z']

/** 覆盖层材质判定：GT 图标覆盖层（iconsets/OVERLAY_*、miscutils controllerFaces/*）。 */
export function isOverlayMaterial(locator) {
  const s = String(locator ?? '')
  return /OVERLAY/i.test(s) || /controllerFaces\//i.test(s)
}

/**
 * 单个四边形的面与面内 UV 手性。
 * @returns {null|{face:string, axis:string, side:number, signs:Record<string,number>}}
 */
export function faceUvSense(quad) {
  const vs = quad?.vertices
  if (!Array.isArray(vs) || vs.length < 4) return null
  for (const axis of AXES) {
    const vals = vs.map((v) => v[axis])
    if (vals.every((t) => Math.abs(t - vals[0]) < 1e-9)) {
      const inPlane = AXES.filter((a) => a !== axis)
      const signs = {}
      for (const a of inPlane) {
        const lo = vs.filter((v) => v[a] < 0.5)
        const hi = vs.filter((v) => v[a] > 0.5)
        if (lo.length === 0 || hi.length === 0) return null
        const du = avg(hi, 'u') - avg(lo, 'u')
        const dv = avg(hi, 'v') - avg(lo, 'v')
        signs[`du/d${a}`] = Math.abs(du) < 1e-9 ? 0 : Math.sign(du)
        signs[`dv/d${a}`] = Math.abs(dv) < 1e-9 ? 0 : Math.sign(dv)
      }
      const face = `${vals[0] > 0.5 ? 'POS' : 'NEG'}_${axis.toUpperCase()}`
      return { face, axis, side: vals[0] > 0.5 ? 1 : 0, signs }
    }
  }
  return null
}

const avg = (arr, k) => arr.reduce((a, v) => a + v[k], 0) / arr.length

export function analyzeDoc(doc) {
  const blocks = doc.blockPalette ?? []
  const mats = doc.materialPalette ?? []
  const rows = []
  blocks.forEach((e, i) => {
    ;(e?.geometry?.quads ?? []).forEach((q, qi) => {
      const sense = faceUvSense(q)
      if (!sense) return
      const loc = mats[q.materialIndex]?.locator ?? '?'
      rows.push({ entry: i, quad: qi, registryId: e.registryId, meta: e.meta, locator: loc, overlay: isOverlayMaterial(loc), ...sense })
    })
  })
  return rows
}

function tally(rows) {
  /** face → {base: Set(signature), overlay: Set(signature)} */
  const byFace = new Map()
  const sigOf = (r) => Object.entries(r.signs).map(([k, v]) => `${k}=${v}`).join(',')
  for (const r of rows) {
    if (!byFace.has(r.face)) byFace.set(r.face, { base: new Map(), overlay: new Map() })
    const bucket = byFace.get(r.face)
    const target = r.overlay ? bucket.overlay : bucket.base
    const sig = sigOf(r)
    target.set(sig, (target.get(sig) ?? 0) + 1)
  }
  return byFace
}

function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const files = args.filter((a) => a !== '--json')
  if (files.length === 0) {
    console.error('用法: node scripts/multiblock-pipeline/uv-face-diag.mjs <file>... [--json]')
    process.exit(2)
  }
  const out = []
  for (const f of files) {
    const rows = analyzeDoc(loadAny(path.resolve(f)))
    const byFace = tally(rows)
    const entry = { file: f, faces: {} }
    for (const [face, b] of [...byFace.entries()].sort()) {
      entry.faces[face] = {
        base: Object.fromEntries([...b.base.entries()].sort()),
        overlay: Object.fromEntries([...b.overlay.entries()].sort()),
      }
    }
    out.push(entry)
    if (!asJson) {
      console.log(`=== ${f}`)
      for (const [face, v] of Object.entries(entry.faces)) {
        console.log(`  ${face}`)
        console.log(`    基础: ${JSON.stringify(v.base)}`)
        console.log(`    覆盖: ${JSON.stringify(v.overlay)}`)
      }
    }
  }
  if (asJson) console.log(JSON.stringify(out, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
