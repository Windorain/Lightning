/**
 * `domain/blockGeometry` 的判据测试（#289 P10d）。
 *
 * ## 本文件证的是什么（三条，各自对应一个会被静默违反的约束）
 *
 * 1. **几何身份是内容派生的** —— 与调色板下标、`name:meta`、**位置**都无关。
 *    负对照：交换两个条目的下标 ⇒ 身份不变（若按下标派生，它会变）。
 * 2. **顶点身份不随枚举顺序漂移** —— 重排 `quads` 或调换角序 ⇒ 身份集合逐字相同。
 *    这是 §15 第 9 条「格坐标/批次序号兼任对象身份」在**几何资产**这一层的落点。
 * 3. **装配 → 编码往返零 diff** —— 解码再编码得到逐字节相同的几何。
 *    这是 #289「零 `decodeBakedGeometry` 回显依赖」的可判定含义。
 *
 * ## 为什么用真实夹具的几何形状（而不是合成小方块）
 *
 * 合成数据会让"顶点是 `0..16` 还是 `0..1`"这类真实格式事实消失。本文件用
 * **真实信封夹具**（`e2e/fixtures/structuredata-exported-envelope.json`）里
 * 实际出现过的四边形（含 33 个不同模型的重名条目）作为输入形状 —— 于是
 * "同名不同几何"这个**决定性的实测事实**在测试里是可复现的，而不是只在报告里。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  blockGeometryAsset,
  blockGeometryId,
  decodeBlockGeometry,
  encodeBlockGeometry,
  blockPaletteEntryKey,
  normalizePalette,
  paletteSharingStats,
  type BlockPaletteEntry,
  type Quad,
} from '@/domain/blockGeometry'

// ─────────────────────────────────────────────────────────────────────────────
// 真实夹具的读入（只读；不改仓库原件）
// ─────────────────────────────────────────────────────────────────────────────

interface FixtureInner {
  blockPalette: {
    registryId: string
    meta?: number
    renderMode?: string
    geometry?: { encoding: string; quads?: Quad[] }
    occludesAdjacentFaces?: boolean
    tooltip?: string[]
    facing?: string
    nbt?: Record<string, unknown>
  }[]
}

/** 读真实信封夹具的内层 body（base64/gzip 两形态都处理，与生产解析器同口径）。 */
function readEnvelopeInner(rel: string): FixtureInner {
  const p = path.join(process.cwd(), rel)
  // 读入口归一化行尾（铁律 6；`crlf-hygiene` 闸门要求）。
  // 本文件读的是夹具 JSON 而非源码，归一化不改 JSON 语义 ——
  // 但保持"每个读入口都显式声明行尾口径"这条纪律，闸门才有意义。
  const env = JSON.parse(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) as { payload: string }
  const buf = Buffer.from(env.payload, 'base64')
  const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8')
  return JSON.parse(text) as FixtureInner
}

const ENVELOPE = 'e2e/fixtures/structuredata-exported-envelope.json'

