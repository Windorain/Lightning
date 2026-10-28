#!/usr/bin/env node
/**
 * Lightning 体积剖析工具（体积剖析基线）
 * ---------------------------------------------------------------------------
 * 对 `/sde export` 产物的两种落盘形态做**可追溯到 JSON 字段路径**的字节分桶统计：
 *   1. V2 plain JSON  —— 单个 JSON 文本（compact / pretty 均可）
 *   2. gzip+base64 信封 —— { documentFormat, payloadEncoding, meta, payload }
 *
 * 与 mod 侧产物一致性依据：
 *   - protocol/lightning/v2/plain_v2.proto        （V2 plain 字段定义）
 *   - protocol/lightning/v2/envelope_v2.proto     （信封字段定义）
 *   - mod/.../client/export/SceneEnvelopeBuilder.java （信封装配：meta + gzip(inner) → base64）
 *   - mod/.../client/export/TextureBlobEmbedder.java  （textureBlobs 填充）
 *   - mod/.../client/meshcapture/MeshCaptureService.java（blockPalette / cellGrid 写出）
 *   - web/src/render/data/compactSceneDocument.ts （信封判定 / 解压）
 *
 * 设计要点：
 *   - 不重新序列化输入文件：直接扫描**原始文本**的字节区间，因此每个字节桶都能唯一归属到
 *     一个真实存在的字段路径，且 sum(桶) == 非空白字节数（有断言保证）。
 *   - gzip / base64 后体积：由 Node 内置 zlib 在同一进程内重算（gzipSync level 9 + base64），
 *     不依赖任何第三方依赖，跑两次结果完全一致。
 *
 * 用法：
 *   node scripts/volume-profile/volume-profile.mjs analyse <file-or-dir> [--md out.md] [--json out.json] [--csv out.csv] [--max-paths N] [--verify false]
 *   node scripts/volume-profile/volume-profile.mjs synth [--out scripts/volume-profile/samples]
 *   node scripts/volume-profile/volume-profile.mjs list
 *
 * 无第三方依赖，Node >= 18（内置 zlib / fs）。
 */

import { createHash } from 'node:crypto'
import { deflateSync, gunzipSync, gzipSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SAMPLE_DIR = path.join(HERE, 'samples')

// ===========================================================================
// 1. 分桶规则（唯一的分类真源；报告中必须与之一致）
// ===========================================================================
//
// `field`：JSON 字段路径；圆括号段表示其后代字段。
// 匹配规则：对某条叶子字段的实际路径 P，取规则中**路径段数最多**且 P === field 或
//          P.startsWith(field + '.') 或 P.startsWith(field + '[') 的那一条。
//
export const BUCKET_RULES = [
  // ── 几何：blockPalette 条目中的烘焙网格（含 quads 及其下所有顶点字段）────
  { bucket: 'palette.geometry', rollup: 'geometry', field: '$.blockPalette[].geometry' },
  { bucket: 'palette.geometry', rollup: 'geometry', field: '$.frames[].structure.blockPalette[].geometry' },

  // ── 方块调色板：同一方块状态只存一份（去重后的状态表，不含几何）────────
  { bucket: 'palette.meta', rollup: 'palette', field: '$.blockPalette' },
  { bucket: 'palette.meta', rollup: 'palette', field: '$.frames[].structure.blockPalette' },

  // ── 网格：cellGrid（方块下标占用）────────────────────────────────────
  { bucket: 'grid.cellGrid', rollup: 'grid', field: '$.cellGrid' },
  { bucket: 'grid.cellGrid', rollup: 'grid', field: '$.frames[].structure.cellGrid' },

  // ── 网格：cellTooltipGrid（逐格 tooltip 下标）────────────────────────
  { bucket: 'grid.cellTooltipGrid', rollup: 'grid', field: '$.cellTooltipGrid' },
  { bucket: 'grid.cellTooltipGrid', rollup: 'grid', field: '$.frames[].structure.cellTooltipGrid' },

  // ── 纹理：textureBlobs（标准 base64 PNG）────────────────────────────
  { bucket: 'texture.blobs', rollup: 'texture', field: '$.textureBlobs' },
  { bucket: 'texture.blobs', rollup: 'texture', field: '$.frames[].structure.textureBlobs' },

  // ── 材质：材质表 + 材质池（不含像素，含 textureBlobIndex 引用）────────
  { bucket: 'material.entries', rollup: 'material', field: '$.materialPalette' },
  { bucket: 'material.entries', rollup: 'material', field: '$.frames[].structure.materialPalette' },

  // ── 平台：共享文案池（blockPalette[].tooltip 已被 palette.meta 更长前缀收走）
  { bucket: 'pool.tooltip', rollup: 'pools', field: '$.tooltipPalette' },
  { bucket: 'pool.tooltip', rollup: 'pools', field: '$.frames[].structure.tooltipPalette' },

  // ── 注解 / 标签 / 统计 ───────────────────────────────────────────────
  { bucket: 'annotations', rollup: 'annotations', field: '$.annotations' },
  { bucket: 'labels', rollup: 'annotations', field: '$.labels' },
  { bucket: 'stats', rollup: 'annotations', field: '$.stats' },
  { bucket: 'stats', rollup: 'annotations', field: '$.statsTemplate' },
  { bucket: 'stats', rollup: 'annotations', field: '$.stats_template' },

  // ── 帧包装：帧下标 / 标签 / 时长 / 结构容器其余键 ─────────────────────
  { bucket: 'frames.meta', rollup: 'frames_meta', field: '$.frames' },

  // ── 文档级元数据 ────────────────────────────────────────────────────
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.meta' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.format_version' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.schemaVersion' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.id' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.label' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.author' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.gtnhVersion' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.gtVersion' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.description' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.modSource' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.mode' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.structureId' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.playback' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.globalConfig' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.source' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.axis' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.initialCamera' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.scanBounds' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.sdeCellNotes' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.geometryPhase' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.frames[].structure.geometryPhase' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.documentFormat' },
  { bucket: 'doc.meta', rollup: 'doc_meta', field: '$.payloadEncoding' },
]

/** 无法归类的键 → 归入 `other.*`（桶名带实际路径，保证映射表仍可追溯）。 */
export const FALLBACK_BUCKET = 'other'

export const BUCKET_ORDER = [
  'palette.geometry',
  'palette.meta',
  'grid.cellGrid',
  'grid.cellTooltipGrid',
  'texture.blobs',
  'material.entries',
  'pool.tooltip',
  'annotations',
  'labels',
  'stats',
  'frames.meta',
  'doc.meta',
]

const RULE_CACHE = new Map()

/** `$.a[].b` → 3（段数）；用于"最长前缀优先"，与字段名长度无关。 */
function segmentCount(field) {
  const m = field.match(/\.([^.[\]]+)|\[(\d*)\]/g)
  return m ? m.length : 0
}

function ruleFor(segPath) {
  const cached = RULE_CACHE.get(segPath)
  if (cached !== undefined) return cached
  let best = null
  let bestDepth = -1
  for (const r of BUCKET_RULES) {
    const f = r.field
    if (segPath === f || segPath.startsWith(f + '.') || segPath.startsWith(f + '[')) {
      const depth = r.__depth ?? (r.__depth = segmentCount(f))
      if (depth > bestDepth) {
        bestDepth = depth
        best = r
      }
    }
  }
  const out = best ?? { bucket: `${FALLBACK_BUCKET}:${segPath}`, rollup: 'other', field: '(未登记路径)' }
  RULE_CACHE.set(segPath, out)
  return out
}

// ===========================================================================
// 2. 原始文本扫描器：把每个叶子值的字节区间定位到字段路径
// ===========================================================================
// 产出 locator 列表（深度优先，顺序即文本中出现顺序）。

/** 去掉结构性空白（**不进入字符串字面量**，避免破坏 `Synthetic A-small` 这类值）。 */
export function stripStructuralWhitespace(text) {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '"') break
        j++
      }
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    out += ch
    i++
  }
  return out
}

