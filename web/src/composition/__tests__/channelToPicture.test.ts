/**
 * **通道取值写回画面（断点②）**。
 *
 * ## 证的是什么（一条闭环，不是单点）
 *
 * 面板写通道（生产命令 setChannelValue）
 *   → Context#kernelMultiblockEvaluation（唯一求值点：按当前取值再装配）
 *   → Context#kernelRenderSourceFace（DRW 定义面）/ kernelPresentationDocument（呈现会话）
 *   → 定义面 cellGrid 与**参考展开网格**逐格一致（scripts/multiblock-fixtures/.out）
 *
 * ## 为什么必须走生产装配（铁律⑦）
 *
 * 输入全部来自**生产解析**（detectAndParse）→ **生产装配**（assembleKernelDocument）→
 * **生产装载**（documentLoad.adoptLoadedDocument）→ **生产 Context 实例**
 * （runtime/__tests__/kernelReadTestHost 用 Object.create(Context.prototype) 注入真 main/kernel，
 * 故被调用的是生产方法本体）。没有一处手搓载荷。
 *
 * ## 负对照（缺一不可：证明本判据有区分力）
 *
 * | # | 负对照 | 期望 |
 * |---|---|---|
 * | ① | 旧通路：直接从**装载期场景**（session.document().scene）取定义面 | 与参考网格**不同**（差异 > 0） |
 * | ② | 把求值点打桩成装载期场景（模拟旧通路复活） | 定义面再次与参考**不同** |
 * | ③ | 生成物只读 / 不写回内核文档 / 失效驱动 | 内核场景同一对象、网格 source === content、取值不变复用同一次求值 |
 *
 * ## 参考网格口径
 *
 * 参考 cellGrid[z][y][x] 的下标指向 fixture 的**并集调色板**（inner.blockPalette），
 * 渲染定义的下标指向**重编号**后的调色板 ⇒ 两边各自把下标映射成 name:meta 再逐格比
 * （与 e2e/helpers/multiblock/referenceGrids 的 idMeta 门禁同口径）。不做任何翻转。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  exists,
  loadInnerDocument,
  loadReferenceLib,
  readJson,
  refPath,
  writeReference,
} from '../../context/__tests__/multiblockFixtureIo.mjs'
import { listVariants } from '@/context/multiblock'
import type { MultiblockInnerDocument } from '@/context/multiblock'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { kernelRenderSourceFaceOf } from '@/composition/kernelPresentationInputs'
import { multiblockDeclarationViewOf } from '@/domain/multiblockDocument'
import { initialMultiblockSelection } from '@/domain/multiblockSelection'
import { plainRootOf } from '@/adapters/plainRoot'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { makeAdoptedKernelReadHost, type KernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'
import type { RuntimeDocument } from '@/context/runtimeDocument'

import ebfFixture from '../../context/__tests__/fixtures/multiblock-ebf-2ch.json'
import lscFixture from '../../context/__tests__/fixtures/multiblock-lsc-overlap.json'

type Json = Record<string, unknown>
const EBF = 'multiblock-ebf-2ch'
const LSC = 'multiblock-lsc-overlap'
const FIXTURES = [EBF, LSC] as const

/** 契约朝向的签名网格（[z][y][x]，每格 = name:meta，air = 空串）。 */
type SigGrid = string[][][]

interface ReferenceGrid {
  variant: string
  dims: { w: number; h: number; d: number }
  cellGrid: number[][][]
}

/** 缺参考文件时用冻结蓝本就地生成（与 --verify-grids 同一实现；不静默跳过）。 */
beforeAll(async () => {
  const missing: Array<{ name: string; key: string }> = []
  for (const name of FIXTURES) {
    const doc = loadInnerDocument(name) as MultiblockInnerDocument
    for (const v of listVariants(doc)) {
      if (!exists(refPath(name, v.key))) missing.push({ name, key: v.key })
    }
  }
  if (missing.length === 0) return
  const lib = (await loadReferenceLib()) as {
    assembleVariant: (doc: unknown, key: string) => ReferenceGrid
  }
  const docs = new Map<string, MultiblockInnerDocument>()
  for (const m of missing) {
    if (!docs.has(m.name)) docs.set(m.name, loadInnerDocument(m.name) as MultiblockInnerDocument)
    const ref = lib.assembleVariant(docs.get(m.name), m.key)
    writeReference(m.name, m.key, { variant: m.key, dims: ref.dims, cellGrid: ref.cellGrid })
  }
})

