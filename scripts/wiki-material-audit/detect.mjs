/**
 * detect.mjs —— 判型核心（纯函数，无网络/无文件 IO）
 * ============================================================================
 *
 * 这里只做一件事：把「一个导出件文档」判成「有没有坏材质、坏在哪、有没有被真正用到」。
 * 判据只看贴图本身与材质 locator，不依赖导出器版本或任何上游工单：
 *
 *   missingTexture（缺失材质占位图）
 *       贴图本身就是 Minecraft 的缺失材质占位图：16x16、颜色数 <= 4、
 *       洋红像素占比 > 10%、纯黑像素占比 > 10%
 *       （洋红 = |r-255|<24 且 g<24 且 |b-255|<24；纯黑 = max(r,g,b)<24）。
 *       命中说明导出时材质没解析出来，页面上会渲染成黑/洋红棋盘。
 *
 *   ic2FaceStrip（IC2 横向多面带）
 *       IC2 的部分机器贴图是「一张 PNG 横向排 N 个面」，导出器把整条带当成一个面：
 *       blob 为 384x32 或 192x32（H=32、W=N*32、W>32），且材质 locator 是 IC2 系。
 *       IC2 系只认 locator 前缀 ic2: / ic2/，不猜注册名里的其它线索。
 *       命中说明一个面上被压进了 N 个面的像素。
 *
 *   其它可疑但不满足上两条的 —— 一律进「未判型」桶，如实列出，禁止硬塞：
 *        - 横向带形状但非 IC2 或宽度不是 384/192；
 *        - 占位图形状（尺寸 <= 32、颜色数 <= 8、洋红和纯黑都出现）但没达到 missingTexture 门槛；
 *        - 贴图解码失败（隔行/非 PNG 等）—— 记为缺口，同样不猜。
 *
 * 「坏材质」与「页面命中」是两件事：blob 坏 ≠ 这个结构真的画错。只有坏 blob 被
 * 某个**实际出现在 cellGrid 里的方块**引用时，才算结构命中（status=bad）；
 * 坏 blob 存在但没被任何方块使用，记为警告（status=warn），不冤枉页面。
 */

import { PngError, pngStats } from './png.mjs'

export const CRITERIA = Object.freeze({
  missingTexture: Object.freeze({ width: 16, height: 16, maxColors: 4, minMagenta: 0.1, minBlack: 0.1 }),
  ic2FaceStrip: Object.freeze({ height: 32, widths: [384, 192], locator: /^ic2[:/]/i }),
  placeholderLike: Object.freeze({ maxSide: 32, maxColors: 8, minMagenta: 0.02, minBlack: 0.02 }),
})

/** 只按贴图本身判 missingTexture 与「像占位图」，不涉及 locator。 */
export function classifyBlob(stats) {
  const c = CRITERIA.missingTexture
  const missingTexture =
    stats.width === c.width &&
    stats.height === c.height &&
    stats.uniqueColors <= c.maxColors &&
    stats.magentaRatio > c.minMagenta &&
    stats.blackRatio > c.minBlack

  const stripShape = stats.height === CRITERIA.ic2FaceStrip.height && stats.width > CRITERIA.ic2FaceStrip.height

  const p = CRITERIA.placeholderLike
  const placeholderLike =
    !missingTexture &&
    stats.width <= p.maxSide &&
    stats.height <= p.maxSide &&
    stats.uniqueColors <= p.maxColors &&
    stats.magentaRatio > p.minMagenta &&
    stats.blackRatio > p.minBlack

  return { missingTexture, stripShape, placeholderLike }
}

/**
 * 材质级判定：missingTexture 看贴图；ic2FaceStrip 看贴图形状 + locator 是否 IC2 系。
 * @returns {{verdict:'ok'|'missing-texture'|'ic2-face-strip'|'unclassified'|'error', reason:string|null}}
 */