export function scanLocators(text) {
  const locs = []
  const n = text.length

  /** @returns {number} 下一个非空白字符的下标；到末尾返回 n */
  function skipWs(i) {
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++
      else break
    }
    return i
  }

  /** 跳过字符串，返回闭合引号下标 + 1（调用时 text[i] === '"'） */
  function scanString(i) {
    i++
    while (i < n) {
      const ch = text[i]
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '"') return i + 1
      i++
    }
    throw new Error('JSON 字符串未闭合')
  }

  /** 读取字符串字面量的值（含反转义），入参 start 指向开引号 */
  function readStringValue(start) {
    const end = scanString(start)
    return JSON.parse(text.slice(start, end))
  }

  /**
   * 测量一个值，返回其结束下标；叶子值推入 locators。
   * `pathSegs` 为**精确**路径段（原始键 token / `a<下标>`），用于与 DOM 取值比对；
   * `segPath` 为人类可读的 `$.a[0].b` 形式，用于报表与分桶规则匹配。
   */
  function measureValue(i, segPath, pathSegs) {
    i = skipWs(i)
    const ch = text[i]
    if (ch === '"') {
      const end = scanString(i)
      locs.push({ pathSegs: pathSegs.slice(), segPath, start: i, end, kind: 'string' })
      return end
    }
    if (ch === '{' || ch === '[') {
      return measureContainer(i, segPath, pathSegs)
    }
    // 数字 / true / false / null
    let j = i
    while (j < n) {
      const c = text[j]
      if (c === ',' || c === '}' || c === ']' || c === ' ' || c === '\t' || c === '\n' || c === '\r') break
      j++
    }
    locs.push({ pathSegs: pathSegs.slice(), segPath, start: i, end: j, kind: 'literal' })
    return j
  }

  function measureContainer(i, segPath, pathSegs) {
    const open = text[i]
    const close = open === '{' ? '}' : ']'
    i++
    let index = 0
    let members = 0
    for (;;) {
      i = skipWs(i)
      if (text[i] === close) {
        // 空容器 `{}` / `[]` 没有任何叶子，若不补记一条 locator，其**键名**（如
        // `"nbt":{}`、`"tooltip":[]`）就会从键名统计里消失。补一条零字节 locator，
        // 只用于键名归属，不贡献任何叶子字节。
        if (members === 0 && pathSegs.length > 0) {
          locs.push({
            pathSegs: pathSegs.slice(),
            segPath,
            start: i,
            end: i,
            kind: 'emptyContainer',
            empty: true,
          })
        }
        return i + 1
      }
      if (text[i] === ',') {
        i++
        continue
      }
      members++
      if (open === '{') {
        if (text[i] !== '"') throw new Error(`对象键位置出现非字符串（offset ${i}）`)
        const keyStart = i
        const key = readStringValue(i)
        // pathSegs 保存的是**原始键文本 token**（含引号转义），因此含 `.` 或 `[` 的键
        // （如 NBT 的 `extRM.DOWN`）也能被精确回读，不会在字符串路径里产生歧义。
        pathSegs.push(text.slice(keyStart, scanString(i)))
        i = skipWs(scanString(i))
        if (text[i] !== ':') throw new Error(`对象键后缺少 ':'（offset ${i}）`)
        i = measureValue(i + 1, `${segPath}.${key}`, pathSegs)
        pathSegs.pop()
      } else {
        pathSegs.push(`a${index}`)
        i = measureValue(i, `${segPath}[]`, pathSegs)
        pathSegs.pop()
        index++
      }
    }
  }

  const i0 = skipWs(0)
  measureContainer(i0, '$', [])
  return locs
}

/** 用 locator 记录的原始键 token 精确取值（绕过字符串路径歧义）。 */
function valueAtPathSegs(parsed, pathSegs) {
  let cur = parsed
  for (const seg of pathSegs) {
    if (/^a\d+$/.test(seg)) {
      cur = cur?.[Number(seg.slice(1))]
    } else {
      const key = JSON.parse(seg)
      cur = cur?.[key]
    }
    if (cur === undefined) return undefined
  }
  return cur
}

/**
 * 直接扫描（去空白后的）JSON 文本、**跳过字符串字面量**，精确统计结构性分隔符的字符数。
 * 这是分隔符的权威口径：字符串值里的 `:`（如 `minecraft:blocks/...`）不会被误计。
 * 返回 `colonKeys` 供交叉校验用：真正的键后 `:` 个数应等于所有键 token 的出现次数之和。
 */
