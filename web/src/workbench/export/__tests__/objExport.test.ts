/**
 * OBJ 导出链路动态分析。
 * 围绕 ZIP 文件损坏问题（文件头 PK\xFD\xFD 而非 PK\x03\x04），
 * 逐环节验证链路健康：OBJ/MTL 序列化 → 体素连通域标记 → 几何采集 → ZIP 组装。
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  serializeObjMeshes,
  serializeMtl,
  type ObjExportMesh,
  type MtlSerializedEntry,
} from '@/adapters/export/objExportSerialize'
import { labelVoxelComponents, AIR_COMPONENT } from '@/render/mesh/voxelComponents'
import { collectStructureGeometryPiecesPure } from '@/render/mesh/structureGeometryCore'
import type {
  StructureDefinition,
  BlockPaletteEntry,
  BakedQuad,
} from '@/render/schema/types'
import type { MaterialPaletteEntry } from '@/pure/materialTypes'

// ---------------------------------------------------------------------------
// Helper: decode a minimal 1×1 valid PNG from a well-known base64 string
// ---------------------------------------------------------------------------
const _PNG_B64_DECODE_TABLE =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodeBase64(s: string): Uint8Array {
  const bytes: number[] = []
  let v = 0
  let bits = 0
  for (const c of s) {
    if (c === '=') break
    const idx = _PNG_B64_DECODE_TABLE.indexOf(c)
    if (idx < 0) continue
    v = (v << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((v >> bits) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

/** Minimal 1×1 white PNG (base64). IHDR + IEND only, no IDAT — valid as per PNG spec end-of-image detection */
const MOCK_PNG_BYTES = decodeBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
)

// ---------------------------------------------------------------------------
// Shared palette entries used across multiple tests
// ---------------------------------------------------------------------------

const AIR_BLOCK: BlockPaletteEntry = {
  registryId: 'air',
  meta: 0,
  renderMode: 'BakedModel',
  geometry: { encoding: 'bakedQuadsJsonV1', quads: [] },
  occludesAdjacentFaces: false,
}

const STONE_BLOCK: BlockPaletteEntry = {
  registryId: 'minecraft:stone',
  meta: 0,
  renderMode: 'BakedModel',
  geometry: { encoding: 'bakedQuadsJsonV1', quads: [] },
  occludesAdjacentFaces: true,
}

const MATERIAL_PALETTE: MaterialPaletteEntry[] = [
  { kind: 'static16', textureBlobIndex: 0 },
]

