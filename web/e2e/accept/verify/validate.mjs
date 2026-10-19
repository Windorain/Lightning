#!/usr/bin/env node
/**
 * 场景/判据校验器（本目录的唯一权威；schema/*.json 只供编辑器与工具使用）。
 *
 * 用法：
 *   node verify/validate.mjs                 # 校验全部 scenes/*.json + expect/*.json
 *   node verify/validate.mjs scenes/x.json   # 校验单份场景（连同其 expect）
 *
 * 退出码：0 = 全部合法；1 = 有错误（逐条打印）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')

const VIEWS = ['front', 'back', 'left', 'right', 'top', 'bottom']
const FACES = ['+x', '-x', '+y', '-y', '+z', '-z']
const KINDS = ['region', 'seam', 'opaque', 'silhouette', 'pair']
const WEATHERS = ['clear', 'rain', 'thunder']

const isInt = (v) => Number.isInteger(v)
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isInt)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

export function loadBlockLibrary(root = ROOT) {
  const p = path.join(root, 'blocks', 'blocks.json')
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (doc.schema !== 'lightning.accept.blocks/1') throw new Error('blocks.json schema 不匹配：' + doc.schema)
  const byId = new Map()
  for (const b of doc.blocks ?? []) {
    if (typeof b.id !== 'string' || typeof b.registryId !== 'string') throw new Error('blocks.json 条目缺 id/registryId')
    if (byId.has(b.id)) throw new Error('blocks.json 重复 id：' + b.id)
    byId.set(b.id, b)
  }
  return byId
}

/** 场景自身的合法性问题（不依赖 expect）。 */
export function validateScene(scene, blocks) {
  const errs = []
  const E = (m) => errs.push(m)
  if (scene?.schema !== 'lightning.accept.scene/1') E('schema 必须为 lightning.accept.scene/1')
  if (typeof scene?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(scene.id)) E('id 必须是小写连字符标识')
  if (typeof scene?.title !== 'string' || scene.title.trim() === '') E('title 不能为空')

  const w = scene?.world
  if (!w || typeof w !== 'object') E('world 缺失')
  else {
    if (typeof w.region !== 'string' || w.region === '') E('world.region 不能为空')
    if (!isVec3(w.origin)) E('world.origin 必须是 3 个整数')
    if (!isInt(w.dim) || w.dim < -1 || w.dim > 1) E('world.dim 必须是 -1..1 的整数')
    if (!isInt(w.time) || w.time < 0 || w.time > 24000) E('world.time 必须是 0..24000 的整数')
    if (!WEATHERS.includes(w.weather)) E('world.weather 必须是 ' + WEATHERS.join('/'))
  }

  const blocksOut = []
  if (!Array.isArray(scene?.blocks) || scene.blocks.length === 0) E('blocks 不能为空')
  else {
    const at = new Set()
    scene.blocks.forEach((b, i) => {
      if (typeof b?.block !== 'string' || !blocks.has(b.block)) E(`blocks[${i}].block 未在 blocks.json 登记：${b?.block}`)
      if (!isVec3(b?.at)) E(`blocks[${i}].at 必须是 3 个整数`)
      else {
        const k = b.at.join(',')
        if (at.has(k)) E(`blocks[${i}].at 与前面重复：[${k}]`)
        at.add(k)
        blocksOut.push({ id: b.block, at: b.at })
      }
    })
  }

  const c = scene?.cameras
  if (!c || typeof c !== 'object') E('cameras 缺失')
  else {
    const hasExplicit = Array.isArray(c.explicit) && c.explicit.length > 0
    if (!hasExplicit) {
      if (!Array.isArray(c.views) || c.views.length === 0) E('cameras.views 不能为空（除非给了 explicit）')
      else {
        if (new Set(c.views).size !== c.views.length) E('cameras.views 有重复')
        for (const v of c.views) if (!VIEWS.includes(v)) E('cameras.views 含未知视图：' + v)
      }
    }
    if (!hasExplicit) {
      if (!Array.isArray(c.axonometric)) E('cameras.axonometric 必须是数组')
      const names = new Set()
      for (const a of c.axonometric ?? []) {
        if (typeof a?.name !== 'string' || a.name === '') E('axonometric 条目缺 name')
        else {
          if (names.has(a.name)) E('axonometric name 重复：' + a.name)
          if (VIEWS.includes(a.name)) E('axonometric name 不得与六视图同名：' + a.name)
          names.add(a.name)
        }
        if (!isNum(a?.yaw)) E('axonometric.yaw 必须是数字')
        if (!isNum(a?.pitch) || a.pitch < -90 || a.pitch > 90) E('axonometric.pitch 必须在 -90..90')
      }
    }
    if (hasExplicit) {
      const names = new Set()
      for (const e of c.explicit) {
        if (typeof e?.name !== 'string' || e.name === '') E('explicit 条目缺 name')
        else { if (names.has(e.name)) E('explicit name 重复：' + e.name); names.add(e.name) }
        if (!Array.isArray(e?.pos) || e.pos.length !== 3 || !e.pos.every(isNum)) E('explicit.pos 必须是 3 个数字')
        if (!isNum(e?.yaw)) E('explicit.yaw 必须是数字')
        if (!isNum(e?.pitch) || e.pitch < -90 || e.pitch > 90) E('explicit.pitch 必须在 -90..90')
        if (!isNum(e?.orthoHeight) || e.orthoHeight <= 0) E('explicit.orthoHeight 必须 > 0')
      }
    }
    if (!hasExplicit && c.orthoHeight !== 'auto' && !(isNum(c.orthoHeight) && c.orthoHeight > 0)) E('cameras.orthoHeight 必须是 auto 或正数')
    if (!Array.isArray(c.resolution) || c.resolution.length !== 2 || !c.resolution.every((n) => isInt(n) && n >= 160)) E('cameras.resolution 必须是 2 个 ≥160 的整数')
    else {
      const [W, H] = c.resolution
      if (Math.abs(W / H - 16 / 9) > 1e-6) E(`cameras.resolution 必须是 16:9（当前 ${W}×${H}）——两侧配对的前提`)
    }
  }

  const e = scene?.export
  if (!e || typeof e !== 'object') E('export 缺失')
  else {
    if (typeof e.name !== 'string' || e.name === '') E('export.name 不能为空')
    if (e.shape !== 'world' && e.shape !== 'structure') E('export.shape 必须是 world/structure')
  }
  return { errors: errs, cells: blocksOut }
}