export function countDelimiters(strippedText) {
  const c = { objOpen: 0, objClose: 0, arrOpen: 0, arrClose: 0, comma: 0, colon: 0 }
  let objDepth = 0
  let arrDepth = 0
  const n = strippedText.length
  let i = 0
  while (i < n) {
    const ch = strippedText[i]
    if (ch === '"') {
      i++
      while (i < n) {
        if (strippedText[i] === '\\') {
          i += 2
          continue
        }
        if (strippedText[i] === '"') {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '{') {
      c.objOpen++
      objDepth++
    } else if (ch === '}') {
      c.objClose++
      objDepth--
    } else if (ch === '[') {
      c.arrOpen++
      arrDepth++
    } else if (ch === ']') {
      c.arrClose++
      arrDepth--
    } else if (ch === ',') c.comma++
    else if (ch === ':') c.colon++
    i++
  }
  return c
}

/**
 * 自校验：把每个叶子 locator 的原文 token 与 DOM 中该路径的值比对。
 * 路径走 locator 记录的**精确键 token**（不经字符串拼接），因此 NBT 里
 * 形如 `extRM.DOWN` / `covers[0]` 的键不会产生歧义。
 * 返回不一致清单（正常应为空）。
 */
export function verifyLocators(text, locs, parsed) {
  const problems = []
  for (const l of locs) {
    if (l.empty) continue
    const token = text.slice(l.start, l.end)
    let tokenValue
    try {
      tokenValue = JSON.parse(token)
    } catch {
      problems.push({ segPath: l.segPath, reason: `token 非合法 JSON：${token.slice(0, 40)}` })
      continue
    }
    const domValue = valueAtPathSegs(parsed, l.pathSegs)
    if (domValue === undefined) {
      problems.push({ segPath: l.segPath, reason: '路径在 DOM 中解析为 undefined' })
      continue
    }
    if (typeof tokenValue === 'number' && typeof domValue === 'number') {
      if (tokenValue !== domValue && Math.abs(tokenValue - domValue) > 1e-9) {
        problems.push({ segPath: l.segPath, reason: `数值不一致 token=${tokenValue} dom=${domValue}` })
      }
    } else if (JSON.stringify(tokenValue) !== JSON.stringify(domValue)) {
      problems.push({
        segPath: l.segPath,
        reason: `值不一致 token=${JSON.stringify(tokenValue)?.slice(0, 40)} dom=${JSON.stringify(domValue)?.slice(0, 40)}`,
      })
    }
  }
  return problems
}

// ===========================================================================
// 3. 序列化 / 压缩度量
// ===========================================================================

/** 与 JSON.stringify 一致但保留对象键顺序（JSON.stringify 本就保留插入顺序）。 */
function serializeValue(v) {
  return JSON.stringify(v)
}

function gzipBytes(buf) {
  // 固定 level=9 + mtime 不写入（Node 的 gzip 头 mtime 恒为 0），保证可重复
  return gzipSync(buf, { level: 9 })
}

function toBase64(buf) {
  return buf.toString('base64')
}

function pct(part, whole) {
  if (!whole) return 0
  return (part / whole) * 100
}

/**
 * 按**顶层键**切分文档，统计每个顶层键子树的原始字节数与分隔符数（各自独立、可复核）。
 * 用于回答"分隔符到底花在哪个字段上"。
 */
export function sectionBreakdown(parsed, docKeys) {
  const out = []
  for (const key of docKeys) {
    const subtree = parsed[key]
    const text = JSON.stringify(subtree)
    const n = text.length
    let objOpen = 0
    let objClose = 0
    let arrOpen = 0
    let arrClose = 0
    let comma = 0
    let colon = 0
    let i = 0
    while (i < n) {
      const ch = text[i]
      if (ch === '"') {
        i++
        while (i < n) {
          if (text[i] === '\\') {
            i += 2
            continue
          }
          if (text[i] === '"') {
            i++
            break
          }
          i++
        }
        continue
      }
      if (ch === '{') objOpen++
      else if (ch === '}') objClose++
      else if (ch === '[') arrOpen++
      else if (ch === ']') arrClose++
      else if (ch === ',') comma++
      else if (ch === ':') colon++
      i++
    }
    out.push({
      key,
      subtreeBytes: n,
      objOpen,
      objClose,
      arrOpen,
      arrClose,
      comma,
      colon,
      delimBytes: objOpen + objClose + arrOpen + arrClose + comma + colon,
      containers: objOpen + arrOpen,
    })
  }
  return out.sort((a, b) => b.subtreeBytes - a.subtreeBytes)
}

// ===========================================================================
// 4. 信封处理
// ===========================================================================

function isEnvelopeShape(doc) {
  return (
    doc !== null &&
    typeof doc === 'object' &&
    !Array.isArray(doc) &&
    doc.documentFormat === 'Envelope' &&
    typeof doc.payload === 'string' &&
    doc.meta !== null &&
    typeof doc.meta === 'object'
  )
}

/** 与 SceneEnvelopeBuilder 的语义一致：解压 payload → JSON → 去掉 meta 键后与 meta 合并。 */
function envelopeToPlain(doc) {
  const b64 = doc.payload
  const raw = Buffer.from(b64, 'base64')
  const inflated = gunzipSync(raw)
  const text = inflated.toString('utf8')
  const inner = JSON.parse(text)
  delete inner.id
  delete inner.label
  delete inner.author
  delete inner.gtnhVersion
  delete inner.gtVersion
  delete inner.structureId
  delete inner.description
  delete inner.modSource
  delete inner.playback
  delete inner.globalConfig
  delete inner.schemaVersion
  delete inner.mode
  const merged = { format_version: '2.0', ...doc.meta, ...inner, documentFormat: 'Plain' }
  return { inner, innerText: text, innerGzipBytes: raw, plain: merged }
}

// ===========================================================================
// 5. 单文件剖析
// ===========================================================================

export function analyseText(text, label, opts = {}) {
  const rawBytes = Buffer.byteLength(text, 'utf8')
  const stripped = stripStructuralWhitespace(text)
  const compactBytes = Buffer.byteLength(stripped, 'utf8')

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`${label}: JSON 解析失败：${e.message}`)
  }

  // --- 字节归属：叶子 token 的紧凑形态字节数（token 原文与紧凑形态逐字节相同）---
  const locs = scanLocators(text)
  const leafBytes = new Map() // segPath -> { bytes, bucket, rollup, occurrences }
  const fieldBytes = new Map() // 归一化字段族路径 -> { bytes, bucket, occurrences }
  const keyBytes = new Map() // JSON 键名 -> 字节（跨整个文档，含数组元素）
  const bucketBytes = new Map()
  let leafTokenBytes = 0
  for (const l of locs) {
    if (l.empty) {
      // 空容器占位 locator（`{}` / `[]`）：只贡献键名归属，不贡献叶子字节/分桶字节
      const lseg = l.pathSegs[l.pathSegs.length - 1]
      if (lseg && lseg.startsWith('"')) {
        const keyName = JSON.parse(lseg)
        const kLen = Buffer.byteLength(lseg + ':', 'utf8')
        const kEntry = keyBytes.get(keyName)
        if (kEntry) {
          kEntry.bytes += kLen
          kEntry.occurrences++
        } else {
          keyBytes.set(keyName, { key: keyName, bytes: kLen, occurrences: 1 })
        }
      }
      continue
    }
    const token = text.slice(l.start, l.end)
    const len = Buffer.byteLength(token, 'utf8')
    leafTokenBytes += len
    // 规则用「数组下标无关」的归一化路径匹配：$.a[0].b → $.a[].b
    const segPath = l.segPath.replace(/\[\d+\]/g, '[]')
    const rule = ruleFor(segPath)
    let entry = leafBytes.get(segPath)
    if (!entry) {
      entry = { segPath, bytes: 0, occurrences: 0, bucket: rule.bucket, rollup: rule.rollup }
      leafBytes.set(segPath, entry)
    }
    entry.bytes += len
    entry.occurrences++
    let fEntry = fieldBytes.get(segPath)
    if (!fEntry) {
      fEntry = { segPath, bytes: 0, occurrences: 0, bucket: rule.bucket, rollup: rule.rollup }
      fieldBytes.set(segPath, fEntry)
    }
    fEntry.bytes += len
    fEntry.occurrences++
    const lastSeg = l.pathSegs[l.pathSegs.length - 1]
    if (lastSeg && lastSeg.startsWith('"')) {
      // 只统计**对象成员键**（`"key":`），数组元素没有键名
      const keyToken = lastSeg + ':'
      const kLen = Buffer.byteLength(keyToken, 'utf8')
      const keyName = JSON.parse(lastSeg)
      const kEntry = keyBytes.get(keyName)
      if (kEntry) {
        kEntry.bytes += kLen
        kEntry.occurrences++
      } else {
        keyBytes.set(keyName, { key: keyName, bytes: kLen, occurrences: 1 })
      }
    }
    bucketBytes.set(rule.bucket, (bucketBytes.get(rule.bucket) ?? 0) + len)
  }
  // 分隔符 / 键名开销：两把独立的尺子，取更可靠的一把为准，另一把用于审计
  //   ① 字符扫描（跳过字符串字面量）→ 分隔符字符数，**权威**（可在文本上肉眼复核）
  //   ② 扫描器逐条累加 `"key":` token → 键名（用于"哪些键最贵"的分布表）
  //   ③ 差额法（compact − Σ叶子）给出「非叶子总量」，① 减去后即得键名总量 → 用于闭合
  const delimCount = countDelimiters(stripped)
  const delimiterBytes =
    2 * delimCount.objOpen + 2 * delimCount.arrOpen + delimCount.comma + delimCount.colon
  // 键名 token 的约定是 `"key":`（**自带冒号**），而 ① 的 delimiterBytes 已经包含了
  // 每个键的 `:`，因此这里要减去冒号数，避免重复计算。
  const nonLeafBytes = compactBytes - leafTokenBytes
  const keyNameBytesIncludingColons = nonLeafBytes - delimiterBytes + delimCount.colon
  const keyNameBytes = keyNameBytesIncludingColons
  const measuredKeyTokenBytes = [...keyBytes.values()].reduce((a, k) => a + k.bytes, 0)
  const measuredKeyTokenCount = [...keyBytes.values()].reduce((a, k) => a + k.occurrences, 0)
  // 审计量：扫描器未能定位到键 token 的键名字节（差值应远小于 keyNameBytes）
  const keyNameAuditGap = keyNameBytes - measuredKeyTokenBytes
  const accounted = leafTokenBytes
  const whitespaceBytes = rawBytes - compactBytes

  // --- 重建一致性断言：tokens 按文档顺序拼接（补上标点）后必须等于紧凑原文 ---
  // 这里用最强的形式：JSON.stringify(JSON.parse(text)) 必须等于紧凑原文，
  // 且 Σ(token) + 标点数 = 紧凑字节数。
  const reserialized = JSON.stringify(parsed)
  const reserializedBytes = Buffer.byteLength(reserialized, 'utf8')
  const reserializeExact = reserialized === stripped

  // --- 扫描器自校验（值级比对，防"分桶看着对、其实错位"）---
  let verifyProblems = []
  if (opts.verify !== false) {
    verifyProblems = verifyLocators(text, locs, parsed)
  }

  // --- 压缩形态 ---
  const compactBuf = Buffer.from(stripped, 'utf8')
  const gzipBuf = gzipBytes(compactBuf)
  const b64 = toBase64(gzipBuf)

  // --- 顶层桶 → 对 gzip 增量的贡献（单独 gzip 该键的 JSON）---
  const gzipContribution = []
  const isPlainObjectDoc = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  if (isPlainObjectDoc && !isEnvelopeShape(parsed)) {
    const emptyGz = gzipBytes(Buffer.from('{}', 'utf8')).length
    for (const [k, v] of Object.entries(parsed)) {
      const one = gzipBytes(Buffer.from(JSON.stringify({ [k]: v }), 'utf8')).length
      gzipContribution.push({ key: k, bytes: Math.max(0, one - emptyGz) })
    }
    gzipContribution.sort((a, b) => b.bytes - a.bytes)
  }

  // --- 网格/调色板规模统计（用于规模归一化指标）---
  const shape = describeShape(parsed)

  // --- 按顶层键的子树体积与分隔符（用于定位"括号花在哪"）---
  const sections = isPlainObjectDoc && !isEnvelopeShape(parsed) ? sectionBreakdown(parsed, Object.keys(parsed)) : []

  // --- 信封形态：额外给出信封结构与内层 JSON 剖析 ---
  let envelope = null
  if (isEnvelopeShape(parsed) && (opts.depth ?? 0) < 2) {
    const env = envelopeToPlain(parsed)
    const innerBuf = Buffer.from(env.innerText, 'utf8')
    const innerGzip = gzipBytes(innerBuf)
    const innerB64 = toBase64(innerGzip)
    const payloadLen = Buffer.byteLength(parsed.payload, 'utf8')
    // 结构开销：把 payload 置空（保持其余键原样）后测得的结构字节
    const skeleton = JSON.stringify({ ...parsed, payload: '' })
    const metaBytes = Buffer.byteLength(JSON.stringify(parsed.meta ?? {}), 'utf8')
    envelope = {
      payloadEncoding: parsed.payloadEncoding ?? null,
      documentFormat: parsed.documentFormat ?? null,
      payloadBase64Bytes: payloadLen,
      payloadGzipBytes: env.innerGzipBytes.length,
      payloadInflatedBytes: Buffer.byteLength(env.innerText, 'utf8'),
      payloadDecodedSha256: createHash('sha256').update(env.innerGzipBytes).digest('hex'),
      payloadBase64RoundTripExact: Buffer.compare(Buffer.from(parsed.payload, 'base64'), env.innerGzipBytes) === 0,
      // 同一内容重压一次的字节数（用于判断 mod 侧 gzip 与 node zlib 的差异）
      regzipBytes: innerGzip.length,
      regzipBase64Bytes: innerB64.length,
      envelopeSkeletonBytes: Buffer.byteLength(skeleton, 'utf8'),
      metaBytes,
      metaKeys: Object.keys(parsed.meta ?? {}),
      payloadKeyCount: Object.keys(env.inner).length,
      payloadKeys: Object.keys(env.inner),
      fileBytes: rawBytes,
      fileMinusPayloadBytes: rawBytes - payloadLen,
      inner: analyseText(env.innerText, `${label} :: payload(解压后内层 JSON)`, {
        verify: opts.verify,
        depth: (opts.depth ?? 0) + 1,
      }),
    }
  }

  return {
    label,
    sourceKind: envelope ? 'Envelope(gzip+base64)' : 'Plain(V2 JSON)',
    rawBytes,
    compactBytes,
    whitespaceBytes,
    gzipBytes: gzipBuf.length,
    gzipBytesWithJsonBoilerplate: gzipBytes(Buffer.from(reserialized, 'utf8')).length,
    base64Bytes: Buffer.byteLength(b64, 'utf8'),
    base64PlusQuotesBytes: Buffer.byteLength(b64, 'utf8') + 2,
    reserializedBytes,
    reserializeExact,
    accountedBytes: accounted,
    nonLeafBytes,
    keyNameAuditGap,
    measuredKeyTokenBytes,
    measuredKeyTokenCount,
    delimiterBytes,
    keyNameBytes,
    delimCount,
    accountExact:
      accounted + (delimiterBytes - delimCount.colon) + keyNameBytes === compactBytes,
    verifyProblems,
    leafCount: locs.length,
    buckets: [...bucketBytes.entries()].map(([bucket, bytes]) => ({
      bucket,
      bytes,
      shareOfCompact: pct(bytes, compactBytes),
    })).sort((a, b) => b.bytes - a.bytes),
    leaves: [...leafBytes.values()].sort((a, b) => b.bytes - a.bytes),
    fields: [...fieldBytes.values()].sort((a, b) => b.bytes - a.bytes),
    keys: [...keyBytes.values()].sort((a, b) => b.bytes - a.bytes),
    gzipContribution,
    sections,
    shape,
    envelope,
  }
}