// ===================================================================
// 1. OBJ / MTL 序列化
// ===================================================================
describe('OBJ/MTL serialization (objExportSerialize)', () => {
  it('serializeObjMeshes 产出 ASCII 文本且不含非打印字符', () => {
    const mesh: ObjExportMesh = {
      objectName: 'test_block',
      materialName: 'stone',
      positions: new Float32Array([
        // 1 triangle: ccw in XY plane
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]),
      uvs: new Float32Array([
        0, 0,
        1, 0,
        0, 1,
      ]),
    }

    const output = serializeObjMeshes({
      headerLines: ['Lightning OBJ test'],
      mtllibName: 'test.mtl',
      meshes: [mesh],
    })

    // Entire output is ASCII (code points 0–127)
    for (let i = 0; i < output.length; i++) {
      const cp = output.charCodeAt(i)
      expect(cp).toBeLessThan(128)
      // Allowable printable range: tab(9), lf(10), cr(13), 32–126
      if (cp !== 9 && cp !== 10 && cp !== 13) {
        expect(cp).toBeGreaterThanOrEqual(32)
        expect(cp).toBeLessThanOrEqual(126)
      }
    }

    // Structural checks
    expect(output).toContain('# Lightning OBJ test')
    expect(output).toContain('mtllib test.mtl')
    expect(output).toContain('o test_block')
    expect(output).toContain('usemtl stone')
    expect(output).toContain('v 0 0 0')
    expect(output).toContain('v 1 0 0')
    expect(output).toContain('v 0 1 0')
    // Normal should be (0,0,1) for CCW XY triangle
    expect(output).toContain('vn 0 0 1')
    expect(output).toContain('f 1/1/1 2/2/2 3/3/3')
  })

  it('serializeMtl 产出 ASCII 文本且格式正确', () => {
    const entries: MtlSerializedEntry[] = [
      {
        name: 'stone',
        kd: [0.6, 0.5, 0.4],
        ka: [0.2, 0.2, 0.2],
        ks: [0.1, 0.1, 0.1],
        d: 1.0,
        illum: 2,
        mapKd: 'stone.png',
      },
      {
        name: 'dirt',
        kd: [0.5, 0.3, 0.1],
        // leave optional fields undefined
      },
    ]

    const output = serializeMtl(entries)

    for (let i = 0; i < output.length; i++) {
      const cp = output.charCodeAt(i)
      expect(cp).toBeLessThan(128)
      if (cp !== 9 && cp !== 10 && cp !== 13) {
        expect(cp).toBeGreaterThanOrEqual(32)
        expect(cp).toBeLessThanOrEqual(126)
      }
    }

    expect(output).toContain('newmtl stone')
    expect(output).toContain('Kd 0.6 0.5 0.4')
    expect(output).toContain('Ka 0.2 0.2 0.2')
    expect(output).toContain('Ks 0.1 0.1 0.1')
    expect(output).toContain('d 1')
    expect(output).toContain('illum 2')
    expect(output).toContain('map_Kd stone.png')
    expect(output).toContain('newmtl dirt')
    expect(output).toContain('Kd 0.5 0.3 0.1')
  })

  it('serializeObjMeshes throws when uvs/tri count mismatch', () => {
    const bad: ObjExportMesh = {
      objectName: 'bad',
      materialName: 'm',
      positions: new Float32Array(9), // 1 tri
      uvs: new Float32Array(2),       // not enough for 1 tri (needs 6)
    }
    expect(() =>
      serializeObjMeshes({ meshes: [bad] }),
    ).toThrow('uvs 与 positions')
  })
})

// ===================================================================
// 2. 体素连通域标记
// ===================================================================
describe('labelVoxelComponents (voxelComponents)', () => {
  const TWO_BLOCK_PALETTE: BlockPaletteEntry[] = [AIR_BLOCK, STONE_BLOCK]

  it('3×3×3 网格中两层石头中间隔空气层 → 2 个连通域', () => {
    // cellGrid[z][row][col] — 3(z) × 3(row) × 3(col)
    const allOne = [1, 1, 1] as const
    const allZero = [0, 0, 0] as const
    const cellGrid: number[][][] = [
      // z = 0  (top): 全部 stone
      [[...allOne], [...allOne], [...allOne]],
      // z = 1  (middle): 全部 air
      [[...allZero], [...allZero], [...allZero]],
      // z = 2  (bottom): 全部 stone
      [[...allOne], [...allOne], [...allOne]],
    ]

    const def: StructureDefinition = {
      geometryPhase: 'baked',
      id: 'conn-test',
      cellGrid,
      blockPalette: TWO_BLOCK_PALETTE,
      materialPalette: MATERIAL_PALETTE,
    }

    const { labels, componentCount } = labelVoxelComponents(def)

    expect(componentCount).toBe(2)

    // Check that all air voxels (z=1) have AIR_COMPONENT
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const airIx = 1 * (3 * 3) + row * 3 + col
        expect(labels[airIx]).toBe(AIR_COMPONENT)
      }
    }

    // Top layer (z=0) and bottom layer (z=2) have different component IDs
    const topIx = 0 * (3 * 3) + 1 * 3 + 1 // center of top layer
    const botIx = 2 * (3 * 3) + 1 * 3 + 1 // center of bottom layer
    expect(labels[topIx]).not.toBe(AIR_COMPONENT)
    expect(labels[botIx]).not.toBe(AIR_COMPONENT)
    expect(labels[topIx]).not.toBe(labels[botIx])
  })

  it('单块石头 → 1 个连通域，空气为 AIR_COMPONENT', () => {
    const def: StructureDefinition = {
      geometryPhase: 'baked',
      id: 'single-block',
      cellGrid: [[[1]]], // 1×1×1, stone
      blockPalette: TWO_BLOCK_PALETTE,
      materialPalette: MATERIAL_PALETTE,
    }

    const { labels, componentCount } = labelVoxelComponents(def)
    expect(componentCount).toBe(1)
    expect(labels[0]).not.toBe(AIR_COMPONENT)
  })

  it('全空白网格 → 0 个非空连通域，所有标签为 AIR_COMPONENT', () => {
    const def: StructureDefinition = {
      geometryPhase: 'baked',
      id: 'all-air',
      cellGrid: [[[0]]], // 1×1×1, air
      blockPalette: TWO_BLOCK_PALETTE,
      materialPalette: MATERIAL_PALETTE,
    }

    const { labels, componentCount } = labelVoxelComponents(def)
    expect(componentCount).toBe(0)
    expect(labels[0]).toBe(AIR_COMPONENT)
  })
})

