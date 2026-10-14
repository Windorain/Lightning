/**
 * **D3c（#289 P10d）· `PresentationInputs` 生产者**。
 *
 * ## 本文件证什么
 *
 * 实测缺口：`PresentationInputs` **没有任何生产者** —— 唯一调用者是 e2e probe
 * （`e2e/helpers/presentation/probe.ts:50 pickFixture` 自造图元）。
 * 于是 `compileScene` / `BatchedPresenter` 虽然被真 WebGL 判据把守，却
 * **从未吃过内核场景**。
 *
 * 本文件钉住那个生产者，判据分三组：
 *
 * | 组 | 判据 |
 * |---|---|
 * | 形状 | 内核场景 → 纯数据（`key`/`geometry`/`primitives`），跳过显式报告 |
 * | **逐位一致** | 经本生产者产出的几何，与**渲染路径同一收集器**的产出逐位相同 |
 * | 可编译 | `compileScene` 真的吃它并产出批次（不是"数据造出来了但编译吃不下"） |
 *
 * ## 为什么"逐位一致"必须与**渲染路径**比（而不是与"某个期望值"比）
 *
 * 它与 D3a 修的那处缺陷直接相关：`structureGeometryAttributes` 曾经不剔除遮挡，
 * 与渲染路径差 3 倍三角形。若本判据改成"比一个硬编码的三角形数"，那次缺陷
 * **照样能通过**（只要把期望值改成错的那个数）。比渲染路径则不可能：
 * 两侧同源 ⇒ 任一侧偏离立刻判红。
 */

import { describe, expect, it } from 'vitest'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { kernelPresentationInputs } from '@/composition/kernelPresentationInputs'
import { compileScene } from '@/presentation/compileScene'
import { TIME_ZERO, type EvaluationKey } from '@/presentation/evaluationKey'
import { collectStructureGeometryPiecesPure, mergeBakedQuadPiecesAttributes } from '@/render/mesh/structureGeometryCore'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { plainRootOf } from '@/adapters/plainRoot'
import type { Scene } from '@/domain/scene'
import type { DocumentContent } from '@/domain/content'
import fs from 'node:fs'
import path from 'node:path'

/** 与宿主同序的生产解析器注册。 */
function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

/** 读一份夹具（多方块走 fixturePath；真实信封在 `e2e/fixtures/`）。 */
function loadRaw(name: string): Record<string, unknown> {
  if (name === 'envelope') {
    return JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json'), 'utf8').replace(/\r\n/g, '\n'),
    ) as Record<string, unknown>
  }
  return readJson(fixturePath(name)) as Record<string, unknown>
}

/** 装配一份夹具 → 内核场景 + 内容。 */
async function assembledOf(name: string): Promise<{ scene: Scene; content: DocumentContent }> {
  const raw = loadRaw(name)
  const parsed = await productionParsers().detectAndParse(raw)
  const r = assembleKernelDocument({ doc: parsed.document!, plainRoot: plainRootOf(raw) })
  if (!r.ok) throw new Error(`装配失败：${r.error.code}`)
  return { scene: r.value.scene, content: r.value.content }
}

function keyOf(sceneId: string): EvaluationKey {
  return { documentVersion: 1, scene: sceneId, time: TIME_ZERO, parameterVersion: 0, contentResourceVersions: {} }
}

