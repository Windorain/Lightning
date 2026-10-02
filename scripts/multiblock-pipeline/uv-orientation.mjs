#!/usr/bin/env node
/**
 * 纹理 V 朝向对照工具（BUG: 纹理上下颠倒 / UV 不正确）。
 *
 * 作用：对一份产物（envelope 或裸内层 JSON 或 dataset palette.json）逐调色板条目、
 * 逐四边形统计「竖直面（有 y=0 与 y=1 两组顶点）上 v(top) 与 v(bottom) 的大小关系」，
 * 从而判定该四边形贴图相对块局部 Y 轴是否上下颠倒：
 *
 *   - normal : v(top) < v(bottom)  —— v=0 在块顶（与游戏内 RenderBlocks/GT 主纹理一致）
 *   - flipped: v(top) > v(bottom)  —— 上下颠倒
 *
 * 输出按材质类别（覆盖层 OVERLAY_* / 其它）汇总，供「全体纹理 vs 仅覆盖层」的分辨。
 *
 * 用法：
 *   node scripts/multiblock-pipeline/uv-orientation.mjs <file> [<file> ...] [--json]
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

/** 取文档里的 blockPalette + materialPalette（兼容 envelope 内层 / dataset palette.json）。 */
export function palettes(doc) {
  return { blocks: doc.blockPalette ?? [], materials: doc.materialPalette ?? [] }
}

/**
 * 单个四边形的竖直朝向。返回 null 表示不是「上下两组顶点」的竖直面（例如顶/底面）。
 * @returns {{top:number,bottom:number,orientation:'normal'|'flipped'}|null}
 */
export function verticalOrientation(quad) {
  const vs = quad?.vertices
  if (!Array.isArray(vs) || vs.length < 4) return null
  const top = vs.filter((v) => v.y > 0.5)
  const bottom = vs.filter((v) => v.y <= 0.5)
  if (top.length === 0 || bottom.length === 0) return null
  const tv = top.reduce((a, v) => a + v.v, 0) / top.length
  const bv = bottom.reduce((a, v) => a + v.v, 0) / bottom.length
  if (Math.abs(tv - bv) < 1e-9) return null // 该面 v 上下同值：无上下方向信息
  return { top: tv, bottom: bv, orientation: tv < bv ? 'normal' : 'flipped' }
}

const isOverlay = (locator) => /(^|[/:])OVERLAY/i.test(String(locator ?? ''))

export function analyze(doc, name = '<doc>') {
  const { blocks, materials } = palettes(doc)
  const entries = []
  for (let i = 0; i < blocks.length; i++) {
    const e = blocks[i]
    const quads = e?.geometry?.quads ?? []
    const perQuad = []
    quads.forEach((q, qi) => {
      const o = verticalOrientation(q)
      const mat = materials[q.materialIndex] ?? {}
      perQuad.push({
        quad: qi,
        materialIndex: q.materialIndex,
        locator: mat.locator ?? '?',
        overlay: isOverlay(mat.locator),
        ...(o ?? { orientation: 'n/a', top: null, bottom: null }),
      })
    })
    entries.push({ index: i, registryId: e.registryId, meta: e.meta, quads: perQuad })
  }
  const tally = (pred) => {
    let normal = 0
    let flipped = 0
    const locators = new Map()
    for (const e of entries) {
      for (const q of e.quads) {
        if (!pred(q) || q.orientation === 'n/a') continue
        if (q.orientation === 'normal') normal++
        else flipped++
        const key = q.locator
        const cur = locators.get(key) ?? { normal: 0, flipped: 0 }
        cur[q.orientation]++
        locators.set(key, cur)
      }
    }
    return { normal, flipped, locators }
  }
  return { name, entries, overlay: tally((q) => q.overlay), nonOverlay: tally((q) => !q.overlay) }
}

export function summarize(a) {
  const lines = []
  lines.push(`${a.name}`)
  for (const [label, t] of [
    ['覆盖层 OVERLAY_*', a.overlay],
    ['非覆盖层（主纹理/结构）', a.nonOverlay],
  ]) {
    lines.push(
      `  ${label}: normal(v0 在顶)=${t.normal}  flipped(v1 在顶)=${t.flipped}` +
        (t.normal + t.flipped > 0 ? '' : '  (无竖直面样本)'),
    )
    const flippedLocs = [...t.locators.entries()].filter(([, c]) => c.flipped > 0 && c.normal === 0)
    for (const [loc, c] of flippedLocs) lines.push(`      ⟂ 全翻: ${loc} (${c.flipped})`)
  }
  return lines.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const files = args.filter((a) => a !== '--json')
  if (files.length === 0) {
    console.error('用法: node scripts/multiblock-pipeline/uv-orientation.mjs <file> [<file>...] [--json]')
    process.exit(2)
  }
  const out = []
  for (const f of files) {
    const doc = loadAny(path.resolve(f))
    const a = analyze(doc, f)
    out.push(a)
    if (!asJson) console.log(summarize(a))
  }
  if (asJson) console.log(JSON.stringify(out, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
