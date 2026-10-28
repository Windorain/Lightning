/**
 * pure/partTypes.ts — 非满方块（部件）数据模型的纯类型与纯函数。
 *
 * 契约：`docs/contracts/format-parts-contract.md`（§2 文件表达、§3 PartRecord schema、§6 盒坐标系）。
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * `cellPartsGrid` 空值标记：与 `cellGrid` 同形、同下标 `[z][row][column]`，
 * 值为根级 `partLists` 下标；`PARTS_GRID_NONE` 表示该格无部件（仿 `TOOLTIP_GRID_NONE`，契约 §2）。
 */
export const PARTS_GRID_NONE = -1

// ---------------------------------------------------------------------------
// PartRecord 五要素 + 来源四元组（契约 §3）
// ---------------------------------------------------------------------------

/** 盒类别（契约 §6.4：视觉/碰撞两盒都取） */
export type PartBoxKind = 'visual' | 'collision'

/**
 * 空间子盒。坐标系 = 0–1 方块局部、Y-up（契约 §6.1）；
 * 允许越出 [0,1]³，如实记录不裁剪（契约 §6.3，如栅栏碰撞盒 maxY=1.5）。
 */
export interface PartBox {
  min: [number, number, number]
  max: [number, number, number]
  kind: PartBoxKind
}

/** 物品身份（契约 §5：计数单位 = 可合成物品） */
export interface PartItem {
  registry: string
  damage: number
  /** FMP 材料串等 NBT 判别（契约 §5 fmp 行）；缺省 = 无 */
  nbtDiscriminator?: string
  count: number
  /** 可选：该物品条目显示名（附加条目无部件级 displayName 时用；缺省 ⇒ UI 以物品身份键作 label） */
  display?: string
}

/** 来源族（契约 §4 localId 命名空间即由此派生） */
export type PartFamily = 'ae2' | 'enderio' | 'fmp' | 'generic' | 'inferred'

/** 盒来源标记（契约 §6.4） */
export type PartBoxProvenance =
  | 'both'
  | 'collision-derived-visual'
  | 'visual-only'
  | 'collision-only'
  | 'degenerate'

/** 来源四元组（契约 §3） */
export interface PartSource {
  family: PartFamily
  /** 是否兜底（族权威 = false；generic/inferred = true） */
  fallback: boolean
  boxProvenance: PartBoxProvenance
  /** 档位：1=族权威 2=通用盒 3=几何推断 */
  tier: number
}

/**
 * PartRecord —— 部件五要素（契约 §3：缺一即契约违例；`items: []` 是显式"无"）。
 * 盒是导出时快照，web 端任何编辑不重算（契约 §10）。
 */
export interface PartRecord {
  /** ① 格内定位：`<族前缀>:<族内定位符>`（契约 §4 命名空间隔离） */
  localId: string
  /** ② 跨格类型键 = 计数/合并键（契约 §5，由物品身份导出） */
  typeKey: string
  /** ③ 空间盒（允许多子盒；坐标系见 PartBox） */
  boxes: PartBox[]
  /** ④ 显示名（尊重游戏内显示名） */
  displayName: string
  /** ④ 说明行（导出时生成完毕，web 端只展示） */
  tooltip: string[]
  /** ⑤ 物品身份（空数组 = 显式"无"） */
  items: PartItem[]
  /** 来源四元组 */
  source: PartSource
  /** 族特有补充信息扩展点（契约 §3；强契约字段不得藏这里） */
  properties?: Record<string, string>
}

/** 一格的部件列表（`partLists` 池的元素类型） */
export type PartList = PartRecord[]

// ---------------------------------------------------------------------------
// 内容签名去重（契约 §2.1：同内容 partList 跨格共享一份下标）
// ---------------------------------------------------------------------------

/** 键序稳定的 JSON 序列化（递归排序对象键；数组保序）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

/**
 * 部件列表内容签名：local id 序列 + 类型键 + 盒 + 物品身份全部一致 ⇒ 同签名（契约 §2.1）。
 * 不做跨版本/跨文件稳定性承诺（仅同一序列化批次内去重用）。
 */
export function partListSignature(list: readonly PartRecord[]): string {
  return stableStringify(list)
}
