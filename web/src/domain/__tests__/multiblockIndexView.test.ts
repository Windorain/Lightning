/**
 * `domain/multiblockDocument#multiblockIndexViewOf` —— **派生索引读视图**的判据（R2/S3 任务 1）。
 *
 * ## 为什么这三条是这一处改动的判据
 *
 * 该函数是本批新增的**唯一**索引构造点（解析器不再自建四张 `Map`），故它必须被证明：
 *
 * | # | 判据 | 会被哪种退化形态静默违反 |
 * |---|---|---|
 * | ① | 同输入 ⇒ 同输出（键集合 + **值的对象身份**），入参不被改写，结果冻结 | 实现里混入时钟/随机/拷贝构造 ⇒ "索引"与"声明"不再同物；或复用了可变中间结构 |
 * | ② | 视图**键集合不含 `raw`** | 用 `{...decl}` 的形态把整节原文顺带发出去 ⇒ 每条声明消费者都拿到了外部格式字段袋（§15 第 2 条） |
 * | ③ | 索引**随声明变化** | 返回常量/缓存了首次结果 ⇒ 查表与声明脱钩 |
 *
 * ## "无 I/O / 无时钟 / 不碰 DOM" 里，哪一半由本文件证明、哪一半由既有闸门证明
 *
 * - **时钟**：本文件用 `vi.useFakeTimers()` 在两个不同系统时间下取视图并**深度相等**断言
 *   —— 若实现里出现 `Date.now()` 之类的戳（哪怕只是个多余字段），第 2 次取值必然不等。
 * - **I/O / DOM / Vue / Three**：由既有架构闸门对 `domain/**`（`ctx.coreFiles`）机械把守
 *   —— `gate/core-no-node-io`、`gate/core-no-dom-globals`、`gate/core-no-vue-three`
 *   （`tests/architecture/boundary-rules.mjs` 的 `GATE_RULES`）。本批实测 `npm run arch:scan`
 *   = PASS 0 finding。**不**在本文件里再造一遍同类判据（那是第二套判据，会漂移）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_MULTIBLOCK_DECLARATION,
  multiblockIndexViewOf,
  type MultiblockChannel,
  type MultiblockRule,
  type MultiblockRunstate,
  type MultiblockVariant,
} from '@/domain/multiblockDocument'

// ---------------------------------------------------------------------------
// 最小声明素材（只填必需字段；元素类型即内核域承载）
// ---------------------------------------------------------------------------

function channel(key: string): MultiblockChannel {
  return {
    enumName: null,
    id: key,
    key,
    name: key,
    kind: 'replace',
    min: 0,
    max: 3,
    domain: Object.freeze({ lo: 0, hi: 3 }),
    slider: true,
  }
}

function runstate(id: string): MultiblockRunstate {
  return { id, name: id, materialSwap: false }
}

function variant(key: string): MultiblockVariant {
  return { key, totalTier: 1, values: Object.freeze({}), runstate: 'idle' }
}

function rule(id: string): MultiblockRule {
  return { id, phase: 'replace', kind: 'setCell', index: 0 }
}

/** 四份清单（键名后缀 = 传入的 id）。 */
function sourceOf(ids: readonly string[]) {
  return Object.freeze({
    rules: Object.freeze(ids.map((id) => rule(id))),
    variants: Object.freeze(ids.map((id) => variant(`v-${id}`))),
    channels: Object.freeze(ids.map((id) => channel(`c-${id}`))),
    runstates: Object.freeze([runstate('idle')]),
  })
}

/** 视图的**键面**（顺序无关）—— 判据 ①②共用的同一把尺子。 */
function keyFace(view: object): string {
  return Object.keys(view).sort().join(',')
}

const FOUR_MAPS = 'channelByKey,ruleById,runstateById,variantByKey'

