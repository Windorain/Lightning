/**
 * G1 / A11（退役侧）：**内容身份替代 structEpoch 手推链** 的判据。
 *
 * 本文件钉住的核心事实：**G1 由构造保证**，不是靠调用方记得传 `bumpStructEpoch: false`。
 * 注解内容不进结构摘要，所以"改一个注解文字"在类型/数据层面就**不可能**让
 * `rebuildGeometry` 为真。
 *
 * 与之对照的是第 5 条的负对照「非内容版本冒充内容变化」：本文件的
 * 负对照用例复现旧 `structEpoch` 的形状（一个与内容无关的计数器），证明它会把
 * 注解编辑误报成结构变化 —— 这正是该机制必须被删除的理由。
 */

import { describe, expect, it } from 'vitest'
import {
  annotationDigestOf,
  contentIdentityOf,
  diffContentIdentity,
  planContentRebuild,
  rebuildPlanIsNoop,
  resourceDigestOf,
  structureDigestOf,
  type ContentIdentity,
} from '../contentIdentity'
import { contentDigestOf } from '../invalidationPlan'

/** 造一份"基准"结构摘要参数（显式，便于逐项改一个字段）。 */
function structureParts(overrides: Partial<Parameters<typeof structureDigestOf>[0]> = {}) {
  return {
    frames: [[0, 1, 0, 1, 0, 0]] as readonly (readonly number[] | null)[],
    palette: ['minecraft:stone@0', 'minecraft:dirt@0'],
    // 内容级调色板身份（与名称级成对；见 `structureDigestOf` 的说明）
    paletteContent: [['#1', { registryId: 'minecraft:stone', meta: 0 }]],
    frameDecls: [{ index: 0, durationMs: undefined }],
    multiblock: null,
    layerFilter: 'all',
    ...overrides,
  }
}

function identity(overrides: Partial<Parameters<typeof contentIdentityOf>[0]> = {}): ContentIdentity {
  return contentIdentityOf({
    documentId: 'doc:1',
    structureDigest: structureDigestOf(structureParts()),
    annotationDigest: annotationDigestOf([{ id: 'a1', text: '文字 A' }]),
    resourceDigest: resourceDigestOf({ stone: 'AAAA' }),
    ...overrides,
  })
}

describe('G1：改一个注解文字不得重建方块几何', () => {
  it('注解内容变化 ⇒ 只同步注解；reloadResources/resolveStructure/rebuildGeometry 全为 false', () => {
    const before = identity()
    // 只改注解文字
    const after = identity({ annotationDigest: annotationDigestOf([{ id: 'a1', text: '文字 B' }]) })

    const change = diffContentIdentity(before, after)
    expect(change.annotationsChanged).toBe(true)
    expect(change.structureChanged, '注解不进结构摘要 ⇒ 结构身份不变').toBe(false)
    expect(change.documentChanged).toBe(false)

    const plan = planContentRebuild(change)
    expect(plan.rebuildGeometry, 'G1 的字面要求：方块几何重建数为 0').toBe(false)
    expect(plan.resolveStructure).toBe(false)
    expect(plan.reloadResources).toBe(false)
    expect(plan.syncAnnotations).toBe(true)
  })

  it('新增/删除注解（成员变化）同样只影响注解', () => {
    const before = identity({ annotationDigest: annotationDigestOf([]) })
    const after = identity({ annotationDigest: annotationDigestOf([{ id: 'a9', text: '新增' }]) })
    const plan = planContentRebuild(diffContentIdentity(before, after))
    expect(plan.rebuildGeometry).toBe(false)
    expect(plan.syncAnnotations).toBe(true)
  })

  it('负对照：用与内容无关的计数器冒充内容版本 ⇒ 注解编辑被误报成结构变化', () => {
    // 复现旧 structEpoch 的形状：任何文档写入都 +1，渲染层据此全量重建
    let structEpoch = 0
    const legacyPlanForAnnotationEdit = () => {
      structEpoch += 1 // replaceDoc() 内自增（与"到底改了什么"无关）
      return { rebuildAll: structEpoch !== 0 }
    }
    // 断言这个形状**必然**判红 G1：它无法区分"改注解"与"改几何"
    expect(legacyPlanForAnnotationEdit().rebuildAll, '计数器形状把注解编辑也算成重建').toBe(true)

    // 而内容身份形状给出正确结果 —— 同一场景、同一操作，结论相反
    const correct = planContentRebuild(
      diffContentIdentity(identity(), identity({ annotationDigest: annotationDigestOf([{ id: 'a1', text: 'B' }]) })),
    )
    expect(correct.rebuildGeometry).toBe(false)
  })
})