/** 文档形状与规模指标。 */
function describeShape(doc) {
  const out = {
    documentFormat: doc?.documentFormat ?? 'Plain(隐式)',
    formatVersion: doc?.format_version ?? null,
    frameCount: Array.isArray(doc?.frames) ? doc.frames.length : 1,
    topLevelKeys: doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? Object.keys(doc) : [],
    frames: [],
  }
  const frameList = Array.isArray(doc?.frames) ? doc.frames : [{ index: 0, structure: doc }]
  for (const f of frameList) {
    const st = f?.structure ?? (doc?.frames ? null : doc)
    const cellGrid = st?.cellGrid
    let dims = null
    let cells = 0
    let nonAir = 0
    if (Array.isArray(cellGrid)) {
      const depth = cellGrid.length
      const height = Array.isArray(cellGrid[0]) ? cellGrid[0].length : 0
      const width = Array.isArray(cellGrid[0]?.[0]) ? cellGrid[0][0].length : 0
      dims = { width, height, depth }
      for (const slice of cellGrid) {
        for (const row of slice) {
          if (!Array.isArray(row)) continue
          for (const v of row) {
            cells++
            if (typeof v === 'number' && v > 0) nonAir++
          }
        }
      }
    }
    const palette = st?.blockPalette
    const quads = Array.isArray(palette)
      ? palette.reduce((acc, e) => acc + (Array.isArray(e?.geometry?.quads) ? e.geometry.quads.length : 0), 0)
      : 0
    const blobs = st?.textureBlobs ?? doc?.textureBlobs
    out.frames.push({
      index: f?.index ?? 0,
      label: f?.label ?? null,
      dims,
      cells,
      nonAir,
      paletteEntries: Array.isArray(palette) ? palette.length : 0,
      quads,
      materialEntries: Array.isArray(st?.materialPalette ?? doc?.materialPalette)
        ? (st?.materialPalette ?? doc?.materialPalette).length
        : 0,
      textureBlobs: Array.isArray(blobs) ? blobs.length : 0,
      cellTooltipGrid: Boolean(st?.cellTooltipGrid),
    })
  }
  out.annotations = Array.isArray(doc?.annotations) ? doc.annotations.length : 0
  out.labels = Array.isArray(doc?.labels) ? doc.labels.length : 0
  return out
}

/** 递归收集目录下的 .json 文件。 */
function collectJsonFiles(target) {
  const st = fs.statSync(target)
  if (st.isFile()) return [target]
  const out = []
  for (const name of fs.readdirSync(target).sort()) {
    const p = path.join(target, name)
    const s = fs.statSync(p)
    if (s.isDirectory()) out.push(...collectJsonFiles(p))
    else if (name.endsWith('.json')) out.push(p)
  }
  return out
}