// ===================================================================
// 3. 几何采集
// ===================================================================
describe('collectStructureGeometryPiecesPure (structureGeometryCore)', () => {
  /** A single quad on the +x face of a unit cube */
  const POS_X_QUAD: BakedQuad = {
    materialIndex: 0,
    vertices: [
      { x: 1, y: 1, z: 0, u: 0, v: 0 },
      { x: 1, y: 1, z: 1, u: 1, v: 0 },
      { x: 1, y: 0, z: 0, u: 0, v: 1 },
      { x: 1, y: 0, z: 1, u: 1, v: 1 },
    ],
  }

  const BLOCK_WITH_QUAD: BlockPaletteEntry = {
    registryId: 'minecraft:stone',
    meta: 0,
    renderMode: 'BakedModel',
    geometry: {
      encoding: 'bakedQuadsJsonV1',
      quads: [POS_X_QUAD],
    },
    occludesAdjacentFaces: true,
  }

  const PALETTE: BlockPaletteEntry[] = [AIR_BLOCK, BLOCK_WITH_QUAD]

  function singleBlockDef(): StructureDefinition {
    return {
      geometryPhase: 'baked',
      id: 'geo-test',
      cellGrid: [[[1]]], // 1×1×1, stone with quad
      blockPalette: PALETTE,
      materialPalette: MATERIAL_PALETTE,
    }
  }

  it('默认模式（遮挡剔除启用）— 单块 1 quad → 产出 1 piece', () => {
    const result = collectStructureGeometryPiecesPure(singleBlockDef())
    expect(result.pieces).toHaveLength(1)
    expect(result.stats.nonAirVoxelCount).toBe(1)
    expect(result.stats.skippedUnmappedCount).toBe(0)

    const p = result.pieces[0]!
    expect(p.materialIndex).toBe(0)
    // 1 quad → 2 triangles = 18 positions, 12 uvs, 18 colors
    expect(p.positions.length).toBe(18)
    expect(p.uvs.length).toBe(12)
    expect(p.colors.length).toBe(18)
  })

  it('cullOccludedQuads=false — 禁掉剔除后仍产出完全相同数量的 piece（单块无邻居时不受影响）', () => {
    const result = collectStructureGeometryPiecesPure(singleBlockDef(), {
      cullOccludedQuads: false,
    })
    // Single block has no neighbor, culling makes no difference
    expect(result.pieces).toHaveLength(1)
    expect(result.stats.nonAirVoxelCount).toBe(1)
  })

  it('componentGather — 用有效/无效 componentId 验证过滤', () => {
    const def = singleBlockDef()

    // Pre-label: single block → component 0
    const { labels } = labelVoxelComponents(def)

    // Gather component 0 → should get the piece
    const result0 = collectStructureGeometryPiecesPure(def, {
      componentGather: { labels, componentId: 0 },
    })
    expect(result0.pieces).toHaveLength(1)

    // Gather component 1 (does not exist) → 0 pieces
    const result1 = collectStructureGeometryPiecesPure(def, {
      componentGather: { labels, componentId: 1 },
    })
    expect(result1.pieces).toHaveLength(0)
    expect(result1.stats.nonAirVoxelCount).toBe(0)
  })
})

