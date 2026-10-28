/**
 * **捕获占位条目的呈现通道**（半透明幽灵）—— 生产装配 + 呈现编译两段判据。
 *
 * ## 判据要回答的问题
 *
 * 导出件里的 `renderMode: "CapturePlaceholder"` 条目在视口里必须被画成
 * **半透明替身**（不透明度 < 1、不写深度、alpha 裁切关闭），而不是一块实心方块；
 * 同时它的**原色**（材质 tint / 顶点色 / 贴图）不得被改。
 *
 * ## 为什么第一段必须走生产装配
 *
 * "占位条目会不会被认出来"取决于**装配后的调色板条目**是否还带着 `renderMode`
 * 与几何；手写一份"已经带字段"的条目会恒绿（真实缺口可能发生在装配把未知模式归一）。
 * 故输入是**仓外**的真实游戏内导出件（CTM 档，含一格末影储罐占位）：
 * `<LIGHTNING_REAL_FIXTURES_DIR>/tesr/tesr-capture-placeholder.ctm.json`，经生产解析器 + 内核装配 + 投影。
 * 夹具缺失时①②③显式跳过（其余 2 条语义判据照跑），不整文件 exclude。
 *
 * ## 覆盖
 *
 * | # | 断言 |
 * |---|---|
 * | ① | 装配后的占位条目仍在（6 四边形、`renderMode` 未被归一） |
 * | ② | 材质分组把占位**单独分组**：该组带 `opacity`，其余组不带 |
 * | ③ | 邻面剔除：两个相邻占位格各 6 面全保留；同状态真几何仍按同块剔除（负对照） |
 * | ④ | 材质状态：`transparent` + `opacity` + `depthWrite:false` + `alphaTest:0`，颜色仍为白（不染色） |
 * | ⑤ | 材质身份把 `opacity` 算进去（占位与真几何不共享缓存材质） |
 *
 * ① ② ③ 读真实件（受门控）；④ ⑤ 是纯语义判据，始终运行。
 */
/// <reference path="../../../e2e/real-fixtures.d.ts" />
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { realFixtureAvailable, realFixturePath } from '../../../e2e/real-fixtures.mjs'
import * as THREE from 'three'
import { plainRootOf } from '@/adapters/plainRoot'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { projectGridCells } from '@/composition/kernelProjection'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { materialIndexFromId } from '@/composition/kernelTextureResources'
import { CAPTURE_PLACEHOLDER_OPACITY } from '@/domain/capturePlaceholder'
import { DEFAULT_BATCH_BUDGET } from '@/presentation/batchPlan'
import { compileScene } from '@/presentation/compileScene'
import { BatchedPresenter, materialIdentityOf } from '@/presentation/presenter'
import type { MaterialDescriptor } from '@/presentation/evaluationKey'
import { structureMaterialGroups, structureMaterialPrimitives } from '@/runtime/presentationAdapter'
import { collectStructureGeometryPiecesPure } from '@/render/mesh/structureGeometryCore'
import type { BlockPaletteEntry, StructureDefinition } from '@/render/schema/types'
import {
  MemoryGeometrySource,
  makeAttributes,
  makeKey,
  makePrimitive,
} from '@/presentation/__tests__/fixtures'

const TESR_FIXTURE_KEY = 'tesrCaptureCtm'

/**
 * 依赖真实件的判据门控：夹具可用 ⇒ 正常注册；缺失 ⇒ **显式 skip**（不是整文件 exclude）。
 * 返回 void，避免把 `it` / `it.skip` 的联合塞进条件表达式后丢失调用签名。
 */
function withTesrCtmFixture(name: string, fn: () => Promise<void> | void): void {
  if (realFixtureAvailable(TESR_FIXTURE_KEY)) it(name, fn)
  else it.skip(name, fn)
}