/** 判据的合法性问题（依赖场景：格子必须存在、相邻必须成立）。 */
export function validateExpect(expect, scene, cells) {
  const errs = []
  const E = (m) => errs.push(m)
  if (expect?.schema !== 'lightning.accept.expect/1') E('schema 必须为 lightning.accept.expect/1')
  if (expect?.scene !== scene?.id) E(`scene 必须等于场景 id（期望 ${scene?.id}）`)

  const cmp = expect?.compare
  if (!cmp || typeof cmp !== 'object') E('compare 缺失')
  else {
    if (cmp.pairs !== 'all-cameras') {
      if (!Array.isArray(cmp.pairs) || cmp.pairs.length === 0) E('compare.pairs 必须是 all-cameras 或非空机位名数组')
      else {
        const known = new Set([...(scene?.cameras?.views ?? []), ...((scene?.cameras?.axonometric ?? []).map((a) => a.name))])
        for (const p of cmp.pairs) if (!known.has(p)) E('compare.pairs 含场景里不存在的机位：' + p)
      }
    }
    if (cmp.normalize !== 'per-face-luminance' && cmp.normalize !== 'none') E('compare.normalize 必须是 per-face-luminance/none')
    if (!Array.isArray(cmp.exclude) || cmp.exclude.some((x) => x !== 'sky')) E('compare.exclude 只能含 sky')
    const t = cmp.thresholds
    if (!t || typeof t !== 'object') E('compare.thresholds 缺失')
    else {
      if (!isNum(t.silhouetteIoU) || t.silhouetteIoU < 0 || t.silhouetteIoU > 1) E('thresholds.silhouetteIoU 必须在 0..1')
      if (!isNum(t.faceColorDelta) || t.faceColorDelta < 0) E('thresholds.faceColorDelta 必须 ≥0')
      if (!isNum(t.seamEdgeMax) || t.seamEdgeMax < 0) E('thresholds.seamEdgeMax 必须 ≥0')
    }
  }

  const cellSet = new Set(cells.map((c) => c.at.join(',')))
  const has = (at) => Array.isArray(at) && cellSet.has(at.join(','))
  const ids = new Set()
  if (!Array.isArray(expect?.checks) || expect.checks.length === 0) E('checks 不能为空')
  else {
    expect.checks.forEach((chk, i) => {
      if (!KINDS.includes(chk?.kind)) E(`checks[${i}].kind 未知：${chk?.kind}`)
      if (typeof chk?.id !== 'string' || chk.id === '') E(`checks[${i}].id 不能为空`)
      else {
        if (ids.has(chk.id)) E('checks id 重复：' + chk.id)
        ids.add(chk.id)
      }
      if (chk?.kind === 'region' || chk?.kind === 'opaque') {
        if (!has(chk.at)) E(`checks[${i}] 的 at 不是场景里声明过的格子：${JSON.stringify(chk.at)}`)
        if (chk.face !== undefined && !FACES.includes(chk.face)) E(`checks[${i}].face 必须是 ${FACES.join('/')}`)
        if (chk.kind === 'region' && !['background', 'not-background'].includes(String(chk.expect)) && !String(chk.expect).startsWith('block:')) {
          E(`checks[${i}].expect 必须是 background/not-background/block:<id>`)
        }
      }
      if (chk?.kind === 'seam') {
        if (!Array.isArray(chk.between) || chk.between.length !== 2) E(`checks[${i}].between 必须是两格`)
        else {
          const [a, b] = chk.between
          if (!has(a) || !has(b)) E(`checks[${i}].between 含未声明的格子`)
          else {
            const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
            if (d !== 1) E(`checks[${i}].between 必须相邻（曼哈顿距离 1，当前 ${d}）`)
          }
        }
        if (!['x', 'y', 'z'].includes(chk.axis)) E(`checks[${i}].axis 必须是 x/y/z`)
      }
    })
  }
  return errs
}

