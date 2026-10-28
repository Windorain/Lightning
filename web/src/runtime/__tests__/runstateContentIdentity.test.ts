/**
 * 回归防线（**生产装配路径**）：多方块运行态切换必须被判为**结构变化**。
 *
 * ## 为什么这条判据必须走生产装配
 *
 * 缺陷的成因是"**内容身份的读面**看不见条目内容变化"，而不是某个纯函数的返回值错。
 * 纯函数判据喂手工构造的载荷会恒绿（本项目已两次实测该形态：D2 `gridInputOf` 漏传
 * `cellPalette`、`gridPayload` 漏填尺寸列）—— 故本用例的输入**全部**来自生产：
 *
 * ```
 * 仓库夹具（真实信封） --生产注册表解析--> 生产装载（adoptLoadedDocument，真 Context + 真 KernelSession）
 *   --Context#kernelMultiblockEvaluation（唯一求值点）--> 已求值场景
 *   --Context#kernelRenderViewInputs + kernelRenderViewFromFace--> renderDoc
 *   --resolveRenderBundle（生产解析）--> definition
 *   --readContentIdentity（生产失效读取面）--> ContentIdentity
 *   --diffContentIdentity + planContentRebuild（生产计划面）--> RebuildPlan
 * ```
 *
 * ⚠️ 这一串原先经 `composition/kernelRenderView#kernelRenderViewOf`（形参是旧格式
 * `RuntimeDocument`）。该入口已随 `M5_CLOSEOUT` 删除 ⇒ 现在走**它的生产替代**
 * （唯一求值点 + 内核面渲染视图），判据的语义与断言点**不变**。
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
import { kernelRenderViewFromFace } from '@/composition/kernelRenderView'
import { isWorldDocument, resolveRenderBundle } from '@/render/data/bundleResolve'
import type { StructureDefinition } from '@/render/schema/types'
import { readContentIdentity } from '@/runtime/presentationAdapter'
import { diffContentIdentity, planContentRebuild, rebuildPlanIsNoop } from '@/presentation/contentIdentity'
import { multiblockDeclarationViewOf } from '@/domain/multiblockDocument'
import { plainRootOf } from '@/adapters/plainRoot'
import { readEnvelopeLayers } from '@/render/data/compactSceneDocument'
import { makeAdoptedKernelReadHost, type KernelReadHost } from '@/runtime/__tests__/kernelReadTestHost'
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

/** 生产链宿主：真实信封 → 生产解析 → 生产装载（真 Context + 真 KernelSession）。 */
async function makeHost(): Promise<KernelReadHost> {
  const raw = ebfFixture as unknown as Record<string, unknown>
  const parsed = await productionRegistry().detectAndParse(raw)
  if (!parsed.document) throw new Error(`夹具解析失败：${parsed.error}`)
  const plainRoot = plainRootOf((await readEnvelopeLayers(raw as never)).plain as Record<string, unknown>)
  return makeAdoptedKernelReadHost(parsed.document as never, plainRoot)
}

/** 生产写通路：与 `e2e` 遍历/面板同一组 setter（运行态按声明下标写）。 */
function writeRunstate(host: KernelReadHost, runstate: string): void {
  const session = host.session
  if (session === null) throw new Error('前提：会话必须在场')
  const decl = host.ctx.kernelMultiblockDeclaration()
  if (decl === null) throw new Error('前提：声明必须在场')
  session.setTotalTier(TIER)
  for (const [k, v] of Object.entries(COMMON)) session.setChannelValue(k, v)
  const idx = decl.runstates.findIndex((r) => r.id === runstate)
  if (idx < 0) throw new Error(`运行态 ${runstate} 未在声明里`)
  session.setRunstateIndex(idx)
}

/** 生产渲染视图文档（`useKernelChannels#renderDoc` 同一入口 + 同一读面）。 */
function renderDocOf(host: KernelReadHost): RuntimeDocument {
  const inputs = host.ctx.kernelRenderViewInputs()
  if (inputs === null) throw new Error('前提：内核渲染视图输入必须在场')
  const rv = kernelRenderViewFromFace({ ...inputs, frameIndex: 0 })
  expect(rv.doc, `内核面渲染视图必须产出：${rv.diagnostics.join(' | ')}`).not.toBeNull()
  return rv.doc!
}

describe('多方块运行态的**内容身份**可辨（生产装配路径）', () => {
  it('仅切运行态 ⇒ 结构身份变化 + 计划要求重解结构；负对照：同文档重复读 ⇒ noop', async () => {
    const host = await makeHost()
    try {
      expect(host.ctx.kernelMultiblockDeclaration(), `${FILE} 必须是多方块文档`).not.toBeNull()

      const defOf = (d: RuntimeDocument): StructureDefinition => {
        const plain = d.serialize()
        expect(isWorldDocument(plain), '多方块渲染视图是 V2（顶层展开），不是 World').toBe(false)
        return resolveRenderBundle({ document: plain }, 0).definition
      }
      const identityOf = (d: RuntimeDocument, def: StructureDefinition | null) =>
        readContentIdentity({ doc: d, frameIndex: 0, layerPreview: 'all', definition: def })

      writeRunstate(host, 'idle')
      const docIdle = renderDocOf(host)
      writeRunstate(host, 'active')
      const docActive = renderDocOf(host)
      const defIdle = defOf(docIdle)
      const defActive = defOf(docActive)

      // 前提（不是本用例的断言对象，但缺了它下面的结论无意义）：两份文档本身可辨
      expect(
        JSON.stringify(docIdle.serialize()),
        '两份 renderDoc 必须先可辨（否则缺陷不在失效判定面，本用例的前提不成立）',
      ).not.toBe(JSON.stringify(docActive.serialize()))

      // 防线①：切换瞬间 —— 文档已新、定义仍是上一轮（DRW 的真实入参）
      const before = identityOf(docIdle, defIdle)
      const atSwitch = identityOf(docActive, defIdle)
      const change = diffContentIdentity(before, atSwitch)
      expect(change.structureChanged, '仅切运行态必须被判为结构变化（条目内容变了）').toBe(true)
      expect(change.documentChanged, '结构变化不得升级成"文档整体变化"（不必重解码纹理）').toBe(false)
      const plan = planContentRebuild(change)
      expect(plan.resolveStructure, '必须要求重解结构（否则视口定义逐字节不变）').toBe(true)
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

      // 反空洞真：声明确实带两个运行态（否则"仅切运行态"这件事无从发生）
      expect(multiblockDeclarationViewOf(host.ctx.kernelMultiblockDeclaration()!).runstates.length).toBeGreaterThan(1)
    } finally {
      host.dispose()
    }
  })
})
