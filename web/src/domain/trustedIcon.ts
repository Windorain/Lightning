/**
 * 可信编译期图标（「可信图标使用专门来源，不能把『支持图标 HTML』
 * 升级为外部内容注入通道」）。
 *
 * ## 为什么需要一个"专门来源"而不是继续 `v-html`
 *
 * 改动前，工具组按钮的图标是模块内的 SVG 字符串常量，经 `v-html` 注入：
 *
 * ```ts
 * const icons = { select: `<svg …>`, … }
 * <span v-html="toolIcon(id, state)" />
 * ```
 *
 * 这段代码**本身**是安全的（字符串是编译期常量）。但它留下了一条**形状**：
 * "某个 prop/字段可以携带 HTML 并生效"。于是只要将来有人把图标来源换成
 * 数据驱动（配置、文档字段、外部主题包），同一条通路立刻变成注入面 ——
 * 而代码审查很难看出这次改动跨越了安全边界。
 *
 * 本模块把这条形状**结构性**堵住：
 *
 * 1. 图标模板是**编译期常量**，值经 `Object.freeze` 冻结；
 * 2. 对外暴露的是**品牌类型** `TrustedIconTemplate`，它的构造口只有
 *    `trustedIcon(...)`，而后者只认**模块内已登记的名称**（`ICON_KEYS`）。
 *    因此调用方无法把任意字符串"声明"成可信图标 —— 拿到模板的唯一途径是
 *    引用一个已登记的键。
 * 3. 颜色等多变部分作为**参数**在构造时替换，替换值来自**本模块的常量表**
 *    （`ICON_STATES`），不接受外部颜色串。
 *
 * ## 仍有一处 `v-html` —— 但它被隔离在一个组件里
 *
 * `editors/TrustedIcon.vue` 是**唯一**消费该类型的地方，也是全仓唯一保留的
 * `v-html`。它只接受 `TrustedIconTemplate`（品牌类型），不可能接受外部文本。
 * 这与"每个组件各自选路径"有本质区别：调用方无法绕过类型去传一个字符串，
 * 且审查面从"6 处调用点"收敛为"1 个组件 + 1 个类型"。
 */

/**
 * 品牌类型：可信图标模板。
 *
 * `readonly __brand` 让"结构化类型"无法伪造 —— 任何对象字面量都缺这一字段，
 * 而该字段只能由本模块的 `trustedIcon()` 产出。
 */
export interface TrustedIconTemplate {
  /** 已替换好颜色的 SVG 标记（**编译期常量派生**，非外部输入）。 */
  readonly markup: string
  /** 来源键（诊断/测试用；证明它来自登记表而非任意字符串）。 */
  readonly key: string
  readonly __brand: 'TrustedIconTemplate'
}

/** 图标状态 → 颜色（**本模块常量表**；外部无法影响）。 */
const ICON_STATES = Object.freeze({
  inactive: '#56728a',
  active: '#4dabf7',
  hover: '#c5d8e8',
} as const)

export type TrustedIconState = keyof typeof ICON_STATES

/** 颜色占位符（模板里唯一可替换的片段）。 */
const COLOR_SLOT = '__COLOR__'

/**
 * 编译期图标模板表。
 *
 * 只允许"本表登记的名称"成为可信图标：新增图标 = 在**这个文件**加一条，
 * 而不是从外部传一个串。表内模板不含任何外部输入，只含一个颜色占位符。
 */
const ICON_TEMPLATES = Object.freeze({
  select: `<svg viewBox="0 0 24 24" fill="none" stroke="${COLOR_SLOT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l6 16 2-6 6-2z"/></svg>`,
  move: `<svg viewBox="0 0 24 24" fill="none" stroke="${COLOR_SLOT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20"/><path d="M8 4l4-2 4 2M8 20l4 2 4-2M4 8l-2 4 2 4M20 8l2 4-2 4"/></svg>`,
  box: `<svg viewBox="0 0 24 24" fill="none" stroke="${COLOR_SLOT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 12h18M12 3v18"/></svg>`,
  point: `<svg viewBox="0 0 24 24" fill="none" stroke="${COLOR_SLOT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 2"/></svg>`,
  line: `<svg viewBox="0 0 24 24" fill="none" stroke="${COLOR_SLOT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.5" fill="${COLOR_SLOT}" stroke="none"/><circle cx="20" cy="4" r="1.5" fill="${COLOR_SLOT}" stroke="none"/></svg>`,
  text: `<svg viewBox="0 0 24 24" fill="none" stroke="${COLOR_SLOT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M12 7v14"/><path d="M6 21h12"/><path d="M7 3h10l-1 4H8z"/></svg>`,
} as const)

/** 已登记的图标键（可信来源的**完整**清单）。 */
export type TrustedIconKey = keyof typeof ICON_TEMPLATES

/** 登记键清单（测试与诊断对账用）。 */
export const TRUSTED_ICON_KEYS: readonly TrustedIconKey[] = Object.freeze(
  Object.keys(ICON_TEMPLATES) as TrustedIconKey[],
)

/** 运行时校验"这个键确实已登记"（防越界索引拿到 undefined）。 */
export function isTrustedIconKey(value: unknown): value is TrustedIconKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ICON_TEMPLATES, value)
}

/**
 * 构造可信图标 —— **唯一**入口。
 *
 * `key` 必须是登记键；`state` 必须是本模块的状态常量之一。两者都不满足时
 * 回退到 `select`/`inactive`（不抛异常：UI 不应因图标名写错而崩，
 * 但也不会因此接受一个任意字符串）。
 */
export function trustedIcon(
  key: unknown,
  state: TrustedIconState = 'inactive',
): TrustedIconTemplate {
  const safeKey: TrustedIconKey = isTrustedIconKey(key) ? key : 'select'
  const safeState: TrustedIconState =
    typeof state === 'string' && Object.prototype.hasOwnProperty.call(ICON_STATES, state)
      ? state
      : 'inactive'
  const color = ICON_STATES[safeState]
  return Object.freeze({
    markup: ICON_TEMPLATES[safeKey].split(COLOR_SLOT).join(color),
    key: safeKey,
    __brand: 'TrustedIconTemplate' as const,
  })
}

/** 结构化类型守卫：只有本模块产出的对象才带品牌字段。 */
export function isTrustedIconTemplate(value: unknown): value is TrustedIconTemplate {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __brand?: string }).__brand === 'TrustedIconTemplate' &&
    typeof (value as { markup?: unknown }).markup === 'string'
  )
}