export function judgeMaterial(stats, locator, decodeError) {
  if (decodeError) return { verdict: 'error', reason: decodeError }
  const shape = classifyBlob(stats)
  if (shape.missingTexture) return { verdict: 'missing-texture', reason: null }
  if (shape.stripShape) {
    const isIcc = CRITERIA.ic2FaceStrip.locator.test(String(locator || ''))
    const widthOk = CRITERIA.ic2FaceStrip.widths.includes(stats.width)
    if (isIcc && widthOk) return { verdict: 'ic2-face-strip', reason: null }
    if (!isIcc) return { verdict: 'unclassified', reason: '横向带形状但 locator 非 IC2 系' }
    return { verdict: 'unclassified', reason: 'IC2 系横向带但宽度不是 384/192（实测 ' + stats.width + 'x32）' }
  }
  if (shape.placeholderLike) {
    return { verdict: 'unclassified', reason: '像占位图但未达 missingTexture 门槛（' + stats.width + 'x' + stats.height + '，' + stats.uniqueColors + ' 色）' }
  }
  return { verdict: 'ok', reason: null }
}

/** base64 -> Buffer；容忍 data URI 前缀与空白。 */
export function decodeBlobBase64(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('textureBlob 不是非空字符串')
  const body = value.trim().replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
  return Buffer.from(body, 'base64')
}

function collectFrames(doc) {
  const frames = Array.isArray(doc.frames) ? doc.frames : []
  if (frames.length) {
    return frames.map((frame, i) => ({
      index: frame && Number.isInteger(frame.index) ? frame.index : i,
      label: frame && frame.label,
      structure: (frame && frame.structure) || {},
    }))
  }
  return [{ index: null, label: doc.meta && doc.meta.name, structure: doc }]
}

function collectBlockMaterials(block) {
  const quads = (block && block.geometry && block.geometry.quads) || []
  const set = new Set()
  for (const quad of quads) {
    if (quad && Number.isInteger(quad.materialIndex)) set.add(quad.materialIndex)
  }
  return [...set].sort((a, b) => a - b)
}

function countCells(grid) {
  const counts = new Map()
  if (!Array.isArray(grid)) return counts
  for (const layer of grid) {
    if (!Array.isArray(layer)) continue
    for (const row of layer) {
      if (!Array.isArray(row)) continue
      for (const cell of row) {
        if (!Number.isInteger(cell) || cell < 0) continue
        counts.set(cell, (counts.get(cell) || 0) + 1)
      }
    }
  }
  return counts
}

/**
 * 审计一个已解压的 Plain 文档（Envelope.payload 解出来的那个对象）。
 * 不读写文件、不发请求；输入输出都可直接 JSON 化。
 */
