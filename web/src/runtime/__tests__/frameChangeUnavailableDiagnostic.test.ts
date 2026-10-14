/**
 * **R2/S3 事1 · "未装配 ⇒ 换帧不可用"的显式诊断**（Gitea #388 评论 7722 的三条裁决）。
 *
 * ## 判据（立项单逐字要求的三条）
 *
 * | # | 判据 | 本文件的落点 |
 * |---|---|---|
 * | ① | **未装配 ⇒ 诊断在** | `① …` 两组（`docRef` 缺席 / 帧轴为空两条 reason）走**生产类 `DRW`** |
 * | ② | **已装配 ⇒ 诊断不在** | 输入是**生产装配链**产出的渲染视图文档（`kernelRenderViewFromFace`），且断言换帧**真的发生** |
 * | ③ | **负对照：守卫改回静默 ⇒ 判据①必红** | 源码结构判据（不可用分支必须先上报再返回）＋ 本地变异实测（报告附读数） |
 *
 * ## 为什么"静默"必须被判死
 *
 * S3 删掉 `Context#legacyRenderSource()` 本体（`518bdc15`）后，未装配成功的文档
 * （`hasAdoptedContent() === false`）**没有**渲染视图文档 ⇒ `setCurrentWorldFrame` 的守卫
 * （`!doc || doc.frameCount === 0`）直接 `return`：调用方看到"点了没反应"。
 * 方向（**不**回落 legacy 旧文档）是被接受的，**静默**不是 —— 立项单两面都写着
 * "未恢复入口**显式不可用**，不自动回落" ＋ "**不静默丢弃**、填空、伪造成功"。
 *
 * ## 口径（复用既有通道与既有判别式，不自行扩码表）
 *
 * 判别式**就是**那条既有守卫；落点是**既有**诊断记录器（`ctx.wm.diagnostics`，
 * 读面 `Context.getDiagnostics()`）。本文件不做码表扩写，接线判据只钉"生产文件确实
 * 把这件事写进既有通道"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ref, shallowRef, type Ref } from 'vue'
import { DRW } from '@/runtime/drw'
import {
  createFrameChangeUnavailableReporter,
  type FrameChangeUnavailableReport,
} from '@/runtime/drwMeshPipeline'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { StructureDefinition } from '@/render/schema/types'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { plainRootOf } from '@/adapters/plainRoot'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { kernelRenderViewFromFace } from '@/composition/kernelRenderView'

/** 读源码并**归一化行尾**（铁律 6：新鲜检出是 CRLF，同一断言必须在两种口径下同结论）。 */
function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(import.meta.dirname, ...segments), 'utf8').replace(/\r\n/g, '\n')
}

/** 生产 `DRW`（两个宿主的视口都用它）+ 两个观测口（上报 / 换帧是否真的发生）。 */
function makeDrw(input: { doc?: RuntimeDocument | null } = {}): {
  readonly drw: DRW
  readonly docRef: Ref<RuntimeDocument | null>
  readonly reports: FrameChangeUnavailableReport[]
  readonly seekCalls: number[]
} {
  // `shallowRef`（不是 `ref`）：`ref<T>()` 的 `UnwrapRef` 会把类实例映射成**结构类型**
  // 而丢掉 `RuntimeDocument` 的私有成员（`_extra`/`_gridToV2`）⇒ 与 `DRWDeps.docRef` 不兼容。
  const docRef = shallowRef<RuntimeDocument | null>(input.doc ?? null)
  const reports: FrameChangeUnavailableReport[] = []
  const seekCalls: number[] = []
  const drw = new DRW({
    docRef,
    contentRefreshTickRef: ref(0),
    worldFrameIndex: () => 0,
    layerWorldY: ref(0),
    structureDefinition: shallowRef<StructureDefinition | null>(null),
    seekFrame: (i) => {
      seekCalls.push(i)
    },
    onFrameChangeUnavailable: (r) => {
      reports.push(r)
    },
  })
  return { drw, docRef, reports, seekCalls }
}

