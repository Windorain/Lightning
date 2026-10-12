/**
 * #334 回归防线（**生产装配路径**）：多方块运行态切换必须被判为**结构变化**。
 *
 * ## 为什么这条判据必须走生产装配
 *
 * 缺陷的成因是"**内容身份的读面**看不见条目内容变化"，而不是某个纯函数的返回值错。
 * 纯函数判据喂手工构造的载荷会恒绿（本项目已两次实测该形态：D2 `gridInputOf` 漏传
 * `cellPalette`、#301 D3 `gridPayload` 漏填尺寸列）—— 故本用例的输入**全部**来自生产：
 *
 * ```
 * 仓库夹具（真实信封） --生产注册表解析--> RuntimeDocument
 *   --kernelRenderViewOf（生产：内核装配 + 投影 + 往返）--> renderDoc
 *   --resolveRenderBundle（生产解析）--> definition
 *   --readContentIdentity（生产失效读取面）--> ContentIdentity
 *   --diffContentIdentity + planContentRebuild（生产计划面）--> RebuildPlan
 * ```
 *
 * 断言点是**计划面**：`plan.resolveStructure === true`（"必须重解结构"）—— 那正是修复前
 * 为 `false` 的那一条（切换瞬间文档已新、定义未跟上，而身份逐字节相同）。
 *
 * ## 三重防线
 *
 * 1. **切换被看见**：`readContentIdentity({doc: active, definition: **旧**定义})` 与
 *    idle 的身份必须不同，且计划要求重解结构（修复前：`structureChanged: false`）；
 * 2. **不产生二次重算**：同一份文档 + 旧/新定义两个入参 ⇒ 身份必须**相同**
 *    （否则"重解完再判一次"会平白再重算一轮）；
 * 3. **负对照**：同一份文档重复读 ⇒ 身份相同、计划为 noop（证明判据不是"总会判变"）。
 */
import { describe, expect, it } from 'vitest'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { kernelRenderViewOf } from '@/composition/kernelRenderView'
import { isWorldDocument, resolveRenderBundle } from '@/render/data/bundleResolve'
import type { StructureDefinition } from '@/render/schema/types'
import { readContentIdentity } from '@/runtime/presentationAdapter'
import { diffContentIdentity, planContentRebuild, rebuildPlanIsNoop } from '@/presentation/contentIdentity'
import ebfFixture from '@/context/__tests__/fixtures/multiblock-ebf-2ch.json'

const FILE = 'multiblock-ebf-2ch.json'
/** 与 `e2e/multiblock-channel-traversal.spec.ts` 的运行态门禁同一对组合（其余轴固定）。 */
const COMMON = { height: 1, coil: 1, glass: 1 }
const TIER = 1

/** 与宿主一致的注册顺序（`src/runtime/host/workbenchHost.ts`）。 */
function productionRegistry() {
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  return registry
}

async function parse(raw: unknown): Promise<RuntimeDocument> {
  const res = await productionRegistry().detectAndParse(raw)
  if (!res.document) throw new Error(`夹具解析失败：${res.error}`)
  return res.document
}

describe('#334：多方块运行态的**内容身份**可辨（生产装配路径）', () => {
  it('仅切运行态 ⇒ 结构身份变化 + 计划要求重解结构；负对照：同文档重复读 ⇒ noop', async () => {
    const doc = await parse(ebfFixture as unknown as Record<string, unknown>)
    expect(doc.isMultiblock, `${FILE} 必须是多方块文档`).toBe(true)

    const renderDocOf = (runstate: string): RuntimeDocument => {
      const kv = kernelRenderViewOf({
        doc,
        selection: { totalTier: TIER, values: { ...COMMON }, runstate },
        frameIndex: 0,
      })
      expect(kv.doc, `kernelRenderViewOf(${runstate}) 必须产出渲染视图：${kv.diagnostics.join(' | ')}`).not.toBeNull()
      return kv.doc!
    }
    const defOf = (d: RuntimeDocument): StructureDefinition => {
      const plain = d.serialize()
      expect(isWorldDocument(plain), '多方块渲染视图是 V2（顶层展开），不是 World').toBe(false)
      return resolveRenderBundle({ document: plain }, 0).definition
    }
    const identityOf = (d: RuntimeDocument, def: StructureDefinition | null) =>
      readContentIdentity({ doc: d, frameIndex: 0, layerPreview: 'all', definition: def })

    const docIdle = renderDocOf('idle')
    const docActive = renderDocOf('active')
    const defIdle = defOf(docIdle)
    const defActive = defOf(docActive)

    // 前提（不是本用例的断言对象，但缺了它下面的结论无意义）：两份文档本身都可辨
    expect(
      JSON.stringify(docIdle.serialize()),
      '两份 renderDoc 必须先可辨（否则缺陷不在失效判定面，本用例的前提不成立）',
    ).not.toBe(JSON.stringify(docActive.serialize()))

    // 防线①：切换瞬间 —— 文档已新、定义仍是上一轮（DRW 的真实入参）
    const before = identityOf(docIdle, defIdle)
    const atSwitch = identityOf(docActive, defIdle)
    const change = diffContentIdentity(before, atSwitch)
    expect(change.structureChanged, '#334：仅切运行态必须被判为结构变化（条目内容变了）').toBe(true)
    expect(change.documentChanged, '结构变化不得升级成"文档整体变化"（不必重解码纹理）').toBe(false)
    const plan = planContentRebuild(change)
    expect(plan.resolveStructure, '#334：必须要求重解结构（否则视口定义逐字节不变）').toBe(true)
    expect(plan.rebuildGeometry, '结构变化连带重建几何').toBe(true)
    expect(plan.reloadResources, '改运行态不必重解码资源').toBe(false)

    // 防线②：同一份文档 + 旧/新定义 ⇒ 身份相同（不留"重解完再判一次"的二次重算）
    expect(
      identityOf(docActive, defActive).structure,
      '身份必须只由文档决定（定义滞后一轮不得改变判定）',
    ).toBe(atSwitch.structure)

    // 防线③：负对照 —— 同一份文档重复读 ⇒ 无变化、noop
    const again = identityOf(docActive, defActive)
    expect(identityOf(docActive, defActive).structure).toBe(again.structure)
    expect(rebuildPlanIsNoop(planContentRebuild(diffContentIdentity(again, again))), '同内容 ⇒ 计划必须为空').toBe(true)
  })
})
