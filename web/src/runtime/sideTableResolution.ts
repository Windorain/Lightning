/**
 * `runtime/sideTableResolution` —— **侧表分流判定**（#301 P10f C′1；N4 修复的纯核心）。
 *
 * ## 为什么它是一个**纯函数**（与 `runtime/frameDeclarations` 同一理由）
 *
 * 我第一版把分流内联在 `Context.kernelAnnotations()` / `kernelMaterials()` 里，
 * 而测试用的宿主**复刻**了那段判定 ⇒ 判据**空转**（实测：把 `Context` 的分流
 * 改成"永远返回空表"，测试**仍全绿**）。那正是本工程反复吃过的"两份实现"。
 *
 * ⇒ 把**决定**提成纯函数：`Context` 只"取事实"，测试直接喂事实，
 * **判的就是生产代码本身**。
 *
 * ## 分流的两个事实（与 D8 同构，但**结论相反**）
 *
 * | 事实 | 来源 | 语义 |
 * |---|---|---|
 * | `adopted` | `KernelSession.hasAdoptedContent()`（GF-16） | 内核里的**就是**这份文档的装配产物吗 |
 * | `legacy` | `main.doc.value`（`Context` 内部读取后经读面函数投影；`getDoc()` 已终删） | 用户打开的那份文档（总有权威） |
 *
 * ## ⚠️ 为什么这里**必须**回落 legacy（而帧声明也回落，但理由不同）
 *
 * 帧声明的回落是"能力不回退"（读到 0 是**错**的数字）；侧表的回落是
 * **语义正确性**：`setDocument` 会清 GF-16（"有了一份文档"不蕴含"内核里的就是它"），
 * 而**注解/材质的编辑路径**正是"换了 legacy 但没装配内核"。
 * ⇒ 若返回空表，用户新建一条注解后**连原有的注解也点不中**，
 * 材质面板**整片变空**。实测该形态：legacy 2 条 / 内核读面 0 条。
 *
 * 两种状态下都给出**正确**答案：装配成功时内核是权威（内容面已迁入内核），
 * 否则 legacy 是权威（它承载用户当前的那份）。
 */

/** 侧表的两种来源（内核投影 / legacy 直读）。 */
export type SideTableSource = 'kernel' | 'legacy'

export interface ResolvedSideTable<T> {
  readonly rows: readonly T[]
  /**
   * 实际采用的来源。
   *
   * ## 为什么它必须**可观测**（与帧声明的 `source` 同一理由）
   *
   * "读到空表"本身是合法的（真的没有注解），但与"走错了分支导致空表"
   * 无法区分 ⇒ 缺陷活得很久。报出来源后，"分支可疑"变成可断言的。
   */
  readonly source: SideTableSource
}

/**
 * 解析侧表（唯一判定点）。
 *
 * @param adoptedRows 装配产物的侧表；**`null` = 未装配成功**（不是"表为空"）
 * @param legacyRows  旧文档的侧表；`null` = 无旧文档
 *
 * 判定顺序（顺序是语义的一部分）：
 *  1. 装配成功（`adoptedRows !== null`）⇒ **内核**为权威；
 *  2. 否则 ⇒ **legacy** 为权威（能力不回退 —— 这是本批实测抓出的自身缺陷的修复）；
 *  3. 两者皆无 ⇒ 空表，来源报 `legacy`（"没有文档"是 legacy 侧的事实）。
 *
 * ⚠️ **`null` 与 `[]` 不可互换**：`null` 是"没有可用来源"，`[]` 是
 * "这一侧确实空了"（例如有装配产物但里面真没有注解）。把后者当前者会让
 * 装配成功且真的无注解时**反而回落去读 legacy**（读到旧内容）—— 与 D8 同型的错误。
 */
export function resolveSideTable<T>(
  adoptedRows: readonly T[] | null,
  legacyRows: readonly T[] | null,
): ResolvedSideTable<T> {
  if (adoptedRows !== null) return { rows: adoptedRows, source: 'kernel' }
  if (legacyRows !== null) return { rows: legacyRows, source: 'legacy' }
  return { rows: EMPTY_ROWS, source: 'legacy' }
}

const EMPTY_ROWS: readonly never[] = Object.freeze([])
