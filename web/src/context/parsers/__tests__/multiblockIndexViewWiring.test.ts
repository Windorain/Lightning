/**
 * 解析器的**索引读视图接线**判据（R2/S3 任务 1 的**生产侧**）。
 *
 * ## 为什么纯函数判据（`domain/__tests__/multiblockIndexView.test.ts`）不够
 *
 * 那条判据喂的是**手工素材**，它证明不了"生产解析这条路真的走域层实现"。本文件喂
 * **真实 fixture**（`src/context/__tests__/fixtures/multiblock-tier-only.json`，内容勿改）
 * 经**生产解析入口** `parseMultiblockDeclaration`，再核三件事：
 *
 * 1. 四张索引表**逐键等于** `multiblockIndexViewOf(解析结果)`，且**值 = 清单里那一条**（`toBe`）
 *    —— 索引是"按主键查清单"，不是另造一批等价对象；
 * 2. **重复主键仍硬失败**（`规则 id 重复：<id>` / `变体键重复：<key>`，消息必须指到键）。
 *    ⚠️ 这一条是**改写后的行为**：旧形态在"边建 `Map` 边 `has` 检查"里顺手判重复，
 *    拆成 `firstDuplicateKey`（解析期判定）+ `multiblockIndexViewOf`（域层纯派生），
 *    而该行为在此前**全树零覆盖**（实测：两条消息文本 0 个测试命中）——
 *    ⇒ 没有这一条，那次拆分就是无人把守的改动；
 * 3. 索引视图**键集合不含 `raw`**，而解析侧的 `decl.raw`（整节原文）**确实存在**
 *    —— 后者是前者的前提，缺了它就是空洞真。
 *
 * ## 负对照（第 2 条自带）
 *
 * 同一份 fixture **不注入**重复项时必须**不抛** —— 否则"抛出"可能来自 fixture 本身非法，
 * 而不是来自注入的重复项（判据就失去了指向性）。
 */
import { describe, expect, it } from 'vitest'
import {
  MultiblockParseError,
  parseMultiblockDeclaration,
} from '@/context/parsers/multiblockDocument'
import { multiblockIndexViewOf } from '@/domain/multiblockDocument'
import tierOnly from '../../__tests__/fixtures/multiblock-tier-only.json'

type Json = Record<string, unknown>

/** base64 → UTF-8 文本（与 `context/__tests__/multiblockParser.test.ts` 同一手法）。 */
function base64ToText(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

/** fixture 的**内层 body**（= `parseMultiblockDeclaration` 的实参形态，每次调用独立副本）。 */
function innerBody(): Json {
  const envelope = tierOnly as unknown as { payload: string }
  return JSON.parse(base64ToText(envelope.payload)) as Json
}

/** 捕获解析异常（要核**具体消息**，不能只核"抛了"）。 */
function caughtBy(body: Json): unknown {
  try {
    parseMultiblockDeclaration(body)
    return null
  } catch (e) {
    return e
  }
}

describe('解析器 · 索引读视图接线（域层唯一实现 + 重复主键判定）', () => {
  it('生产解析：四张表与 `multiblockIndexViewOf` 逐键一致，且值 = 清单里那一条（不是拷贝）', () => {
    // ⚠️ 解析产物的形状是**两层**：顶层 `{schemaVersion, multiblockCount, decl, frames, …, warnings, raw}`
    // （= parser 的 `MultiblockDeclaration`），而四张索引表在**内层 `decl`**（= `MultiblockDecl`，
    // 即 `doc.multiblock.decl` / `useKernelChannels.ts:202` 取的那一个）。索引视图喂的是内层。
    const parsed = parseMultiblockDeclaration(innerBody())
    const decl = parsed.decl
    const view = multiblockIndexViewOf(decl)

    // 前提：素材必须非空 —— 否则下面的 for 循环是空洞真
    expect(decl.rules.length).toBeGreaterThan(0)
    expect(decl.variants.length).toBeGreaterThan(0)
    expect(decl.channels.length).toBeGreaterThan(0)
    expect(decl.runstates.length).toBeGreaterThan(0)

    // 键集合逐项一致（解析产出的索引 = 域层实现的产出）
    expect([...decl.ruleById.keys()]).toEqual([...view.ruleById.keys()])
    expect([...decl.variantByKey.keys()]).toEqual([...view.variantByKey.keys()])
    expect([...decl.channelByKey.keys()]).toEqual([...view.channelByKey.keys()])
    expect([...decl.runstateById.keys()]).toEqual([...view.runstateById.keys()])

    // 值 = 清单里那一条（对象身份）—— 四处都核，避免"只核一张表"的抽样失真
    for (const r of decl.rules) expect(decl.ruleById.get(r.id)).toBe(r)
    for (const v of decl.variants) expect(decl.variantByKey.get(v.key)).toBe(v)
    for (const c of decl.channels) expect(decl.channelByKey.get(c.key)).toBe(c)
    for (const s of decl.runstates) expect(decl.runstateById.get(s.id)).toBe(s)
  })

  it('重复主键仍硬失败（`firstDuplicateKey` 拆分的行为判据；改写前全树零覆盖）', () => {
    // 注入 ①：规则 id 重复（复制第一条追加到末尾 ⇒ 顺序上的第一个重复键就是它）
    const dupRule = innerBody()
    const rules = (dupRule.multiblock as Json).rules as Json[]
    const ruleId = rules[0]!.id
    rules.push({ ...rules[0]! })
    const ruleErr = caughtBy(dupRule)
    expect(ruleErr).toBeInstanceOf(MultiblockParseError)
    expect((ruleErr as MultiblockParseError).reason).toBe(`规则 id 重复：${String(ruleId)}（文件内必须唯一）`)

    // 注入 ②：变体键重复
    const dupVariant = innerBody()
    const variants = (dupVariant.multiblock as Json).variants as Json[]
    const variantKey = variants[0]!.key
    variants.push({ ...variants[0]! })
    const variantErr = caughtBy(dupVariant)
    expect(variantErr).toBeInstanceOf(MultiblockParseError)
    expect((variantErr as MultiblockParseError).reason).toBe(`变体键重复：${String(variantKey)}`)

    // ── 负对照：同一份 fixture 不注入时必须**不抛** ──
    // （否则上面的"抛出"可能源自 fixture 本身非法 —— 判据就失去了指向注入项的区分力）
    expect(caughtBy(innerBody()), '未注入重复项的 fixture 必须解析成功').toBeNull()
  })

  it('索引视图键集合不含 `raw`，而解析侧的整节原文（`decl.raw`）确实存在', () => {
    const parsed = parseMultiblockDeclaration(innerBody())
    const decl = parsed.decl
    const view = multiblockIndexViewOf(decl)

    expect(Object.keys(view).sort()).toEqual(['channelByKey', 'ruleById', 'runstateById', 'variantByKey'])
    expect('raw' in view).toBe(false)

    // 前提：解析结果**确实**带整节原文 ⇒ 上一条不是"因为根本没有 raw 所以不含 raw"
    expect(Object.keys(decl.raw).length, '解析侧 `decl.raw` = multiblock 节原文，必须非空').toBeGreaterThan(0)

    // 旁证（与 e2e 观测面同源）：真实 fixture 的**解析告警**为空。
    // `e2e/helpers/multiblock/contract.ts:241` 与 `realExports.ts:1077` 把"告警非空"判为违规，
    // 它们读的就是 `doc.multiblock.warnings`（本行这一份）；e2e 观测面的迁移口径见 R2/S3 汇报。
    expect(parsed.warnings, '真实 fixture 不得有解析告警').toEqual([])
  })
})