// ===================================================================
// 4. ZIP 组装（关键：验证文件头 504b0304）
// ===================================================================
describe('ZIP assembly (JSZip) — corruption root cause analysis', () => {
  const OBJ_CONTENT = '# mock obj\no mock\nv 0 0 0\n'
  const MTL_CONTENT = '# mock mtl\nnewmtl mock\nKd 1 1 1\n'
  // JSZip in vitest Node environment: pass Uint8Array (not Blob) for binary data
  const PNG_DATA = MOCK_PNG_BYTES.slice()

  /** Read first 4 bytes of a Uint8Array as hex string */
  function readZipSig(data: Uint8Array): string {
    const view = new Uint8Array(data.buffer, data.byteOffset, 4)
    return Array.from(view)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  it('基本 ZIP 文件头为 504b0304', async () => {
    const zip = new JSZip()
    zip.file('test.obj', OBJ_CONTENT)
    zip.file('test.mtl', MTL_CONTENT)
    zip.file('tex_0.png', PNG_DATA)

    const data = await zip.generateAsync({ type: 'uint8array' })
    expect(readZipSig(data)).toBe('504b0304')
  })

  it('JSZip.loadAsync 可重新读取生成的 ZIP', async () => {
    const zip = new JSZip()
    zip.file('test.obj', OBJ_CONTENT)
    zip.file('tex_0.png', PNG_DATA)

    const data = await zip.generateAsync({ type: 'uint8array' })
    const reloaded = await JSZip.loadAsync(data)

    expect(Object.keys(reloaded.files)).toEqual(
      expect.arrayContaining(['test.obj', 'tex_0.png']),
    )

    const objContent = await reloaded.file('test.obj')!.async('string')
    expect(objContent).toBe(OBJ_CONTENT)

    const pngContent = await reloaded.file('tex_0.png')!.async('uint8array')
    expect(pngContent.length).toBe(MOCK_PNG_BYTES.length)
  })

  it('多文件（20+ PNG）ZIP 仍有效', async () => {
    const zip = new JSZip()
    const COUNT = 25 // >20
    for (let i = 0; i < COUNT; i++) {
      zip.file(`tex_${i}.png`, PNG_DATA)
    }
    // Also add a manifest
    zip.file('manifest.json', JSON.stringify({ count: COUNT }))

    const data = await zip.generateAsync({ type: 'uint8array' })
    expect(readZipSig(data)).toBe('504b0304')

    const reloaded = await JSZip.loadAsync(data)
    const files = Object.keys(reloaded.files).filter(
      (k) => !reloaded.files[k]!.dir,
    )
    expect(files).toHaveLength(COUNT + 1) // 25 png + 1 json
  })

  it('STORE 模式（无压缩）ZIP 仍有效', async () => {
    const zip = new JSZip()
    zip.file('test.obj', OBJ_CONTENT, { compression: 'STORE' })
    zip.file('tex_0.png', PNG_DATA, { compression: 'STORE' })
    zip.file('tex_1.png', PNG_DATA, { compression: 'STORE' })

    const data = await zip.generateAsync({
      type: 'uint8array',
      compression: 'STORE',
    })
    expect(readZipSig(data)).toBe('504b0304')

    const reloaded = await JSZip.loadAsync(data)
    const objText = await reloaded.file('test.obj')!.async('string')
    expect(objText).toBe(OBJ_CONTENT)
  })
})
