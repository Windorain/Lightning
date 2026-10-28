// @vitest-environment jsdom
/**
 * 回归锁：缺 `tooltipPalette` 的文档上，逐格说明**写得进、读得回、保存落盘**。
 *
 * 由组件级复现（repro-tooltip-write-lost.test.ts，7 断言复现缺陷）转正：
 * 同一套夹具与面板驱动，断言翻转为修复后的期望行为。缺陷形态（修复前）：
 *  - 算子把文本 push 进 `newDoc.tooltipPalette ?? []` 的**孤儿数组**（从不挂回文档），
 *    网格却写下指向它的下标 ⇒ 文字丢失 + 悬空下标随保存落盘；
 *  - 面板 `loadValue` 因 `!palette` 短路 ⇒ 写入的内容切走再切回读不出（"接受了输入"的假象）。
 *
 * 负对照即主路径：文档**缺调色板**（mod 单一结构分支的真实产出形态，见组件级复现）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
// `getDoc()` 已终删 ⇒ 替身改用**真 `Context`**（见 `makeOperatorCtx` 的说明）。
import { makeKernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { TooltipEditOperator } from '@/operators/builtin/metaEditOperators'
import TooltipEditorPanel from '@/workbench/ux/panels/TooltipEditorPanel.vue'

/** 与 workbenchHost / embedHost 注册顺序一致的生产解析链。 */
function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

function parse(raw: Record<string, unknown>) {
  return productionRegistry().detectAndParse(raw)
}

/**
 * 夹具（= 报告页形态，尺寸压到 1×2×2）：根有 `cellTooltipGrid`（全 -1），可选 `tooltipPalette`。
 * cellGrid 行序：row 0 = 顶部（= height-1-y）。
 */
function bakedDoc(withPalette: boolean): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    geometryPhase: 'baked',
    id: 'repro',
    label: 'repro',
    cellGrid: [[[1, 0], [0, 1]]],
    blockPalette: [{ registryId: 'air', meta: 0 }, { registryId: 'minecraft:stone', meta: 0 }],
    cellTooltipGrid: [[[-1, -1], [-1, -1]]],
  }
  if (withPalette) doc.tooltipPalette = []
  return doc
}

/** 方块 A：cellGrid[0][0][0] → row 0 → 世界 y = height-1-row = 1 */
const POS_A = { x: 0, y: 1, z: 0 }
/** 方块 B：cellGrid[0][1][1] → row 1 → y = 0 */
const POS_B = { x: 1, y: 0, z: 0 }
/** 面板/算子约定的网格行号：`h - 1 - pos.y`（h = 2） */
const rowOf = (y: number) => 2 - 1 - y

// ---------------------------------------------------------------------------
// 算子层
// ---------------------------------------------------------------------------

function makeOperatorCtx(initialDoc: unknown) {
  // ## ⚠️ 手工替身换成**真 `Context`**（`makeKernelReadHost`）
  //
  // 迁移后的算子读三样东西：`hasLoadedDocument()`（R1 存在性）、
  // `kernelGrid(0)?.height`（R5 帧高）、以及回落分支的 `frozenDocumentValue()`（R8）。
  // 手工替身逐个补会造出**第二份**读面语义（本工程三度实测它必然漂移）
  // ⇒ 用宿主的**生产 `Context`**（`kernel === null` ⇒ 三条读面都走 legacy 分支）。
  const host = makeKernelReadHost(initialDoc as never)
  const ctx = Object.assign(host.ctx, {
    // 算子**先**试内核写（`Context.submitContentEdit`）。
    // 本宿主是**无内核会话**的替身 ⇒ 如实返回 `false`
    //（生产 `Context.submitContentEdit` 在 `kernel === null` 时正是返回 `false`），
    // 于是本文件的用例**恰好**覆盖 D0 的**回落分支** —— 那正是回归锁要守的东西。
    submitContentEdit: () => false,
  })
  return {
    ctx,
    current: () => host.legacyDocument() as unknown as {
      tooltipPalette?: unknown[]
      cellTooltipGrid?: number[][][]
      serialize: () => Record<string, unknown>
    },
  }
}

