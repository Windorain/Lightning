/**
 * `runtime/frameDeclarations` —— **帧声明的分流判定**（读数一致性的纯核心）。
 *
 * ## 为什么它是一个**纯函数**（而不是 `Context` 方法里的几行 if）
 *
 * 该缺陷的本质是"守卫测错了事实"，而**判据必须能注入装配失败**。
 * 若判定逻辑内联在 `Context.frameDeclarations` 里，测试只能：
 *  - 造一整个 `Context`（`Main`/`WM`/`ViewportManager`/`ScreenRoot`/`WorkbenchServices`
 *    六件外壳都到位），或
 *  - 在测试里**复刻**一份判定 —— 那就是"两份实现"，而本工程已多次实测它会漂移。
 *
 * ⇒ 把**决定**提成纯函数（显式输入、不改输入、不依赖 Vue/DOM/IO），
 * 外壳只负责"取事实、调本函数、交结果"。测试直接喂事实，**判的就是生产代码本身**。
 *
 * ## 它替代的旧机制
 *
 * | 旧机制 | 位置 | 本函数的替代 |
 * |---|---|---|
 * | 守卫测"文档存在"（恒真）⇒ 装配失败时返回空帧轴 | `composition/useKernelFrameLoop` + `StatusBar.vue`（两处各判、判据不同） | 一处判定：**装配成功 ⇒ 内核；否则 ⇒ legacy** |
 *
 * ## 两个输入事实**不可互换**（这是该缺陷的本质）
 *
 * | 事实 | 来源 | 语义 |
 * |---|---|---|
 * | `adopted` | `KernelSession.hasAdoptedContent()`（内容装配读面） | 内核里的**就是**这份文档的装配产物吗 |
 * | `legacy` | `main.doc.value`（`Context.legacyFrames` 的内部读取；`getDoc()` 已终删） | 用户打开的那份文档（总有权威） |
 *
 * 「内核有文档」（`document() !== undefined`）**不是**这里的判据 ——
 * 它恒真，用它就会退回该缺陷的形态。故 `adopted` 参数在类型上被刻意做成
 * **`null` 表示"没装配"**（而不是一个可能恒真的布尔取值来源），
 * 让"用错事实"在调用点就写不出来。
 */

/** 帧声明（帧数 + 每帧时长 + 帧标签；内核与 legacy 两种来源的共同形状）。 */
export interface FrameDeclarationSet {
  readonly count: number
  readonly durationsMs: readonly number[]
  /**
   * 每帧的**声明标签**（`FrameDeclaration.label`；`null` = 该帧未声明标签）。
   *
   * ## 为什么它属于本读面
   *
   * `context/queries#getCurrentFrame` 与 `#currentFrameKey` 需要
   * "当前帧的 `{index, label}`" —— 两个字段都在**同一份** `FrameAxis` 上。
   * 若只暴露 `count`/`durationsMs`，调用方仍得另找一条路读 `label`
   * ⇒ 那就又是一条绕过本读面的旁路（正是 `raw-authority-object` 要消灭的形态）。
   *
   * ⚠️ `index` **不**在此列：帧键与数组下标的区别由调用方按契约决定
   * （见 `currentFrameKey` 的说明），本读面给的是**轴上的位置序**。
   */
  readonly labels: readonly (string | null)[]
}

export type FrameDeclarationSource = 'kernel' | 'legacy'

export interface ResolvedFrameDeclarations extends FrameDeclarationSet {
  /**
   * 实际采用的来源。
   *
   * ## 为什么它必须**可观测**（而不是内部细节）
   *
   * 该缺陷之所以活了很久，是因为"读到 0"看起来只是一个**正常数值** ——
   * 没有任何东西告诉观察者"这一刻走的是哪条分支"。把来源报出来，
   * 缺陷就从"数值可疑"变成"分支可疑"（可断言、可报警）。
   */
  readonly source: FrameDeclarationSource
}

/**
 * 解析帧声明（唯一判定点）。
 *
 * @param adopted 装配产物的帧声明；**`null` = 未装配成功**（不是"帧数为 0"）
 * @param legacy  旧文档的帧声明；`null` = 无旧文档
 *
 * 判定顺序（顺序是语义的一部分）：
 *  1. 装配成功（`adopted !== null`）⇒ **内核**为权威 —— 内核承载的帧轴是
 *     "文档内容面迁进内核"的可观测含义；
 *  2. 否则 ⇒ **legacy** 为权威（能力不回退）—— 这正是该修复要恢复的那条回落；
 *  3. 两者皆无 ⇒ `count: 0`，来源仍报 `legacy`（"没有文档"是 legacy 侧的事实）。
 */
export function resolveFrameDeclarations(
  adopted: FrameDeclarationSet | null,
  legacy: FrameDeclarationSet | null,
): ResolvedFrameDeclarations {
  if (adopted !== null) {
    return {
      count: adopted.count,
      durationsMs: adopted.durationsMs,
      labels: adopted.labels,
      source: 'kernel',
    }
  }
  if (legacy !== null) {
    return {
      count: legacy.count,
      durationsMs: legacy.durationsMs,
      labels: legacy.labels,
      source: 'legacy',
    }
  }
  return { count: 0, durationsMs: [], labels: [], source: 'legacy' }
}