describe('domain/multiblockDocument · 派生索引读视图（`multiblockIndexViewOf`）', () => {
  it('① 纯函数：同输入 ⇒ 同输出（键集合 + 值的**对象身份**），入参不被改写，结果冻结', () => {
    const src = sourceOf(['a', 'b'])
    const before = [...src.rules]

    const first = multiblockIndexViewOf(src)
    const second = multiblockIndexViewOf(src)

    // 键集合相同
    expect(keyFace(second)).toBe(keyFace(first))
    // 值的**对象身份**相同 ⇒ 不是"深拷贝出一份等价物"（旧解析侧据此断言"查到的就是清单里那一条"）
    expect(second.ruleById.get('a')).toBe(first.ruleById.get('a'))
    expect(second.variantByKey.get('v-b')).toBe(first.variantByKey.get('v-b'))
    // 值 = 清单里的那个对象（不是拷贝）
    expect(first.ruleById.get('a')).toBe(src.rules[0])
    expect(first.variantByKey.get('v-b')).toBe(src.variants[1])
    expect(first.channelByKey.get('c-a')).toBe(src.channels[0])
    expect(first.runstateById.get('idle')).toBe(src.runstates[0])
    // 入参未被改写/重排
    expect([...src.rules]).toEqual(before)
    // 结果冻结（调用方拿到的是只读视图，不是可被就地改写的容器）
    expect(Object.isFrozen(first)).toBe(true)

    // 时钟轴：两个不同系统时间下的视图必须**深度相等** ⇒ 实现里没有时间戳类字段
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
      const at1 = multiblockIndexViewOf(src)
      vi.setSystemTime(new Date('2026-06-06T06:06:06Z'))
      const at2 = multiblockIndexViewOf(src)
      expect(at2).toEqual(at1)
      expect(keyFace(at2)).toBe(FOUR_MAPS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('② 视图**键集合不含 `raw`**（负对照：把源摊进视图的退化形态会被同一判据判红）', () => {
    // "旧解析形状"元素：自带元素级 `raw`（`context/parsers/multiblockDocument.ts` 的 `*Decl` 就是这一形态）
    const parserish = Object.freeze({
      rules: Object.freeze([{ ...rule('a'), raw: { id: 'a', secret: 1 } }]),
      variants: Object.freeze([{ ...variant('v-a'), raw: { key: 'v-a' } }]),
      channels: Object.freeze([{ ...channel('c-a'), raw: { key: 'c-a' } }]),
      runstates: Object.freeze([{ ...runstate('idle'), raw: { id: 'idle' } }]),
    })

    const view = multiblockIndexViewOf(parserish)
    expect(keyFace(view)).toBe(FOUR_MAPS)
    expect('raw' in view).toBe(false)
    // 视图**不剥元素字段**（它只承诺"键面是四张表"）：查到的就是清单里那一条，元素自带的 raw 仍在元素上
    expect((view.ruleById.get('a') as { raw?: unknown }).raw).toEqual({ id: 'a', secret: 1 })

    // ── 负对照：同一把尺子必须能对退化形态判红 ──
    // 退化形态 = "把源摊进视图"（`{...decl, ...index}`，即 `MultiblockDeclaredView` 的加法形态；
    // 若源是旧解析形状，声明级/元素级 `raw` 也会随之进入键面）。
    const degenerate = { ...parserish, raw: { multiblock: {} }, ...multiblockIndexViewOf(parserish) }
    expect(keyFace(degenerate), '前提：退化形态确实带 raw ⇒ 下面的不相等不是空洞真').toContain('raw')
    expect(keyFace(degenerate), '同一判据对退化形态必须判红').not.toBe(keyFace(view))
  })

  it('③ 索引随声明变化（增/删/改主键都反映到查表；四张表互不串档）', () => {
    const one = multiblockIndexViewOf(sourceOf(['a']))
    const two = multiblockIndexViewOf(sourceOf(['a', 'b']))
    // 多出来的键：在 one 里查不到，在 two 里查到 —— 证明查表**由声明决定**，不是常量
    expect(one.ruleById.get('b')).toBeUndefined()
    expect(two.ruleById.get('b')).toBeDefined()

    // 改主键（同长度）：旧键查不到、新键查得到
    const renamed = multiblockIndexViewOf({ ...sourceOf(['a']), rules: Object.freeze([rule('z')]) })
    expect(renamed.ruleById.get('a')).toBeUndefined()
    expect(renamed.ruleById.get('z')).toBeDefined()
    // 四张表各自独立：改 rules 不得影响 variants
    expect(renamed.variantByKey.get('v-a')).toBeDefined()
  })

  it('边界：空声明 ⇒ 四张表都空（`EMPTY_MULTIBLOCK_DECLARATION` 的索引面）', () => {
    const view = multiblockIndexViewOf(EMPTY_MULTIBLOCK_DECLARATION)
    expect(keyFace(view)).toBe(FOUR_MAPS)
    expect([
      view.ruleById.size,
      view.variantByKey.size,
      view.channelByKey.size,
      view.runstateById.size,
    ]).toEqual([0, 0, 0, 0])
  })
})