describe('算子层：缺 tooltipPalette 的文档上写入逐格说明', () => {
  it('前提形态：解析后网格在、调色板缺（报告页的真实形态）', async () => {
    const res = await parse(bakedDoc(false))
    const doc = res.document!
    expect(res.parser?.formatName).toBe('StructureData')
    expect(doc.cellTooltipGrid).toBeDefined()
    expect(doc.tooltipPalette).toBeUndefined()
    expect('tooltipPalette' in doc.serialize()).toBe(false)
  })

  it('负对照主路径：文字进文档（新建调色板）、下标指向真实条目、serialize 落盘可检索', async () => {
    const res = await parse(bakedDoc(false))
    const { ctx, current } = makeOperatorCtx(res.document!)

    TooltipEditOperator.exec?.(ctx as never, {
      text: '11111',
      pos: { x: POS_A.x, y: rowOf(POS_A.y), z: POS_A.z },
    } as never)

    const doc = current()
    expect(doc.tooltipPalette).toEqual(['11111'])
    const idx = doc.cellTooltipGrid![0]![0]![0]!
    expect(idx).toBe(0)
    expect((doc.tooltipPalette as string[])[idx]).toBe('11111')
    // 保存路径写出的就是 serialize()：文字必须能被检索到（期望行为 1）
    const saved = doc.serialize()
    expect(JSON.stringify(saved)).toContain('11111')
    expect(saved.tooltipPalette).toEqual(['11111'])
  })

  it('保存 → 重新载入：文字读得回（不再是悬空下标）', async () => {
    const res = await parse(bakedDoc(false))
    const { ctx, current } = makeOperatorCtx(res.document!)
    TooltipEditOperator.exec?.(ctx as never, {
      text: '11111',
      pos: { x: POS_A.x, y: rowOf(POS_A.y), z: POS_A.z },
    } as never)

    const again = await parse(current().serialize())
    const doc2 = again.document!
    expect(doc2.tooltipPalette).toEqual(['11111'])
    expect(doc2.cellTooltipGrid![0]![0]![0]).toBe(0)
    // 面板读取规则（loadValue 修复后）：palette 按空调色板兜底 ⇒ 该格读回文本
    const palette = (doc2.tooltipPalette as string[] | undefined) ?? []
    expect(palette[doc2.cellTooltipGrid![0]![0]![0]!]).toBe('11111')
  })

  it('清空文本：下标复位 -1，不制造悬空下标（期望行为 2）', async () => {
    const res = await parse(bakedDoc(false))
    const { ctx, current } = makeOperatorCtx(res.document!)
    TooltipEditOperator.exec?.(ctx as never, {
      text: '11111', pos: { x: POS_A.x, y: rowOf(POS_A.y), z: POS_A.z },
    } as never)
    TooltipEditOperator.exec?.(ctx as never, {
      text: '', pos: { x: POS_A.x, y: rowOf(POS_A.y), z: POS_A.z },
    } as never)
    expect(current().cellTooltipGrid![0]![0]![0]).toBe(-1)
  })

  it('对照组不回归：自带调色板的老结构追加文本（调色板去重语义不变）', async () => {
    const res = await parse(bakedDoc(true))
    const { ctx, current } = makeOperatorCtx(res.document!)
    TooltipEditOperator.exec?.(ctx as never, {
      text: '11111', pos: { x: POS_A.x, y: rowOf(POS_A.y), z: POS_A.z },
    } as never)
    TooltipEditOperator.exec?.(ctx as never, {
      text: '11111', pos: { x: POS_B.x, y: rowOf(POS_B.y), z: POS_B.z },
    } as never)
    const doc = current()
    expect(doc.tooltipPalette).toEqual(['11111']) // 同文本去重，不重复入池
    expect(doc.cellTooltipGrid![0]![0]![0]).toBe(0)
    expect(doc.cellTooltipGrid![0]![1]![1]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 面板层（DOM）：打字 → 切走 → 切回来，内容还在
// ---------------------------------------------------------------------------

function makePanelCtx(initialDoc: unknown) {
  // 与算子层同款 —— 用**真 `Context`**（生产读面），只补两处非读面的位
  //（`getFrameIndex` 是时间面；`getOperators` 是外壳面）与"无内核会话"的如实回落。
  const host = makeKernelReadHost(initialDoc as never)
  const frameRef = ref(0)
  const tickRef = ref(0)
  const items = ref<unknown[]>([])
  const ctx = Object.assign(host.ctx, {
    // 帧下标改为**只读派生**访问器（旧 `getCurrentFrameIndex(): Ref<number>`
    // 是可写权威，已删除）。测试替身随之只提供读面。
    getFrameIndex: () => frameRef.value,
    getSelection: () => ({ items }),
    getOperators: () => ({
      invoke: (id: string, props?: Record<string, unknown>) => {
        if (id === 'OPERATOR_TOOLTIP_EDIT') {
          TooltipEditOperator.exec?.(ctx as never, (props ?? {}) as never)
        }
        return { status: 'FINISHED' }
      },
    }),
    // 面板经 `OPERATOR_TOOLTIP_EDIT` 提交，而算子**先**试内核写。
    // 本宿主**无内核会话** ⇒ 如实返回 `false`（与生产在 `kernel === null` 时一致）
    // ⇒ 用例覆盖 D0 的**回落分支**（回归锁的本意）。
    submitContentEdit: () => false,
    // `TooltipEditorPanel` 的重读信号从"文档身份"改为
    // **内容重读**（宽信号）—— 原地改 tooltip 侧表也要刷新，故替身须提供它。
    getContentRefreshTick: () => tickRef,
  })
  // `host` 一并返回：**测试侧**观测被跟踪的 legacy 文档（`getDoc()` 已终删，
  // 见 `kernelReadTestHost#legacyDocument` 的说明）。
  return { ctx, items, host }
}

function select(items: { value: unknown[] }, pos: { x: number; y: number; z: number }) {
  items.value = [{ kind: 'block', ref: { pos: { ...pos }, block_state_id: 'minecraft:stone' } }]
}

function mountPanel(ctx: unknown) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(TooltipEditorPanel as never, { ctx }) })
  app.mount(host)
  return { app, host }
}

const textarea = (host: HTMLElement) =>
  host.querySelector('textarea.tooltip-editor-textarea') as HTMLTextAreaElement

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('面板层：缺调色板文档上打字 → 切走 → 切回来，内容还在', () => {
  async function typeAndSwitch(withPalette: boolean) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const res = await parse(bakedDoc(withPalette))
    const { ctx, items, host: readHost } = makePanelCtx(res.document!)

    select(items, POS_A)
    const { app, host } = mountPanel(ctx)
    await nextTick()

    const ta = textarea(host)
    expect(ta, '面板应显示选中方块的编辑框').toBeTruthy()

    ta.dispatchEvent(new Event('focus'))
    ta.value = '11111'
    ta.dispatchEvent(new Event('input'))
    await nextTick()

    vi.advanceTimersByTime(500) // 300ms 防抖 → 算子落库
    await nextTick()

    select(items, POS_B)
    await nextTick()
    select(items, POS_A)
    await nextTick()
    const after = textarea(host).value

    const doc = readHost.legacyDocument() as unknown as {
      cellTooltipGrid?: number[][][]
      tooltipPalette?: unknown[]
    }
    app.unmount()
    return { after, doc }
  }

  it('缺调色板：切回来内容还在（修复后语义）；文档里调色板与下标成对', async () => {
    const { after, doc } = await typeAndSwitch(false)
    expect(after).toBe('11111')
    expect(doc.tooltipPalette).toEqual(['11111'])
    expect(doc.cellTooltipGrid![0]![0]![0]).toBe(0)
  })

  it('对照：自带调色板的老结构行为不变', async () => {
    const { after, doc } = await typeAndSwitch(true)
    expect(after).toBe('11111')
    expect(doc.tooltipPalette).toEqual(['11111'])
  })
})