/** 一方块条目的 name:meta（air 映射为空串）；与 e2e 的 idMeta 口径同义。 */
function idMetaOf(entry: unknown): string {
  if (entry === null || typeof entry !== 'object') return ''
  const e = entry as { registryId?: unknown; meta?: unknown }
  const rid = typeof e.registryId === 'string' ? e.registryId : ''
  const colon = rid.indexOf(':')
  const name = colon >= 0 ? rid.slice(colon + 1) : rid
  if (name === '' || name === 'air' || name === 'Air') return ''
  return name + ':' + String(e.meta ?? 0)
}

function sigOf(cellGrid: number[][][], palette: readonly unknown[]): SigGrid {
  const names = palette.map(idMetaOf)
  return cellGrid.map((slice) => slice.map((row) => row.map((idx) => names[idx] ?? '?' + String(idx))))
}

function referenceSig(name: string, variantKey: string): { sig: SigGrid; grid: ReferenceGrid } {
  const grid = readJson<ReferenceGrid>(refPath(name, variantKey))
  const inner = loadInnerDocument(name) as MultiblockInnerDocument & { blockPalette: readonly unknown[] }
  return { sig: sigOf(grid.cellGrid, inner.blockPalette), grid }
}

interface Diff {
  count: number
  cells: number
  shape: string | null
  details: string[]
}

function diffSig(got: SigGrid, want: SigGrid): Diff {
  const out: Diff = { count: 0, cells: 0, shape: null, details: [] }
  const d = want.length
  const h = want[0]?.length ?? 0
  const w = want[0]?.[0]?.length ?? 0
  const gd = got.length
  const gh = got[0]?.length ?? 0
  const gw = got[0]?.[0]?.length ?? 0
  if (gd !== d || gh !== h || gw !== w) out.shape = gd + 'x' + gh + 'x' + gw + ' != ref ' + d + 'x' + h + 'x' + w
  for (let z = 0; z < d; z++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        out.cells++
        const a = got[z]?.[y]?.[x]
        const b = want[z]?.[y]?.[x]
        if (a !== b) {
          out.count++
          if (out.details.length < 6) out.details.push('(' + x + ',' + y + ',' + z + ') got=' + String(a) + ' want=' + String(b))
        }
      }
    }
  }
  return out
}

/** 生产链：fixture 原文 → 解析 → 装配 → 装载（真 Context + 真 KernelSession）。 */
async function loadFixture(name: string, raw: Json): Promise<KernelReadHost> {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  const parsed = await registry.detectAndParse(raw)
  if (parsed.document === null) throw new Error(name + ': fixture 解析失败')
  const plainRoot = plainRootOf((await readEnvelopeLayers(raw as never)).plain as Record<string, unknown>)
  const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot })
  if (!assembled.ok) throw new Error(name + ': fixture 装配失败')
  return makeAdoptedKernelReadHost(parsed.document as never as RuntimeDocument, plainRoot)
}

interface Picture {
  shape: [number, number, number]
  sig: SigGrid
  identity: string
}

/** 读**画面侧**的定义面（DRW 消费的那一份）。 */
function pictureOf(host: KernelReadHost): Picture | null {
  const face = host.ctx.kernelRenderSourceFace()
  if (face === null) return null
  const hit = face.definitionAt(0)
  if (hit === null) return null
  const def = hit.definition as unknown as { cellGrid: number[][][]; blockPalette: readonly unknown[] }
  const evaluation = host.ctx.kernelMultiblockEvaluation()
  return {
    shape: [def.cellGrid.length, def.cellGrid[0]?.length ?? 0, def.cellGrid[0]?.[0]?.length ?? 0],
    sig: sigOf(def.cellGrid, def.blockPalette),
    identity: evaluation?.identity ?? '',
  }
}

/** 生产写通路：逐通道写值（setChannelValue 命令；与面板同一个 setter）。 */
function writeSelection(
  host: KernelReadHost,
  sel: { totalTier: number; values: Record<string, number>; runstate: string },
): void {
  const session = host.session
  if (session === null) throw new Error('前提：会话必须在场')
  session.setTotalTier(sel.totalTier)
  for (const [k, v] of Object.entries(sel.values)) session.setChannelValue(k, v)
  const decl = host.ctx.kernelMultiblockDeclaration()
  if (decl === null) throw new Error('前提：声明必须在场')
  const idx = decl.runstates.findIndex((r) => r.id === sel.runstate)
  if (idx >= 0) session.setRunstateIndex(idx)
}