/** 任何"帧轴非空"的文档都能让守卫放行；这只是守卫读的字段。 */
const DOC_WITH_FRAMES = { frameCount: 5 } as unknown as RuntimeDocument
const DOC_WITH_EMPTY_AXIS = { frameCount: 0 } as unknown as RuntimeDocument

/**
 * **生产链**产出的渲染视图文档：`e2e/fixtures` → 生产解析器 → 生产装配 →
 * `kernelRenderViewFromFace`（= 视口 `useKernelChannels#renderDoc` 的同一个生产者）。
 */
async function productionRenderViewDoc(): Promise<RuntimeDocument> {
  const p = path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json')
  const raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  const parsed = await parsers.detectAndParse(raw)
  if (parsed.document === null) throw new Error('fixture 解析失败（判据②的输入必须是生产解析产物）')
  const plainRoot = plainRootOf((await readEnvelopeLayers(raw as never)).plain as Record<string, unknown>)
  const assembled = assembleKernelDocument({ doc: parsed.document as never, plainRoot })
  if (!assembled.ok) throw new Error('fixture 装配失败（判据②的输入必须是生产装配产物）')
  const view = kernelRenderViewFromFace({
    body: null,
    selection: { totalTier: 1, values: {}, runstate: '' },
    frameIndex: 0,
    scene: assembled.value.scene,
    content: assembled.value.content,
    frameObjects: assembled.value.frameObjects,
    multiblockDeclaration: null,
  })
  if (view.doc === null) throw new Error('生产链未产出渲染视图文档（判据②的输入必须真实在场）')
  return view.doc
}

describe('R2/S3 事1 ① · 未装配 ⇒ 诊断**在**（生产 DRW 类）', () => {
  it('① `docRef` 缺席（未装配成功）⇒ 一条可查诊断，且请求确实没有生效', async () => {
    const { drw, reports, seekCalls } = makeDrw()
    await drw.setCurrentWorldFrame(3)

    // 反空洞真：这条路径上换帧**确实**没发生 —— 这就是被诊断出来的"不可用"。
    expect(seekCalls, '未装配时不得假装换帧成功').toEqual([])
    expect(reports, '静默 = 红；必须有一条诊断').toEqual([
      { index: 3, reason: 'no-render-view-document' },
    ])

    // 拖一次帧滑块 = 几十次请求；记录器是**共享**的有界环形缓冲 ⇒ 同一不可用时段只记首条。
    for (let i = 0; i < 30; i++) await drw.setCurrentWorldFrame(i)
    expect(reports, '同一不可用时段只记首条（不得把其它通道的记录挤掉）').toHaveLength(1)
  })

  it('①变体 帧轴为空（`doc` 在、`frameCount === 0`）⇒ 以另一条 reason 同样报告', async () => {
    const { drw, reports } = makeDrw({ doc: DOC_WITH_EMPTY_AXIS })
    await drw.setCurrentWorldFrame(1)
    expect(reports).toEqual([{ index: 1, reason: 'empty-frame-axis' }])
  })

  it('不可用时段结束后再次不可用 ⇒ 重新记一条（`clear` 语义；不是"一辈子只报一次"）', async () => {
    const { drw, docRef, reports } = makeDrw()
    await drw.setCurrentWorldFrame(1)
    docRef.value = DOC_WITH_FRAMES
    await drw.setCurrentWorldFrame(0)
    docRef.value = null
    await drw.setCurrentWorldFrame(2)
    expect(reports.map((r) => r.reason)).toEqual([
      'no-render-view-document',
      'no-render-view-document',
    ])
    expect(reports.map((r) => r.index), '每条带当时的请求下标').toEqual([1, 2])
  })
})