function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** 真实信封 → 内核装配 → 投影（与生产呈现输入同一重建口径）。 */
async function productionDefinition(): Promise<StructureDefinition> {
  const raw = JSON.parse(
    // 铁律：读入口先归一化行尾（外部件经 Windows 复制后仍可能是 CRLF；内核口径统一 LF）。
    fs.readFileSync(realFixturePath(TESR_FIXTURE_KEY), 'utf8').replace(/\r\n/g, '\n'),
  ) as Record<string, unknown>
  const parsed = await productionParsers().detectAndParse(raw)
  expect(parsed.document, '真实信封必须能被生产解析器解析').not.toBeNull()
  const assembled = assembleKernelDocument({ doc: parsed.document!, plainRoot: plainRootOf(raw) })
  if (!assembled.ok) throw new Error(`装配失败：${assembled.error.code}`)
  const payload = Object.values(assembled.value.scene.data)
    .map((d) => d.payload)
    .find((p) => p.kind === 'blockGrid')
  if (payload === undefined || payload.kind !== 'blockGrid') throw new Error('无 blockGrid 载荷')
  const projected = projectGridCells({
    cells: payload.cells,
    sizeColumn: payload.sizeColumn,
    sizeRow: payload.sizeRow,
    sizeZSlice: payload.sizeZSlice,
    geometry: payload.geometry,
    cellGeometry: payload.cellGeometry,
    cellPalette: payload.cellPalette,
    palette: payload.palette,
    cellContent: payload.cellContent,
  })
  return {
    geometryPhase: 'baked',
    cellGrid: projected.cellGrid,
    blockPalette: projected.blockPalette,
    // 几何收集逐四边形读 `materialPalette[q.materialIndex]`。
    materialPalette: assembled.value.content.resources.map((res) => ({ kind: res.kind, blend: res.blend })),
  } as unknown as StructureDefinition
}

function placeholderEntryOf(definition: StructureDefinition): BlockPaletteEntry {
  const entry = definition.blockPalette.find(
    (e) => (e.renderMode as string) === 'CapturePlaceholder',
  )
  if (entry === undefined) throw new Error('真实导出件里没有占位条目 —— 判据无法建立')
  return entry
}

/**
 * 用真实占位条目复制成两格并排的合成定义。
 *
 * 两格**同一个条目**（只改 `renderMode` 做负对照）：判据比的是"同状态邻面剔除"
 * 在占位模式下必须让位，故两格身份必须相同，否则剔除本来就不会发生。
 */
function pairDefinition(definition: StructureDefinition, mode: string): StructureDefinition {
  const ghost = placeholderEntryOf(definition)
  const entry = Object.freeze({ ...ghost, renderMode: mode }) as unknown as BlockPaletteEntry
  const air = Object.freeze({
    assetId: '',
    registryId: 'air',
    meta: 0,
    renderMode: 'BakedModel',
    geometry: null,
  }) as unknown as BlockPaletteEntry
  return {
    geometryPhase: 'baked',
    cellGrid: [[[1, 1]]],
    blockPalette: [air, entry],
    materialPalette: [{ kind: 'static16', blend: 'cutout' }],
  } as unknown as StructureDefinition
}

const GHOST_MATERIAL: MaterialDescriptor = {
  id: 'material:3',
  version: 'v1',
  blend: 'cutout',
  tint: 0xffffff,
  useVertexColor: true,
  opacity: CAPTURE_PLACEHOLDER_OPACITY,
}

function onlyMaterial(root: THREE.Object3D): THREE.MeshBasicMaterial {
  const found = new Set<THREE.Material>()
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material
    if (mat === undefined) return
    if (Array.isArray(mat)) for (const m of mat) found.add(m)
    else found.add(mat)
  })
  expect(found.size, '夹具只有一个材质（否则断言对象不确定）').toBe(1)
  return [...found][0] as THREE.MeshBasicMaterial
}