describe('通道写 => 再装配 => 画面定义面 = 参考网格（生产装配链）', () => {
  it('EBF：初始 / coil 非尺寸通道 / 尺寸+运行态 三档取值，画面定义面逐格 = 参考', async () => {
    const host = await loadFixture(EBF, ebfFixture as unknown as Json)
    try {
      const decl = host.ctx.kernelMultiblockDeclaration()!
      const initial = initialMultiblockSelection(multiblockDeclarationViewOf(decl))
      const initialKey =
        'height:0|coil:0|glass:0|tt:' + initial.totalTier + '|runstate:' + initial.runstate
      const initPic = pictureOf(host)
      expect(initPic, '初始必须有画面定义面').not.toBeNull()
      const initRef = referenceSig(EBF, initialKey)
      expect(initPic!.shape, '初始画面形状（' + initialKey + '）').toEqual([
        initRef.grid.dims.d,
        initRef.grid.dims.h,
        initRef.grid.dims.w,
      ])
      expect(diffSig(initPic!.sig, initRef.sig).count, '初始画面必须逐格 = 参考').toBe(0)

      const cases: Array<{
        label: string
        sel: { totalTier: number; values: Record<string, number>; runstate: string }
        key: string
      }> = [
        {
          // h>=3 才有线圈槽（fixture 的 casingTower 只在 h>=3 挖 (1,1,1)），
          // 故非尺寸通道的可观察点在 h>=3 上取。
          label: '非尺寸通道 coil（replace 型；本包前画面完全不响应）',
          sel: { totalTier: 2, values: { height: 3, coil: 3 }, runstate: 'idle' },
          key: 'height:3|coil:3|glass:0|tt:2|runstate:idle',
        },
        {
          label: '尺寸通道 + glass + 运行态（三维一起变）',
          sel: { totalTier: 14, values: { height: 5, coil: 3, glass: 2 }, runstate: 'active' },
          key: 'height:5|coil:3|glass:2|tt:14|runstate:active',
        },
      ]

      for (const c of cases) {
        writeSelection(host, c.sel)
        const pic = pictureOf(host)
        expect(pic, c.label + '：写后必须有画面定义面').not.toBeNull()
        const ref = referenceSig(EBF, c.key)
        const wantShape: [number, number, number] = [ref.grid.dims.d, ref.grid.dims.h, ref.grid.dims.w]
        expect(pic!.shape, c.label + '（' + c.key + '）：画面形状').toEqual(wantShape)
        const diff = diffSig(pic!.sig, ref.sig)
        expect(
          diff.count,
          c.label + '（' + c.key + '）：画面定义面必须逐格 = 参考。形状=' + String(diff.shape) + ' ' + diff.details.join(' '),
        ).toBe(0)
      }

      // ④ 非尺寸通道**单独**生效（不是被尺寸轴顺带带过去的）：同 height 下只改 coil，
      //    画面必须变，且变到 coil:3 的参考网格上。
      writeSelection(host, { totalTier: 2, values: { height: 3, coil: 0 }, runstate: 'idle' })
      const coil0 = pictureOf(host)!
      expect(diffSig(coil0.sig, referenceSig(EBF, 'height:3|coil:0|glass:0|tt:2|runstate:idle').sig).count).toBe(0)
      writeSelection(host, { totalTier: 2, values: { coil: 3 }, runstate: 'idle' })
      const coil3 = pictureOf(host)!
      expect(diffSig(coil3.sig, referenceSig(EBF, 'height:3|coil:3|glass:0|tt:2|runstate:idle').sig).count).toBe(0)
      expect(coil3.sig, '只改非尺寸通道（coil）时画面必须变').not.toEqual(coil0.sig)

      const kernelDoc = host.session!.document()!
      const evalD = host.ctx.kernelMultiblockEvaluation()!
      expect(evalD.scene, '派生场景不是内核场景（求值产物，不是写回）').not.toBe(kernelDoc.scene)
      const kernelData = kernelDoc.scene.data['structure:multiblock:data']
      expect(kernelData?.source, '内核里的生成网格仍是 content（只读）').toBe('content')
    } finally {
      host.dispose()
    }
  })

  it('LSC：耦合夹取后的取值也写进画面（夹取结果 = 参考网格）', async () => {
    const host = await loadFixture(LSC, lscFixture as unknown as Json)
    try {
      writeSelection(host, { totalTier: 14, values: { height: 5, capacitor: 1, glass: 2 }, runstate: 'idle' })
      const pic = pictureOf(host)
      expect(pic).not.toBeNull()
      const ref = referenceSig(LSC, 'height:5|capacitor:1|glass:1|tt:14|runstate:idle')
      expect(pic!.shape).toEqual([ref.grid.dims.d, ref.grid.dims.h, ref.grid.dims.w])
      expect(diffSig(pic!.sig, ref.sig).count, '耦合夹取后的画面必须逐格 = 参考').toBe(0)
    } finally {
      host.dispose()
    }
  })
})