/** 一个最小的合法四边形（真实格式：`0..16` 局部坐标、UV `0..1`）。 */
function quad(materialIndex: number, color = 0xffffff): Quad {
  return {
    materialIndex,
    vertices: [
      { x: 0, y: 0, z: 0, u: 0, v: 0, brightness: 0.85, color },
      { x: 16, y: 0, z: 0, u: 1, v: 0, brightness: 0.85, color },
      { x: 16, y: 16, z: 0, u: 1, v: 1, brightness: 0.85, color },
      { x: 0, y: 16, z: 0, u: 0, v: 1, brightness: 0.85, color },
    ],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 几何身份是内容派生的
// ─────────────────────────────────────────────────────────────────────────────

describe('几何身份：内容派生（与下标 / name:meta / 位置无关）', () => {
  it('同一份几何内容 ⇒ 同一身份（可直接共享）', () => {
    const a = blockGeometryAsset([quad(0)])
    const b = blockGeometryAsset([quad(0)])
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.id).toBe(b!.id)
  })

  it('**内容不同 ⇒ 身份不同**（材质下标进身份）', () => {
    const a = blockGeometryAsset([quad(0)])
    const b = blockGeometryAsset([quad(1)])
    expect(a!.id).not.toBe(b!.id)
  })

  it('**内容不同 ⇒ 身份不同**（顶点色进身份）', () => {
    const a = blockGeometryAsset([quad(0, 0xffffff)])
    const b = blockGeometryAsset([quad(0, 0x000000)])
    expect(a!.id).not.toBe(b!.id)
  })

  it('**负对照**：同 `name:meta` 的两份不同几何，身份**不同**（实测定量的可复现形式）', () => {
    // 真实信封夹具里 `tile.BlockCableBus:0` 出现 33 次、`quads.length` 从 6 到 110 不等。
    // 若几何身份按 `name:meta` 派生，这 33 份会塌成 1 份 —— 渲染结果与切换前不一致。
    const small = blockGeometryAsset([quad(0)])
    const big = blockGeometryAsset([quad(0), quad(0), quad(0)])
    expect(small!.id).not.toBe(big!.id)
  })

  it('真实夹具：**重名条目确实带不同几何**（本条把这个事实钉在测试里）', () => {
    const inner = readEnvelopeInner(ENVELOPE)
    const cable = inner.blockPalette.filter(
      (e) => String(e.registryId).slice(String(e.registryId).indexOf(':') + 1) === 'tile.BlockCableBus',
    )
    expect(cable.length, '真实夹具里应有多个重名线缆条目').toBeGreaterThan(1)
    const lengths = new Set(cable.map((e) => e.geometry?.quads?.length ?? -1))
    expect(lengths.size, '重名条目的几何长度必须不止一种（否则"重名不同几何"不成立）').toBeGreaterThan(1)
    // 逐条算出身份：**内容不同 ⇒ 身份不同**。
    //
    // 注意断言的分寸（实测定量）：33 个线缆条目得到 **26** 个唯一身份 ——
    // 即 7 条与别的条目**内容完全相同**（同样的连接形状出现在多个位置）。
    // 故正确判据是「唯一数远大于 1 且不超过条目数」，而**不是**「两两不同」：
    // 后者会把"内容真的相同的条目共享同一几何"这一**正确行为**误判成缺陷。
    const ids = cable.map((e) => {
      const dec = decodeBlockGeometry(e.geometry ?? null)
      return dec === null ? null : blockGeometryAsset(dec.quads)?.id
    })
    expect(ids.every((x) => x !== null)).toBe(true)
    const unique = new Set(ids).size
    expect(unique, '33 个重名条目必须派生出远多于 1 个几何身份').toBeGreaterThan(20)
    expect(unique, '唯一数不得超过条目数（共享只减不增）').toBeLessThanOrEqual(cable.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 顶点身份不随枚举顺序漂移
// ─────────────────────────────────────────────────────────────────────────────

describe('顶点/面身份：与四边形枚举顺序、与角序无关', () => {
  it('**重排 quads ⇒ 顶点身份集合逐字相同**（身份不随枚举漂移）', () => {
    const q0 = quad(0)
    const q1: Quad = { ...quad(1), vertices: quad(1).vertices.map((v) => ({ ...v, x: v.x + 1 })) }
    const a = blockGeometryAsset([q0, q1])!
    const b = blockGeometryAsset([q1, q0])!
    const idsA = a.mesh.topology.vertices.map((v) => v.id).sort()
    const idsB = b.mesh.topology.vertices.map((v) => v.id).sort()
    expect(idsA).toEqual(idsB)
    // 面身份集合同样不变
    expect(a.mesh.topology.faces.map((f) => f.id).sort()).toEqual(b.mesh.topology.faces.map((f) => f.id).sort())
  })

  it('**几何身份含绘制顺序**（顺序是内容：半透明重叠时结果依赖它）', () => {
    // 文件契约逐字写明「`geometry.quads` 有序：绘制顺序与数组顺序一致」，且渲染侧
    // 按 `quadOrder` 排序批次（`render/mesh/blockMesh.ts:105-109`）。
    // ⇒ 同四边形集、不同顺序是**两种不同的几何**，身份必须能区分。
    const q0 = quad(0)
    const q1: Quad = { ...quad(1), vertices: quad(1).vertices.map((v) => ({ ...v, x: v.x + 1 })) }
    expect(blockGeometryId([q0, q1])).not.toBe(blockGeometryId([q1, q0]))
    // 且**同一**顺序两次调用必然相同（可复现）
    expect(blockGeometryId([q0, q1])).toBe(blockGeometryId([q0, q1]))
  })

  it('**顶点身份集合**不随顺序漂移（与上一条互补：身份稳定，几何内容有别）', () => {
    const q0 = quad(0)
    const q1: Quad = { ...quad(1), vertices: quad(1).vertices.map((v) => ({ ...v, x: v.x + 1 })) }
    const a = blockGeometryAsset([q0, q1])!
    const b = blockGeometryAsset([q1, q0])!
    expect(a.mesh.topology.vertices.map((v) => v.id).sort()).toEqual(b.mesh.topology.vertices.map((v) => v.id).sort())
  })

  it('**角序翻转 ⇒ 顶点身份不变**（身份是内容派生的，不是槽位的）', () => {
    const q = quad(0)
    const rotated: Quad = { materialIndex: q.materialIndex, vertices: [q.vertices[1]!, q.vertices[2]!, q.vertices[3]!, q.vertices[0]!] }
    const a = blockGeometryAsset([q])!
    const b = blockGeometryAsset([rotated])!
    expect(a.mesh.topology.vertices.map((v) => v.id).sort()).toEqual(b.mesh.topology.vertices.map((v) => v.id).sort())
  })

  it('**负对照**：内容真的变了 ⇒ 顶点身份集合**必须**变（判据不是恒真）', () => {
    const a = blockGeometryAsset([quad(0)])!
    const moved: Quad = { materialIndex: 0, vertices: quad(0).vertices.map((v) => ({ ...v, y: v.y + 1 })) }
    const b = blockGeometryAsset([moved])!
    expect(a.mesh.topology.vertices.map((v) => v.id).sort()).not.toEqual(b.mesh.topology.vertices.map((v) => v.id).sort())
  })

  it('相邻四边形共享的逻辑顶点被**真实去重**，且属性层长度 = 顶点数（`meshTopology` 的硬断言）', () => {
    // 两个四边形共用同一条棱（v(0,16,0)–v(16,16,0)）：去重后顶点数 < 8。
    const shared = quad(0)
    const q2: Quad = { materialIndex: 0, vertices: [shared.vertices[3]!, shared.vertices[2]!, { ...shared.vertices[2]!, z: 16 }, { ...shared.vertices[3]!, z: 16 }] }
    const asset = blockGeometryAsset([shared, q2])!
    const n = asset.mesh.topology.vertices.length
    expect(n, '两个共棱四边形应去重到 6 个顶点').toBe(6)
    for (const layer of asset.mesh.topology.attributes) {
      expect(layer.values.length, `属性层 ${layer.name} 长度必须 = 顶点数 × 分量数（否则 meshTopology 早该拒绝）`).toBe(
        n * layer.components,
      )
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 解码 / 编码往返零 diff
// ─────────────────────────────────────────────────────────────────────────────

describe('解码与编码：往返零 diff（"零回显依赖"的可判定含义）', () => {
  it('**真实夹具逐条往返零 diff**（全部 68 条目）', () => {
    const inner = readEnvelopeInner(ENVELOPE)
    let checked = 0
    let withGeometry = 0
    for (const entry of inner.blockPalette) {
      const dec = decodeBlockGeometry((entry.geometry ?? null) as never)
      checked += 1
      if (dec === null || dec.quads.length === 0) continue
      withGeometry += 1
      const asset = blockGeometryAsset(dec.quads)
      expect(asset, `${entry.registryId}:${entry.meta} 应产出资产`).not.toBeNull()
      const re = encodeBlockGeometry(asset!)
      // 逐字节比较（键序由构造顺序固定 —— 同一份资产两次编码必然同序）
      expect(JSON.stringify(re), `${entry.registryId}:${entry.meta} 往返必须零 diff`).toBe(
        JSON.stringify({ encoding: 'bakedQuadsJsonV1', quads: dec.quads }),
      )
    }
    expect(checked, '真实夹具应有 68 条目').toBe(68)
    expect(withGeometry, '真实夹具应有 67 条带几何（第 0 条为 air）').toBe(67)
  })

  it('**编码两次得到同一结果**（可复现，不是"碰巧一致"）', () => {
    const dec = decodeBlockGeometry({ encoding: 'bakedQuadsJsonV1', quads: [quad(0), quad(1)] })!
    const asset = blockGeometryAsset(dec.quads)!
    expect(JSON.stringify(encodeBlockGeometry(asset))).toBe(JSON.stringify(encodeBlockGeometry(asset)))
  })

  it('不支持编码 ⇒ `null`（**显式**，不静默当空几何）', () => {
    expect(decodeBlockGeometry({ encoding: 'packedQuadsV1', quads: [] })).toBeNull()
    expect(decodeBlockGeometry({ encoding: 'nope', quads: [] })).toBeNull()
    expect(decodeBlockGeometry(null)).toBeNull()
  })

  it('非法四边形**逐条跳过并记录**（不整条失败 —— 与既有渲染行为同口径）', () => {
    const bad = { materialIndex: 0, vertices: [quad(0).vertices[0]!] } as unknown as Quad
    const dec = decodeBlockGeometry({ encoding: 'bakedQuadsJsonV1', quads: [quad(0), bad, quad(1)] })!
    expect(dec.quads.length, '两条合法四边形应保留').toBe(2)
    expect(dec.skipped.length, '非法的一条应被记录').toBe(1)
    expect(dec.skipped[0]!.reason).toBe('degenerateQuad')
    expect(dec.skipped[0]!.quadIndex).toBe(1)
  })

  it('非有限顶点被跳过并记录（几何契约 §1：非有限值不参与几何）', () => {
    const q = quad(0)
    const nan = { materialIndex: 0, vertices: q.vertices.map((v, i) => (i === 2 ? { ...v, x: Number.NaN } : v)) }
    const dec = decodeBlockGeometry({ encoding: 'bakedQuadsJsonV1', quads: [nan] })!
    expect(dec.quads.length).toBe(0)
    expect(dec.skipped[0]!.reason).toBe('nonFiniteVertex')
  })

  it('**明暗层只在文件真的写了时承载**（"没写"与"写了 0"可区分）', () => {
    const withB = blockGeometryAsset([quad(0)])!
    expect(withB.mesh.topology.attributes.some((a) => a.name === 'quad.brightness')).toBe(true)
    const noB: Quad = { materialIndex: 0, vertices: quad(0).vertices.map(({ brightness: _b, ...rest }) => rest) }
    const without = blockGeometryAsset([noB])!
    expect(without.mesh.topology.attributes.some((a) => a.name === 'quad.brightness')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3b. 退化四边形（零长度棱）—— 实测缺陷：一条退化棱让**整份**资产变成 null
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 零面积四边形：角序与 UV 原样，但第 2 个角**逐位复制**第 1 个角。
 *
 * 形状取自实机（2026-10-20，LP 物流管 / PR #91 忠实捕获导出件）：每个管格的
 * `blockPalette` 条目 174/188 个四边形里有 **8 个**是这种 1/16 薄片的退化四边形 ——
 * LP 的 Tessellator 本来就这么发，游戏里它只是"什么也不画"。
 */
function sliverQuad(): Quad {
  const q = quad(0)
  return {
    materialIndex: 0,
    vertices: [q.vertices[0]!, q.vertices[1]!, { ...q.vertices[1]! }, q.vertices[3]!],
  }
}

describe('退化四边形（零长度棱）：不拒整份资产', () => {
  it('一条零长度棱**不得**让整份几何变成 `null`（实测：4 根 LP 管全格空渲染）', () => {
    const asset = blockGeometryAsset([sliverQuad()])
    expect(asset, '退化四边形是文件里的真实内容，不得让整份资产被拒').not.toBeNull()
    // 四边形**保真**：零面积四边形是"什么也不画"，不是"不存在" ——
    // 丢掉它会让"装配 → 编码"的逐字节往返不再无损（见本文件第 3 节）。
    expect(asset!.quads.length, '退化四边形必须原样保留（往返无损）').toBe(1)
    expect(asset!.mesh.topology.faces.length, '每个四边形对应一个面（`faces[k] === quads[k]` 不变量）').toBe(1)
  })

  it('零长度棱不进拓扑（3 条实棱），且没有自环棱', () => {
    const asset = blockGeometryAsset([sliverQuad()])!
    expect(asset.mesh.topology.edges.length, '三角形状的退化四边形只有 3 条实棱').toBe(3)
    for (const e of asset.mesh.topology.edges) expect(e.a, `棱 ${e.id} 不得自环`).not.toBe(e.b)
  })

  it('**负对照**：正常四边形仍有 4 条棱（上一条不是"永远 3 条"）', () => {
    const asset = blockGeometryAsset([quad(0)])!
    expect(asset.mesh.topology.edges.length).toBe(4)
  })

  it('退化与正常四边形混排 ⇒ 面都保留，棱按内容去重（4 + 3 − 公共棱）', () => {
    const asset = blockGeometryAsset([quad(0), sliverQuad()])!
    expect(asset.mesh.topology.faces.length, '两个四边形 ⇒ 两个面').toBe(2)
    expect(asset.mesh.topology.edges.length, '(v0,v1) 与 (v3,v0) 是公共棱 ⇒ 5 条').toBe(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 调色板（联合表 / 共享统计）
// ─────────────────────────────────────────────────────────────────────────────

function entry(registryId: string, meta: number, quads: readonly Quad[], extra: Partial<BlockPaletteEntry> = {}): BlockPaletteEntry {
  const dec = decodeBlockGeometry({ encoding: 'bakedQuadsJsonV1', quads: [...quads] })
  const asset = dec === null ? null : blockGeometryAsset(dec.quads)
  return Object.freeze({
    assetId: asset?.id ?? '',
    registryId,
    meta,
    renderMode: 'BakedModel',
    geometry: asset,
    ...extra,
  })
}

describe('调色板：按内容去重、跨条目共享几何', () => {
  it('同内容条目**合并**（共享几何，A07 的前提）', () => {
    const a = entry('minecraft:stone', 0, [quad(0)])
    const b = entry('minecraft:stone', 0, [quad(0)])
    expect(normalizePalette([a, b]).length).toBe(1)
  })

  it('**负对照**：同 `name:meta` 但几何不同 ⇒ **不合并**（去重键含 assetId）', () => {
    const a = entry('minecraft:stone', 0, [quad(0)])
    const b = entry('minecraft:stone', 0, [quad(0), quad(0)])
    const out = normalizePalette([a, b])
    expect(out.length, '几何不同必须保留两条（否则渲染结果回退）').toBe(2)
  })

  it('**负对照**：同几何但条目内容不同（`nbt` 位置特异）⇒ **不合并**', () => {
    // 本批实测（真实信封夹具）：4 组"几何相同但条目不同"的条目（idx 5/6/7/8 等），
    // 差异在**位置特异**的 `nbt`（真实导出把 x/y/z 写进 nbt）。
    // 第一版只按 `(registryId, meta, assetId)` 去重 ⇒ 68 塌成 61 ⇒ 渲染三角形
    // 4882 → 4862（渲染侧同调色板剔除按**条目**判，见 `blockPaletteEntryKey` 的注释）。
    const a = entry('minecraft:stone', 0, [quad(0)], { nbt: Object.freeze({ x: 1, y: 2, z: 3 }) })
    const b = entry('minecraft:stone', 0, [quad(0)], { nbt: Object.freeze({ x: 4, y: 5, z: 6 }) })
    expect(a.assetId, '前提：两条几何相同（assetId 相等）').toBe(b.assetId)
    expect(blockPaletteEntryKey(a), '内容键必须区分它们').not.toBe(blockPaletteEntryKey(b))
    expect(normalizePalette([a, b]).length, '条目内容不同必须保留两条').toBe(2)
  })

  it('`occludesAdjacentFaces` 进内容键（它改变邻面剔除，故是**内容**）', () => {
    const a = entry('minecraft:stone', 0, [quad(0)], { occludesAdjacentFaces: true })
    const b = entry('minecraft:stone', 0, [quad(0)], { occludesAdjacentFaces: false })
    expect(blockPaletteEntryKey(a)).not.toBe(blockPaletteEntryKey(b))
    expect(normalizePalette([a, b]).length).toBe(2)
  })

  it('`assetId` 相同 ⇒ 两条目指向**同一份**几何对象（真共享，不是深拷贝巧合）', () => {
    const a = entry('minecraft:stone', 0, [quad(0)])
    const b = entry('minecraft:other', 0, [quad(0)])
    expect(a.assetId).toBe(b.assetId)
    expect(a.geometry!.id).toBe(b.geometry!.id)
  })

  it('共享统计可对账（条目数 / 唯一几何 / 共享数 / 无几何数）', () => {
    const a = entry('minecraft:stone', 0, [quad(0)])
    const b = entry('minecraft:dirt', 0, [quad(0)])
    const c = entry('minecraft:glass', 0, [quad(1)])
    const noGeo: BlockPaletteEntry = Object.freeze({ assetId: '', registryId: 'minecraft:air', meta: 0, renderMode: 'BlockModel', geometry: null })
    const stats = paletteSharingStats([a, b, c, noGeo])
    expect(stats.entries).toBe(4)
    expect(stats.uniqueGeometry).toBe(2)
    expect(stats.shared).toBe(1)
    expect(stats.withoutGeometry).toBe(1)
  })

  it('排序稳定：同一份内容两种枚举顺序 ⇒ 同一张表（诊断/证据可比）', () => {
    const a = entry('minecraft:stone', 0, [quad(0)])
    const b = entry('minecraft:dirt', 0, [quad(1)])
    expect(normalizePalette([a, b]).map((e) => e.registryId)).toEqual(normalizePalette([b, a]).map((e) => e.registryId))
  })
})
