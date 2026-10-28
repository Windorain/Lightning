/**
 * **旧文档 → 内核场景装配** 验收（核心判据）。
 *
 * ## 本文件证明什么（以及为什么必须用**真实产物**）
 *
 * 缺口是「全树没有任何生产代码从旧场景文件构造内核 `Scene`」。
 * 因此本文件的判据必须落在**真实的多方块夹具**上 —— 用合成的最小 JSON 证明
 * "能装配"会让缺口以"自造夹具恰好满足装配层假设"的形态被掩盖（
 * `plainCodec` 文件头对同一陷阱有逐字记录：手写夹具的键序与 `JSON.stringify` 一致，
 * 故缺陷在自造夹具上永不出现）。
 *
 * 三份夹具（`web/src/context/__tests__/fixtures/`）：
 * `multiblock-ebf-2ch`（432 帧/3 通道）、`multiblock-lsc-overlap`（108/3）、
 * `multiblock-tier-only`（12/1）。
 *
 * ## 判据分三层（每层对应一条会被静默违反的约束）
 *
 * | 层 | 判据 | 违反的后果 |
 * |---|---|---|
 * | 形态 | 真实文件 → 解析器 → 内核 `Scene` 的**对象确实存在**且 `cells` 非空 | 「装配成功」是一句空话 |
 * | 归属 | 多方块网格的 `ObjectData.source === 'content'` ⇒ 写权 `readOnly` | §3.3「生成对象只读」被通用对象模型吃掉 |
 * | 不丢 | 未知字段进保真记录**且**产诊断；内容三块（元数据/时长轴/资源）逐项有值 | 「不能静默丢失无法解释的语义」 |
 *
 * ## 负对照（A24 要求「负对照必须证明确实破坏了目标保证」）
 *
 * 见文件末的「负对照」组：它**故意**构造出违规形态（把 content 来源改成 document、
 * 抽掉未知字段的记录），证明上面的判据会判红 —— 不是靠"测试主动抛错"。
 */

import { describe, expect, it } from 'vitest'
import { assembleKernelDocument, blockCellKey, KNOWN_ROOT_KEYS } from '@/composition/kernelAssembly'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { writeAuthority, findObject, findObjectData, objectsInOrder } from '@/domain/scene'
import { resourceIdentity } from '@/domain/content'
import { unwrap } from '@/domain/errors'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { createParserRegistry } from '@/context/parserRegistry'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'

/** 三份真实夹具（与 `multiblockAssembler.test.ts` 同一清单）。 */
const FIXTURES = ['multiblock-ebf-2ch', 'multiblock-lsc-overlap', 'multiblock-tier-only'] as const

/** 各夹具的已声明帧数（契约 §9.3）。 */
const EXPECTED_FRAMES: Record<string, number> = {
  'multiblock-ebf-2ch': 432,
  'multiblock-lsc-overlap': 108,
  'multiblock-tier-only': 12,
}

/** 各夹具的通道声明条数（`multiblock-fixture-load.spec.ts` 的 REQUIRED_TRIPLE）。 */
const EXPECTED_CHANNELS: Record<string, number> = {
  'multiblock-ebf-2ch': 3,
  'multiblock-lsc-overlap': 3,
  'multiblock-tier-only': 1,
}

/**
 * 走**生产解析路径**把夹具原件读成 `RuntimeDocument`。
 *
 * 为什么必须经解析器而不是手工 `new RuntimeDocument(...)`：解析器是真实产物的
 * 入口（信封解包 + 形态判别 + 帧/多方块声明构建）。绕过它，本文件就只证明了
 * "装配层能处理我手工构造的对象"，而不是"能处理真实文件"。
 */
/**
 * 走**生产解析路径**把夹具原件读成 `RuntimeDocument`，并同时交出解析器看到的 plain 根。
 *
 * 为什么必须同时给 plain 根：`RuntimeDocument` 是**有损**中间层 ——
 * `fromV2Plain` 的 `known` 集合列了 `label`/`author`/`description` 等根级键
 * 却从不读、也排除在 `_extra` 外，于是它们从 `RuntimeDocument` **无法恢复**。
 * 实测：`plain.label` 有值而 `doc.serialize().label === undefined`。
 */