export function auditDocument(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('结构文档不是对象')

  const blobsRaw = Array.isArray(doc.textureBlobs) ? doc.textureBlobs : []
  const materials = Array.isArray(doc.materialPalette) ? doc.materialPalette : []
  const frames = collectFrames(doc)

  const blobs = blobsRaw.map((raw, index) => {
    try {
      const bytes = decodeBlobBase64(raw)
      const stats = pngStats(bytes)
      return { index, ok: true, stats }
    } catch (error) {
      return {
        index,
        ok: false,
        error: error instanceof PngError ? error.code + ': ' + error.message : String(error && error.message ? error.message : error),
      }
    }
  })

  // 方块 -> 材质索引，并按 cellGrid 统计每种方块被用了几格。
  const usageByMaterial = new Map()
  let blockCount = 0
  for (const frame of frames) {
    const structure = frame.structure || {}
    const palette = Array.isArray(structure.blockPalette) ? structure.blockPalette : []
    const cells = countCells(structure.cellGrid)
    blockCount += palette.length
    palette.forEach((block, paletteIndex) => {
      if (!block || !block.registryId) return
      const cellCount = cells.get(paletteIndex) || 0
      for (const materialIndex of collectBlockMaterials(block)) {
        const list = usageByMaterial.get(materialIndex) || []
        list.push({
          frameIndex: frame.index,
          paletteIndex,
          registryId: block.registryId,
          meta: block.meta,
          cells: cellCount,
        })
        usageByMaterial.set(materialIndex, list)
      }
    })
  }

  const materialRows = materials.map((material, index) => {
    const blobIndex = Number.isInteger(material && material.textureBlobIndex) ? material.textureBlobIndex : null
    const blob = blobIndex != null ? blobs[blobIndex] : null
    const judged = blob
      ? judgeMaterial(blob.stats, material.locator, blob.ok ? null : blob.error)
      : { verdict: 'ok', reason: '材质没有 textureBlobIndex（不参与贴图判型）' }
    const users = usageByMaterial.get(index) || []
    return {
      index,
      locator: material && material.locator,
      kind: material && material.kind,
      atlas: material && material.atlas,
      blobIndex,
      blobStats: blob && blob.ok ? compactStats(blob.stats) : null,
      verdict: judged.verdict,
      reason: judged.reason,
      usedByBlocks: users,
      usedInGrid: users.some((u) => u.cells > 0),
    }
  })

  // 一个 blob 可能被多个材质共用；按 blob 汇总，避免重复计数。
  const badBlobs = []
  for (const blob of blobs) {
    const mats = materialRows.filter((m) => m.blobIndex === blob.index)
    if (!mats.length) {
      // 没有任何材质引用的 blob：仍然判型（可能是导出器残留），但不影响结构命中。
      if (!blob.ok) {
        badBlobs.push({ index: blob.index, verdict: 'error', error: blob.error, locators: [], usedInGrid: false, blockUsers: [] })
      } else {
        const judged = judgeMaterial(blob.stats, '')
        if (judged.verdict !== 'ok') {
          badBlobs.push({ index: blob.index, stats: compactStats(blob.stats), verdict: judged.verdict, reason: judged.reason, locators: [], usedInGrid: false, blockUsers: [] })
        }
      }
      continue
    }
    const worst = worstVerdict(mats.map((m) => m.verdict))
    if (worst === 'ok') continue
    const users = []
    for (const m of mats) for (const u of m.usedByBlocks) users.push({ ...u, materialIndex: m.index, locator: m.locator })
    badBlobs.push({
      index: blob.index,
      stats: blob.ok ? compactStats(blob.stats) : null,
      error: blob.ok ? null : blob.error,
      verdict: worst,
      reason: mats.find((m) => m.verdict === worst)?.reason || null,
      locators: mats.map((m) => m.locator),
      usedInGrid: mats.some((m) => m.usedInGrid),
      blockUsers: users,
    })
  }

  const unclassified = badBlobs.filter((b) => b.verdict === 'unclassified')
  const hitsMissingTexture = badBlobs.filter((b) => b.verdict === 'missing-texture')
  const hitsFaceStrip = badBlobs.filter((b) => b.verdict === 'ic2-face-strip')
  const decodeErrors = badBlobs.filter((b) => b.verdict === 'error')

  let status = 'ok'
  if (hitsMissingTexture.some((b) => b.usedInGrid) || hitsFaceStrip.some((b) => b.usedInGrid)) status = 'bad'
  else if (badBlobs.length) status = 'warn'
  if (!blobs.length && !materials.length) status = 'no-textures'

  return {
    status,
    frameCount: Array.isArray(doc.frames) ? doc.frames.length : 0,
    blobCount: blobs.length,
    materialCount: materials.length,
    blockCount,
    hitsMissingTexture: hitsMissingTexture.length,
    hitsFaceStrip: hitsFaceStrip.length,
    unclassifiedCount: unclassified.length,
    decodeErrorCount: decodeErrors.length,
    badBlobs,
    unclassified,
    materials: materialRows.map((m) => ({
      index: m.index,
      locator: m.locator,
      kind: m.kind,
      blobIndex: m.blobIndex,
      verdict: m.verdict,
      usedInGrid: m.usedInGrid,
      blockCount: m.usedByBlocks.length,
    })),
  }
}

const SEVERITY = { ok: 0, unclassified: 1, error: 2, 'ic2-face-strip': 3, 'missing-texture': 4 }

function worstVerdict(list) {
  let worst = 'ok'
  for (const v of list) if ((SEVERITY[v] ?? 0) > (SEVERITY[worst] ?? 0)) worst = v
  return worst
}

function compactStats(stats) {
  return {
    width: stats.width,
    height: stats.height,
    uniqueColors: stats.uniqueColors,
    magentaRatio: round4(stats.magentaRatio),
    blackRatio: round4(stats.blackRatio),
    bytes: stats.bytes,
  }
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}
