/**
 * **D3a（#289 P10d）· 几何收集只有一条判据**。
 *
 * ## 本文件证什么
 *
 * 本批实测抓出一处**真实不一致**：`runtime/presentationAdapter#structureGeometryAttributes`
 * 手写了一遍遍历（逐格逐四边形全收，**不**剔除遮挡），而其注释声称与渲染路径
 * "几何数值一致" —— 实际上它**恰好等于"不剔除"**（`cullOccludedQuads: false`）。
 *
 * | 夹具 | 渲染路径（剔除） | 修复前 |
 * |---|---|---|
 * | multiblock-tier-only | 12 | 12 |
 * | multiblock-ebf-2ch（tier1） | 12 | **36** |
 * | multiblock-ebf-2ch（默认） | 24 | **72** |
 * | multiblock-lsc-overlap | 40 | **104** |
 *
 * ## 为什么这条判据必须存在（旧判据为何漏掉）
 *
 * `structureGeometryAttributes` 在本批之前**零调用者**（生产与测试都没有；
 * `renderCutoverParity` 的几何指纹一律走 `collectStructureGeometryPiecesPure`）。
 * 于是"注释声称一致"没有任何判据把守 —— 这正是 #251「未实现的断言不得冒充通过」
 * 的同族：**声称**不是**判据**。
 *
 * ## 判据的形状：**逐位相同**，而不是"三角形数相同"
 *
 * 只比三角形数会漏掉"数目对但顺序/坐标错"的实现（本仓有过同族教训：
 * 集合比较不够强，必须比键→值映射）。故这里比 `positions`/`uvs`/`colors`
 * 三个 `Float32Array` 的**逐元素相等**。
 */

import { describe, expect, it } from 'vitest'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { projectGridCells } from '@/composition/kernelProjection'
import { structureMaterialPrimitives } from '@/runtime/presentationAdapter'
import { collectStructureGeometryPiecesPure, mergeBakedQuadPiecesAttributes } from '@/render/mesh/structureGeometryCore'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { plainRootOf } from '@/adapters/plainRoot'
import type { StructureDefinition } from '@/render/schema/types'

function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

const FIXTURES = ['multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap'] as const

/** 装配 → 旧格式网格（呈现编译的输入形状）。 */
async function definitionOf(
  name: string,
  selection?: { totalTier: number; values: Record<string, number>; runstate: string },
): Promise<StructureDefinition> {
  const raw = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await productionParsers().detectAndParse(raw)
  const r = assembleKernelDocument({
    doc: parsed.document!,
    plainRoot: plainRootOf(raw),
    ...(selection === undefined ? {} : { multiblockSelection: selection }),
  })
  if (!r.ok) throw new Error(`装配失败：${r.error.code}`)
  const payload = Object.values(r.value.scene.data)
    .map((d) => d.payload)
    .find((p) => p.kind === 'blockGrid')
  if (payload === undefined || payload.kind !== 'blockGrid') throw new Error('无 blockGrid 载荷')
  const projected = projectGridCells({
    cells: payload.cells,
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
    // 几何收集逐四边形读 `materialPalette[q.materialIndex]` —— 缺它当场抛。
    materialPalette: r.value.content.resources.map((res) => ({ kind: res.kind })) as never,
  } as unknown as StructureDefinition
}

/** 逐位比较两个 `Float32Array`（集合比较不够强 —— 见文件头）。 */
function sameFloatBits(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('D3a · 适配层的几何必须与渲染路径**逐位**一致（C6 起按材质组比）', () => {
  for (const name of FIXTURES) {
    for (const selection of [undefined, { totalTier: 1, values: {}, runstate: '' }]) {
      const label = selection === undefined ? '默认取值' : 'Tier 1'
      it(`${name}（${label}）：每组三个属性数组逐元素相同，且并集不漏不重`, async () => {
        const definition = await definitionOf(name, selection)
        // C6 起生产的适配层入口是**逐材质**的：比"整座结构合并值"会恒红，
        // 故逐组与渲染路径同 `materialIndex` 的那一段比（过滤保序）。
        const groups = structureMaterialPrimitives({ definition, layerPreview: 'all', materialTint: 0xffffff })
        const all = collectStructureGeometryPiecesPure(definition).pieces
        let triangles = 0
        for (const g of groups) {
          const mi = Number(g.primitive.material.id.slice('material:'.length))
          const merged = mergeBakedQuadPiecesAttributes(all.filter((x) => x.materialIndex === mi))
          expect(g.attributes.triangleCount, `material:${mi} 三角形数必须相同`).toBe(merged.positions.length / 9)
          expect(sameFloatBits(g.attributes.positions, merged.positions), `material:${mi} positions 必须逐位相同`).toBe(true)
          expect(sameFloatBits(g.attributes.uvs, merged.uvs), `material:${mi} uvs 必须逐位相同`).toBe(true)
          expect(sameFloatBits(g.attributes.colors, merged.colors), `material:${mi} colors 必须逐位相同`).toBe(true)
          triangles += g.attributes.triangleCount
        }
        // 反空洞真：必须有真实几何（否则"逐位相同"是 0 === 0），且并集正好覆盖渲染路径全部
        expect(triangles, `${name} 必须有真实三角形`).toBeGreaterThan(0)
        expect(triangles, '各组三角形数之和 = 渲染路径全部').toBe(all.length * 2)
      })
    }
  }

  it('**负对照**：不剔除遮挡 ⇒ 三角形数**必然**更多（证明上面的一致性不是恒真）', async () => {
    // 这条同时是"剔除确实生效"的证明：若两个口径给出相同的数，
    // 那么"与渲染路径一致"这个断言就退化成了"与任何一个口径都一致"。
    let sawDifference = false
    for (const name of FIXTURES) {
      const definition = await definitionOf(name, { totalTier: 1, values: {}, runstate: '' })
      const culled = collectStructureGeometryPiecesPure(definition).pieces.reduce((n, p) => n + p.positions.length / 9, 0)
      const uncalled = collectStructureGeometryPiecesPure(definition, { cullOccludedQuads: false }).pieces.reduce(
        (n, p) => n + p.positions.length / 9,
        0,
      )
      expect(uncalled, `${name}：不剔除的三角形数不得少于剔除的`).toBeGreaterThanOrEqual(culled)
      if (uncalled > culled) sawDifference = true
    }
    expect(sawDifference, '至少一份夹具必须体现剔除差异（否则本判据是空洞真）').toBe(true)
  })
})
