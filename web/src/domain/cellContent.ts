/**
 * `domain/cellContent` —— **逐格内容的类型化承载**（部件 / 逐格说明）。
 *
 * ## 本模块解决什么（它替代的旧机制）
 *
 * 实测登记的缺口原文（机械证据）：
 *
 * > 同类缺口：注解几何（只剩 shape/text）、**部件（`cellPartsGrid`/`partLists`）**、
 * > **tooltip 池（`tooltipPalette`/`cellTooltipGrid`）**。
 *
 * 内核 `Document` 原先只承载 `{metadata, frameAxis, resources}`（`domain/content`），
 * 与方块几何一同缺失的正是这两类**逐格内容**。于是：
 *
 * | 旧形态 | 位置 | 后果 |
 * |---|---|---|
 * | `cellPartsGrid`（`[z][row][col]` 下标网格）+ `partLists`（池） | `render/schema/types.ts:182/187`；`pure/partTypes.ts` | 内核无落点 ⇒ 装配 → 投影往返**静默丢掉**整个部件面 |
 * | `tooltipPalette`（文案池）+ `cellTooltipGrid`（下标网格） | `render/schema/types.ts:198/177` | 同上；且真实信封夹具的 `tooltipPalette` 长度 16 |
 * | 下标网格用 `-1` 兼表「无」 | `PARTS_GRID_NONE`/`TOOLTIP_GRID_NONE` = `-1` | `-1` 是**哨兵值**而非类型事实：`null`/越界/`-1` 在消费侧三分不清 |
 *
 * ## 三条设计判据
 *
 * ### 1. 「池 + 下标网格」是**文件格式的表达手段**，不是领域模型
 *
 * 池化（`partLists` / `tooltipPalette`）的目的是**压缩**：同内容跨格共享一份下标。
 * 它是文件或传输层的关切，不是「这一格有什么」的领域事实。内核若照搬池 + 下标，
 * 就把压缩手段变成了内容模型 —— 于是"两个格子引用了池里的同一项"变成一条**结构性**
 * 关系（而它是巧合），且 `-1` 哨兵必须被每一个消费者重新解释。
 *
 * ⇒ 内核承载的是**逐格解析后的值**：{@link CellContent}。池与下标网格是
 * **投影时**由它机械重建的（见 `composition/kernelProjection#projectCellContent`），
 * 因此"同内容共享一份下标"这条文件性质仍被保持，而领域面看不到池。
 *
 * ### 2. 逐格键是**世界坐标** `"x,y,z"`，与 `blockGrid.cells` **同一套键**
 *
 * `composition/kernelAssembly#blockCellKey` 已经把方块单元放在 Y-up 世界坐标上，
 * 且那里逐字写明「**唯一**的翻转点」是解析期的 `structureRowToWorldY`。
 * 若本模块再存 `[z][row][col]` 下标，就出现了**第二套坐标**，
 * 而两套坐标之间的翻转必然要在某个消费者里再做一次 —— 那正是
 * 要消除的"重复坐标翻转"（负对照）。
 *
 * ⇒ 本模块的键与 `blockCellKey` **共用同一个构造函数**（{@link cellContentKey}
 * 转发它），于是"两套键会不会漂移"这个问题在结构上不存在。
 *
 * ### 3. 「没有这一格的内容」与「这一格的内容是空」必须可区分
 *
 * 旧形态把两者都表达成 `-1`（`PARTS_GRID_NONE`/`TOOLTIP_GRID_NONE`），
 * 于是"该格无部件"与"该格的部件列表是空数组"不可分辨。
 * 同族要求是「区分未请求、加载中、可用、缺失、失败」——
 * 用一个哨兵兼表多态正是负对照要判红的形态。
 *
 * ⇒ 本模块的类型是**可选字段**（`parts?: ...`、`tooltip?: ...`）：字段缺席 = 该格无此类内容；
 * 字段在场且为空数组/空串 = 显式声明的空。两者都能往返。
 *
 * ## 合约接触点
 *
 * `docs/contracts/web-kernel-contracts.md` 只在读面清单提到 `blockGrid`/`multiblock`/
 * `annotation` 这些名字（`kernelGrid`/`kernelMultiblock*`/`kernelAnnotations`），未定义逐格承载面——
 * 故本模块与 `domain/content.ts` 新增的逐格承载面属**契约未覆盖处**，就地记录、不就地实现。
 * 本模块**不**改任何冻结类型。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无时钟、不 import 任何旧层（`domain/` 是纯核心）。
 * 部件盒与说明行是**导出时快照**（契约 §10：web 端任何编辑不重算），故本模块只承载、不推导。
 */

import { cellPositionKey, type CellPosition } from './cellPosition'
import { canonicalize } from './identity'

