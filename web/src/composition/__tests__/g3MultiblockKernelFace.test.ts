/**
 * R2-G3 ③ —— **内层 body 的内核承运**与**内核面再装配入口**的生产装配判据。
 *
 * ## 为什么必须走生产装配（AGENTS.md 第 ⑦ 条）
 *
 * 纯函数判据喂"已带字段"的手工载荷会**恒绿**：它证明的是"函数能装下这个值"，
 * 不是"生产链真的产出并消费了它"。故本文件的输入全部来自**真实夹具**：
 *
 *   真实夹具 → `parseMultiblockDeclaration`（生产解析）/ `registry.detectAndParse`
 *   → `multiblockBodyContentOf`（类型化适配器）→ `assembleMultiblockKernelFace`（生产装配）
 *
 * ## 判据与负对照（#388 评论 7501 第 3 项 / 7672 条件 / 7698）
 *
 * | # | 正判据 | 区分力（不靠测试主动抛错） |
 * |---|---|---|
 * | ① | 承运**非空**、**等于适配器输出**、与解析侧**不同物** | 与 `doc.multiblock`（解析侧原物）比引用 |
 * | ② | 不填 body（`null`）⇒ 装配**显式失败**（`multiblockBodyNotCarried`） | 同一条判据本体的两处：填了 ⇒ 成功 |
 * | ③ | **诊断出现 ⇒ 该帧声明 grid 被忽略**：注入"维度故意不同"的帧参考网格 ⇒ 装配结果逐格**不变** | 注入网格的维度 ≠ 求值产物维度（求值若读了它，逐格相等必红） |
 * | ④ | 取证通道**不进声明、不进摘要** | 编译期断言（`cellGrid` 不是声明字段）+ 运行期逐键比对 |
 *
 * 注入样本取自真实夹具：三份 `multiblock-*` **本身都不带**帧参考网格（契约 §9.6
 * 「生产产物必须省略」——实测 framesWithCellGrid = 0），故注入是"取证样本"，
 * 不是伪造生产数据。
 */
import { describe, it, expect } from 'vitest'

