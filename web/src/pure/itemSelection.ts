/**
 * pure/itemSelection.ts — 左栏**物品行**的「经典文件选择式」多选语义（B-5 / Gitea #38）。
 *
 * 需求依据：#7 §5「交互语义（多选已定案：对齐经典文件选择）」——该表是硬约束，本模块是它的
 * 唯一实现；UI（`BlockStatsSidebar`）只把**行点击 + 修饰键 + 当前可见顺序**送来，不做语义判断。
 *
 * ── 语义表（逐项对应 #7 §5 / #38「完成定义」表）──────────────────────────
 * | 操作 | 语义 |
 * |---|---|
 * | 单击 | 单选：清空既有选择，选中该行；该行成为**锚点** |
 * | Ctrl / Cmd + 单击 | 切换累加：未选 ⇒ 加入；已选 ⇒ 移出；锚点更新为该行 |
 * | Shift + 单击 | 锚点行 → 该行的连续区间（含两端），**替换**既有选择；锚点不变 |
 * | Ctrl + Shift + 单击 | 同区间**并入**既有选择；锚点不变 |
 * | Esc / 点左栏空白 | 清空（`EMPTY_ITEM_SELECTION`） |
 *
 * ── 拍板（实现者定稿，留痕见 #38 评论）────────────────────────────────
 * 1. **区间在「当前左栏可见顺序」上生效**：`order` 由调用方按渲染顺序给出（物品行 =
 *    `buildItemStats` 的数量降序 / 并列键字典序），本模块不做排序——"可见顺序"是 UI 事实。
 * 2. **无锚点或锚点已不在可见顺序**（文档/过滤层变化后锚点行消失）：区间无定义 ⇒ 退化，
 *    且**不清空既有选择**：
 *    - 纯 Shift ⇒ 退化为此前语义的"单选该行"（与单击同结果），锚点置为该行；
 *    - Ctrl+Shift ⇒ 退化为此前语义的"切换累加"，锚点置为该行。
 *    这样"锚点丢失"不会把用户已有的多选无声抹掉。
 * 3. **单击不切换**：点已选中的行仍是"单选该行"（经典语义），不是取消选中——取消选中走
 *    Ctrl+单击（切换）或 Esc/空白（清空）。这与**旧文件宿主行**的"单击切换"不同，
 *    两条路径语义各自独立（旧路径不在本模块管辖内）。
 *
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments
 * （返回值一律是新对象/新 Set；`EMPTY_ITEM_SELECTION` 的 Set 从不被改写）。
 */

/** 行点击的修饰键快照（`ctrl` 已由 UI 合并 Cmd/Meta） */
export interface ItemRowClickMods {
  ctrl?: boolean
  shift?: boolean
}

/** 选择状态：选中集合 + 锚点行（`null` = 无锚点） */
export interface ItemSelectionState {
  /** 选中的物品身份键集合 */
  selected: ReadonlySet<string>
  /** 锚点行键（Shift 区间的起点）；`null` = 无锚点 */
  anchor: string | null
}

/** 空选择（Esc / 点空白 / 初始态）。`selected` 是共享只读空集，调用方不得改写。 */
export const EMPTY_ITEM_SELECTION: ItemSelectionState = {
  selected: new Set<string>(),
  anchor: null,
}

/** 切换单个键（纯函数：返回新 Set） */
export function toggleItemKey(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/**
 * 可见顺序上的闭区间 `from → to`（含两端，自动判方向）；任一端不在 `order` 内 ⇒ `null`
 * （区间无定义，调用方走退化语义）。
 */
export function itemRangeKeys(
  order: readonly string[],
  from: string,
  to: string,
): string[] | null {
  const i = order.indexOf(from)
  const j = order.indexOf(to)
  if (i < 0 || j < 0) return null
  const lo = Math.min(i, j)
  const hi = Math.max(i, j)
  return order.slice(lo, hi + 1)
}

/**
 * 行点击 → 新选择状态（纯函数；语义表见文件头）。
 *
 * @param state 当前选择
 * @param key   被点击行键（物品身份键）
 * @param order 当前左栏**可见顺序**（行键数组）
 * @param mods  修饰键（`ctrl` = Ctrl/Cmd；`shift` = Shift）
 */
export function applyItemRowClick(
  state: ItemSelectionState,
  key: string,
  order: readonly string[],
  mods: ItemRowClickMods = {},
): ItemSelectionState {
  const ctrl = mods.ctrl === true
  const shift = mods.shift === true

  if (!shift) {
    if (ctrl) return { selected: toggleItemKey(state.selected, key), anchor: key }
    return { selected: new Set([key]), anchor: key }
  }

  const range = state.anchor === null ? null : itemRangeKeys(order, state.anchor, key)
  if (range === null) {
    // 无锚点 / 锚点不在可见顺序 ⇒ 区间无定义：退化到"此前语义"，不清空既有选择（拍板 2）
    if (ctrl) return { selected: toggleItemKey(state.selected, key), anchor: key }
    return { selected: new Set([key]), anchor: key }
  }

  if (ctrl) {
    const next = new Set(state.selected)
    for (const k of range) next.add(k)
    return { selected: next, anchor: state.anchor }
  }
  return { selected: new Set(range), anchor: state.anchor }
}

/** 清空（Esc / 点左栏空白）。返回共享空状态。 */
export function clearItemSelection(): ItemSelectionState {
  return EMPTY_ITEM_SELECTION
}

/** 是否选中（UI 判定入口，避免调用方各自写 `?.has`） */
export function isItemSelected(state: ItemSelectionState, key: string): boolean {
  return state.selected.has(key)
}