/** 目录级一致性：每份场景有且只有一份判据，反之亦然。 */
export function validateTree(root = ROOT) {
  const blocks = loadBlockLibrary(root)
  const scenesDir = path.join(root, 'scenes')
  const expectDir = path.join(root, 'expect')
  const scenes = fs.readdirSync(scenesDir).filter((f) => f.endsWith('.json'))
  const expects = fs.readdirSync(expectDir).filter((f) => f.endsWith('.json'))
  const errs = []
  for (const f of scenes) {
    const id = f.replace(/\.json$/, '')
    const scene = JSON.parse(fs.readFileSync(path.join(scenesDir, f), 'utf8'))
    if (scene.id !== id) errs.push(`${f}: id 与文件名不一致（${scene.id}）`)
    const { errors, cells } = validateScene(scene, blocks)
    errs.push(...errors.map((e) => `scenes/${f}: ${e}`))
    const ep = path.join(expectDir, id + '.json')
    if (!fs.existsSync(ep)) { errs.push(`scenes/${f}: 缺判据 expect/${id}.json`); continue }
    const expect = JSON.parse(fs.readFileSync(ep, 'utf8'))
    errs.push(...validateExpect(expect, scene, cells).map((e) => `expect/${id}.json: ${e}`))
  }
  for (const f of expects) {
    const id = f.replace(/\.json$/, '')
    if (!scenes.includes(id + '.json')) errs.push(`expect/${f}: 没有对应场景 scenes/${id}.json`)
  }
  return errs
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errs = validateTree()
  if (errs.length === 0) console.log('[accept] 校验通过')
  else { for (const e of errs) console.error('[accept] ' + e); process.exitCode = 1 }
}