/** 逐位比较两个 `Float32Array`。 */
function sameFloatBits(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const FIXTURES = ['multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap', 'envelope'] as const

describe('D3c · 形状：内核场景 → 纯数据', () => {
  for (const name of FIXTURES) {
    it(`${name}：产出 key/geometry/primitives，且**不是**空产出`, async () => {
      const { scene, content } = await assembledOf(name)
      const { inputs, skipped } = kernelPresentationInputs({ layerWorldY: null, scene, content, key: keyOf(scene.id) })
      expect(skipped, `${name} 不应有跳过项`).toEqual([])
      expect(inputs.primitives.length, `${name} 必须有可呈现对象`).toBeGreaterThan(0)
      expect(inputs.key.scene, 'key 必须如实透传').toBe(scene.id)
      // 反空洞真：几何端口必须真的能给属性（否则 compileScene 会静默跳过全部对象）
      const p = inputs.primitives[0]!
      expect(inputs.geometry.versionOf(p.geometry.id), '几何版本必须可查').toBeDefined()
      expect(inputs.geometry.attributesOf(p.geometry.id), '几何属性必须可取').toBeDefined()
    })
  }

  it('**几何身份与版本同源**（否则 `compileScene` 判 `geometry-version-mismatch` 并静默跳过全部）', async () => {
    const { scene, content } = await assembledOf('multiblock-ebf-2ch')
    const { inputs } = kernelPresentationInputs({ layerWorldY: null, scene, content, key: keyOf(scene.id) })
    for (const p of inputs.primitives) {
      expect(
        inputs.geometry.versionOf(p.geometry.id),
        '`primitive.geometry.version` 必须与 `geometry.versionOf(id)` 一致（两处不同源 ⇒ 全跳过）',
      ).toBe(p.geometry.version)
    }
  })

  it('非 `blockGrid` 载荷（相机）⇒ 跳过并**报出原因**（不静默）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    // 追加一个相机对象（由它自己的呈现路径负责）
    const camId = 'cam-data'
    const withCam: Scene = {
      ...scene,
      order: Object.freeze([...scene.order, 'cam']),
      objects: Object.freeze({ ...scene.objects, cam: { ...Object.values(scene.objects)[0]!, id: 'cam', dataId: camId } }),
      data: Object.freeze({
        ...scene.data,
        [camId]: { id: camId, source: 'document', payload: { kind: 'camera', projection: 'perspective', fov: 70, clipStart: 0.1, clipEnd: 100 }, contentVersion: 1, topologyVersion: 1 },
      }),
    }
    const { inputs, skipped } = kernelPresentationInputs({ layerWorldY: null, scene: withCam, content, key: keyOf(scene.id) })
    expect(inputs.primitives.length, '原 blockGrid 仍在').toBeGreaterThan(0)
    expect(skipped.length).toBe(1)
    expect(skipped[0]!.reason).toBe('not-blockGrid:camera')
  })

  it('空场景 ⇒ 空产出 + 空跳过（不伪造一个图元）', async () => {
    const { scene } = await assembledOf('multiblock-tier-only')
    const empty: Scene = { ...scene, order: Object.freeze([]), objects: Object.freeze({}), data: Object.freeze({}) }
    const r = kernelPresentationInputs({ layerWorldY: null, scene: empty, content: { metadata: { name: '', author: '', created_at_ms: null, description: '' }, frameAxis: { frames: [] }, resources: [] } as unknown as DocumentContent, key: keyOf('empty') })
    expect(r.inputs.primitives.length).toBe(0)
    expect(r.skipped.length).toBe(0)
  })
})

describe('D3c · **逐位一致**：与渲染路径同一收集器（逐材质组比，C6 起）', () => {
  for (const name of FIXTURES) {
    it(`${name}：每个材质图元的几何与渲染路径**逐位相同**，且各组并集不漏不重`, async () => {
      const { scene, content } = await assembledOf(name)
      const { inputs } = kernelPresentationInputs({ layerWorldY: null, scene, content, key: keyOf(scene.id) })
      const payload = Object.values(scene.data)
        .map((d) => d.payload)
        .find((x) => x.kind === 'blockGrid')
      expect(payload, '前提：夹具带 blockGrid 载荷').toBeDefined()
      const def = await definitionOf(payload as never, content)
      const all = collectStructureGeometryPiecesPure(def).pieces

      let compared = 0
      let trianglesInPrimitives = 0
      for (const p of inputs.primitives) {
        const actual = inputs.geometry.attributesOf(p.geometry.id)!
        // 材质 id 的约定是 `material:<下标>`（`kernelTextureResources`）—— 判据侧据此
        // 独立复算该组的参照，而**不是**再调一次生产的分组函数（那会变成同义反复）。
        expect(p.material.id.startsWith('material:'), `材质 id 必须符绑定约定，实得 ${p.material.id}`).toBe(true)
        const mi = Number(p.material.id.slice('material:'.length))
        const merged = mergeBakedQuadPiecesAttributes(all.filter((x) => x.materialIndex === mi))
        expect(merged.positions.length, `material:${mi} 在渲染路径里必须有四边形`).toBeGreaterThan(0)
        expect(actual.triangleCount, `${name} material:${mi} 三角形数必须与渲染路径相同`).toBe(
          merged.positions.length / 9,
        )
        expect(sameFloatBits(actual.positions, merged.positions), `material:${mi} positions 逐位相同`).toBe(true)
        expect(sameFloatBits(actual.uvs, merged.uvs), `material:${mi} uvs 逐位相同`).toBe(true)
        expect(sameFloatBits(actual.colors, merged.colors), `material:${mi} colors 逐位相同`).toBe(true)
        trianglesInPrimitives += actual.triangleCount
        compared += 1
      }
      expect(compared, '必须真的比较过（否则是空洞真）').toBeGreaterThan(0)
      // **并集判据**：分组不得漏掉任何四边形（漏 ⇒ 某些方块根本不画）。
      expect(trianglesInPrimitives, '各组三角形数之和必须等于渲染路径的全部').toBe(all.length * 2)
      expect(new Set(all.map((x) => x.materialIndex)).size, '夹具必须真的有多个材质（否则本组只覆盖单组路径）').toBe(
        new Set(inputs.primitives.map((p) => p.material.id)).size,
      )
    })
  }

  it('**负对照**：真实夹具的三角形数**不是**常数（证明上一条不是恒真）', async () => {
    const counts: number[] = []
    for (const name of FIXTURES) {
      const { scene, content } = await assembledOf(name)
      const { inputs } = kernelPresentationInputs({ layerWorldY: null, scene, content, key: keyOf(scene.id) })
      const p = inputs.primitives[0]
      if (p === undefined) continue
      counts.push(inputs.geometry.attributesOf(p.geometry.id)!.triangleCount)
    }
    expect(new Set(counts).size, '不同夹具必须给出不同三角形数（否则"一致"无意义）').toBeGreaterThan(1)
    expect(counts.every((c) => c > 0), '每份都必须有真实几何').toBe(true)
  })
})