describe('负对照：旧通路（读装载期场景）若复活必红', () => {
  it('① 直接从 session.document().scene 取定义面 => 与参考不同（差异 > 0）', async () => {
    const host = await loadFixture(EBF, ebfFixture as unknown as Json)
    try {
      writeSelection(host, { totalTier: 14, values: { height: 5, coil: 3, glass: 2 }, runstate: 'idle' })
      const kernelDoc = host.session!.document()!
      const face = host.ctx.kernelRenderSourceFace()
      expect(face, '前提：画面读面在场').not.toBeNull()
      const legacyFace = kernelRenderSourceFaceOf({
        scene: kernelDoc.scene,
        content: kernelDoc.content,
        frameObjects: ['structure:multiblock'],
      })
      const hit = legacyFace.definitionAt(0)!
      const legacyDef = hit.definition as unknown as {
        cellGrid: number[][][]
        blockPalette: readonly unknown[]
      }
      const legacySig = sigOf(legacyDef.cellGrid, legacyDef.blockPalette)
      const ref = referenceSig(EBF, 'height:5|coil:3|glass:2|tt:14|runstate:idle')
      const diff = diffSig(legacySig, ref.sig)
      expect(diff.count, '旧通路读装载期场景时必须与参考不同（否则本判据对断点②没有区分力）').toBeGreaterThan(0)
    } finally {
      host.dispose()
    }
  })

  it('② 把求值点打桩成装载期场景（模拟旧通路复活）=> 画面再次与参考不同', async () => {
    const host = await loadFixture(EBF, ebfFixture as unknown as Json)
    try {
      writeSelection(host, { totalTier: 14, values: { height: 5, coil: 3, glass: 2 }, runstate: 'idle' })
      const live = pictureOf(host)!
      const ref = referenceSig(EBF, 'height:5|coil:3|glass:2|tt:14|runstate:idle')
      expect(diffSig(live.sig, ref.sig).count, '前提：真求值画面 = 参考').toBe(0)

      const kernelDoc = host.session!.document()!
      const patched = host.ctx as unknown as { kernelMultiblockEvaluation: () => unknown }
      patched.kernelMultiblockEvaluation = () => ({
        scene: kernelDoc.scene,
        content: kernelDoc.content,
        frameObjects: ['structure:multiblock'],
        multiblockDeclaration: null,
        selection: { totalTier: 14, values: {}, runstate: 'idle' },
        identity: '',
        assembly: null,
        failed: false,
        diagnostics: [],
      })
      const revived = pictureOf(host)!
      const diff = diffSig(revived.sig, ref.sig)
      expect(diff.count, '旧通路复活时画面必然偏离参考（本判据据此判红）').toBeGreaterThan(0)
    } finally {
      host.dispose()
    }
  })

  it('③ 失效驱动：取值不变不重装配（同对象复用）；写通道才重算（身份变化）', async () => {
    const host = await loadFixture(EBF, ebfFixture as unknown as Json)
    try {
      writeSelection(host, { totalTier: 2, values: { coil: 2 }, runstate: 'idle' })
      const a = host.ctx.kernelMultiblockEvaluation()
      const b = host.ctx.kernelMultiblockEvaluation()
      expect(a, '前提：求值在场').not.toBeNull()
      expect(b, '取值未变 => 复用同一次求值产物（每帧不得全量重装配）').toBe(a)

      writeSelection(host, { totalTier: 2, values: { coil: 3 }, runstate: 'idle' })
      const c = host.ctx.kernelMultiblockEvaluation()
      expect(c, '写通道后必须有新求值').not.toBe(a)
      expect(c!.identity, '取值变 => 求值身份必须变').not.toBe(a!.identity)
    } finally {
      host.dispose()
    }
  })
})