// ─────────────────────────────────────────────────────────────────────────────
// 部件（非满方块）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 盒类别（契约 §6.4：视觉/碰撞两盒都取）。
 *
 * 就地声明而**不** import `pure/partTypes`：`pure/` 是旧层，`domain/` 不得依赖它
 * （`kernel-legacy-isolation` 闸门）。这个联合只有两个成员且是
 * **格式契约**的一部分（`format-parts-contract.md` §6.4），就地声明是唯一来源而不是重复。
 */
export type PartBoxKind = 'visual' | 'collision'

/**
 * 空间子盒（契约 §6）：坐标系 = 0–1 方块局部、Y-up。
 *
 * 允许越出 `[0,1]³`，**如实记录不裁剪**（契约 §6.3，如栅栏碰撞盒 `maxY = 1.5`）——
 * 裁剪会让"这个盒子比一格高"这个事实消失，而它是渲染与拾取都要用的。
 */
export interface PartBox {
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
  readonly kind: PartBoxKind
}

/** 来源族（契约 §4 `localId` 命名空间即由此派生）。 */
export type PartFamily = 'ae2' | 'enderio' | 'fmp' | 'generic' | 'inferred'

/** 盒来源标记（契约 §6.4）。 */
export type PartBoxProvenance = 'both' | 'collision-derived-visual' | 'visual-only' | 'collision-only' | 'degenerate'

/**
 * 来源四元组（契约 §3）。
 *
 * `tier`：1 = 族权威、2 = 通用盒、3 = 几何推断。它是"这个部件的盒有多可信"的**声明**，
 * 呈现侧据此决定是否提示；本模块只承载，不据此改变任何行为（那会是第二份政策）。
 */
export interface PartSource {
  readonly family: PartFamily
  /** 是否兜底（族权威 = `false`；`generic`/`inferred` = `true`）。 */
  readonly fallback: boolean
  readonly boxProvenance: PartBoxProvenance
  readonly tier: number
}

/** 物品身份（契约 §5：计数单位 = 可合成物品）。 */
export interface PartItem {
  readonly registry: string
  readonly damage: number
  /** FMP 材料串等 NBT 判别；缺省 = 无。 */
  readonly nbtDiscriminator?: string
  readonly count: number
  /** 可选显示名（附加条目无部件级 `displayName` 时用）。 */
  readonly display?: string
}

/**
 * 一个部件（契约 §3 的"五要素"；缺一即契约违例）。
 *
 * `items: []` 是显式"无"（不是字段缺席）—— 与契约 §3 逐字一致。
 */
