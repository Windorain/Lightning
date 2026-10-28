/**
 * **Wiki 远端是否陈旧**的**唯一权威**（完整保存产物的语义相等）。
 *
 * ## 为什么不能只看编辑摘要草稿
 *
 * `buildWikiEditSummaryDraft` 只比较少数可摘要字段（`meta.title/description/author/version`、
 * `tooltipPalette`、`cellTooltipGrid`、注解/标签数量）。它回答的是"给这次保存写什么摘要"，
 * **不是**"当前内容是否与 Wiki 页上的内容相同"。
 *
 * 真实缺口：只改 `frames[].structure.cellGrid`（例如换一格方块身份）时，上面那些字段
 * 全都不变 ⇒ 草稿为 `null`；若再配合一次本地 SAVE_FILE/SAVE_PROJECT，内核保存基线变干净
 * （内容已写进本地文件），而 Wiki 页仍是旧的 ⇒ 保存门灰显、状态栏没有「未保存」、
 * 装载前也不提示丢弃，用户的主编辑内容无法推回原 Wiki 页。
 *
 * ⇒ 本模块用**当前完整保存产物**（`ctx.plainForSave().plain`，与真正写出去的 payload
 * 同一来源）与 `DocumentBinding.saveBaseline`（Wiki 远端已保存内容）做**全量语义比较**。
 *
 * ## 为什么是 canonicalize 而不是 JSON.stringify
 *
 * plain 是对象图：同一份语义内容经不同构造路径可能得到不同的键插入顺序。
 * `JSON.stringify` 会因此产生**假差异**，把"刚装载/刚保存"误判成脏。
 * `canonicalize`（`domain/identity`，内容身份的唯一规范化实现）对对象键排序、数组保序，
 * 且 `-0`/NaN/Infinity 有显式口径 —— 于是"相等 ⇔ 同一份内容"是这条判据的定义，
 * 不是"两次序列化恰好一样"。
 *
 * ⚠️ 边界（**不**改全局 `canonicalize` 的身份语义）：`undefined`/NaN/Infinity 不是合法
 * JSON 值，`canonicalize` 给它们各自的标记；真实保存产物由 `plainForSave()` 的投影保证
 * 不含这些值（判据见 `documentBindingTakeover` 的 JSON-safe 用例）。若某天产物里出现它们，
 * 那是投影缺陷，不应靠放宽本比较来"兼容"。
 *
 * ## 性能：baseline 的 canonical 字符串按**对象身份**做 WeakMap 派生缓存
 *
 * 真实 2.5MB / 14 万键的 plain 上，单次 `canonicalize` 约 59ms；旧实现对 baseline 与
 * current **每次**都各算一次（约 117ms），而 StatusBar 会随每次编辑重算 ⇒ 超过帧预算。
 *
 * 关键事实：**基线在两次编辑之间是同一个对象**（所有替换点——Wiki 保存/SaveAs/
 * Reload/本地接管/recovery——都是整对象替换或 reset），而 current 每次
 * `plainForSave()` 都是新对象。故这里只缓存 baseline → canonical 字符串：
 *  - 第一次编辑付"baseline + current"；
 *  - 之后每次编辑只付 current 一次（约 60ms）+ 3ms 投影；
 *  - WeakMap 以对象为键，旧基线被替换后可回收，不滞留、不跨文档。
 *
 * ⚠️ **所有权**：`DocumentBinding.saveBaseline` 必须是**不可变快照**，只允许整对象替换，
 * **禁止就地修改**（否则缓存会返回旧字符串）。现有写点全部是整替换/reset，见
 * `binding#applyDocumentBinding` / `resetDocumentBinding` 与 `pipeline#completeDocumentSave`。
 *
 * ## 它不是第二份 dirty marker
 *
 * 本模块**不存** dirty 布尔/版本判定；只缓存"某个对象 → 它的 canonical 字符串"这一
 * 纯派生值，判据每次仍是`基线串 !== 当前串`。内核保存基线继续回答"内容有没有
 * 写进某个保存目标"；本判据只回答"**Wiki 远端**是否落后"。
 */
import type { Context } from '@/runtime/context'
import { canonicalize } from '@/domain/identity'

type Plain = Readonly<Record<string, unknown>>

/** 规范化函数（测试可注入计数实现，证明缓存命中；生产固定 `canonicalize`）。 */
export type PlainCanonicalizer = (value: unknown) => string

export interface WikiRemoteDirtyReader {
  hasChanges(baseline: Plain | null, current: Plain | null): boolean
}

/**
 * 造一个远端脏读器。
 *
 * @param canonicalizeValue 规范化函数；注入点只用于**确定性计数**（单测证明同一基线对象
 *        只规范化一次），生产不替换。
 */
export function createWikiRemoteDirtyReader(
  canonicalizeValue: PlainCanonicalizer = canonicalize,
): WikiRemoteDirtyReader {
  const baselineText = new WeakMap<object, string>()
  return {
    hasChanges(baseline, current) {
      // 缺一侧不是"干净"：没有 baseline 时无法证明 Wiki 页与当前相同；
      // 没有 current（无文档）时也无法证明远端与"什么都没有"相同。
      // 只有两边都不存在才是否定形态的"无差异"（例如尚未装载）。
      if (baseline === null && current === null) return false
      if (baseline === null || current === null) return true
      let baselineCanonical = baselineText.get(baseline)
      if (baselineCanonical === undefined) {
        baselineCanonical = canonicalizeValue(baseline)
        baselineText.set(baseline, baselineCanonical)
      }
      // current **不缓存**：每次 plainForSave 都是新对象；也避免把渲染期对象留在缓存里。
      return baselineCanonical !== canonicalizeValue(current)
    },
  }
}

/** 生产读器（baseline WeakMap 缓存 + canonicalize）。 */
const defaultWikiRemoteDirtyReader = createWikiRemoteDirtyReader()

/**
 * 当前完整产物与 Wiki 远端保存基线是否存在差异。
 *
 * 语义：双 `null` ⇒ false；**任一侧缺失 ⇒ true**（保留态不确定，不能当干净）。
 */
export function hasWikiRemoteChanges(baseline: Plain | null, current: Plain | null): boolean {
  return defaultWikiRemoteDirtyReader.hasChanges(baseline, current)
}

/**
 * `Context` 面上的 Wiki 远端陈旧读面。
 *
 * 只对 `sourceId === 'wiki-data'` 的绑定生效；嵌入外壳没有工作台绑定会话
 * （`ctx.workbench === null`）⇒ 不适用，返回 `false`。
 *
 * 性能：StatusBar 的 computed 只在 `main.doc` / 内容投影变化时重算；一次编辑的
 * 规范化成本 = 缓存命中的 baseline 比较 + current 一次（约 60ms），不再成对计算。
 */
export function wikiRemoteDirtyOf(ctx: Context): boolean {
  if (ctx.workbench === null) return false
  const binding = ctx.getDocumentBinding().value
  if (binding.sourceId !== 'wiki-data') return false
  return hasWikiRemoteChanges(binding.saveBaseline, ctx.plainForSave().plain)
}