describe('捕获占位条目的呈现通道（真实装配 + 呈现编译）', () => {
  withTesrCtmFixture('① 生产装配后占位条目仍在，且 6 个四边形原样保留', async () => {
    const definition = await productionDefinition()
    const ghost = placeholderEntryOf(definition)
    expect(ghost.registryId).toBe('EnderStorage:enderChest')
    expect(ghost.meta).toBe(1)
    const quads = (ghost.geometry as { quads?: unknown[] } | null)?.quads ?? []
    expect(quads.length, '占位几何必须仍是 6 个四边形').toBe(6)
  })

  withTesrCtmFixture('② 占位单独成组并带 opacity；其余材质组不带', async () => {
    const definition = await productionDefinition()
    const groups = structureMaterialGroups({ definition, layerPreview: 'all' })
    const ghostGroups = groups.filter((g) => g.opacity !== undefined)
    expect(ghostGroups.length, '占位组必须恰好一个').toBe(1)
    const ghost = ghostGroups[0]!
    expect(ghost.opacity).toBe(CAPTURE_PLACEHOLDER_OPACITY)
    expect(ghost.materialIndex, '占位条目指向图集图标（黑曜石）材质下标').toBe(3)
    expect(ghost.attributes.triangleCount, '6 个四边形 = 12 个三角形').toBe(12)
    expect(ghost.materialId, '纹理绑定键仍遵循 material:<下标> 约定').toBe('material:3')
    expect(materialIndexFromId(ghost.materialId), '绑定键必须能解回资源下标').toBe(3)
    for (const g of groups) {
      if (g === ghost) continue
      expect(g.opacity, '真几何组不得被占位策略染成半透明').toBeUndefined()
    }
    const prims = structureMaterialPrimitives({ definition, layerPreview: 'all', materialTint: 0xffffff })
    const ghostPrim = prims.find((p) => p.primitive.material.opacity !== undefined)
    expect(ghostPrim, '占位图元必须把 opacity 带到材质描述符').toBeDefined()
    expect(ghostPrim!.primitive.material.opacity).toBe(CAPTURE_PLACEHOLDER_OPACITY)
    expect(ghostPrim!.primitive.transparency, '占位图元的透明顺序键不得为 null').not.toBeNull()
    for (const p of prims) {
      if (p === ghostPrim) continue
      expect(p.primitive.material.opacity).toBeUndefined()
      expect(p.primitive.transparency, '真几何图元仍是不透明组').toBeNull()
    }
  })

  withTesrCtmFixture('③ 邻面剔除：相邻两个占位格各 6 面全保留；同状态真几何仍剔除共享面（负对照）', async () => {
    const definition = await productionDefinition()
    const ghostPair = collectStructureGeometryPiecesPure(pairDefinition(definition, 'CapturePlaceholder')).pieces
    expect(ghostPair.length, '两个相邻占位格必须是 6+6 面（共享面不得被同块剔除）').toBe(12)
    const solidPair = collectStructureGeometryPiecesPure(pairDefinition(definition, 'BakedModel')).pieces
    expect(solidPair.length, '负对照：同状态真几何相邻时共享面被剔除（6+6-2=10）').toBe(10)
  })

  it('④ 材质状态：transparent/opacity/depthWrite:false/alphaTest:0，颜色保持白', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(2))
    const compiled = compileScene(
      { key: makeKey(), geometry, primitives: [makePrimitive('obj:ghost', { material: GHOST_MATERIAL })] },
      DEFAULT_BATCH_BUDGET,
    )
    if (!compiled.ok) throw new Error('夹具编译失败')
    const presenter = new BatchedPresenter({ scope: 'test:capture-placeholder' })
    try {
      presenter.apply(compiled.value)
      const material = onlyMaterial(presenter.object3d)
      expect(material.transparent).toBe(true)
      expect(material.opacity).toBeCloseTo(CAPTURE_PLACEHOLDER_OPACITY, 6)
      expect(material.depthWrite, '不写深度：替身不得遮挡身后的几何').toBe(false)
      expect(material.alphaTest, 'alphaTest 必须关，否则半透明整块被裁掉').toBe(0)
      expect(material.color.getHex(), '颜色不得被染（只降不透明度）').toBe(0xffffff)
      expect(material.vertexColors, '顶点色路径不变').toBe(true)
    } finally {
      presenter.dispose()
    }
  })

  it('⑤ 材质身份区分"占位"与"同材质的真几何"', () => {
    const solid: MaterialDescriptor = {
      id: GHOST_MATERIAL.id,
      version: GHOST_MATERIAL.version,
      blend: GHOST_MATERIAL.blend,
      tint: GHOST_MATERIAL.tint,
      useVertexColor: GHOST_MATERIAL.useVertexColor,
    }
    expect(materialIdentityOf(GHOST_MATERIAL).id).not.toBe(materialIdentityOf(solid).id)
    const nearOne: MaterialDescriptor = { ...GHOST_MATERIAL, opacity: 1 }
    expect(materialIdentityOf(nearOne).id, '不透明度 1 与缺席同义').toBe(materialIdentityOf(solid).id)
  })
})