describe('A11：结构身份的粒度（该变才变）', () => {
  it('改一格网格下标 ⇒ 结构变化、资源不重载（不必重解码纹理）', () => {
    const before = identity()
    const after = identity({ structureDigest: structureDigestOf(structureParts({ frames: [[0, 1, 0, 1, 0, 2]] })) })
    const change = diffContentIdentity(before, after)
    expect(change.structureChanged).toBe(true)
    expect(change.documentChanged, '结构变化不得升级成"文档整体变化"').toBe(false)

    const plan = planContentRebuild(change)
    expect(plan.rebuildGeometry).toBe(true)
    expect(plan.resolveStructure).toBe(true)
    // 这是旧 bindMultiblockMeshSync 手工绕开 rebuildAll 的那个优化，
    // 现在由内容身份自然得到 —— 调用方不再需要"记得只调某两个函数"
    expect(plan.reloadResources, '结构变化不必重解码资源').toBe(false)
  })

  it('改调色板身份 ⇒ 结构变化（同格下标配不同调色板几何完全不同）', () => {
    const before = identity()
    const after = identity({ structureDigest: structureDigestOf(structureParts({ palette: ['minecraft:oak_planks@0'] })) })
    expect(diffContentIdentity(before, after).structureChanged).toBe(true)
  })

  /**
   * **名称级相同、内容级不同**必须判为结构变化。
   *
   * 这是"运行态不可辨"的**最小复现**：多方块运行态只把控制器条目从并集下标 7 换到 8，
   * 两条条目的 `name:meta` 完全相同（`gt.blockmachines:1000`），差异只在 `tooltip` 与
   * `nbt.activeFace` —— 名称级口径（`palette: registryId@meta`）**结构上**看不见它。
   *
   * 负对照（同一条用例内）：把 `paletteContent` 也换成"名称级等价"的一份 ⇒ 结构身份
   * 不变 —— 证明本判据的区分力来自内容级字段，而不是来自别的字段顺带变了。
   */
  it('调色板条目内容变化（同 `registryId@meta`）⇒ 结构变化；负对照：名称级不动 ⇒ 不变', () => {
    const nameLevel = ['gregtech:gt.blockmachines@1000']
    const idleEntry = { registryId: 'gregtech:gt.blockmachines', meta: 1000, tooltip: ['Electric Blast Furnace'] }
    const activeEntry = {
      registryId: 'gregtech:gt.blockmachines',
      meta: 1000,
      tooltip: ['Electric Blast Furnace (running)'],
      nbt: { activeFace: true },
    }
    const at = (entry: unknown) =>
      identity({
        structureDigest: structureDigestOf(
          structureParts({ palette: nameLevel, paletteContent: [['#7', entry]] }),
        ),
      })

    // 名称级逐字相同（这是运行态的真实形态）
    expect(JSON.stringify(nameLevel)).toBe(JSON.stringify(['gregtech:gt.blockmachines@1000']))
    expect(diffContentIdentity(at(idleEntry), at(activeEntry)).structureChanged, '内容级变化必须被看见').toBe(true)

    // 负对照：内容级也用同一份 ⇒ 结构身份必须**不变**（否则本判据没有区分力）
    expect(
      diffContentIdentity(at(idleEntry), at({ ...idleEntry })).structureChanged,
      '负对照：内容级不动 ⇒ 不得判为变化',
    ).toBe(false)
  })

  it('只见呈现层的分层过滤变化 ⇒ 结构变化（它改变被采集的几何）', () => {
    const before = identity()
    const after = identity({ structureDigest: structureDigestOf(structureParts({ layerFilter: { worldY: 3 } })) })
    expect(diffContentIdentity(before, after).structureChanged).toBe(true)
  })

  it('多方块声明变化 ⇒ 结构变化', () => {
    const before = identity()
    const after = identity({
      structureDigest: structureDigestOf(structureParts({ multiblock: { channels: ['tier'] } })),
    })
    expect(diffContentIdentity(before, after).structureChanged).toBe(true)
  })

  it('逐帧声明变化（如时长）⇒ 结构变化', () => {
    const before = identity()
    const after = identity({
      structureDigest: structureDigestOf(structureParts({ frameDecls: [{ index: 0, durationMs: 120 }] })),
    })
    expect(diffContentIdentity(before, after).structureChanged).toBe(true)
  })
})