describe('R2/S3 事1 ② · 已装配 ⇒ 诊断**不在**（输入走生产装配链）', () => {
  it('② 生产链产出的渲染视图文档在场 ⇒ 零诊断，且换帧真的发生', async () => {
    const doc = await productionRenderViewDoc()
    expect(doc.frameCount, '反空洞真：帧轴非空（否则命中的是另一条判别式）').toBeGreaterThan(0)

    const { drw, reports, seekCalls } = makeDrw({ doc })
    await drw.setCurrentWorldFrame(0)

    expect(reports, '已装配 ⇒ 该诊断必须不在').toEqual([])
    expect(seekCalls, '换帧必须真的发生（否则②只是"两条路都不通"）').toEqual([0])
  })
})

describe('R2/S3 事1 ③ · 负对照：守卫一改回静默，判据①**必红**', () => {
  it('③ 源码结构判据：不可用分支必须**先上报再返回**', () => {
    const src = readSource('..', 'drwMeshPipeline.ts')
    expect(src.length, '反空洞真：读到的必须是非空源文件').toBeGreaterThan(1000)
    expect(
      /if \(!doc \|\| doc\.frameCount === 0\) \{\n\s*frameChangeUnavailable\.report\(/m.test(src),
      '把这段改回裸 `return`（静默）⇒ 本判据红、①的"诊断在"也必红',
    ).toBe(true)
    // 反向：不得出现"守卫原样保留、上报却挪到别处/删掉"的形态。
    expect(src, '上报器必须是本文件里被守卫调用的那一个').toContain(
      'const frameChangeUnavailable = createFrameChangeUnavailableReporter(',
    )
  })
})

describe('R2/S3 事1 · 生产接线（既有通道 + 既有判别式，不扩码表）', () => {
  it('视口把上报落进 `ctx.wm.diagnostics`，码与判别式都是既有的', () => {
    const src = readSource('..', '..', 'shared', 'viewport', 'useViewportRuntime.ts')
    expect(src).toContain('onFrameChangeUnavailable')
    expect(src, '通道与码都取自既有码表（不新造体系）').toContain("channel: 'command'")
    expect(src).toContain("code: 'command.unsupported'")
    expect(src, '判别式复用 GF-16 的既有判定').toContain('ctx.hasAdoptedContent()')
    expect(src, '`reason` 必须真的进 params（否则读面分不出两条 reason）').toContain(
      'reason: report.reason',
    )
  })

  it('`DRW` 透传上报口（漏了这一步，生产接线会静默失效）', () => {
    const src = readSource('..', 'drw.ts')
    expect(src).toContain('onFrameChangeUnavailable: deps.onFrameChangeUnavailable')
  })
})

describe('R2/S3 事1 · 上报器本身的界（有界性在结构上成立）', () => {
  it('同一不可用时段一条；reason 变化各一条；`clear()` 后重开一段', () => {
    const out: FrameChangeUnavailableReport[] = []
    const r = createFrameChangeUnavailableReporter((x) => out.push(x))
    expect(r.report(1, 'no-render-view-document')).toBe(true)
    expect(r.report(2, 'no-render-view-document')).toBe(false)
    expect(r.report(3, 'empty-frame-axis'), 'reason 不同 ⇒ 是新的一条事实').toBe(true)
    r.clear()
    expect(r.report(4, 'no-render-view-document')).toBe(true)
    expect(out).toEqual([
      { index: 1, reason: 'no-render-view-document' },
      { index: 3, reason: 'empty-frame-axis' },
      { index: 4, reason: 'no-render-view-document' },
    ])
  })

  it('签名空间恰为 2 ⇒ 记录数上界 = 2 条（无需"丢弃计数"，与自由文本签名族不同）', () => {
    const out: FrameChangeUnavailableReport[] = []
    const r = createFrameChangeUnavailableReporter((x) => out.push(x))
    for (let i = 0; i < 500; i++) {
      r.report(i, i % 2 === 0 ? 'no-render-view-document' : 'empty-frame-axis')
    }
    expect(out.length, '500 次交替请求 ⇒ 恰 2 条（能力边界逐字：签名空间 = reason 的取值数）').toBe(2)
  })
})