import {
  assembleKernelDocument,
  assembleMultiblockKernelFace,
  type MultiblockKernelFaceInput,
} from '@/composition/kernelAssembly'
import { createParserRegistry } from '@/context/parserRegistry'
import { parseMultiblockDeclaration } from '@/context/parsers/multiblockDocument'
import { fixturePath, loadInnerDocument, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { multiblockBodyContentOf } from '@/adapters/multiblockDeclaration'
import { multiblockBodyOf } from '@/adapters/files/multiblockDeclaration'
import {
  multiblockDeclDigest,
  type MultiblockBody,
  type MultiblockDeclaration,
} from '@/domain/multiblockDocument'
import { findObject, findObjectData } from '@/domain/scene'
import { unwrap } from '@/domain/errors'
import fs from 'node:fs'
import path from 'node:path'
import type { RuntimeDocument } from '@/context/runtimeDocument'

/** 多方块为主的真实夹具（与 `kernelAssembly.test.ts` / 适配器判据同一清单）。 */
const FIXTURES = ['multiblock-tier-only', 'multiblock-ebf-2ch', 'multiblock-lsc-overlap'] as const

// ─────────────────────────────────────────────────────────────────────────────
// 编译期断言：两条"不许"由**类型**把关（写错即 `npm run typecheck` 红，不靠人记得）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 条件 ①（#388 评论 7672）的**类型层面**形态：`cellGrid` **不是**声明字段
 * ⇒ 取证网格在类型上到不了 `multiblockDeclDigest`（它的形参就是 `MultiblockDeclaration`）。
 * 谁把 `cellGrid` 加回 `MultiblockScene`（或声明本身），这一行就编译失败。
 */
type CellGridNotInDeclaration = Extract<
  'cellGrid',
  keyof MultiblockDeclaration | keyof MultiblockDeclaration['scenes'][number]
> extends never
  ? true
  : never
const cellGridNotInDeclaration: CellGridNotInDeclaration = true
void cellGridNotInDeclaration

/**
 * 入口形参不含 `RuntimeDocument`（G3 的目标状态）：把一份 `RuntimeDocument` 当输入
 * 传给内核面入口**必须**类型不成立（`RuntimeDocument` 没有 `body` 承运）。
 * 机械、不依赖读源码文本。
 */
type InputRejectsRuntimeDocument = RuntimeDocument extends MultiblockKernelFaceInput ? never : true
const inputRejectsRuntimeDocument: InputRejectsRuntimeDocument = true
void inputRejectsRuntimeDocument

// ─────────────────────────────────────────────────────────────────────────────
// 生产链装载
// ─────────────────────────────────────────────────────────────────────────────

/** 真实夹具 → 生产解析（`registry.detectAndParse`）→ 类型化适配器 → 内核承运。 */
async function loadProduction(name: string): Promise<{ doc: RuntimeDocument; body: MultiblockBody }> {
  const registry = createParserRegistry()
  const envelope = readJson(fixturePath(name)) as Record<string, unknown>
  const parsed = await registry.detectAndParse(envelope)
  expect(parsed.document, `${name} 应能被生产解析器解析`).not.toBeNull()
  return { doc: parsed.document!, body: multiblockBodyContentOf(parsed.document!.multiblock) }
}

/** 夹具的内层 body（解包 + meta 合并），供"生产解析 → 适配器"这条直路。 */
function innerOf(name: string): Record<string, unknown> {
  return loadInnerDocument(name) as Record<string, unknown>
}

type BlockGridPayload = {
  readonly kind: string
  readonly cells: Readonly<Record<string, string>>
  readonly palette?: readonly unknown[]
  readonly sizeColumn?: number
  readonly sizeRow?: number
  readonly sizeZSlice?: number
}

function cellKeysOf(payload: BlockGridPayload): readonly string[] {
  return Object.keys(payload.cells).sort()
}

describe('R2-G3 · 内层 body 的内核承运（生产链）', () => {
  for (const name of FIXTURES) {
    it(`${name}：承运**非空**、**等于适配器输出**、与解析侧**不同物**`, async () => {
      const { doc, body } = await loadProduction(name)

      // ① 非空：声明两半都在（通道/帧/并集调色板），且不是"空声明"。
      expect(body.declaration.multiblockCount).toBe(1)
      expect(body.declaration.channels.length).toBeGreaterThan(0)
      expect(body.declaration.scenes.length).toBeGreaterThan(0)
      expect(body.declaration.blockPalette.length).toBeGreaterThan(0)

      // ② 等于**适配器输出**：装配回执与输入是**同一份**承运（不是又造一份）。
      const out = unwrap(assembleMultiblockKernelFace({ body }))
      expect(out.body, `${name}: 装配回执必须就是同一份承运`).toBe(body)
      expect(out.body.declaration).toBe(body.declaration)

      // ③ 与**解析侧原物**不同物（`decl`/`raw` 这些解析侧字段在内核承载里不存在）。
      expect(body as unknown as Record<string, unknown>).not.toBe(doc.multiblock)
      expect(body.declaration as unknown as Record<string, unknown>).not.toHaveProperty('decl')
      expect(body.declaration as unknown as Record<string, unknown>).not.toHaveProperty('raw')
      for (const frame of body.declaration.scenes) {
        expect(frame as unknown as Record<string, unknown>).not.toHaveProperty('raw')
      }

      // ④ 求值真的发生了：网格非空、尺寸 > 0、有逐格内容（不是"静默产空"）。
      expect(out.grid.width).toBeGreaterThan(0)
      expect(out.grid.height).toBeGreaterThan(0)
      expect(out.grid.depth).toBeGreaterThan(0)
      expect(cellKeysOf(out.payload as BlockGridPayload).length).toBeGreaterThan(0)

      // ⑤ 直路（真实夹具 → parseMultiblockDeclaration → 适配器）给出**同摘要**的声明：
      //    两个入口对同一份文件必须给同一份内核承载。
      const direct = multiblockBodyContentOf(parseMultiblockDeclaration(innerOf(name)))
      expect(multiblockDeclDigest(direct.declaration)).toBe(multiblockDeclDigest(body.declaration))
    })
  }

  it('生产交叉核对：三条通路（旧文档 / 内核承运 / 解析直路）给出**逐格同值**的 `blockGrid` 载荷', async () => {
    for (const name of FIXTURES) {
      const { doc, body } = await loadProduction(name)

      const assembled = unwrap(assembleKernelDocument({ doc }))
      const obj = findObject(assembled.scene, 'structure:multiblock')
      expect(obj, `${name}: 文档路径必须装配出多方块对象`).toBeDefined()
      const data = findObjectData(assembled.scene, obj!.dataId)
      expect(data).toBeDefined()
      const docPayload = data!.payload as unknown as BlockGridPayload
      expect(docPayload.kind).toBe('blockGrid')

      const out = unwrap(assembleMultiblockKernelFace({ body }))
      const facePayload = out.payload as unknown as BlockGridPayload
      expect(facePayload.kind).toBe('blockGrid')

      // 同一条生产链的两条通路（旧：吃 `RuntimeDocument`；新：吃内核承运）必须同值。
      //
      // 这条判据是**桥接忠实性**的现场证据：内核声明的通道域是 `{lo,hi}`（解析期已折叠），
      // 而求值端口读文件格式的 `domain.max` —— 若桥接写错（例如键名不换），
      // `multiblock-lsc-overlap` 的 `glass` 域会从 2 变 3 ⇒ 装配直接抛
      // 「规则 glass.plate 的 indexTable 缺第 3 档」（本判据首跑实测）。
      expect(cellKeysOf(facePayload), `${name}: 逐格键集合`).toEqual(cellKeysOf(docPayload))
      expect(facePayload.cells, `${name}: 逐格内容`).toEqual(docPayload.cells)
      expect(facePayload.palette, `${name}: 并集调色板`).toEqual(docPayload.palette)
      expect(facePayload.sizeColumn, `${name}: 声明尺寸列`).toBe(docPayload.sizeColumn)
      expect(facePayload.sizeRow, `${name}: 声明尺寸行`).toBe(docPayload.sizeRow)
      expect(facePayload.sizeZSlice, `${name}: 声明尺寸层`).toBe(docPayload.sizeZSlice)
    }
  })

  it('负对照（区分力）：不填 body ⇒ 装配**显式失败**，不回落旧文档、不静默产空', () => {
    // 同一条判据本体的两处：填了 ⇒ 成功；不填 ⇒ 失败。第一步证明第二步不是恒真。
    const filled = assembleMultiblockKernelFace({
      body: multiblockBodyContentOf(parseMultiblockDeclaration(innerOf('multiblock-tier-only'))),
    })
    expect(filled.ok, '填了 body 必须成功（否则下面的失败断言无区分力）').toBe(true)

    const empty = assembleMultiblockKernelFace({ body: null })
    expect(empty.ok, '不填 body 必须**显式失败**').toBe(false)
    if (empty.ok) throw new Error('unreachable')
    expect(empty.error.code).toBe('InvalidValue')
    expect(empty.error.params.reason).toBe('multiblockBodyNotCarried')
    // "不静默产空"的机械形态：失败分支**没有** `value`。
    expect(empty as unknown as Record<string, unknown>).not.toHaveProperty('value')
  })
})

describe('R2-G3 · 过渡不变式：诊断出现 ⇒ 该帧声明 grid 被忽略（机械可判）', () => {
  it('注入帧参考网格 ⇒ 报 `FrameCellGridNotCarried`、进**取证通道**，而装配结果逐格不变', () => {
    const name = 'multiblock-tier-only'

    const clean = multiblockBodyContentOf(parseMultiblockDeclaration(innerOf(name)))
    const cleanOut = unwrap(assembleMultiblockKernelFace({ body: clean }))

    // ---- 取证样本：给第 0 帧注入一个**维度故意不同**的参考网格 -------------------
    // 维度不同是关键：若求值端读了它，装配结果的尺寸/逐格立刻变（③ 的区分力所在）。
    const injectedInner = innerOf(name)
    const injectedGrid = [[[9]]]
    ;(injectedInner.frames as Record<string, unknown>[])[0]!.cellGrid = injectedGrid

    const parsedInjected = parseMultiblockDeclaration(injectedInner)
    // 诊断：声明侧**保留**该码（#388 评论 7501 第 4 项）——它的语义是"**声明**不承载它"。
    const codes = multiblockBodyOf(parsedInjected).diagnostics.map((d) => d.code)
    expect(codes).toContain('FrameCellGridNotCarried')

    const injected = multiblockBodyContentOf(parsedInjected)
    // 承运：取证通道拿到了它（不是静默丢），帧号 = 该帧的**声明下标**。
    expect(injected.sceneGridEvidence).toHaveLength(1)
    expect(injected.sceneGridEvidence[0]!.sceneIndex).toBe(clean.declaration.scenes[0]!.index)
    expect(injected.sceneGridEvidence[0]!.cellGrid).toEqual([[[9]]])
    // 与解析侧原物**不同物**（拷贝 + 逐层冻结）。
    expect(injected.sceneGridEvidence[0]!.cellGrid).not.toBe(injectedGrid)
    expect(Object.isFrozen(injected.sceneGridEvidence[0]!.cellGrid)).toBe(true)

    // ---- 不变式 1：取证网格**不进身份**（带与不带 ⇒ 同摘要） -------------------
    expect(multiblockDeclDigest(injected.declaration)).toBe(multiblockDeclDigest(clean.declaration))
    for (const frame of injected.declaration.scenes) {
      expect(frame as unknown as Record<string, unknown>).not.toHaveProperty('cellGrid')
    }

    // ---- 不变式 2：取证网格**不进求值/渲染**（带与不带 ⇒ 逐格相等） -------------
    const injectedOut = unwrap(assembleMultiblockKernelFace({ body: injected }))
    const injectedPayload = injectedOut.payload as unknown as BlockGridPayload
    const cleanPayload = cleanOut.payload as unknown as BlockGridPayload
    expect(cellKeysOf(injectedPayload)).toEqual(cellKeysOf(cleanPayload))
    expect(injectedPayload.cells).toEqual(cleanPayload.cells)
    expect(injectedPayload.sizeColumn).toBe(cleanPayload.sizeColumn)
    expect(injectedPayload.sizeRow).toBe(cleanPayload.sizeRow)
    expect(injectedPayload.sizeZSlice).toBe(cleanPayload.sizeZSlice)

    // ---- 区分力证明：取证样本与求值产物**维度不同** ⇒ "逐格相等"不是恒真 ----------
    // （1×1×1 的取证样本 vs 骨架阶的 [d][h][w]；求值若读了它，上面的判据必红。）
    expect(injectedGrid).toEqual([[[9]]])
    expect([cleanOut.grid.depth, cleanOut.grid.height, cleanOut.grid.width]).not.toEqual([1, 1, 1])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 语义桥（#388 评论 7717 的条件 (a)(b)）：两种记法**只在这一处相遇**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 装配根源码。**读后归一化 CRLF**：本仓 `core.autocrlf=true`，新鲜检出是 CRLF，
 * 而执行者工具写出的工作树常是 LF —— 不归一化的源码判据只在 LF 树上绿（AGENTS 铁律 6）。
 */
function assemblyRootSource(): string {
  return fs
    .readFileSync(path.join(process.cwd(), 'src', 'composition', 'kernelAssembly.ts'), 'utf8')
    .replace(/\r\n/g, '\n')
}

/** 只看**代码行**：桥的说明里逐字写着 `{ max: hi }` —— 那是文档，不是写点。 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')
}

/** 抽取一个顶层函数的源码区间（`function 名(` → 其后第一个列首 `}`）。 */
function functionSource(code: string, name: string): string {
  const start = code.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`找不到函数 ${name}（判据的前提，实现改名即须同批改判据）`)
  const end = code.indexOf('\n}', start)
  if (end < 0) throw new Error(`函数 ${name} 的结尾不可定位（判据的前提）`)
  return code.slice(start, end + 2)
}

describe('R2-G3 · 语义桥（#388 评论 7717 条件 a/b）：两种记法只在这一处相遇', () => {
  it('① 文件格式通道域的写点在全文件里**恰好一处**，且落在具名桥函数内', () => {
    const raw = assemblyRootSource()
    const code = codeOnly(raw)
    // 前提自检：桥确实存在（否则下面的"恰好一处"可能因为一处都没有而误判）。
    expect(raw.includes('{ max: domain.hi }'), '前提：源码里确有这座桥').toBe(true)

    const writes = [...code.matchAll(/\{\s*max\s*:/g)]
    expect(writes.length, '文件格式通道域（`{ max: … }`）的写点必须**恰好一处** —— 散落即判红').toBe(1)

    const at = writes[0]!.index ?? -1
    const bridge = functionSource(code, 'evaluatorChannelDomainOf')
    const bridgeStart = code.indexOf(bridge)
    expect(at, '唯一写点必须落在具名桥函数里（内联回调用点即判红）').toBeGreaterThanOrEqual(bridgeStart)
    expect(at).toBeLessThan(bridgeStart + bridge.length)
    // 端口适配**只经**这一处：它自己不得再写 `{ max: … }`。
    expect(
      functionSource(code, 'evaluatorMultiblockOf').includes('evaluatorChannelDomainOf('),
      '端口适配必须调用这座桥（不得自己内联换键）',
    ).toBe(true)
  })

  it('② 桥**只**换这一个语义字段（不是通用"内核 → 旧形状"转换器）', () => {
    const bridge = functionSource(codeOnly(assemblyRootSource()), 'evaluatorChannelDomainOf')
    const body = bridge
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
    // 签名 + **唯一一条** return + 收尾 —— 多一行即说明它开始长成转换器。
    expect(body, '桥体不得增长（它只许换通道取值域这一个字段）').toHaveLength(3)
    expect(body[1], '桥体必须只有一处换键，值直取声明的域上界').toBe('return { max: domain.hi }')
  })
})