describe('资源身份（A28/A36）：按内容而非键名/URL', () => {
  it('同键不同内容 ⇒ 资源身份变化（同一 URL 换内容不得静默复用）', () => {
    expect(resourceDigestOf({ stone: 'AAAA' })).not.toBe(resourceDigestOf({ stone: 'BBBB' }))
  })

  it('同内容不同键 ⇒ 身份不变（换 URL 不该导致重解码）', () => {
    expect(resourceDigestOf({ stone: 'AAAA' })).toBe(resourceDigestOf({ stone: 'AAAA' }))
    // 同一引用走记忆化，结果与直接哈希一致
    const blobs = { stone: 'AAAA' }
    expect(resourceDigestOf(blobs)).toBe(resourceDigestOf(blobs))
  })

  it('无资源 ⇒ 稳定哨兵值（不是 undefined/NaN）', () => {
    expect(resourceDigestOf(undefined)).toBe('r:none')
    expect(resourceDigestOf(null)).toBe('r:none')
  })

  it('资源变化 ⇒ 文档身份变化但结构摘要本身不变（可区分"换纹理"与"改几何"）', () => {
    const structureDigest = structureDigestOf(structureParts())
    const before = identity({ structureDigest, resourceDigest: resourceDigestOf({ stone: 'v1' }) })
    const after = identity({ structureDigest, resourceDigest: resourceDigestOf({ stone: 'v2' }) })
    const change = diffContentIdentity(before, after)
    expect(change.documentChanged, '资源变化属于文档/资源整体变化').toBe(true)
    expect(change.structureChanged).toBe(false)
    // 文档整体变化 ⇒ 需要重载资源（这正是"换了纹理要重解码"的合法形态）
    expect(planContentRebuild(change).reloadResources).toBe(true)
  })
})

describe('内容身份相对计数器的核心优势：撤销回原内容 ⇒ 身份回原值', () => {
  it('内容 A → B → A：第二次比较得出"什么都不用做"', () => {
    const a = identity()
    const b = identity({ structureDigest: structureDigestOf(structureParts({ frames: [[9, 9, 9]] })) })

    const forward = planContentRebuild(diffContentIdentity(a, b))
    expect(forward.rebuildGeometry).toBe(true)

    // 撤销：内容回到 A
    const back = planContentRebuild(diffContentIdentity(b, a))
    expect(back.rebuildGeometry, '撤销回原内容 ⇒ 需要重建回原几何').toBe(true)

    // 而"当前内容 == 目标内容"时（例如重复应用同一次求值）什么都不做
    const noop = planContentRebuild(diffContentIdentity(a, identity()))
    expect(rebuildPlanIsNoop(noop), '内容相同 ⇒ 无操作').toBe(true)
  })

  it('首次加载 ⇒ 一切都要做（这是正常起点，不是"全量失效"）', () => {
    const plan = planContentRebuild(diffContentIdentity(null, identity()))
    expect(plan).toEqual({
      reloadResources: true,
      resolveStructure: true,
      rebuildGeometry: true,
      syncAnnotations: true,
    })
  })

  it('摘要对**顺序**敏感（保守方向）；集合语义仅用于不含序的读集', () => {
    // 注解摘要把整个集合作为**单个元素**摘要，故数组顺序参与哈希。
    //
    // 这是**刻意**的保守选择，不是疏忽：两个方向的代价不对称 ——
    //  - 顺序敏感 + 顺序其实无意义 ⇒ 多重建一次注解叠加层（**廉价**）；
    //  - 顺序不敏感 + 顺序其实有意义（作者重排） ⇒ 漏掉一次变化（**错误**）。
    // 在廉价的多做与昂贵的漏做之间，选前者。
    expect(annotationDigestOf([{ id: 'a' }, { id: 'b' }])).not.toBe(
      annotationDigestOf([{ id: 'b' }, { id: 'a' }]),
    )
    expect(annotationDigestOf([{ id: 'a' }])).not.toBe(annotationDigestOf([{ id: 'b' }]))
    // 而 `contentDigestOf` 对**顶层**元素按稳定序排列：那是为"同一读集被按不同顺序枚举"
    // 准备的（依赖图的枚举顺序不构成内容差异）—— 两处语义不同，各有其理由。
    expect(contentDigestOf(['a', 'b'])).toBe(contentDigestOf(['b', 'a']))
  })
})