// ===========================================================================
// 6. 合成样例生成（仓库内无真实导出产物时使用；报告中必须标注来源）
// ===========================================================================

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 生成确定性的 16x16 RGBA PNG（内容由 seed 决定），用于仿真 textureBlobs。 */
function makePng(seed, size = 16, entropy = 'noise') {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let p = 0
  let s = (seed * 2654435761 + 12345) >>> 0
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      if (entropy === 'noise') {
        // 接近不可压缩的伪随机像素：真实 MC 纹理多为手绘噪点/抖色，比纯色块难压缩得多，
        // 用它可以让 textureBlobs 的 gzip 表现不虚高。
        raw[p++] = Math.floor(rnd() * 256)
        raw[p++] = Math.floor(rnd() * 256)
        raw[p++] = Math.floor(rnd() * 256)
        raw[p++] = 255
      } else {
        const base = ((seed * 37) % 256 + x * 5) % 256
        const mix = Math.floor(rnd() * 48)
        raw[p++] = (base + mix) & 0xff
        raw[p++] = (base + seed * 3 + y * 7 + mix) & 0xff
        raw[p++] = (base * 2 + x * y + mix) & 0xff
        raw[p++] = 255
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', require_zlib_deflate(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return png.toString('base64')
}

function require_zlib_deflate(buf) {
  return deflateSync(buf, { level: 9 })
}

/** 方块状态 palette 条目工厂（字段顺序与 MeshCaptureService L580–624 一致）。 */
function paletteEntry({ registryId, meta, quads, materialCount, occludes, tooltip }) {
  const geoQuads = []
  for (let q = 0; q < quads; q++) {
    const mi = (q * 3 + meta) % Math.max(1, materialCount)
    const ox = (q % 2) * 0.5
    const oy = (Math.floor(q / 2) % 2) * 0.5
    geoQuads.push({
      materialIndex: mi,
      vertices: [
        { x: ox, y: oy, z: 1.0, u: 0.0, v: 0.0, brightness: 0.85, color: 16777215 },
        { x: ox + 0.5, y: oy, z: 1.0, u: 0.25, v: 0.0, brightness: 0.85, color: 16777215 },
        { x: ox + 0.5, y: oy + 0.5, z: 1.0, u: 0.25, v: 0.25, brightness: 0.85, color: 16777215 },
        { x: ox, y: oy + 0.5, z: 1.0, u: 0.0, v: 0.25, brightness: 0.85, color: 16777215 },
      ],
    })
  }
  const entry = {
    registryId,
    meta,
    renderMode: 'BakedModel',
    geometry: { encoding: 'bakedQuadsJsonV1', quads: geoQuads },
    occludesAdjacentFaces: occludes,
  }
  if (tooltip && tooltip.length) entry.tooltip = tooltip
  return entry
}

/**
 * 构造一个代表性场景。
 * @param {object} o
 * @param {string} o.name
 * @param {[number,number,number]} o.dims [w,h,d]（cellGrid 的 [z][row][col] 尺寸取 [d,h,w]）
 * @param {number} o.kinds     方块状态种类数（决定 blockPalette 条目数）
 * @param {number} o.materials 材质条目数
 * @param {number} o.quadsPerEntry 每个 palette 条目的四边形数
 * @param {boolean} o.shellOnly 只填外壳（模拟多方块中空结构）
 * @param {number} o.frames    帧数（每帧尺寸递减 1，用于观察逐帧重复几何开销）
 * @param {boolean} o.withAnnotations
 * @param {boolean} o.withTooltipGrid
 */
function makeScene(o) {
  const {
    name,
    dims,
    kinds,
    materials,
    quadsPerEntry = 6,
    shellOnly = false,
    frames = 1,
    withAnnotations = false,
    withTooltipGrid = false,
    textureSeedBase = 1,
    pngSize = 16,
  } = o
  const [w0, h0, d0] = dims
  const textureBlobs = []
  for (let i = 0; i < materials; i++) textureBlobs.push(makePng(textureSeedBase + i, pngSize))
  const materialPalette = []
  for (let i = 0; i < materials; i++) {
    materialPalette.push({
      locator: i % 3 === 0 ? `gregtech:blocks/materialicons/${name}_${i}` : `minecraft:blocks/${name}_${i}`,
      atlas: i % 5 === 0 ? null : 'blocks',
      blendMode: i % 7 === 0 ? 'translucent' : 'opaque',
      textureBlobIndex: i,
    })
  }
  const palette = [
    {
      registryId: 'air',
      meta: 0,
      renderMode: 'BakedModel',
      geometry: { encoding: 'bakedQuadsJsonV1', quads: [] },
      occludesAdjacentFaces: false,
      nbt: null,
      tooltip: [],
    },
  ]
  const tooltipLines = []
  for (let i = 1; i <= kinds; i++) {
    const tt = []
    if (i % 4 === 0) {
      tt.push(`${name} Component ${i}`)
      tt.push(`Tier ${(i % 14) + 1} Machine Casing`)
      tooltipLines.push(...tt)
    }
    palette.push(
      paletteEntry({
        registryId: i % 3 === 0 ? `gregtech:gt.blockmachines` : i % 3 === 1 ? `minecraft:stone` : `IC2:blockAlloyGlass`,
        meta: i,
        quads: quadsPerEntry + (i % 3),
        materialCount: materials,
        occludes: i % 3 !== 2,
        tooltip: tt,
      }),
    )
  }

  const frameList = []
  for (let fi = 0; fi < frames; fi++) {
    const w = Math.max(3, w0 - fi)
    const h = Math.max(3, h0 - fi)
    const d = Math.max(3, d0 - fi)
    const slice = []
    const tipSlice = []
    for (let z = 0; z < d; z++) {
      const rows = []
      const tipRows = []
      for (let y = 0; y < h; y++) {
        const cols = []
        const tipCols = []
        for (let x = 0; x < w; x++) {
          const onShell = x === 0 || y === 0 || z === 0 || x === w - 1 || y === h - 1 || z === d - 1
          const filled = shellOnly ? onShell : onShell || ((x + y + z + fi) % 3 !== 0)
          if (filled) {
            const idx = 1 + ((x * 7 + y * 13 + z * 29 + fi * 3) % kinds)
            cols.push(idx)
            tipCols.push(idx % 5 === 0 ? idx : -1)
          } else {
            cols.push(0)
            tipCols.push(-1)
          }
        }
        rows.push(cols)
        tipRows.push(tipCols)
      }
      slice.push(rows)
      tipSlice.push(tipRows)
    }
    const structure = {
      geometryPhase: 'baked',
      cellGrid: slice,
    }
    if (withTooltipGrid) structure.cellTooltipGrid = tipSlice
    structure.blockPalette = palette
    frameList.push({ index: fi, label: fi === 0 ? 'default' : `tier-${fi + 1}`, structure })
  }

  const doc = {
    format_version: '2.0',
    id: `synthetic-${name}`,
    label: `Synthetic ${name}`,
    gtnhVersion: '2.7.4',
    author: 'Lightning volume profiler',
    description: `Synthetic representative scene for volume profiling (${name}). NOT a real /sde export artifact.`,
    modSource: 'lightning.synth',
    schemaVersion: 3,
    meta: {
      name: `Synthetic ${name}`,
      author: 'Lightning volume profiler',
      created_at_ms: 1700000000000,
      description: 'Synthetic scene generated by scripts/volume-profile/volume-profile.mjs',
      tags: ['synthetic', name],
      origin: { x: 0, y: 64, z: 0 },
    },
    frames: frameList,
    annotations: [],
    labels: [],
    materialPalette,
    textureBlobs,
  }
  if (tooltipLines.length) doc.tooltipPalette = tooltipLines
  if (withAnnotations) {
    doc.annotations = [
      {
        id: 'ann-energy',
        title: 'Energy Hatch',
        description: '**LV** energy hatch — see wiki page for wiring.',
        min: { x: 0, y: 0, z: 0 },
        max: { x: 1, y: 1, z: 1 },
        color: '#ffaa00',
        visible: true,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        hover_event: 'open_url',
        hover_payload: 'https://example.invalid/wiki',
        render_style: 'box',
        render_opacity: 0.35,
        linked_block_ref: '#12',
      },
      {
        id: 'ann-coil',
        title: 'Coil Tier',
        description: 'Cupronickel coil block line.',
        min: { x: 3, y: 1, z: 0 },
        max: { x: 3, y: 4, z: 0 },
        color: '#44ddff',
        visible: true,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        hover_event: '',
        hover_payload: '',
        render_style: 'box',
        render_opacity: 0.2,
        linked_block_ref: '',
      },
    ]
    doc.labels = [
      { id: 'lbl-1', text: 'Input Bus', x: 1.5, y: 2.0, z: 0.5, color: '#ffffff', font_size: 16, visible: true },
      { id: 'lbl-2', text: 'Output Hatch', x: 5.5, y: 2.0, z: 0.5, color: '#ffffff', font_size: 16, visible: true },
    ]
  }
  return doc
}

/** 与 SceneEnvelopeBuilder.toEnvelope 等价的信封包装。 */
function toEnvelope(plain) {
  const metaKeys = [
    'id',
    'mode',
    'label',
    'author',
    'gtnhVersion',
    // 两条版本事实成对搬运：gtnhVersion 是整合包版本（dreamcraft），gtVersion 是 GregTech 版本
    // （见 docs/contracts/format-scene-file.md §2.1）。缺这条会让剖面样本的 GT 版本落进 payload 根。
    'gtVersion',
    'structureId',
    'description',
    'modSource',
    'playback',
    'globalConfig',
    'schemaVersion',
  ]
  const innerKeys = ['frames', 'materialPalette', 'blockPalette', 'cellGrid', 'cellTooltipGrid', 'textureBlobs', 'tooltipPalette']
  const meta = {}
  const inner = {}
  if (Array.isArray(plain.frames)) {
    for (const k of metaKeys) if (k in plain) meta[k] = plain[k]
    for (const k of innerKeys) if (k in plain) inner[k] = plain[k]
  } else {
    for (const k of [...metaKeys, 'geometryPhase', 'source', 'axis', 'initialCamera', 'scanBounds']) {
      if (k in plain) meta[k] = plain[k]
    }
    for (const k of ['blockPalette', 'materialPalette', 'cellGrid', 'cellTooltipGrid', 'sdeCellNotes', 'textureBlobs', 'tooltipPalette']) {
      if (k in plain) inner[k] = plain[k]
    }
  }
  const utf8 = Buffer.from(JSON.stringify(inner), 'utf8')
  const payload = toBase64(gzipBytes(utf8))
  return {
    documentFormat: 'Envelope',
    payloadEncoding: 'gzip+base64',
    meta,
    payload,
  }
}

export const SAMPLE_SPECS = [
  {
    name: 'A-small-shell',
    note: '小结构（7×5×7 中空外壳），6 种方块状态，4 材质',
    build: () =>
      makeScene({
        name: 'A-small-shell',
        dims: [7, 5, 7],
        kinds: 6,
        materials: 4,
        quadsPerEntry: 6,
        shellOnly: true,
      }),
  },
  {
    name: 'B-medium-solid',
    note: '中结构（15×11×15 实心为主），14 种状态，12 材质，含 cellTooltipGrid',
    build: () =>
      makeScene({
        name: 'B-medium-solid',
        dims: [15, 11, 15],
        kinds: 14,
        materials: 12,
        quadsPerEntry: 8,
        withTooltipGrid: true,
      }),
  },
  {
    name: 'C-large-solid',
    note: '大结构（31×17×31 实心为主），24 种状态，24 材质',
    build: () =>
      makeScene({
        name: 'C-large-solid',
        dims: [31, 17, 31],
        kinds: 24,
        materials: 24,
        quadsPerEntry: 9,
      }),
  },
  {
    name: 'D-texture-only',
    note: '单格结构 + 96 材质：隔离 textureBlobs 体积',
    build: () =>
      makeScene({
        name: 'D-texture-only',
        dims: [3, 3, 3],
        kinds: 2,
        materials: 96,
        quadsPerEntry: 1,
      }),
  },
  {
    name: 'E-frames8',
    note: '8 帧逐级变大，共享同一 blockPalette：观察"逐帧重复几何"的线性开销',
    build: () =>
      makeScene({
        name: 'E-frames8',
        dims: [19, 11, 19],
        kinds: 12,
        materials: 10,
        quadsPerEntry: 7,
        frames: 8,
        shellOnly: true,
        withTooltipGrid: true,
      }),
  },
  {
    name: 'F-decorated',
    note: '小结构 + 注解/标签：隔离 annotations/labels 体积',
    build: () =>
      makeScene({
        name: 'F-decorated',
        dims: [7, 5, 7],
        kinds: 6,
        materials: 4,
        quadsPerEntry: 6,
        shellOnly: true,
        withAnnotations: true,
        withTooltipGrid: true,
      }),
  },
]

export function synthSamples(outDir, { envelope = true, pretty = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const written = []
  for (const spec of SAMPLE_SPECS) {
    const plain = spec.build()
    // 与 web 侧 `RuntimeDocument.serialize()` 对齐：首帧的 cellGrid / blockPalette /
    // cellTooltipGrid 会被展开到根级（供 loadStructureData 直接读取），因此 Plain 形态
    // 里这些数据在「帧内 + 根级」各存在一份。这是真实 Plain 产物的形状，必须如实建模。
    const firstStructure = plain.frames?.[0]?.structure
    if (firstStructure) {
      for (const key of ['cellGrid', 'blockPalette', 'cellTooltipGrid']) {
        if (key in firstStructure && !(key in plain)) plain[key] = firstStructure[key]
      }
    }
    const plainPath = path.join(outDir, `${spec.name}.plain.json`)
    fs.writeFileSync(plainPath, (pretty ? JSON.stringify(plain, null, 2) : JSON.stringify(plain)) + '\n', 'utf8')
    written.push(plainPath)
    if (envelope) {
      const env = toEnvelope(plain)
      const envPath = path.join(outDir, `${spec.name}.envelope.json`)
      fs.writeFileSync(envPath, JSON.stringify(env, null, 2) + '\n', 'utf8')
      written.push(envPath)
    }
  }
  return written
}

// ===========================================================================
// 7. 报告渲染
// ===========================================================================

function fmtBytes(n) {
  return n.toLocaleString('en-US')
}

function kb(n) {
  return (n / 1024).toFixed(1)
}

function reportOne(r, { maxPaths = 60 } = {}) {
  const L = []
  L.push(`### ${r.label}`)
  L.push('')
  L.push(`输入形态：**${r.sourceKind}**`)
  L.push('')
  L.push('| 形态 | 字节 | KiB | 说明 |')
  L.push('|---|---:|---:|---|')
  L.push(`| 落盘（原始文本，含空白） | ${fmtBytes(r.rawBytes)} | ${kb(r.rawBytes)} | 文件真实大小 |`)
  L.push(`| 未压缩 JSON（去结构性空白） | ${fmtBytes(r.compactBytes)} | ${kb(r.compactBytes)} | 分桶统计口径 |`)
  L.push(`| gzip(level 9) | ${fmtBytes(r.gzipBytes)} | ${kb(r.gzipBytes)} | 压缩后 payload |`)
  L.push(`| base64(gzip) | ${fmtBytes(r.base64Bytes)} | ${kb(r.base64Bytes)} | 信封 payload 字符串本体 |`)
  L.push(`| 压缩率 | ${pct(r.gzipBytes, r.compactBytes).toFixed(2)}% | — | gzip/未压缩 |`)
  L.push(`| base64 膨胀 | ${pct(r.base64Bytes, r.gzipBytes).toFixed(2)}% | — | base64/gzip |`)
  L.push('')
  L.push(
    `- 重建一致性：\`JSON.stringify(JSON.parse(text)) === 去空白原文\` → **${r.reserializeExact ? '一致' : '不一致'}**（重建 ${fmtBytes(r.reserializedBytes)} vs 去空白 ${fmtBytes(r.compactBytes)}）`,
  )
  L.push(
    `- 三分解闭合：Σ叶子 ${fmtBytes(r.accountedBytes)} + 分隔符 ${fmtBytes(r.delimiterBytes)} + 键名(不含冒号) ${fmtBytes(r.keyNameBytes - r.delimCount.colon)} = ${fmtBytes(r.accountedBytes + r.delimiterBytes + r.keyNameBytes - r.delimCount.colon)}；去空白原文 ${fmtBytes(r.compactBytes)} → **${r.accountExact ? '闭合' : '不闭合'}**；叶子 ${fmtBytes(r.leafCount)} 个，对象 ${fmtBytes(r.delimCount.objOpen)} 个 / 数组 ${fmtBytes(r.delimCount.arrOpen)} 个 / 键 ${fmtBytes(r.delimCount.colon)} 个，空白缩进 ${fmtBytes(r.whitespaceBytes)} 字节`,
  )
  L.push(
    `- 分隔符（字符扫描，已跳过字符串字面量）：\`{}\` ${fmtBytes(r.delimCount.objOpen * 2)}、\`[]\` ${fmtBytes(r.delimCount.arrOpen * 2)}、\`,\` ${fmtBytes(r.delimCount.comma)}、\`:\` ${fmtBytes(r.delimCount.colon)}（合计 ${fmtBytes(r.delimiterBytes)}）`,
  )
  L.push(
    `- 键名审计：键名总量（含冒号）${fmtBytes(r.keyNameBytes)}；扫描器逐条定位到的键 token ${fmtBytes(r.measuredKeyTokenBytes)}（${fmtBytes(r.measuredKeyTokenCount)} 个），未定位差额 ${fmtBytes(r.keyNameAuditGap)} 字节（空对象/空数组的父键等），已计入键名总量`,
  )
  L.push(
    `- 扫描器自校验（每个叶子 token 与 DOM 同路径取值逐一比对）：**${r.verifyProblems.length === 0 ? '全部一致' : `${r.verifyProblems.length} 处不一致`}**`,
  )
  if (r.verifyProblems.length) {
    for (const p of r.verifyProblems.slice(0, 20)) L.push(`  - ⚠️ \`${p.segPath}\`：${p.reason}`)
  }
  const s = r.shape
  L.push(
    `- 形状：format=${s.formatVersion} / documentFormat=${s.documentFormat} / 帧数=${s.frameCount} / 顶层键=[${s.topLevelKeys.join(', ')}]`,
  )
  for (const f of s.frames) {
    const d = f.dims ? `${f.dims.width}×${f.dims.height}×${f.dims.depth}(x×y×z)` : 'n/a'
    L.push(
      `  - 帧 ${f.index}：cellGrid ${d}，格 ${fmtBytes(f.cells)}（非空 ${fmtBytes(f.nonAir)}），palette 条目 ${f.paletteEntries}，quad ${fmtBytes(f.quads)}，材质 ${f.materialEntries}，textureBlob ${f.textureBlobs}，cellTooltipGrid=${f.cellTooltipGrid}`,
    )
  }
  L.push(`- 注解 ${s.annotations} 条 / 标签 ${s.labels} 条`)
  L.push('')
  L.push('**分桶（按 JSON 字段路径 → 桶）**')
  L.push('')
  const cells = s.frames.reduce((a, f) => a + f.cells, 0)
  const quads = s.frames.reduce((a, f) => a + f.quads, 0)
  const rollupTotals = new Map()
  const rollupByBucket = new Map()
  for (const r of BUCKET_RULES) rollupByBucket.set(r.bucket, r.rollup)
  for (const b of r.buckets) {
    const key = b.bucket.startsWith(FALLBACK_BUCKET + ':') ? 'other' : (rollupByBucket.get(b.bucket) ?? 'other')
    rollupTotals.set(key, (rollupTotals.get(key) ?? 0) + b.bytes)
  }
  L.push('| 汇总桶（rollup） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |')
  L.push('|---|---:|---:|---:|---:|')
  for (const [k, v] of [...rollupTotals.entries()].sort((a, b) => b[1] - a[1])) {
    L.push(
      `| ${k} | ${fmtBytes(v)} | ${pct(v, r.compactBytes).toFixed(2)}% | ${cells ? (v / cells).toFixed(3) : '—'} | ${quads ? (v / quads).toFixed(2) : '—'} |`,
    )
  }
  L.push('')
  L.push('| 明细桶（bucket） | 字节 | 占未压缩 | 每格字节 | 每 quad 字节 |')
  L.push('|---|---:|---:|---:|---:|')
  for (const b of r.buckets) {
    L.push(
      `| ${b.bucket} | ${fmtBytes(b.bytes)} | ${b.shareOfCompact.toFixed(2)}% | ${cells ? (b.bytes / cells).toFixed(3) : '—'} | ${quads ? (b.bytes / quads).toFixed(2) : '—'} |`,
    )
  }
  L.push(
    `| （分隔符 \`{}[],:\`，非键名） | ${fmtBytes(r.delimiterBytes)} | ${pct(r.delimiterBytes, r.compactBytes).toFixed(2)}% | | |`,
  )
  L.push(
    `| （键名 \`"key":\`，共 ${fmtBytes(r.delimCount.colon)} 个键） | ${fmtBytes(r.keyNameBytes)} | ${pct(r.keyNameBytes, r.compactBytes).toFixed(2)}% | | |`,
  )
  L.push(
    `| **Σ 未压缩 JSON** | **${fmtBytes(r.compactBytes)}** | **100.00%** | | |`,
  )
  L.push('')
  if (r.sections && r.sections.length) {
    L.push('**按顶层键的子树体积与分隔符（各自独立统计，可单独复核）**')
    L.push('')
    L.push('| 顶层键 | 子树字节 | 占未压缩 | 对象 | 数组 | 键 | `,` | `:` | 分隔符合计 | 分隔符占比 |')
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const s of r.sections) {
      L.push(
        `| ${s.key} | ${fmtBytes(s.subtreeBytes)} | ${pct(s.subtreeBytes, r.compactBytes).toFixed(2)}% | ${fmtBytes(s.objOpen)} | ${fmtBytes(s.arrOpen)} | ${fmtBytes(s.colon)} | ${fmtBytes(s.comma)} | ${fmtBytes(s.colon)} | ${fmtBytes(s.delimBytes)} | ${pct(s.delimBytes, s.subtreeBytes).toFixed(1)}% |`,
      )
    }
    const sumSub = r.sections.reduce((a, s) => a + s.subtreeBytes, 0)
    L.push(
      `| **Σ 子树** | **${fmtBytes(sumSub)}** | — | | | | | | | |（与未压缩 ${fmtBytes(r.compactBytes)} 的差 = 顶层键名与顶层分隔符 ${fmtBytes(r.compactBytes - sumSub)}） |`,
    )
    L.push('')
  }
  if (r.gzipContribution.length) {
    L.push('**顶层键对 gzip 的贡献（单独 gzip 该键 − 空文档 gzip 基线）**')
    L.push('')
    L.push('| 顶层键 | gzip 增量字节 |')
    L.push('|---|---:|')
    for (const g of r.gzipContribution) L.push(`| ${g.key} | ${fmtBytes(g.bytes)} |`)
    L.push('')
  }
  L.push(`**最大字段族（Top ${Math.min(maxPaths, r.fields.length)}，路径已按数组下标归一化）**`)
  L.push('')
  L.push('| 字段路径 | 出现次数 | 字节 | 桶 |')
  L.push('|---|---:|---:|---|')
  for (const l of r.fields.slice(0, maxPaths)) {
    L.push(`| \`${l.segPath}\` | ${l.occurrences} | ${fmtBytes(l.bytes)} | ${l.bucket} |`)
  }
  L.push('')
  L.push(`**按 JSON 键名聚合（Top ${Math.min(maxPaths, r.keys.length)}，与所在位置无关）**`)
  L.push('')
  L.push('| 键名 | 出现次数 | 字节 | 平均字节 |')
  L.push('|---|---:|---:|---:|')
  for (const k of r.keys.slice(0, maxPaths)) {
    L.push(
      `| \`${k.key}\` | ${fmtBytes(k.occurrences)} | ${fmtBytes(k.bytes)} | ${(k.bytes / k.occurrences).toFixed(2)} |`,
    )
  }
  L.push('')
  if (r.envelope) {
    const e = r.envelope
    L.push('**信封（Envelope）分解**')
    L.push('')
    L.push('| 组成部分 | 字节 | 说明 |')
    L.push('|---|---:|---|')
    L.push(`| 文件落盘 | ${fmtBytes(e.fileBytes)} | ${'`documentFormat` + `payloadEncoding` + `meta` + `payload`'} |`)
    L.push(`| payload 字段（base64 字符串） | ${fmtBytes(e.payloadBase64Bytes)} | ${pct(e.payloadBase64Bytes, e.fileBytes).toFixed(2)}% 的文件 |`)
    L.push(`| 非 payload 结构开销 | ${fmtBytes(e.fileMinusPayloadBytes)} | documentFormat/payloadEncoding/meta + JSON 骨架（其中 meta 本体 ${fmtBytes(e.metaBytes)}） |`)
    L.push(`| payload 解 base64 后（gzip 流） | ${fmtBytes(e.payloadGzipBytes)} | 与 mod 侧写出的 gzip 流逐字节比对：${e.payloadBase64RoundTripExact ? '一致' : '不一致'} |`)
    L.push(`| payload 解压 + 解 base64 后（内层 JSON） | ${fmtBytes(e.payloadInflatedBytes)} | 内层为不含元数据键的 body |`)
    L.push(`| 内层 JSON 重新 gzip（node zlib level 9） | ${fmtBytes(e.regzipBytes)} | 与 mod 侧 gzip 流差 ${fmtBytes(e.regzipBytes - e.payloadGzipBytes)} 字节（头部/压缩器实现差异） |`)
    L.push(`| 内层重新 gzip 后 base64 | ${fmtBytes(e.regzipBase64Bytes)} | 理论最优 payload 长度参考 |`)
    L.push('')
    L.push(`- 内层 gzip 流 sha256：\`${e.payloadDecodedSha256}\``)
    L.push(`- meta 键：[${e.metaKeys.join(', ')}]`)
    L.push(`- payload 内层键：[${e.payloadKeys.join(', ')}]`)
    L.push('')
    L.push('**内层 payload 剖析（信封内的真实内容）**')
    L.push('')
    L.push(reportOne(e.inner, { maxPaths }))
  }
  return L.join('\n')
}

function reportAll(results, opts) {
  const L = []
  L.push('# 体积剖析原始输出')
  L.push('')
  L.push('- 工具：`scripts/volume-profile/volume-profile.mjs`（本文件不含时间戳，便于逐字节比对两次运行结果）')
  L.push(`- 文件数：${results.length}`)
  L.push('')
  L.push('## 汇总表')
  L.push('')
  L.push('| 文件 | 落盘 | 未压缩 JSON | gzip | base64 | 帧 | cellGrid 规模 | palette 条目 | quad | 材质 | textureBlob |')
  L.push('|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|')
  for (const r of results) {
    const s = r.shape
    const dims = s.frames.map(f => (f.dims ? `${f.dims.width}×${f.dims.height}×${f.dims.depth}` : '?')).join(' / ')
    const pal = s.frames.reduce((a, f) => a + f.paletteEntries, 0)
    const q = s.frames.reduce((a, f) => a + f.quads, 0)
    const mat = Math.max(...s.frames.map(f => f.materialEntries))
    const blobs = Math.max(...s.frames.map(f => f.textureBlobs))
    L.push(
      `| ${r.label} | ${fmtBytes(r.rawBytes)} | ${fmtBytes(r.compactBytes)} | ${fmtBytes(r.gzipBytes)} | ${fmtBytes(r.base64Bytes)} | ${s.frameCount} | ${dims} | ${pal} | ${fmtBytes(q)} | ${mat} | ${blobs} |`,
    )
  }
  L.push('')
  L.push('## 逐文件明细')
  L.push('')
  for (const r of results) {
    L.push(reportOne(r, opts))
    L.push('')
    L.push('---')
    L.push('')
  }
  return L.join('\n')
}

/** 机器可读的 CSV 汇总（供画体积增长曲线；每文件一行）。 */
export function toCsv(results) {
  const bucketCols = BUCKET_ORDER
  const header = [
    'label',
    'source_kind',
    'raw_bytes',
    'compact_json_bytes',
    'gzip_bytes',
    'base64_bytes',
    'gzip_ratio',
    'frames',
    'cellgrid_w',
    'cellgrid_h',
    'cellgrid_d',
    'cells',
    'nonair_cells',
    'palette_entries',
    'quads',
    'material_entries',
    'texture_blobs',
    'punctuation_bytes',
    'account_exact',
    'reserialize_exact',
    ...bucketCols,
  ]
  const q = v => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = [header.join(',')]
  for (const r of results) {
    const cellsTotal = r.shape.frames.reduce((a, f) => a + f.cells, 0)
    const nonAir = r.shape.frames.reduce((a, f) => a + f.nonAir, 0)
    const pal = r.shape.frames.reduce((a, f) => a + f.paletteEntries, 0)
    const quads = r.shape.frames.reduce((a, f) => a + f.quads, 0)
    const mat = r.shape.frames.length ? Math.max(...r.shape.frames.map(f => f.materialEntries)) : 0
    const blobs = r.shape.frames.length ? Math.max(...r.shape.frames.map(f => f.textureBlobs)) : 0
    const d0 = r.shape.frames.find(f => f.dims)?.dims ?? { width: '', height: '', depth: '' }
    const bmap = new Map(r.buckets.map(b => [b.bucket, b.bytes]))
    rows.push(
      [
        q(r.label),
        q(r.sourceKind),
        r.rawBytes,
        r.compactBytes,
        r.gzipBytes,
        r.base64Bytes,
        (r.gzipBytes / r.compactBytes).toFixed(6),
        r.shape.frameCount,
        d0.width,
        d0.height,
        d0.depth,
        cellsTotal,
        nonAir,
        pal,
        quads,
        mat,
        blobs,
        r.delimiterBytes,
        r.accountExact,
        r.reserializeExact,
        ...bucketCols.map(b => bmap.get(b) ?? 0),
      ].join(','),
    )
  }
  return rows.join('\n')
}

// ===========================================================================
// 8. CLI
// ===========================================================================

function parseFlags(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), undefined]
      if (v !== undefined) flags[k] = v
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
      else flags[k] = true
    } else positional.push(a)
  }
  return { flags, positional }
}