describe('D3c · 可编译：`compileScene` 真的吃它', () => {
  for (const name of FIXTURES) {
    it(`${name}：编译成功且**零跳过**（数据造出来但编译吃不下会是这一条的失败）`, async () => {
      const { scene, content } = await assembledOf(name)
      const { inputs } = kernelPresentationInputs({ layerWorldY: null, scene, content, key: keyOf(scene.id) })
      const compiled = compileScene(inputs)
      expect(compiled.ok, `${name} 必须能编译`).toBe(true)
      if (!compiled.ok) throw new Error('unreachable')
      const c = compiled.value
      expect(c.payloads.length, '必须有批次').toBeGreaterThan(0)
      expect(c.skipped, `编译不得跳过任何对象（实测：${JSON.stringify(c.skipped)}）`).toEqual([])
      expect(c.drawCallEstimate, '绘制数估计 = 批次数').toBe(c.payloads.length)
      // 来源记录必须与图元一一对应（A18 的"对象身份与批次身份分离"）
      expect(c.provenance.length).toBe(inputs.primitives.length)
    })
  }

  it('**负对照**：把几何端口抽掉 ⇒ 编译**必须**跳过（证明上一条的"零跳过"不是恒真）', async () => {
    const { scene, content } = await assembledOf('multiblock-ebf-2ch')
    const { inputs } = kernelPresentationInputs({ layerWorldY: null, scene, content, key: keyOf(scene.id) })
    const broken = {
      ...inputs,
      geometry: { versionOf: () => undefined, attributesOf: () => undefined },
    }
    const compiled = compileScene(broken)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) throw new Error('unreachable')
    expect(compiled.value.skipped.length, '几何不可用 ⇒ 必须显式跳过，不得静默产出空批次').toBeGreaterThan(0)
    expect(compiled.value.payloads.length).toBe(0)
  })
})

/**
 * 从内核载荷重建网格定义（与 `kernelPresentationInputs` 内部同一路径；判据侧独立复算）。
 *
 * ⚠️ 声明尺寸三字段必须与生产 `definitionOfPayload` 同字段集（#262 P11-A）：
 * 漏传 ⇒ 本复算退回包围盒维度，而生产按声明维度 ⇒ 两侧在**稀疏**载荷上分叉，
 * 本文件的"逐位一致"判据就会拿错参照（本文件现有夹具都是"声明 == 包围盒"，
 * 故漏传不会当场红 —— 正是那种"以后才炸"的漂移）。
 */
async function definitionOf(
  payload: Extract<import('@/domain/scene').ObjectDataPayload, { kind: 'blockGrid' }>,
  content: DocumentContent,
): Promise<Parameters<typeof collectStructureGeometryPiecesPure>[0]> {
  const { projectGridCells } = await import('@/composition/kernelProjection')
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
    materialPalette: content.resources.map((r) => ({ kind: r.kind })),
  } as never
}