export interface PartRecord {
  /** ① 格内定位：`<族前缀>:<族内定位符>`（契约 §4 命名空间隔离）。 */
  readonly localId: string
  /** ② 跨格类型键 = 计数/合并键（契约 §5，由物品身份导出）。 */
  readonly typeKey: string
  /** ③ 空间盒（允许多子盒）。 */
  readonly boxes: readonly PartBox[]
  /** ④ 显示名（尊重游戏内显示名）。 */
  readonly displayName: string
  /** ④ 说明行（导出时生成完毕，web 端只展示）。 */
  readonly tooltip: readonly string[]
  /** ⑤ 物品身份（空数组 = 显式"无"）。 */
  readonly items: readonly PartItem[]
  readonly source: PartSource
  /** 族特有补充信息扩展点（契约 §3；强契约字段不得藏这里）。 */
  readonly properties?: Readonly<Record<string, string>>
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐格内容
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一格的内容（除方块身份之外的逐格事实）。
 *
 * ## 为什么是"一格一个值"而不是"每类一张下标网格"
 *
 * 三类逐格内容（部件、逐格说明、未来的注解挂点）在文件里各自是一张网格，但它们的
 * **语义**是同一条："这一格除了方块身份之外还有什么"。把它们拆成 N 张平行网格，
 * 就要求每个消费者自己维护"这几张网格的下标必须对齐"这一不变量 ——
 * 而它**没有任何类型**在把守（旧形态正是如此：`cellGrid`/`cellPartsGrid`/`cellTooltipGrid`
 * 三者必须同形同下标，靠约定维持）。
 *
 * ⇒ 一个 `CellContent` 一次给全该格的全部非身份内容，"下标对齐"从约定变成结构。
 *
 * ## 字段全可选，且"缺席"与"空"不同（见文件头判据 3）
 */
export interface CellContent {
  /** 该格的部件列表；**缺席** = 无部件格。空数组 = 显式"有部件数据但列表为空"。 */
  readonly parts?: readonly PartRecord[]
  /** 该格的说明文案；**缺席** = 无逐格说明。空串 = 显式"说明了空"。 */
  readonly tooltip?: string
}

/** 逐格内容表（键 = 世界坐标 `"x,y,z"`，与 `blockGrid.cells` 同一套键）。 */
export type CellContentTable = Readonly<Record<string, CellContent>>

/** 空格内容表（冻结的同一个实例，不每次新建）。 */
export const EMPTY_CELL_CONTENT: CellContentTable = Object.freeze({})

/** 世界坐标 → 逐格内容键（**转发** `blockGrid.cells` 的同一构造函数，见文件头判据 2）。 */
export function cellContentKey(x: number, y: number, z: number): string {
  return cellPositionKey({ x, y, z })
}

/** 单格内容的规范化构造（冻结；缺席字段不写入 —— 缺席与空必须可区分）。 */
export function cellContent(init: { parts?: readonly PartRecord[]; tooltip?: string } = {}): CellContent {
  const out: { parts?: readonly PartRecord[]; tooltip?: string } = {}
  if (init.parts !== undefined) out.parts = Object.freeze([...init.parts])
  if (init.tooltip !== undefined) out.tooltip = init.tooltip
  return Object.freeze(out)
}

/** 该格是否有任何内容（用于"有内容"与"内容为空"的判定；不做深比较）。 */
export function cellContentIsEmpty(content: CellContent): boolean {
  const parts = content.parts
  if (parts !== undefined && parts.length > 0) return false
  if (content.tooltip !== undefined && content.tooltip !== '') return false
  return true
}

/**
 * 规范化逐格内容表：按**键排序** + 逐项冻结。
 *
 * 排序的理由是**内容身份**：`DocumentContent` 进 `digestOf`（`domain/identity` 的
 * `canonicalize` 对对象键**排序**），但那是**对象字面量**的键序归一；而这里若用
 * 「插入顺序」构造对象，两次语义相同的装配仍会得到同一个 `canonicalize` 结果
 * （因为它排序）。⇒ 排序**不是**身份正确性的必要条件，而是**诊断可比性**的必要条件：
 * 逐格对照证据要求两份产物的键序一致，否则 diff 输出不可读。
 *
 * 空表返回冻结的共享实例（`EMPTY_CELL_CONTENT`），使"空文档两次装配得到同一个引用"
 * 成为可断言的事实（`digestOf` 之外的第二层等价性）。
 */
export function normalizeCellContent(table: CellContentTable): CellContentTable {
  const keys = Object.keys(table)
  if (keys.length === 0) return EMPTY_CELL_CONTENT
  const out: Record<string, CellContent> = {}
  for (const k of keys.sort()) out[k] = table[k] as CellContent
  return Object.freeze(out)
}

/** 逐格内容表的**内容摘要**（供诊断与对账；不参与 `DocumentContent` 的身份，见下）。 */
export function cellContentDigestInput(table: CellContentTable): unknown {
  return Object.keys(table)
    .sort()
    .map((k) => [k, table[k]?.parts ?? null, table[k]?.tooltip ?? null])
}

/** 位置类型再导出（供装配/投影两侧共用同一形状，不各自声明）。 */
export type { CellPosition }

/**
 * 两份逐格内容是否**语义相同**（幂等判定的唯一口径）。
 *
 * ## 为什么不用 `JSON.stringify` 或逐字段手写比较
 *
 * | 方案 | 为什么不成立 |
 * |---|---|
 * | `JSON.stringify(a) === JSON.stringify(b)` | 键序依赖**构造顺序** ⇒ 同一份语义内容经 `cellContent()` 与经装配得到不同串 ⇒ 幂等判定漏判 ⇒ 每次"写同样的值"都推进版本并进历史（`domain/identity` 文件头记录的同一条理由） |
 * | 逐字段手写 | `CellContent` 的 `parts` 是 `PartRecord` 的**任意嵌套**结构（`boxes`/`items`/`properties`）⇒ 手写比较会随 `PartRecord` 加字段而**静默漏比**（漏比 = 把"不同"读成"相同" = 丢写） |
 *
 * ⇒ 用 `canonicalize`（`domain/identity`）：它对对象键**排序**、对数组保序、
 * 对 `undefined` 显式编码 ⇒ 同一份语义内容恒得同一串，而它也正是内容身份
 * （`digestOf`）用的规范化器 —— **不存在第二套规范化口径**。
 *
 * ⚠️ 这里返回的是**字符串相等**而不是摘要相等：`digestOf` 是 32 位 FNV-1a，
 * 它承担"内容身份"（可碰撞、够用）而不承担"是否要写入"的判定
 * （漏判会让一次真实写入被吞掉）。两者用途不同，故不复用摘要。
 */
export function sameCellContent(a: CellContent | undefined, b: CellContent | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return canonicalize(a) === canonicalize(b)
}