async function parseFixture(name: string): Promise<{
  readonly doc: RuntimeDocument
  readonly plainRoot: Readonly<Record<string, unknown>>
}> {
  const registry = createParserRegistry()
  // 喂**信封原件**（不是解包后的内层 body）：生产解析路径正是"信封 → 解包 →
  // 合并 meta → 构建声明"（`multiblockParser.parse`）。
  const envelope = readJson(fixturePath(name)) as Record<string, unknown>
  const result = await registry.detectAndParse(envelope)
  expect(result.document, `${name} 应能被生产解析器解析`).not.toBeNull()
  // 解析器看到的 plain 根 = 信封解包 + meta 合并（`readEnvelopeLayers` 的产物）。
  // 这里用**同一个生产函数**取它，而不是自己拼一份 —— 否则"装配层看到的源"
  // 与"解析器看到的源"可能不同，判据就失去意义。
  const layers = await readEnvelopeLayers(envelope as never)
  return { doc: result.document!, plainRoot: layers.plain }
}

/** 便利：只要文档。 */
async function fixtureDoc(name: string): Promise<RuntimeDocument> {
  return (await parseFixture(name)).doc
}

describe('真实多方块夹具 → 内核 Scene（形态层）', () => {
  for (const name of FIXTURES) {
    it(`${name}：真实文件经解析器装配出非空内核场景`, async () => {
      const doc = await fixtureDoc(name)
      expect(doc.isMultiblock, `${name} 应被判为多方块为主文档`).toBe(true)
      expect(doc.frameCount, `${name} 帧数应与文件声明一致`).toBe(EXPECTED_FRAMES[name])

      const assembled = unwrap(assembleKernelDocument({ doc }))

      // ── 反空洞真：对象确实存在 ──
      expect(assembled.scene.order.length, `${name} 装配出的对象数必须 > 0`).toBeGreaterThan(0)

      // ── 多方块网格对象确实存在且 cells 非空（不是"空壳对象"） ──
      const mbObject = findObject(assembled.scene, 'structure:multiblock')
      expect(mbObject, `${name} 应装配出多方块网格对象`).toBeDefined()
      const mbData = findObjectData(assembled.scene, mbObject!.dataId)
      expect(mbData, `${name} 多方块对象应有数据`).toBeDefined()
      expect(mbData!.payload.kind, `${name} 多方块数据应是 blockGrid`).toBe('blockGrid')
      if (mbData!.payload.kind === 'blockGrid') {
        const cellCount = Object.keys(mbData!.payload.cells).length
        expect(cellCount, `${name} 装配网格的实心格数必须 > 0（否则"装配成功"是空话）`).toBeGreaterThan(0)
      }

      // ── 帧对象映射：多方块文档的网格是装配产物，故恰一个网格对象 ──
      expect(assembled.frameObjects.length, `${name} 应恰有一个可渲染网格对象`).toBe(1)
    })
  }

  it('帧为主文档（minimal-v2 同形）装配出**每帧一个**网格对象', () => {
    // 合成一份最小帧为主文档：**不是**用来证明"能装配"（那由上面三份真实夹具证明），
    // 而是专门证明"多帧 → 多对象"这条映射（真实多方块夹具恰好只有 1 个网格对象，
    // 覆盖不到这条路径）。
    const grid = {
      cellGrid: [[[1, 0], [0, 1]]],
      blockPalette: [
        { registryId: 'air', meta: 0, renderMode: 'BlockModel' },
        { registryId: 'minecraft:stone', meta: 0, renderMode: 'BlockModel' },
      ],
    }
    const doc = RuntimeDocument.fromV2Plain({
      format_version: '2.0',
      id: 'frame-dominant',
      meta: { name: '两帧', author: 'a', created_at_ms: 1, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
      annotations: [],
      labels: [],
      frames: [
        { index: 0, label: 'f0', durationMs: 50, structure: grid },
        { index: 1, label: 'f1', durationMs: 100, structure: grid },
      ],
    })
    expect(doc, '合成帧为主文档应能解析').not.toBeNull()

    const assembled = unwrap(assembleKernelDocument({ doc: doc! }))
    expect(assembled.frameObjects, '两帧应装配出两个网格对象').toEqual(['structure:frame-0', 'structure:frame-1'])
    // 帧时长轴逐项保留（`durationMs` 是文档声明，不是播放状态）
    expect(assembled.content.frameAxis.frames.map((f) => f.durationMs)).toEqual([50, 100])
    // 帧键（落盘的 `index`）与标签都在轴上
    expect(assembled.content.frameAxis.frames.map((f) => f.index)).toEqual([0, 1])
    expect(assembled.content.frameAxis.frames.map((f) => f.label)).toEqual(['f0', 'f1'])
  })
})

describe('写权归属（内核契约 §3.4「生成对象只读」的可执行面）', () => {
  it('多方块生成物的写权是 readOnly（`source: content`）', async () => {
    const doc = await fixtureDoc('multiblock-tier-only')
    const assembled = unwrap(assembleKernelDocument({ doc }))
    const mbObject = findObject(assembled.scene, 'structure:multiblock')!
    const mbData = findObjectData(assembled.scene, mbObject.dataId)!
    expect(mbData.source, '多方块生成物的来源应是 content（只读内容定义）').toBe('content')
    expect(
      writeAuthority(assembled.scene, mbObject.id),
      '§3.3：生成对象可查询和拾取，但写能力为只读',
    ).toBe('readOnly')
  })

  it('帧为主文档的网格写权是 writable（用户内容）', () => {
    const grid = {
      cellGrid: [[[1]]],
      blockPalette: [
        { registryId: 'air', meta: 0, renderMode: 'BlockModel' },
        { registryId: 'minecraft:stone', meta: 0, renderMode: 'BlockModel' },
      ],
    }
    const doc = RuntimeDocument.fromV2Plain({
      format_version: '2.0',
      id: 'writable',
      meta: { name: '', author: '', created_at_ms: 1, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
      annotations: [],
      labels: [],
      frames: [{ index: 0, structure: grid }],
    })!
    const assembled = unwrap(assembleKernelDocument({ doc }))
    expect(
      writeAuthority(assembled.scene, 'structure:frame-0'),
      '帧自带网格是用户内容 ⇒ 可写（与多方块生成物形成对照）',
    ).toBe('writable')
  })
})

describe('不静默丢失（保真记录 + 诊断）', () => {
  it('真实夹具的**全部**顶层键都被解释或有保真记录（无静默丢弃）', async () => {
    for (const name of FIXTURES) {
      const doc = await fixtureDoc(name)
      const assembled = unwrap(assembleKernelDocument({ doc }))
      const serialized = doc.serialize()
      // 反空洞真：这份文件**确实**有顶层键可被解释
      expect(Object.keys(serialized).length, `${name} 应有顶层键`).toBeGreaterThan(0)
      // 每个顶层键：要么在已解释清单里，要么进保真记录 —— **没有第三种**。
      for (const key of Object.keys(serialized)) {
        const explained = KNOWN_ROOT_KEYS.includes(key)
        const recorded = Object.prototype.hasOwnProperty.call(assembled.unknownFields, key)
        expect(
          explained || recorded,
          `${name} 的顶层键 ${key} 既未被解释也未报为未知字段（这正是"静默丢失"）`,
        ).toBe(true)
      }
      // 未知字段的来源身份必须齐备（调用方据此构造保真记录 —— 记录带源格式/源版本）
      expect(assembled.sourceFormat.length, `${name} 必须报出源格式（供保真记录使用）`).toBeGreaterThan(0)
      expect(assembled.sourceVersion.length, `${name} 必须报出源版本（供保真记录使用）`).toBeGreaterThan(0)
    }
  })

  it('内容三块逐项有值（元数据 / 帧时长轴 / 资源引用）', async () => {
    const { doc, plainRoot } = await parseFixture('multiblock-ebf-2ch')
    const assembled = unwrap(assembleKernelDocument({ doc, plainRoot }))
    // 元数据：具名字段（不是字段袋）
    expect(assembled.content.metadata.name.length, '元数据 name 应被装配').toBeGreaterThan(0)
    // ## 实测抓出的真实缺陷（判据的**来历**，不是装饰）
    //
    // 真实多方块产物的展示名在**信封 `meta.label`**，而信封解包把 meta 的键
    // **摊平到 plain 根**（`readEnvelopeLayers`），于是 `doc.meta` 是空默认值；
    // 更糟的是 `fromV2Plain` 把 `label` 列进 `known` 却不读、也不收进 `_extra`
    // ⇒ 它从 `RuntimeDocument` **无法恢复**（`doc.serialize().label === undefined`）。
    //
    // ⇒ 装配层必须吃 plain 根（`AssemblyInput.plainRoot`）。下面几条断言把这个
    // 缺陷钉死：它们若判红，说明装配层又只从有损中间层读元数据了。
    expect(doc.meta.name, '前提：真实夹具的 meta.name 确实是空的（缺陷的成因）').toBe('')
    expect(
      doc.serialize().label,
      '前提：label 已从 RuntimeDocument 丢失（known 列了却不读 ⇒ 有损中间层）',
    ).toBeUndefined()
    expect(plainRoot.label, '前提：plain 根上确实有展示名').toBeTruthy()
    expect(
      assembled.content.metadata.name,
      '装配出的展示名必须等于 plain 根的 label（生产标题优先级：根 label → meta.name → meta.label）',
    ).toBe(plainRoot.label)
    expect(assembled.content.metadata.author, '作者应被装配（同样来自 plain 根）').toBe(plainRoot.author)
    expect(assembled.content.metadata.description.length, '描述应被装配').toBeGreaterThan(0)
    // 多方块的**场景清单不进时间轴** —— 帧轴必须为空，但场景声明必须仍全部承载
    expect(
      assembled.content.frameAxis.frames.length,
      '多方块文档的帧轴必须为空（帧清单 = 变体配置集合，不是时间轴）',
    ).toBe(0)
    expect(
      assembled.multiblock!.projection.scenes.length,
      '场景声明必须仍全部承载（空帧轴 ≠ 丢内容）',
    ).toBe(EXPECTED_FRAMES['multiblock-ebf-2ch'])
    // 资源引用：真实夹具内嵌纹理 ⇒ 必须有资源且**每条都有内容版本**
    expect(assembled.content.resources.length, 'ebf-2ch 应装配出资源引用').toBeGreaterThan(0)
    for (const r of assembled.content.resources) {
      expect(r.ref.contentVersion.length, `资源 ${r.ref.assetId} 必须有内容版本（内容身份与版本）`).toBeGreaterThan(0)
      // 身份键由唯一权威给出（不是本地拼串）
      expect(resourceIdentity(r)).toBe(`${r.ref.assetId}\u0000${r.ref.contentVersion}`)
    }
  })

  it('多方块声明被装配为**只读内容定义**（通道/运行态/变体与文件一致）', async () => {
    for (const name of FIXTURES) {
      const doc = await fixtureDoc(name)
      const assembled = unwrap(assembleKernelDocument({ doc }))
      expect(assembled.multiblock, `${name} 应装配出多方块声明`).not.toBeNull()
      expect(
        assembled.multiblock!.channels.length,
        `${name} 通道声明条数应与文件一致`,
      ).toBe(EXPECTED_CHANNELS[name])
      expect(assembled.multiblock!.variants.length, `${name} 变体数应与文件一致`).toBe(EXPECTED_FRAMES[name])
      // `source`（整个内层 body 的原始 JSON 回显）**已退役**；
      // 保留的是 `declRaw`（**单个** `multiblock` 节的扩展键保真）。
      // 本条断言随之改判 `declRaw` —— 它证明"声明原文可用"这一事实仍然成立，
      // 同时证明"内层 body 整份回显"已经不在产物里。
      expect(assembled.multiblock!.declRaw, `${name} 的 multiblock 节原文应可用（扩展键保真）`).toBeTruthy()
      expect(
        Object.prototype.hasOwnProperty.call(assembled.multiblock!, 'source'),
        `${name} 产物不得再有 source（原始 JSON 回显已退役）`,
      ).toBe(false)
    }
  })

  it('未知顶层字段**同时**产保真记录与诊断（不是只躺进存储）', () => {
    const doc = RuntimeDocument.fromV2Plain({
      format_version: '2.0',
      id: 'with-unknown',
      meta: { name: '', author: '', created_at_ms: 1, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
      annotations: [],
      labels: [],
      frames: [
        {
          index: 0,
          structure: {
            cellGrid: [[[1]]],
            blockPalette: [
              { registryId: 'air', meta: 0, renderMode: 'BlockModel' },
              { registryId: 'minecraft:stone', meta: 0, renderMode: 'BlockModel' },
            ],
          },
        },
      ],
      someFutureField: { nested: true },
    })!
    const assembled = unwrap(assembleKernelDocument({ doc }))
    // ① 保真记录里有它（带源格式/源版本）
    expect(
      Object.prototype.hasOwnProperty.call(assembled.unknownFields, 'someFutureField'),
      '未知字段必须被报为 unknownFields（供调用方进保真记录）',
    ).toBe(true)
    // ② 诊断里也有它（于是"这份文件有什么我们没解释"在 UI/日志上可见）
    const diag = assembled.diagnostics.filter((d) => d.code === 'unknownRootField')
    expect(
      diag.some((d) => d.path === '$.someFutureField'),
      '未知字段必须同时产诊断（否则它只在存储里躺着）',
    ).toBe(true)
    // ③ 核心文档里**没有**字段袋（核心无字段袋）
    expect(
      Object.prototype.hasOwnProperty.call(assembled.scene, '_extra'),
      '内核场景不得出现字段袋 `_extra`',
    ).toBe(false)
  })
})

describe('负对照（证明判据不是恒绿）', () => {
  it('负对照：把 content 来源改成 document ⇒ 写权判据会判红', async () => {
    const doc = await fixtureDoc('multiblock-tier-only')
    const assembled = unwrap(assembleKernelDocument({ doc }))
    const mbObject = findObject(assembled.scene, 'structure:multiblock')!
    const mbData = findObjectData(assembled.scene, mbObject.dataId)!
    // 故意构造违规形态：把来源改成 document（"生成物变得可编辑"）
    const tampered = {
      ...assembled.scene,
      data: { ...assembled.scene.data, [mbData.id]: { ...mbData, source: 'document' as const } },
    }
    expect(
      writeAuthority(tampered, mbObject.id),
      '§3.3 负对照：生成物一旦可写，"只读内容定义"这条保证确实被破坏（故上面的 readOnly 判据有意义）',
    ).toBe('writable')
  })

  it('负对照：把未知字段从已解释清单里加进去 ⇒ 上一条"无静默丢弃"会失效', () => {
    // 与上一条**同一个**判定式，只换事实来源。
    const key = 'someFutureField'
    const explainedIfListed = KNOWN_ROOT_KEYS.includes(key)
    expect(explainedIfListed, '该键**不**应在已解释清单里（否则上一条判据对它是空转）').toBe(false)
    // 而一旦有人把它加进清单（"假装已解释"），保真记录就不再收它 ⇒ 静默丢失。
    const fakeKnown = [...KNOWN_ROOT_KEYS, key]
    expect(fakeKnown.includes(key), '把它列进清单后，判据的"已解释"分支会成立 ⇒ 它不再进保真记录').toBe(true)
  })

  it('负对照：形态不可识别的文档 ⇒ 显式失败，不装配出假成功', () => {
    // 没有 frames、不是多方块、也没有可识别网格的文档。
    const doc = new RuntimeDocument({ id: 'unknown-shape', frames: [], meta: {}, annotations: [], labels: [] })
    const result = assembleKernelDocument({ doc })
    expect(result.ok, '不可识别形态必须**显式失败**（禁止假成功）').toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('InvalidValue')
      expect(result.error.params.reason).toBe('unsupportedDocumentShape')
    }
  })

  it('负对照：blockGrid 的 cells 键格式确实参与判据（换格式则键集合不同）', () => {
    const a = blockCellKey(1, 2, 3)
    expect(a).toBe('1,2,3')
    // 用契约下标序（z,row,x）写键会得到不同的键 ⇒ 逐格比对会失败。
    expect(`3,2,1`, '行序与坐标序不可互换（重复坐标翻转是负对照）').not.toBe(a)
  })
})

describe('装配的纯度与可重放性', () => {
  it('同一份文件两次装配得到**逐位相同**的内容身份（A02/A04 前提）', async () => {
    const doc = await fixtureDoc('multiblock-tier-only')
    const a = unwrap(assembleKernelDocument({ doc }))
    const b = unwrap(assembleKernelDocument({ doc }))
    // 内容三块逐位相同（故内容身份必然相同 —— 装配是纯映射，不读时钟/随机）
    expect(JSON.stringify(a.content)).toBe(JSON.stringify(b.content))
    // 场景的对象身份集合相同（装配**不**分配随机 id）
    expect(a.scene.order).toEqual(b.scene.order)
  })

  it('装配产出的应用状态**可结构化克隆**（A04「无需 DOM/GPU 重放」的前提）', async () => {
    const doc = await fixtureDoc('multiblock-tier-only')
    const assembled = unwrap(assembleKernelDocument({ doc }))
    expect(() => structuredClone(assembled.scene), '内核场景必须可克隆（含全部对象与数据）').not.toThrow()
    expect(() => structuredClone(assembled.content), '内容三块必须可克隆').not.toThrow()
  })

  it('对象顺序稳定（`scene.order` 与装配顺序一致，可复现）', async () => {
    const doc = await fixtureDoc('multiblock-tier-only')
    const assembled = unwrap(assembleKernelDocument({ doc }))
    expect(assembled.scene.order, 'scene.order 应与 objects 表键序一致').toEqual(objectsInOrder(assembled.scene).map((o) => o.id))
  })
})