function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2))
  const cmd = positional[0] ?? 'analyse'
  const maxPaths = flags['max-paths'] ? Number(flags['max-paths']) : 60

  if (cmd === 'synth') {
    const outDir = flags.out ? path.resolve(flags.out) : DEFAULT_SAMPLE_DIR
    const written = synthSamples(outDir, {
      envelope: flags.envelope !== 'false',
      pretty: Boolean(flags.pretty),
    })
    console.log(`[synth] 已写出 ${written.length} 个合成样例到 ${outDir}`)
    for (const w of written) {
      const size = fs.statSync(w).size
      console.log(`  - ${path.basename(w)}  ${fmtBytes(size)} B`)
    }
    return
  }

  if (cmd === 'list') {
    for (const s of SAMPLE_SPECS) console.log(`${s.name}\t${s.note}`)
    return
  }

  if (cmd !== 'analyse') {
    console.error(`未知命令：${cmd}\n用法：analyse <file-or-dir> | synth | list`)
    process.exitCode = 2
    return
  }

  const target = positional[1] ? path.resolve(positional[1]) : DEFAULT_SAMPLE_DIR
  if (!fs.existsSync(target)) {
    console.error(`路径不存在：${target}（先跑 \`node scripts/volume-profile/volume-profile.mjs synth\` 生成合成样例）`)
    process.exitCode = 2
    return
  }
  const files = collectJsonFiles(target)
  if (files.length === 0) {
    console.error(`未找到 .json 文件：${target}`)
    process.exitCode = 2
    return
  }
  const results = []
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    const label = path.relative(process.cwd(), f).replace(/\\/g, '/')
    try {
      results.push(analyseText(text, label, { verify: flags.verify !== 'false' }))
    } catch (e) {
      console.error(`[skip] ${label}: ${e.message}`)
    }
  }
  const md = reportAll(results, { maxPaths })
  process.stdout.write(md + '\n')

  if (flags.md) {
    fs.mkdirSync(path.dirname(path.resolve(flags.md)), { recursive: true })
    fs.writeFileSync(path.resolve(flags.md), md + '\n', 'utf8')
    console.error(`[out] markdown → ${path.resolve(flags.md)}`)
  }
  if (flags.csv) {
    fs.mkdirSync(path.dirname(path.resolve(flags.csv)), { recursive: true })
    fs.writeFileSync(path.resolve(flags.csv), toCsv(results) + '\n', 'utf8')
    console.error(`[out] csv → ${path.resolve(flags.csv)}`)
  }
  if (flags.json) {
    const slim = results.map(r => ({
      label: r.label,
      sourceKind: r.sourceKind,
      rawBytes: r.rawBytes,
      compactBytes: r.compactBytes,
      whitespaceBytes: r.whitespaceBytes,
      gzipBytes: r.gzipBytes,
      base64Bytes: r.base64Bytes,
      reserializeExact: r.reserializeExact,
      accountExact: r.accountExact,
      accountedBytes: r.accountedBytes,
      delimiterBytes: r.delimiterBytes,
      keyNameBytes: r.keyNameBytes,
      keyNameAuditGap: r.keyNameAuditGap,
      delimCount: r.delimCount,
      punctuationBytes: r.delimiterBytes + r.keyNameBytes,
      delimiterBytes: r.delimiterBytes, keyNameBytes: r.keyNameBytes,
      verifyProblems: r.verifyProblems,
      leafCount: r.leafCount,
      buckets: r.buckets,
      leaves: r.leaves,
      fields: r.fields,
      keys: r.keys,
      gzipContribution: r.gzipContribution,
      sections: r.sections,
      shape: r.shape,
      envelope: r.envelope
        ? {
            ...r.envelope,
            inner: {
              label: r.envelope.inner.label,
              rawBytes: r.envelope.inner.rawBytes,
              compactBytes: r.envelope.inner.compactBytes,
              gzipBytes: r.envelope.inner.gzipBytes,
              base64Bytes: r.envelope.inner.base64Bytes,
              accountExact: r.envelope.inner.accountExact,
              accountedBytes: r.envelope.inner.accountedBytes,
              delimiterBytes: r.envelope.inner.delimiterBytes,
              keyNameBytes: r.envelope.inner.keyNameBytes,
              keyNameAuditGap: r.envelope.inner.keyNameAuditGap,
              delimCount: r.envelope.inner.delimCount,
              whitespaceBytes: r.envelope.inner.whitespaceBytes,
              reserializeExact: r.envelope.inner.reserializeExact,
              delimiterBytes: r.envelope.inner.delimiterBytes, keyNameBytes: r.envelope.inner.keyNameBytes,
              verifyProblems: r.envelope.inner.verifyProblems,
              buckets: r.envelope.inner.buckets,
              leaves: r.envelope.inner.leaves,
              fields: r.envelope.inner.fields,
              keys: r.envelope.inner.keys,
              gzipContribution: r.envelope.inner.gzipContribution,
              sections: r.envelope.inner.sections,
              shape: r.envelope.inner.shape,
            },
          }
        : null,
    }))
    fs.mkdirSync(path.dirname(path.resolve(flags.json)), { recursive: true })
    fs.writeFileSync(path.resolve(flags.json), JSON.stringify(slim, null, 2) + '\n', 'utf8')
    console.error(`[out] json → ${path.resolve(flags.json)}`)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
