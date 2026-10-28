/**
 * `application/commands` —— **唯一写通路**：纯命令转移 `reduceCommand`。
 *
 * ## 本模块的三条不可协商性质
 *
 * 1. **纯**：`reduceCommand(state, command, env)` **不改输入**、不读全局时钟/随机/DOM/Vue/网络、
 *    不隐式发事件、不记日志、不写文件。需要时间、身份分配、
 *    能力、随机种子时一律经 `ExecutionInputs` 显式传入。
 * 2. **唯一写通路**：不存在第二条属性写通路 —— 没有 JS Proxy，没有 setter 旁路，
 *    没有"暴露任意字段 patch"的通用命令（唯一写路由的要求）。
 *    ⇒ `Command` 是**封闭判别联合**，不是 `{ kind: string; patch: unknown }`。
 * 3. **无政策藏在接线里**：合法性、写权、冲突、原子性全部在 `domain/*` 的纯函数里；
 *    本模块只做**编排**（把命令路由到对应纯函数并按契约组装 `Transition`）。
 *
 * ## 为什么 `Transition` 里带 `effects`
 *
 * 「接纳已排序输入 → 纯命令转移/交互推进 → 验证并原子提交 → 失效传播与
 * 必要查询求值 → **发出效果/发布只读更新**」。效果**发起**是接线层的事，
 * 但"该发什么效果"是业务政策的一部分（保存命令必须产生 save 效果请求），
 * 故由纯转移描述、由 `runtime/effects` 执行。这样重放的"效果序列一致"才有唯一来源。
 *
 * ## `applied` 与 `unchanged` 的界线（一处口径澄清）
 *
 * 内核契约 §4.1：「`unchanged` 必须保持未改分支的身份（结构共享），但不因"创建了新容器"
 * 就判 `applied`」。契约同时规定 `documentVersion` 只随**内容**推进。
 * 于是存在第三类情形：**业务确实变了，但文档内容没变**（改选择、改时间、改通道取值、
 * begin/update 交互暂存）。这类一律报 `applied`，`changes` 如实描述，
 * 而 `version.documentVersion` **保持不变** —— 因为推进它才是违约。
 * 把它们错报成 `unchanged` 会让"订阅者看到变化"失去依据；
 * 把它们错报成"推进版本"会让"拒绝零残留"判据判红。两者都不是本实现的选择。
 */

import {
  beginSave,
  completeSave,
  createDocument,
  createSaveLedger,
  pushHistory,
  redo as redoDoc,
  undo as undoDoc,
  withAnimation,
  withDocumentContent,
  withScene,
  type Document,
  type SaveLedger,
  type SaveOutcome,
} from '@/domain/document'
// 对象构造入口直接取自 `domain/scene`（不经 `domain/document` 转出口 ——
// 目录骨架规则 1 禁 barrel（`web/tests/architecture/boundary-rules.mjs`）；同层具名导入是常态）。
import { DEFAULT_OBJECT_FACTORIES, createObjectOfType, objectData, withObject, withUpdatedData } from '@/domain/scene'
import type { ObjectData, ObjectDataPayload } from '@/domain/scene'
import { cellContent, cellContentKey, normalizeCellContent, sameCellContent, type CellContent, type CellContentTable, type CellPosition } from '@/domain/cellContent'
import { documentContent, documentMetadata, type DocumentMetadata } from '@/domain/content'
import {
  acquireLease,
  advancePlayback,
  beginInteraction,
  cancelInteraction,
  clearSelection,
  commitInteraction,
  createEditContext,
  createLease,
  releaseLease,
  selectOne,
  updateInteraction,
  withChannelValue,
  withPlaybackRate,
  withPlaying,
  withTime,
  type DocumentLease,
  type EditContext,
  type InteractionState,
  type SceneWriter,
  type SelectionState,
  type TimeValue,
} from '@/domain/editing'
import {
  checkValueAgainstDeclaredType,
  findTrack,
  insertKeyframe,
  propertyKey,
  removeKeyframe,
  sameTime,
  sampleTrack,
  setTrackEnabled,
  withTrack,
  withoutTrack,
  withPublishedDefault,
  frameRateOf,
  type AnimationKey,
  type AnimationState,
  type AnimationTrack,
  type InterpolationKind,
  type TrackValue,
  type TrackValueType,
} from '@/domain/animation'
import {
  err,
  invalidValue,
  missingTarget,
  ok,
  readOnly,
  unsupportedOperation,
  versionConflict,
  type DomainError,
  type Result,
} from '@/domain/errors'
import {
  allocateId,
  canonicalize,
  changeSummary,
  documentRef,
  entityRef,
  objectRef,
  sameContent,
  type ChangeSummary,
  type EntityRef,
  type IdState,
  type PropertyRef,
  type Version,
} from '@/domain/identity'
import { findObject, findObjectData, sameTransform, type Scene, type Transform, type Vec3 } from '@/domain/scene'
import type { ApplicationState, EffectRequest } from './state'
import { applySetProperty, type SetPropertyCommand } from './property-commands'
import {
  describeProperty as describeRnaProperty,
  type PropertyDescriptor,
  type PropertyValue,
} from './properties'
import { kernelAccessOf, kernelPropertyRegistry, kernelWritePorts } from './kernel-properties'

// ─────────────────────────────────────────────────────────────────────────────
// 命令（封闭判别联合 —— 唯一写通路的类型级保证）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 属性值 —— **唯一权威是 `application/properties`**。
 *
 * 本文件曾本地定义 `PropertyValue = number | string | boolean | Vec3 | Quat | null`，
 * 那是早期并行开发的产物。收敛后本文件**不再定义**任何属性值类型：
 * 它只 import RNA 侧的定义，于是「值类型」不可能出现两个不兼容版本
 * （两个版本会让「同一个值在写路由与值 handler 眼里合法性不同」）。
 */
export type { PropertyValue }

/**
 * 属性写命令（`SetPropertyCommand`）—— **唯一权威是 `application/property-commands`**。
 *
 * 本文件曾本地定义一份（含 `contextId`/`expectedVersion`）。收敛后唯一权威在
 * `property-commands.ts`：那里是 RNA 的公开命令类型，面板/脚本/命令搜索共用同一个定义。
 * `reduceSetProperty` 从命令的 `refs[0].owner` 解析文档，不再要求命令携带 `contextId`
 * —— 文档由**引用**决定，不由调用方另填一个可能与引用矛盾的字段决定。
 */
export type { SetPropertyCommand }

export interface SetTransformCommand {
  readonly kind: 'setTransform'
  readonly contextId: string
  readonly objectId: string
  readonly transform: Transform
  readonly expectedVersion?: Version
}

export interface AddObjectCommand {
  readonly kind: 'addObject'
  readonly contextId: string
  /**
   * 对象类型 id（`ObjectTypeId` = `string`，**不是**封闭联合）。
   *
   * ## 为什么这里必须开放（由实测与接入需求印证）
   *
   * 初版写的是 `'block' | 'annotation' | 'camera'` 三元联合。「通过现有贡献接口新增类型，
   * **而非改核心**」的判据把它抓了出来 ——
   * 那个联合让"新增 `text` 类型"必须回来改**命令类型的定义**，
   * 即核心仍需为每个新类型改动。
   *
   * **接入需求印证**：实现 `mesh` 类型时，正是回到这个联合里加了 `'mesh'`、
   * 并加了一个 `meshSize` 具名字段 —— 同一形态的第二次出现。
   * 此后采用开放通道：`meshSize` 移入 `params.meshSize`。
   *
   * 现在它是开放字符串，合法性由**类型描述表**在运行时判定
   * （`domain/scene#typeDescriptor` + `createObjectOfType`）：
   * 表里没有该类型 ⇒ `UnsupportedOperation`，而不是编译期封闭。
   * 这正是「"新增属性类型之外的普通对象类型"不得需要改核心」的要求。
   */
  readonly objectType: string
  readonly name?: string
  /**
   * 类型特有的构造参数（**唯一**的开放通道）。
   *
   * 各类型自己的字段（注释形状 `shape`、网格尺寸 `meshSize`、相机投影…）
   * 一律经这里传入，核心**不**认识任何单类型特有的字段名 ——
   * 那会让"新增一个类型"变成"回来改命令类型"，即要禁止的形态。
   *
   * ## 保留键 `objectId`
   *
   * `params.objectId`（**字符串**）有值时，`reduceAddObject` 用它作为新对象的
   * 对象 id，而**不**调 `allocateId`；无值 ⇒ `allocateId` 兜底（与改动前逐字节相同）。
   *
   * 为什么需要：装配给注解对象的 id 是 `annotation:<legacyId>`（身份由**源**决定），
   * 而 `allocateId` 产出 `wk-object-N` ⇒ 同一份注解经"装配"与经"addObject"
   * 会得到**两个身份**。实测后果：`selection.active` 与属性面板的 `EntityRef`
   * 对不上 ⇒ **面板后续每次写都打到不存在的 id**。
   *
   * ⇒ 显式 id 把"注解身份由源决定"这条**已存在于装配**的口径贯彻到写路径，
   * 而不是引入第二套身份规则。
   */
  readonly params?: Readonly<Record<string, unknown>>
}

export interface DeleteObjectCommand {
  readonly kind: 'deleteObject'
  readonly contextId: string
  readonly objectId: string
}

/**
 * **写一格说明**（最小命令集的成员）。
 *
 * ## 它替代的旧机制
 *
 * | 旧机制 | 位置 |
 * |---|---|
 * | `clone + 改 `tooltipPalette`/`cellTooltipGrid` + `setDocument`` | `operators/builtin/metaEditOperators.ts:26-43` |
 * | 同上（属性面板路径） | `editors/property-writers.ts:168-180` |
 *
 * 两条写路径都直接改**文件格式的两个顶层侧表字段**
 * （`tooltipPalette` = 文案池、`cellTooltipGrid` = 下标网格，靠 `-1` 哨兵表示"无"），
 * 而内核把逐格说明承载在 `blockGrid` 载荷的 `cellContent[key].tooltip` 上
 * （**键编码**，与 `cells` 同一套键）。
 *
 * ## ⚠️ 为什么"一格"要用 `x/y/z` 而不是下标
 *
 * 旧侧表用 `cellTooltipGrid[z][row][x]` 的**三元下标**，且 `row` 是**从上往下**的行序
 * （装配侧要翻成 `y = sizeRow - 1 - row`，见 `kernelPaletteAssembly.ts:260`）。
 * 内核用 **`x,y,z` 世界坐标键**（`cellContentKey`）。
 * ⇒ 本命令收**世界坐标**，把"行序翻转"这件事挡在命令面之外 ——
 * 那正是旧形态最容易错一行的地方（装配层注释已记过一次同类风险）。
 *
 * ## `text: null` = 删除该格说明
 *
 * 与 `cellContentIsEmpty` 的"缺席 ≠ 空"同口径：
 * - `null` ⇒ **移除该格的 `tooltip` 字段**（若该格因此无内容，连键一起删）；
 * - `''` ⇒ 写**显式空说明**（`tooltip: ''`，语义是"说明了空"）。
 * 把两者压成同一个会让"没说明"与"说明为空"不可区分。
 */
export interface SetCellTooltipCommand {
  readonly kind: 'setCellTooltip'
  readonly contextId: string
  /**
   * ⚠️ **没有 `objectId`**：逐格说明是**文档级**事实（见下方"为什么文档级"）。
   *
   * ## 为什么文档级（实测的语义不对称，本命令的设计依据）
   *
   * | 侧 | 承载方式 |
   * |---|---|
   * | legacy（文件格式） | `tooltipPalette` + `cellTooltipGrid` 是**文档根**的**单个**网格 |
   * | 内核 | 逐格说明挂在**每个** `blockGrid` 载荷的 `cellContent` 上 |
   *
   * 而装配把**同一份**文档级说明复制到**每一个**帧对象
   * （`kernelAssembly.ts:1559-1583`：帧循环里逐帧调 `tooltipContentOf(doc, grid)`，
   * 且用**该帧自己的** `grid.height` 做行序翻转）。
   *
   * ## ⚠️ 为什么必须一次写**全部** `blockGrid` 对象（不能只写一个）
   *
   * 投影侧 `tooltipPoolOfPayloads`（`kernelProjection.ts:869-873`）取
   * **第一个**有池的载荷就返回 ⇒ 若各帧的说明**不一致**，只有第一帧的会被写回文件，
   * 其余帧的**静默丢失**（"看起来写成功了，存出来却没有"）。
   * ⇒ 本命令对**每个**含该格的 `blockGrid` 对象**原子**写入（一条命令 = 一个事务 = 一条历史）。
   *
   * 只写"当前帧对象"是**错的**：那会让多帧文档的说明逐帧分叉，
   * 而装配期建立的不变量是"所有帧携带同一份文档级说明"。
   */
  readonly cells: readonly CellPosition[]
  /** 说明文案；`null` = 删除该格说明（见上文"缺席 ≠ 空"）。 */
  readonly text: string | null
}

/**
 * **写一格（或多格）的逐格内容**（最小集成员 `setCellContent`）。
 *
 * ## 它与 {@link SetCellTooltipCommand} 的分工（不是第二条写通路）
 *
 * | 命令 | 写什么 | 粒度 |
 * |---|---|---|
 * | `setCellTooltip` | **只**写 `CellContent.tooltip` | 逐字段（保留 `parts`） |
 * | `setCellContent`（本条） | 该格的 `CellContent` **整体**（`parts` + `tooltip`） | 整值替换 |
 *
 * 两条命令的**语义**不同（改一个字段 vs 给出这一格的全部内容），
 * 但它们归约到**同一条状态转移**：`writeCellContentOf`（本文件内唯一的写入助手），
 * 故"同一格事实有两个写者"在实现上不成立 —— 那正是 §5.2 要消除的形态。
 * 拆成两条具名命令的理由是同一句：「移动多个对象、删除对象、
 * 插入关键帧等**保持具名命令**」—— 字段级与整值级的**拒绝条件不同**
 * （前者只关心 tooltip 的幂等，后者还关心 `parts`），压成一条会让
 * "只写说明"也必须携带整份部件表（调用方被迫先读后写 ⇒ 引入竞态）。
 *
 * ## 为什么 `content: null` 能表达"这一格没有内容"，而 `{}` 不能
 *
 * `CellContent` 的两个字段都是**可选**的，且"字段缺席"与"字段在场但为空"
 * 是两种不同事实（`domain/cellContent` 文件头判据 3）。于是：
 *
 * - `content: null` ⇒ **删除该格的 `cellContent` 条目**（"这一格没有逐格内容"）；
 * - `content: { tooltip: '' }` ⇒ 该格有内容，内容是"**说明了空**"；
 * - `content: {}` ⇒ 该格有内容条目但两类内容都**缺席**
 *   （与 `null` 的差别是"有键无内容" vs "无键" —— 前者是显式声明的空壳）。
 *
 * 三者都必须可表达，故 `null` 与 `{}` **不得**合并。
 *
 * ## 文档级（与 `setCellTooltip` 同一取舍，理由逐字相同）
 *
 * 逐格内容在文件格式里是**文档根**的池 + 下标网格（`partLists`/`cellPartsGrid`），
 * 装配把它复制到**每一个**帧网格对象上。若只写"当前帧对象"，多帧文档的逐格内容
 * 会逐帧分叉，而投影只取第一份池 ⇒ 其余帧静默丢失。故本命令对**每个**含该格的
 * `blockGrid` 对象**原子**写入（一条命令 = 一个事务 = 一条历史）。
 */
export interface SetCellContentCommand {
  readonly kind: 'setCellContent'
  readonly contextId: string
  /** 目标格（世界坐标；与 `cells` 同一套键，行序翻转**不**进命令面）。 */
  readonly cells: readonly CellPosition[]
  /** 该格的新内容；`null` = 删除该格的逐格内容条目（见上文三态）。 */
  readonly content: CellContent | null
  /** 期望的文档版本（防"基于过期画面提交"；缺省 = 不检查）。 */
  readonly expectedVersion?: Version
}

/**
 * **移动格**（最小集成员 `moveCells`；领域语义的**裁定点**）。
 *
 * ## 领域语义（这里给出裁定与理由）
 *
 * ### ① 被移动的是**整格**，不是"方块身份的坐标"
 *
 * 一格在载荷里由**四张同键的逐格表**共同描述（`cells` / `cellContent` /
 * `cellGeometry` / `cellPalette`，外加文件槽位 `cellPaletteIndex`）。
 * 只搬 `cells` 会造出一格"身份在 B、内容还在 A"的格子 ——
 * 那正是 `domain/cellContent` 文件头判据 1 明确要消灭的
 * 「几张平行网格的下标必须对齐，而**没有任何类型在把守**」这一约定。
 * ⇒ 本命令把这四张表**同一个键**的项一起搬，于是"下标对齐"从约定变成结构。
 *
 * ### ② 方块身份**随格迁移**
 *
 * 用户拖动的是**那一块方块**（身份在其上），不是"坐标上的位置"。
 * 故 `cells`/`cellPalette` 的值随键一起走 —— 且**不得**在移动时重算方块身份：
 * `cellPalette` 的取值是**条目内容键**（`blockPaletteEntryKey`），
 * 它含条目的**真实 `registryId`（带命名空间）**，原样迁移即保真；
 * 若在移动时按 `cells` 的编码规则重算，就会把
 * `appliedenergistics2:tile.BlockCableBus` 塌成 `minecraft:tile.BlockCableBus`
 * （**历史事故**：投影侧实测 68 条调色板里 66 条命名空间被改写）。
 *
 * ### ③ 目标是**替换**，不是**交换**
 *
 * 目标格原有内容被丢弃，源格**不**接收目标格的原内容。
 * 依据：`moveBlock(from, to)` 的两参数签名**只能**表达"搬到"，
 * 而"互换"是另一件事（它需要两个目标与一条不同的不变量：
 * "互换两次回到原状"）。把 swap 塞进 move 会让"撤销一次"之后
 * 得到既非起点也非终点的第三种状态。互换若需要，另立具名命令。
 *
 * ### ④ 一次命令内的多个移动是**同时**的（与顺序无关）
 *
 * 实现顺序：先**读**全部源格 → 再**写**全部目标格 → 最后**删**掉
 * 那些自己不是任何目标的源键。于是 `a→b, b→c` 的净效果是
 * "a 与 b 都到 c 的位置（b 覆盖 a）"而不是"a 到 b、再 b 到 c"
 * —— 后者（链式）必须写成**两条命令**（第二条看得见第一条的结果）。
 * 选择同时语义的理由是**可判定**：链式语义的结果依赖命令内顺序，
 * 而"命令内顺序"不是 `Command` 联合能表达的事实（`moves` 是集合）。
 *
 * ## 拒绝条件（全部可归因）
 *
 * | 条件 | 错误 |
 * |---|---|
 * | `moves` 为空 | `MissingTarget` |
 * | 同一 `from` 出现两次，或同一 `to` 出现两次 | `InvalidValue{reason:'duplicateCells'}` |
 * | 某 `from` 不在该网格里（`cells` 与四张逐格表都没有该键） | `MissingTarget{objectId:'cell@x,y,z'}` |
 * | `to` 落在**声明尺寸**之外（载荷声明了 `sizeColumn/sizeRow/sizeZSlice`） | `InvalidValue{reason:'outsideDeclaredGrid'}` |
 * | 目标对象数据是 `content` 源（只读） | `ReadOnly` |
 * | `expectedVersion` 与当前不符 | `VersionConflict` |
 *
 * 尺寸越界之所以**拒绝**而不是"扩展尺寸"：越界的目标格在文件格式里
 * **写不出来**（`cellGrid` 的维度是文件声明的），静默丢弃它会让
 * "命令 applied 但方块不见了" —— 那正是"提交成功却看不见"的形态。
 *
 * ## 为什么 `objectId` 必填（与 `setCellTooltip` 的**不对称**，实测语义）
 *
 * 方块身份（`cells`）在文件格式里是**逐帧网格**的字段（`frames[].structure.cellGrid`），
 * 而逐格说明是**文档根**的单张表 ⇒ 装配把它们分别落到"每帧一个对象"与
 * "广播到每帧对象"。故身份写必须点名**哪一个网格**（拖的是那一帧的那一块），
 * 而说明写按文档级广播。
 */
export interface MoveCellsCommand {
  readonly kind: 'moveCells'
  readonly contextId: string
  /** 在**哪个**网格（`blockGrid` 对象）里移动 —— 见上文"为什么 `objectId` 必填"。 */
  readonly objectId: string
  readonly moves: readonly { readonly from: CellPosition; readonly to: CellPosition }[]
  readonly expectedVersion?: Version
}

/**
 * **写一格（或多格）的方块身份**。
 *
 * ## 落点与历史事故的成因（本命令为什么不能"反拼注册名"）
 *
 * 方块身份在文件格式里是两个**平行**事实：`cellGrid` 存注册名（**已截去
 * `minecraft:` 前缀**，`pure/gridTypes.ts:17-22` 逐字如此），`cellPalette` 存
 * 条目内容键（含**真实带命名空间的 `registryId`**）。旧面板写路径
 * （`editors/property-writers.ts:150`）直接改 `SlotBlock.name`/`meta`，
 * 而显示侧的 `block_state_id` 由 `context/queries.ts` 按
 * `` `minecraft:${name}:${meta}` `` **反拼** ⇒ 任何非 `minecraft` 命名空间
 * （`ae2:`、`appliedenergistics2:`…）在"读出→写回"一个来回后被改写成
 * `minecraft:appliedenergistics2:…`。投影侧实测 68 条调色板里 66 条
 * 命名空间被改写，**成因就是这条反拼**。
 *
 * ⇒ 本命令**不参与**注册名的拼装：调用方给的是它已经持有的
 * 「`cells` 值（截前缀注册名）+ `cellPalette` 值（registryId 内容键）」二元组，
 * 命令只做**原样落表**。核心不认识 `minecraft:` 之外的任何命名空间规则 ——
 * 「哪些字节写进 `cells`」是格式边界的口径（`adapters/files`），不是内核的政策。
 *
 * ## 为什么 `null` 能表达"这一格没有方块"，而 `{ name:'', … }` 不能
 *
 * 与 `setCellContent` 同一取舍：`cells[key]` **缺席** = 该格没有方块（空位）；
 * `cells[key] === ''` = 有键但注册名为空（非法字节）。两者必须可区分 ⇒
 * `identity: null` 删 `cells`/`cellPalette` 两表的键，非 `null` 写两表。
 *
 * ## 为什么 `name` 与 `paletteRef` 必须**同时**给出，不能只给一个
 *
 * `cellPalette` 的条目键（`blockPaletteEntryKey`）含真实 `registryId`，
 * 而 `cells` 的值只有截前缀注册名 ⇒ **单给任一半都不能唯一决定另一半**
 * （同一个 `cells` 值可以对应多个不同 `registryId` 的条目）。只给 `cells`
 * 就会让面板写身份时把调色板引用留在旧方块上 —— "身份在 B、内容还在 A"
 * 的同族形态（`domain/cellContent` 文件头判据 1）。故两值**必须**成对。
 *
 * ## 文档级（与 `setCellTooltip` 同一理由，逐字复用）
 *
 * 身份是**逐帧网格**的字段（文件格式 `frames[].structure.cellGrid`），
 * 装配把它广播到每一个帧网格对象上 ⇒ 本命令对**每个**含该格的
 * `blockGrid` 对象**原子**写入（一条命令 = 一个事务 = 一条历史）。
 */
export interface SetCellIdentityCommand {
  readonly kind: 'setCellIdentity'
  readonly contextId: string
  /** 目标格（世界坐标；与 `cells` 表同一套键）。 */
  readonly cells: readonly CellPosition[]
  /** 新身份；`null` = 该格没有方块（删除两表的键，见上文三态）。 */
  readonly identity: CellIdentity | null
  /** 期望的文档版本（防"基于过期画面提交"；缺省 = 不检查）。 */
  readonly expectedVersion?: Version
}

/**
 * 一格的方块身份（{@link SetCellIdentityCommand} 的取值形态）。
 *
 * `name` = **已截去 `minecraft:` 前缀**的注册名（照 `SlotBlock.name` 的口径原样给，
 * **不得**由本类型反拼或补前缀）；`paletteRef` = `cellPalette` 的内容键
 * （含真实 `registryId`，见 `domain/scene` 的 `blockPaletteEntryKey`）。
 */
export interface CellIdentity {
  readonly name: string
  readonly paletteRef: string
  readonly meta?: number
}

/**
 * **写文档元数据**（最小集成员 `setDocumentMeta`）。
 *
 * ## 它替代的旧机制
 *
 * | 旧机制 | 位置 |
 * |---|---|
 * | `clone + 改 `meta.*` + `setDocument`` | `context/embedInitialView#setDocumentEmbedInitialView`（`meta.embed_initial_view`，原地改） |
 * | 属性面板的 `ownerKind === 'document'` 写 | `editors/property-writers.ts`（经 `DocumentState.document: RuntimeDocument`）→ **已改走本命令的 `setDocumentMeta`** |
 * | 注解/文档元数据命令 | `operators/builtin/metaEditOperators.ts` |
 *
 * 落点是 `DocumentContent.metadata`（`domain/content` 的**具名字段**类型，
 * 不是旧 `meta` 的 `Record<string, unknown>` 字段袋）。
 *
 * ## 为什么 `patch` 是 `Partial<DocumentMetadata>` 而不是整值
 *
 * 整值替换要求每个调用方先读后写 —— 而"读到的元数据"与"写回的元数据"之间
 * 任何别的写都会**静默丢失**（典型的丢失更新）。`Partial` 的 `undefined` = "不改这个字段"
 * 是**类型上的缺席**，不是运行期约定；而 `createdAtMs: null` 仍可表达
 * （`null` 是 `DocumentMetadata` 的合法值：源里没有时间）。
 *
 * ## 未知键**不进**这里
 *
 * 文件里的未知 `meta` 键走 `adapters/files/fidelityRecord`（保真记录，
 * 按**文档身份**承载）。本命令的 `patch` 只接受**具名**字段 ——
 * 若它接受 `Record<string, unknown>`，"哪些字段真的没人懂"就永远查不出来
 * （`domain/content` 文件头判据 3 的同一理由）。
 */
export interface SetDocumentMetaCommand {
  readonly kind: 'setDocumentMeta'
  readonly contextId: string
  /** 要改的具名字段；`undefined` = 不改该字段（缺席，非"置空"）。 */
  readonly patch: Partial<DocumentMetadata>
  readonly expectedVersion?: Version
}

export interface BeginInteractionCommand {
  readonly kind: 'beginInteraction'
  readonly contextId: string
  readonly tool: string
  readonly targets: readonly string[]
}

export interface UpdateInteractionCommand {
  readonly kind: 'updateInteraction'
  readonly contextId: string
  /** 自**起点**的总位移（不是自上一帧的增量）。 */
  readonly displacement: Vec3
}

export interface CommitInteractionCommand {
  readonly kind: 'commitInteraction'
  readonly contextId: string
  readonly label: string
}

export interface CancelInteractionCommand {
  readonly kind: 'cancelInteraction'
  readonly contextId: string
}

export interface SelectCommand {
  readonly kind: 'select'
  readonly contextId: string
  readonly target: EntityRef | null
}

export interface SetTimeCommand {
  readonly kind: 'setTime'
  readonly contextId: string
  readonly time: TimeValue
}

/**
 * 开始/停止播放（补齐内核读面；替代旧 `OPERATOR_TOGGLE_FRAME_PLAYBACK`
 * 直写 `Main.framesPlaybackIsPlaying`）。
 *
 * ## 为什么是具名命令而不是"通用上下文写"
 *
 * 播放开关是**业务事实**（时间要不要自己走），它有自己的拒绝条件与自己的读面。
 * 用一个 `patchContext` 之类的通用写命令承载它，会让"哪些上下文字段可写"
 * 变成运行期才知道的事 —— 那正是唯一写路由要消除的形态（封闭判别联合）。
 *
 * ## 不碰时间
 *
 * 「停止播放保留当前时间」⇒ 本命令**只**翻开关。
 * 需要同时定位时，调用方另发 `setTime`（两条命令各自可断言）。
 */
export interface SetPlayingCommand {
  readonly kind: 'setPlaying'
  readonly contextId: string
  readonly playing: boolean
}

/**
 * 设置常量播放倍率（速度是**常量**，当前不接受轨道驱动的速度）。
 *
 * 拒绝：非有限或负（`InvalidValue`）。`0` 合法 —— 等于"playing 但时间不动"。
 */
export interface SetPlaybackRateCommand {
  readonly kind: 'setPlaybackRate'
  readonly contextId: string
  readonly rate: number
}

/**
 * **按注入的经过秒数推进播放时间**（宿主按帧注入时间输入的唯一落点）。
 *
 * ## 为什么它是命令，而不是宿主编排直接改状态
 *
 * 唯一写路由要求"所有权威变化经同一条 `reduceCommand`"。若宿主编排自己
 * `ctx.time = advanceTime(...)`，就出现了一条**绕过唯一写通路**的状态变更，
 * 于是「所有权威变化只在更新阶段」与「相同输入可重放」都不再成立
 * （重放日志里不会有这次推进，重放结果必然不同）。
 *
 * ## `deltaSeconds` 是**输入**，不是从时钟读的
 *
 * 宿主从 RAF 帧时钟算出 delta 后作为命令参数传入；纯转移不读墙钟。
 * 这使"同一时间 ⇒ 同一样本"与"跳帧 = 直接 `setTime`"共用同一条求值路径。
 *
 * 暂停或倍率为 0 ⇒ `unchanged`（**不**产生版本推进，也不产生历史）。
 */
export interface AdvancePlaybackCommand {
  readonly kind: 'advancePlayback'
  readonly contextId: string
  /** 自上一帧经过的**逻辑**秒数（由宿主的帧时钟给出）。 */
  readonly deltaSeconds: number
}

export interface SetChannelValueCommand {
  readonly kind: 'setChannelValue'
  readonly contextId: string
  readonly channel: string
  readonly value: number
}

/**
 * 插入/替换一个关键帧（「要求使用关键帧命令或禁用轨道」里的**关键帧命令**）。
 *
 * 为什么是具名命令而不是"通用属性写 + 一个 flag"：唯一写路由的明文要求
 * 「插入关键帧等**保持具名命令**」。而且它与 `setProperty` 的**语义不同** ——
 * `setProperty` 写基础值（被轨道驱动时会被拒），本命令写**轨道**（永远合法，
 * 前提是目标属性可动画）。合成一个命令会让"我到底改了哪一层"在命令类型上消失。
 */
export interface InsertKeyframeCommand {
  readonly kind: 'insertKeyframe'
  readonly contextId: string
  readonly target: PropertyRef
  readonly time: TimeValue
  readonly value: TrackValue
  /** 缺省：已有轨道则沿用其策略，无轨道则按值类型推断（见 `defaultInterpolationFor`）。 */
  readonly interpolation?: InterpolationKind
  readonly valueType?: TrackValueType
  /** 枚举/布尔的合法取值（由 RNA 描述提供）。 */
  readonly legalValues?: readonly TrackValue[]
  readonly quantization?: AnimationTrack['quantization']
}

export interface RemoveKeyframeCommand {
  readonly kind: 'removeKeyframe'
  readonly contextId: string
  readonly target: PropertyRef
  readonly time: TimeValue
}

/** 启用/禁用轨道（「禁用轨道后回到手动/默认值」）。 */
export interface SetTrackEnabledCommand {
  readonly kind: 'setTrackEnabled'
  readonly contextId: string
  readonly target: PropertyRef
  readonly enabled: boolean
}

/** 发布默认值（有效值优先级的**第一层**；「可发布默认值…属文档」）。 */
export interface PublishDefaultCommand {
  readonly kind: 'publishDefault'
  readonly contextId: string
  readonly target: PropertyRef
  readonly value: TrackValue
}

export interface UndoCommand {
  readonly kind: 'undo'
  readonly contextId: string
}

export interface RedoCommand {
  readonly kind: 'redo'
  readonly contextId: string
}

export interface SaveCommand {
  readonly kind: 'save'
  readonly contextId: string
}

/** 保存完成（**完成事件**入口，不是第二条写通路：它走同一个 `reduceCommand`）。 */
export interface SaveCompletedCommand {
  readonly kind: 'saveCompleted'
  readonly documentId: string
  readonly sequence: number
  readonly bindingGeneration: number
  readonly outcome: SaveOutcome
}

export interface OpenDocumentCommand {
  readonly kind: 'openDocument'
  readonly documentId: string
  readonly contextId: string
}

export interface CloseDocumentCommand {
  readonly kind: 'closeDocument'
  readonly documentId: string
}

export type Command =
  | SetPropertyCommand
  | SetTransformCommand
  | AddObjectCommand
  | DeleteObjectCommand
  | SetCellTooltipCommand
  | SetCellContentCommand
  | SetCellIdentityCommand
  | MoveCellsCommand
  | SetDocumentMetaCommand
  | BeginInteractionCommand
  | UpdateInteractionCommand
  | CommitInteractionCommand
  | CancelInteractionCommand
  | SelectCommand
  | SetTimeCommand
  | SetPlayingCommand
  | SetPlaybackRateCommand
  | AdvancePlaybackCommand
  | SetChannelValueCommand
  | InsertKeyframeCommand
  | RemoveKeyframeCommand
  | SetTrackEnabledCommand
  | PublishDefaultCommand
  | UndoCommand
  | RedoCommand
  | SaveCommand
  | SaveCompletedCommand
  | OpenDocumentCommand
  | CloseDocumentCommand

/**
 * 无效果、可有界完成的命令集合（`executeNow` 的适用范围）。
 *
 * `save` / `saveCompleted` / `openDocument` / `closeDocument` **不在其中**：
 * 前两者涉及 IO 效果，后两者改变可观察的文档集合。
 * 「`executeNow` 仅允许**无效果、可有界完成**的命令」。
 */
export type ImmediateCommand = Extract<
  Command,
  | { kind: 'select' }
  | { kind: 'setTime' }
  | { kind: 'setPlaying' }
  | { kind: 'setPlaybackRate' }
  | { kind: 'advancePlayback' }
  | { kind: 'setChannelValue' }
  | { kind: 'setProperty' }
  | { kind: 'setTransform' }
  | { kind: 'beginInteraction' }
  | { kind: 'updateInteraction' }
  | { kind: 'cancelInteraction' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'addObject' }
  | { kind: 'deleteObject' }
  | { kind: 'setCellTooltip' }
  | { kind: 'setCellContent' }
  | { kind: 'setCellIdentity' }
  | { kind: 'moveCells' }
  | { kind: 'setDocumentMeta' }
  | { kind: 'insertKeyframe' }
  | { kind: 'removeKeyframe' }
  | { kind: 'setTrackEnabled' }
  | { kind: 'publishDefault' }
>

/** 命令是否需要进入队列（有副作用或需要效果）。 */
export function requiresQueue(command: Command): boolean {
  return command.kind === 'save' || command.kind === 'saveCompleted' || command.kind === 'openDocument' || command.kind === 'closeDocument'
}

// ─────────────────────────────────────────────────────────────────────────────
// 执行输入
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 执行输入（`ExecutionInputs`）。
 *
 * 这里**没有**时钟函数、随机源或 IO 句柄 —— 因为纯转移不需要它们。
 * 时间是命令携带的值（`SetTimeCommand.time`），身份来自状态里的 `ids`。
 * 这一"什么都不给"本身是纯性的结构性保证：没有可读的全局来源。
 */
export interface ExecutionInputs {
  /**
   * 能力集合（profile 裁剪）。缺失能力时命令返回 `UnsupportedOperation`
   * —— 内核契约 §4.2 要求「必须可由**运行时**拒绝，不只靠 UI 隐藏按钮」（负对照）。
   */
  readonly capabilities: readonly string[]
  /**
   * **对象类型构造工厂**（「需要…能力…时，作为输入或状态传入」的落点）。
   *
   * ## 为什么它在输入里而不在 `Document`
   *
   * 早期实现把工厂放进了 `Document.types` 的描述符里，`pureDomain.test.ts`
   * 立刻判红：`structuredClone(openDocumentState())` 抛 `DataCloneError`
   * —— 应用状态必须可克隆、可重放，而函数是运行期句柄。
   * 内核契约 §2.1 也要求「`read` 不导出…文档实例字段」。
   *
   * ⇒ 工厂是**执行输入**（能力），不是**状态**（内容）。
   * 缺省取内置三类（`DEFAULT_OBJECT_FACTORIES`），使既有行为逐字不变；
   * 装配层可以覆盖它来加载贡献的类型（见 `composition`）。
   */
  readonly objectFactories?: import('@/domain/scene').ObjectFactoryTable
  /**
   * **装配贡献的对象类型声明**（属性写半边）。
   *
   * ## 为什么它与 `objectFactories` 并列（而不是塞进某个全局注册表）
   *
   * `contributes.objectTypes` 提供的是"新类型是什么"（`dataKind`/`editable`），
   * `objectFactories` 提供的是"怎么造它"，而本字段提供的是"它的属性怎么描述"
   * —— 三者都是**能力**（装配层装配、输入传入、用完即弃），不是文档内容。
   *
   * ## 缺省即内置（既有行为零改动）
   *
   * 缺省时 `reduceSetProperty` 用的就是那个构造期固定的内核注册表/写端口单例，
   * 与未贡献时逐字相同；只有装配真的贡献了新类型（`ObjectTypeContribution.rna`）
   * 时才走按清单构造的那一份（见 `kernelPropertyRegistry(contributed)`）。
   *
   * ## 为什么不用"装配期写进全局注册表"
   *
   * 那会让 `reduceCommand` 依赖一个**可变全局**（与纯性的"没有可读的全局来源"
   * 直接冲突），并使 `freeze-convergence` 的既有判据（注册表类型集 = 文档模型类型集）
   * 在触发过装配注册的进程里判红。见 `kernel-properties` 的对应说明。
   */
  readonly contributedObjectTypes?: readonly import('./properties').ObjectTypeDecl[]
  /** 该次执行的关联 id（供诊断，不参与语义）。 */
  readonly correlationId?: string
}

export const ALL_CAPABILITIES: readonly string[] = Object.freeze([
  'content.edit',
  'content.add',
  'content.delete',
  'interaction.begin',
  'save.write',
])

/** 查看器 profile：无内容编辑能力（负对照的输入）。 */
export const VIEWER_CAPABILITIES: readonly string[] = Object.freeze(['interaction.begin'])

export function defaultExecutionInputs(capabilities: readonly string[] = ALL_CAPABILITIES): ExecutionInputs {
  return Object.freeze({ capabilities, objectFactories: DEFAULT_OBJECT_FACTORIES })
}

// ─────────────────────────────────────────────────────────────────────────────
// 转移（内核契约 §4.1 CommandOutcome 的对应物）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 三分支**互斥且穷尽**（内核契约 §4.1）。
 *
 * `rejected` 分支**不带可写状态**，只有原状态引用 —— 于是"拒绝后仍报告 applied"
 * 在类型层面不可表达，而不是靠实现自觉。这是拒绝零残留的结构性保证。
 */
export type Transition =
  | {
      readonly status: 'applied'
      readonly state: ApplicationState
      readonly version: Version
      readonly changes: ChangeSummary
      readonly effects: readonly EffectRequest[]
    }
  | {
      readonly status: 'unchanged'
      readonly state: ApplicationState
      readonly version: Version
      readonly effects: readonly EffectRequest[]
    }
  | {
      readonly status: 'rejected'
      readonly state: ApplicationState
      /**
       * 拒绝时**未变**的版本。
       *
       * 内核契约 §4.1 的 `CommandOutcome.rejected` 不带版本；这里带上它是为了让
       * 重放摘要能在拒绝分支上同样记录"当时处于哪个版本"，
       * 从而"改变一项输入应产生差异"在拒绝路径上也可对账。
       * 它恒等于拒绝前状态的版本，不表示任何推进。
       */
      readonly version: Version
      readonly error: DomainError
      readonly effects: readonly EffectRequest[]
    }

const NO_EFFECTS: readonly EffectRequest[] = Object.freeze([])

function applied(state: ApplicationState, version: Version, changes: ChangeSummary, effects: readonly EffectRequest[] = NO_EFFECTS): Transition {
  return Object.freeze({ status: 'applied', state, version, changes, effects })
}
function unchanged(state: ApplicationState, version: Version, effects: readonly EffectRequest[] = NO_EFFECTS): Transition {
  return Object.freeze({ status: 'unchanged', state, version, effects })
}
/** 拒绝：`state` **恒为原引用**，版本取该次转移实际作用于的文档版本（「拒绝…零残留」）。 */
function rejected(state: ApplicationState, error: DomainError, version?: Version): Transition {
  return Object.freeze({ status: 'rejected', state, version: version ?? versionOfFirstDocument(state), error, effects: NO_EFFECTS })
}

/** 拒绝路径的版本取当前（未变）版本；无文档时给零版本。 */
function versionOfFirstDocument(state: ApplicationState): Version {
  for (const id of Object.keys(state.docs)) return state.docs[id].version
  return Object.freeze({ documentVersion: 0, contentVersion: 0 })
}

// ─────────────────────────────────────────────────────────────────────────────
// reduceCommand —— 唯一入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 纯命令转移。
 *
 * `submit` 与 `executeNow` **共用**本函数（共用同一条逻辑更新入口，不是第二写通路）。
 * 两者差别只在**执行器**如何处置
 * 需要排队/需要效果的情形，不在转移本身。
 */
export function reduceCommand(state: ApplicationState, command: Command, env: ExecutionInputs): Transition {
  for (const cap of capabilityFor(command)) {
    if (!env.capabilities.includes(cap)) {
      return rejected(state, unsupportedOperation({ capability: cap, command: command.kind }))
    }
  }
  switch (command.kind) {
    case 'openDocument':
      return reduceOpenDocument(state, command)
    case 'closeDocument':
      return reduceCloseDocument(state, command)
    case 'select':
      return reduceSelect(state, command)
    case 'setTime':
      return reduceSetTime(state, command)
    case 'setPlaying':
      return reduceSetPlaying(state, command)
    case 'setPlaybackRate':
      return reduceSetPlaybackRate(state, command)
    case 'advancePlayback':
      return reduceAdvancePlayback(state, command)
    case 'setChannelValue':
      return reduceSetChannelValue(state, command)
    case 'insertKeyframe':
      return reduceInsertKeyframe(state, command)
    case 'removeKeyframe':
      return reduceRemoveKeyframe(state, command)
    case 'setTrackEnabled':
      return reduceSetTrackEnabled(state, command)
    case 'publishDefault':
      return reducePublishDefault(state, command)
    case 'addObject':
      return reduceAddObject(state, command, env)
    case 'deleteObject':
      return reduceDeleteObject(state, command)
    case 'setCellTooltip':
      return reduceSetCellTooltip(state, command)
    case 'setCellContent':
      return reduceSetCellContent(state, command)
    case 'setCellIdentity':
      return reduceSetCellIdentity(state, command)
    case 'moveCells':
      return reduceMoveCells(state, command)
    case 'setDocumentMeta':
      return reduceSetDocumentMeta(state, command)
    case 'setTransform':
      return reduceSetTransform(state, command)
    case 'setProperty':
      return reduceSetProperty(state, command, env)
    case 'beginInteraction':
      return reduceBeginInteraction(state, command)
    case 'updateInteraction':
      return reduceUpdateInteraction(state, command)
    case 'commitInteraction':
      return reduceCommitInteraction(state, command)
    case 'cancelInteraction':
      return reduceCancelInteraction(state, command)
    case 'undo':
      return reduceUndoRedo(state, command.contextId, 'undo')
    case 'redo':
      return reduceUndoRedo(state, command.contextId, 'redo')
    case 'save':
      return reduceSave(state, command, env)
    case 'saveCompleted':
      return reduceSaveCompleted(state, command)
  }
}

/** 命令 → 所需能力。**单点**判定表，不散落在各处。 */
function capabilityFor(command: Command): readonly string[] {
  switch (command.kind) {
    case 'addObject':
      return ['content.add']
    case 'deleteObject':
      return ['content.delete']
    case 'setTransform':
    case 'setProperty':
    case 'commitInteraction':
    case 'insertKeyframe':
    case 'removeKeyframe':
    case 'setTrackEnabled':
    case 'publishDefault':
    case 'setCellContent':
    case 'setCellIdentity':
    case 'moveCells':
    case 'setDocumentMeta':
      return ['content.edit']
    case 'beginInteraction':
    case 'updateInteraction':
      return ['interaction.begin']
    case 'save':
      return ['save.write']
    default:
      return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 文档生命周期
// ─────────────────────────────────────────────────────────────────────────────

function reduceOpenDocument(state: ApplicationState, cmd: OpenDocumentCommand): Transition {
  if (has(state.docs, cmd.documentId)) return rejected(state, invalidValue({ reason: 'documentAlreadyOpen', documentId: cmd.documentId }))
  if (has(state.contexts, cmd.contextId)) return rejected(state, invalidValue({ reason: 'contextAlreadyExists', contextId: cmd.contextId }))
  const doc = createDocument(cmd.documentId)
  const ctx = createEditContext(cmd.contextId, cmd.documentId)
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [cmd.documentId]: doc }),
    contexts: Object.freeze({ ...state.contexts, [cmd.contextId]: ctx }),
    leases: Object.freeze({ ...state.leases, [cmd.documentId]: createLease(cmd.documentId) }),
    saveLedgers: Object.freeze({ ...state.saveLedgers, [cmd.documentId]: createSaveLedger() }),
  })
  return applied(next, doc.version, changeSummary({ createdEntities: [entityRef('document', cmd.documentId)] }))
}

function reduceCloseDocument(state: ApplicationState, cmd: CloseDocumentCommand): Transition {
  const doc = getDoc(state, cmd.documentId)
  if (!doc) return rejected(state, missingTarget({ documentId: cmd.documentId }))
  const docs = { ...state.docs }
  delete docs[cmd.documentId]
  const leases = { ...state.leases }
  delete leases[cmd.documentId]
  const saveLedgers = { ...state.saveLedgers }
  delete saveLedgers[cmd.documentId]
  // 绑定该文档的上下文一并移除 —— 「文档关闭也释放租约、取消归属作业」
  const contexts: Record<string, EditContext> = {}
  for (const [id, ctx] of Object.entries(state.contexts)) {
    if (ctx.documentId !== cmd.documentId) contexts[id] = ctx
  }
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze(docs),
    contexts: Object.freeze(contexts),
    leases: Object.freeze(leases),
    saveLedgers: Object.freeze(saveLedgers),
  })
  return applied(next, doc.version, changeSummary({ removedEntities: [entityRef('document', cmd.documentId)] }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 上下文状态（选择/时间/通道）
// ─────────────────────────────────────────────────────────────────────────────

function reduceSelect(state: ApplicationState, cmd: SelectCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const nextCtx = cmd.target === null ? clearSelection(ctx) : selectOne(ctx, cmd.target)
  if (sameSelection(ctx.selection, nextCtx.selection)) return unchanged(state, doc.version)
  // 业务确实变了（选择），但**文档内容版本不动**（所有权表：点选不记文档历史）
  return applied(
    withContext(state, nextCtx),
    doc.version,
    changeSummary({ changedProperties: [], structurallyShared: true }),
  )
}

function reduceSetTime(state: ApplicationState, cmd: SetTimeCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  // 帧率合法性判据在 `domain/animation`（纯、含有理帧率的规范化），
  // **不**在本层重写一遍。拒绝的 `reason` 与既有实现保持同一个（`fpsMustBePositive`），
  // 使既有断言与消费者无需改动。
  const rate = frameRateOf(cmd.time.fps)
  if (!rate.ok) return rejected(state, rate.error)
  // 比较用 `sameTime`（精确、含有理数约分），不用 `frame`/`fps` 逐字段比对 ——
  // 后者会让 `20` 与 `{num:40,den:2}` 被判为不同时间，从而白推一次求值。
  if (sameTime(ctx.time, cmd.time)) return unchanged(state, doc.version)
  // 时间属 EditContext：改它**不推进 documentVersion**（「动画播放不增加文档版本」）
  return applied(withContext(state, withTime(ctx, cmd.time)), doc.version, changeSummary({ structurallyShared: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 播放状态（归 EditContext；替代旧 Main 播放 Ref）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 开始/停止播放。
 *
 * 三条语义要点（各自对应一条会被静默违反的约束）：
 *  1. **不碰时间** —— 「停止播放保留当前时间」；定位是 `setTime` 的职责。
 *  2. **不推进文档版本** —— 播放是 `EditContext` 的从属事实，
 *     与 `setTime` 同一口径（"动画播放不增加文档版本"）。
 *  3. **幂等** —— 已经是该状态 ⇒ `unchanged`（不因"新建了上下文容器"记 applied）。
 */
function reduceSetPlaying(state: ApplicationState, cmd: SetPlayingCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const next = withPlaying(ctx, cmd.playing)
  if (next === ctx) return unchanged(state, doc.version)
  return applied(withContext(state, next), doc.version, changeSummary({ structurallyShared: true }))
}

/**
 * 设置常量播放倍率。
 *
 * 非法值（非有限、负）⇒ `InvalidValue`，**不**夹取（「不悄悄夹取」）。
 * `0` 合法：它表达"playing 但时间不动"，与"暂停"是两件不同的事
 * （`domain/animation#Playhead` 对两者有同一区分）。
 */
function reduceSetPlaybackRate(state: ApplicationState, cmd: SetPlaybackRateCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  if (!Number.isFinite(cmd.rate) || cmd.rate < 0) {
    return rejected(state, invalidValue({ reason: 'playbackRateMustBeNonNegative', rate: String(cmd.rate) }))
  }
  const next = withPlaybackRate(ctx, cmd.rate)
  if (next === ctx) return unchanged(state, doc.version)
  return applied(withContext(state, next), doc.version, changeSummary({ structurallyShared: true }))
}

/**
 * 按注入的经过秒数推进播放时间（宿主帧时钟的唯一落点）。
 *
 * 拒绝：非有限 delta（`InvalidValue`）—— 一个 `NaN` delta 会让时间变成 `NaN`，
 * 而 `NaN` 时间会让之后每次采样都失败且**无从诊断来源**。
 *
 * 暂停 / 倍率为 0 ⇒ `unchanged`（`advancePlayback` 返回原引用）。
 * 这条让"没在播放时宿主仍每帧发推进命令"成为**无副作用**的行为 ——
 * 宿主不必自己判断要不要发（判断会变成第二份播放状态判据）。
 */
function reduceAdvancePlayback(state: ApplicationState, cmd: AdvancePlaybackCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  if (!Number.isFinite(cmd.deltaSeconds)) {
    return rejected(state, invalidValue({ reason: 'playbackDeltaNotFinite', delta: String(cmd.deltaSeconds) }))
  }
  const next = advancePlayback(ctx, cmd.deltaSeconds)
  if (next === ctx) return unchanged(state, doc.version)
  // 时间属 EditContext：推进它**不**推进 documentVersion。
  return applied(withContext(state, next), doc.version, changeSummary({ structurallyShared: true }))
}

function reduceSetChannelValue(state: ApplicationState, cmd: SetChannelValueCommand): Transition {  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  if (!Number.isFinite(cmd.value)) return rejected(state, invalidValue({ reason: 'notFinite', channel: cmd.channel, value: String(cmd.value) }))
  if (ctx.channelValues[cmd.channel] === cmd.value) return unchanged(state, doc.version)
  // 通道取值属编辑上下文（「手动预览取值属编辑上下文」）⇒ 不动文档
  return applied(withContext(state, withChannelValue(ctx, cmd.channel, cmd.value)), doc.version, changeSummary({ structurallyShared: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 对象增删
// ─────────────────────────────────────────────────────────────────────────────

function reduceAddObject(state: ApplicationState, cmd: AddObjectCommand, env: ExecutionInputs): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  // ⚠️ **显式 id 通道**：`params.objectId` 有值则用它。
  //
  // ## 为什么必须有（实测的阻塞）
  //
  // 装配（`composition/kernelAssembly#annotationObjects`）给注解对象的 id 是
  // **`annotation:<legacyId>`**（身份由**源**决定）。而本函数原先**总是**
  // `allocateId` ⇒ 同一份注解"走装配"与"走 addObject"得到**两个身份**。
  //
  // 后果（实测）：`annotationOperators` 新建后设 `selection.active = a2`，
  // 而内核对象是 `wk-object-1`；`editors/workbench-inspector.ts:598-602`
  // 把这个 id **原样**包成 `EntityRef`（`annotationOwner` 零映射）
  // ⇒ **属性面板后续每次写都打到不存在的 id**（用户可见功能损坏）。
  //
  // ## 为什么经 `params` 而不加 `Command` 具名字段
  //
  // 新增类型/字段不该回来改命令**类型**。`params` 是既有的**唯一开放通道**
  // （见 `AddObjectCommand.params` 的说明），故走它。
  //
  // ## 零破坏
  //
  // 无 `params.objectId` ⇒ 行为与改动前**逐字节相同**（`allocateId` 兜底）。
  const requestedId = cmd.params?.objectId
  const hasRequestedId = typeof requestedId === 'string' && requestedId !== ''
  const a1 = hasRequestedId
    ? { id: requestedId, next: state.ids }
    : allocateId(state.ids, 'object')
  const a2 = allocateId(a1.next, 'data')
  const ref = objectRef(a1.id, a2.next.counter)
  const scene = doc.scene
  /**
   * **唯一**的对象构造入口：经**执行输入**里的工厂表
   * （`domain/scene#createObjectOfType`），核心**不**为对象类型开 switch
   * （「扩展验证要求通过现有贡献接口新增类型，而非改核心 switch」）。
   *
   * 实测修正两处：
   *  1. 初版这里是 `switch (cmd.objectType)` 三分支；判据抓出后改为查表；
   *  2. 第二版把工厂塞进 `Document.types`，`pureDomain.test.ts` 抓到
   *     `structuredClone` 抛错（状态必须可克隆 ⇒ 函数不能进状态），
   *     故最终把它移到 `ExecutionInputs.objectFactories`（能力，不是内容）。
   *
   * 接入 `mesh` 时发现它需要**结构化失败**
   * （`badBoxSize` 与 id 冲突不可压成同一个结果），故工厂返回
   * `Result<ObjectCreation> | null` —— `null` = 类型不认识、`err` = 构造失败。
   */
  const built = createObjectOfType(env.objectFactories ?? DEFAULT_OBJECT_FACTORIES, cmd.objectType, {
    objectId: a1.id,
    dataId: a2.id,
    ...(cmd.name === undefined ? {} : { name: cmd.name }),
    params: Object.freeze({ ...(cmd.params ?? {}) }),
  })
  // 没有该类型的工厂 ⇒ 本装配不认识它。这是 `UnsupportedOperation`（能力缺失），
  // 不是 `InvalidValue`（输入本身没问题）—— 内核契约 §4.2 的触发条件表。
  if (built === null) return rejected(state, unsupportedOperation({ objectType: cmd.objectType, kind: 'addObject' }))
  // 类型认识但构造失败 ⇒ **原样透出结构化错误**（例如 `badBoxSize`），
  // 不压成 `null`/`idCollision`（「不能用默认值掩盖缺失」）。
  if (!built.ok) return rejected(state, built.error)
  const nextScene = withObject(scene, built.value.object, built.value.data)
  if (nextScene === null) return rejected(state, invalidValue({ reason: 'idCollision', objectId: a1.id }))

  const write = withScene(doc, nextScene)
  const changes = changeSummary({ createdEntities: [ref], structurallyShared: true })
  const withHistory = recordHistory(write.doc, {
    label: cmd.name ?? `add ${cmd.objectType}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextScene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: [ref],
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    ids: a2.next,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    contexts: Object.freeze({ ...state.contexts, [ctx.id]: selectOne(ctx, ref) }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

function reduceDeleteObject(state: ApplicationState, cmd: DeleteObjectCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const obj = findObject(doc.scene, cmd.objectId)
  if (!obj) return rejected(state, missingTarget({ objectId: cmd.objectId }))
  const data = findObjectData(doc.scene, obj.dataId)
  if (data?.source === 'content') return rejected(state, readOnly({ owner: data.source, objectId: cmd.objectId }))
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  const objects = { ...doc.scene.objects }
  delete objects[cmd.objectId]
  const dataMap = { ...doc.scene.data }
  // 仅当无其他对象引用时才删数据（共享几何的其它消费者必须保持完好）
  const stillShared = Object.values(objects).some((o) => o.dataId === obj.dataId)
  if (!stillShared) delete dataMap[obj.dataId]
  const nextScene: Scene = Object.freeze({
    ...doc.scene,
    objects: Object.freeze(objects),
    data: Object.freeze(dataMap),
    order: Object.freeze(doc.scene.order.filter((id) => id !== cmd.objectId)),
  })
  const write = withScene(doc, nextScene)
  const changes = changeSummary({ removedEntities: [objectRef(cmd.objectId)], structurallyShared: true })
  const withHistory = recordHistory(write.doc, {
    label: `delete ${cmd.objectId}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextScene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: [],
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    contexts: Object.freeze({ ...state.contexts, [ctx.id]: clearSelection(ctx) }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

/**
 * **逐格写的目标解析**（唯一实现；`setCellTooltip` 与 `setCellContent` 共用）。
 *
 * ## 为什么必须抽成一个函数而不是各写一遍
 *
 * 两条命令的语义不同（字段级 vs 整值级），但"哪些 `blockGrid` 对象是这次写的目标"
 * 是**同一条事实**。各写一遍会让"多帧文档的逐格内容必须同时成立"这条不变量
 * 在某一条命令上退化成"只写当前帧" —— 而那正是"写成功但存出来没有"的形态。
 * 抽取后，"目标解析"只有一处可漂移。
 *
 * @returns `list` = 含**任一**目标键的 `blockGrid` 对象；`orphanKey` = 不在任何
 *          网格里的键（`null` = 全部键都有落点）。
 */
function blockGridWriteTargets(
  doc: Document,
  keys: readonly string[],
): {
  readonly list: readonly {
    readonly objectId: string
    readonly dataId: string
    readonly source: ObjectData['source']
    readonly payload: Extract<ObjectDataPayload, { kind: 'blockGrid' }>
  }[]
  readonly orphanKey: string | null
} {
  const list: {
    readonly objectId: string
    readonly dataId: string
    readonly source: ObjectData['source']
    readonly payload: Extract<ObjectDataPayload, { kind: 'blockGrid' }>
  }[] = []
  const hitsPerKey = new Map<string, number>(keys.map((k) => [k, 0]))
  for (const objectId of doc.scene.order) {
    const obj = findObject(doc.scene, objectId)
    if (obj === undefined || obj.type !== 'block') continue
    const data = findObjectData(doc.scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'blockGrid') continue
    let hit = false
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(data.payload.cells, k)) continue
      hitsPerKey.set(k, (hitsPerKey.get(k) ?? 0) + 1)
      hit = true
    }
    // 该对象与本次写入无关（不含任一格）⇒ 不是目标（各帧网格可以不同尺寸）
    if (!hit) continue
    list.push({ objectId, dataId: obj.dataId, source: data.source, payload: data.payload })
  }
  const orphanKey = keys.find((k) => (hitsPerKey.get(k) ?? 0) === 0) ?? null
  return { list, orphanKey }
}

/**
 * **写一格说明**。
 *
 * ## 落点：`blockGrid` 载荷的 `cellContent`
 *
 * 逐格说明在内核侧**不是**文档级侧表，而是网格对象载荷的一部分：
 * `ObjectDataPayload` 的 `blockGrid` 变体带 `cellContent?: CellContentTable`，
 * 键与 `cells` **同一套**（`cellContentKey`）。
 * 故本 reducer 改的是**对象数据**，而不是 `DocumentContent`。
 *
 * ## 三条与旧路径**逐点等价**的语义（照抄我要替代的那两处行为）
 *
 * | 语义 | 旧实现 | 本实现 |
 * |---|---|---|
 * | 空文案 = 无说明 | `grid[..] = text ? at : -1`（`-1` 哨兵） | `text === ''` ⇒ 移除 `tooltip` 字段 |
 * | 同文案共享 | `palette.indexOf(text)` 去重 | 无需池：内核**逐格直接承载文本**（池是对外格式的压缩，不是内核语义） |
 * | 显式删除 | 无（旧路径只能写 `-1`） | `text === null` ⇒ 移除字段（与 `''` 区分） |
 *
 * ⇒ "池 + 下标"这条间接层**不需要**在内核侧复现：它是**文件格式**的压缩方式，
 * 内核用"文本直接落格"，投影时再重新聚成池
 * （`kernelProjection.ts:1141-1142` 的 `tooltipPoolOfPayloads` 已实现，本命令**复用**它）。
 *
 * ## 幂等：同值 ⇒ `unchanged`
 *
 * 与 `reduceSetTransform` 同口径（内核契约 §1.4：不因新建容器而记 `applied`）。
 * 少了这条，每次"点一下同样的说明"都会推进版本并进历史。
 */
function reduceSetCellTooltip(state: ApplicationState, cmd: SetCellTooltipCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value

  // ⚠️ **只 `null` 表示删除**（我第一版把 `''` 也当删除，被自己的判据当场判红）。
  //
  // 内核 `CellContent.tooltip` 的口径（`domain/cellContent.ts:170`）：
  // 「**缺席** = 无逐格说明。空串 = 显式"说明了空"」—— 两者**必须**可区分。
  const nextTooltip: string | undefined = cmd.text === null ? undefined : cmd.text
  if (cmd.cells.length === 0) return rejected(state, missingTarget({ objectId: 'cells[]' }))

  const keys = cmd.cells.map((c) => cellContentKey(c.x, c.y, c.z))
  if (new Set(keys).size !== keys.length) {
    // 重复格 ⇒ 拒绝（"多选一失败整批拒"的同一纪律；重复会让变更摘要出现两条同目标项）
    return rejected(state, invalidValue({ reason: 'duplicateCells', count: keys.length }))
  }

  // ── 找出**全部**目标：含**任一**该格的 `blockGrid` 对象 ──────────────────
  //
  // 见 `SetCellTooltipCommand` 的说明：文档级事实必须在每个帧对象上**同时**成立，
  // 否则投影只取第一份池 ⇒ 其余帧的说明静默丢失。
  //
  // ⚠️ **每格都必须有落点**，否则整批拒绝（部分成功会让"多选一失败整批拒"失效）。
  const targets = blockGridWriteTargets(doc, keys)
  if (targets.list.length === 0 || targets.orphanKey !== null) {
    // 有格不在任何网格里 ⇒ 拒绝（否则会存下永不显示的说明；
    // 投影侧的 `cellContentKeyDiagnostic` 正是为此报警）。
    return rejected(state, missingTarget({ objectId: `cell@${targets.orphanKey ?? keys[0]}` }))
  }

  // 只读数据（`content` 源）不得写 —— 与另两条对象写路径同一守卫。
  const readOnlyTarget = targets.list.find((t) => t.source === 'content')
  if (readOnlyTarget !== undefined) {
    return rejected(state, readOnly({ owner: readOnlyTarget.source, objectId: readOnlyTarget.objectId }))
  }

  // ── 幂等：**全部**（目标 × 格）都已是该值 ⇒ `unchanged` ──────────────────
  const alreadyAll = targets.list.every((t) =>
    keys.every((k) => ((t.payload.cellContent?.[k]?.tooltip) ?? undefined) === nextTooltip),
  )
  if (alreadyAll) return unchanged(state, doc.version)

  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  // ── 原子地更新全部目标（一条命令 = 一个事务 = 一条历史） ────────────────
  let scene: Scene = doc.scene
  for (const t of targets.list) {
    const table: Record<string, CellContent> = { ...(t.payload.cellContent ?? {}) }
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(t.payload.cells, k)) continue
      const before = t.payload.cellContent?.[k] ?? {}
      if (nextTooltip === undefined) {
        const rest: { parts?: CellContent['parts'] } = {}
        if (before.parts !== undefined) rest.parts = before.parts
        // 该格因此再无内容 ⇒ **连键一起删**（不留下 `{}` 空壳：
        // 空表与"有键但空"必须可区分，见 `cellContentIsEmpty` 的口径）。
        // ⚠️ 但若它还有 `parts`，只去掉 `tooltip` —— 不能把部件一起删掉。
        if (rest.parts === undefined) delete table[k]
        else table[k] = cellContent(rest)
      } else {
        table[k] = cellContent({
          ...(before.parts === undefined ? {} : { parts: before.parts }),
          tooltip: nextTooltip,
        })
      }
    }
    const nextPayload: ObjectDataPayload = Object.freeze({
      ...t.payload,
      cellContent: normalizeCellContent(table),
    })
    // `objectData()` 机械派生 `contentVersion` ⇒ "改了字节版本必变"是结构事实。
    scene = withUpdatedData(scene, objectData(t.dataId, nextPayload, t.source))
  }
  const nextScene = scene
  const write = withScene(doc, nextScene)

  const changes = changeSummary({
    // 变更摘要逐**格**列出（多选/多帧下"改了哪些格"必须可见，不压成一条）
    changedProperties: cmd.cells.map((c) => ({
      owner: objectRef(`${c.x},${c.y},${c.z}`),
      property: 'cellTooltip',
    })),
    structurallyShared: true,
  })
  const withHistory = recordHistory(write.doc, {
    label: `cell tooltip @${keys.join(' ')}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextScene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐格内容写（整值） / 格移动 / 文档元数据写
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 逐格内容写的事务收尾（**唯一**实现；`setCellContent` 与 `setCellTooltip` 共用）。
 *
 * ## 为什么"改哪些格"必须在同一处收尾
 *
 * 一条逐格写命令 = 一个事务 = 一条历史。把"原子更新全部目标 → 变更摘要 → 记历史"
 * 散在两处，会让两条命令的可撤销性、租约语义与摘要形状各自演化 ——
 * 而它们**必须**逐点相同（同一格事实，撤销一次就该回到同一处）。
 *
 * `mutate` 收到的是**目标对象的数据载荷**，返回该载荷的新 `cellContent` 表
 * （`null` = 保持原表不变，用于"这次写与该对象无关"的情形）。
 */
function cellContentWrite(
  state: ApplicationState,
  ctx: EditContext,
  doc: Document,
  label: string,
  changedCells: readonly CellPosition[],
  mutate: (
    payload: Extract<ObjectDataPayload, { kind: 'blockGrid' }>,
    index: number,
  ) => CellContentTable | null,
): Transition {
  const targets = blockGridWriteTargets(doc, changedCells.map((c) => cellContentKey(c.x, c.y, c.z)))
  if (targets.list.length === 0 || targets.orphanKey !== null) {
    return rejected(state, missingTarget({ objectId: `cell@${targets.orphanKey ?? 'none'}` }))
  }
  const readOnlyTarget = targets.list.find((t) => t.source === 'content')
  if (readOnlyTarget !== undefined) {
    return rejected(state, readOnly({ owner: readOnlyTarget.source, objectId: readOnlyTarget.objectId }))
  }
  const lease = acquireFor(state, doc.id, ctx.id)
  if (!lease.ok) return rejected(state, lease.error)

  let scene: Scene = doc.scene
  let index = 0
  for (const t of targets.list) {
    const nextTable = mutate(t.payload, index)
    index += 1
    if (nextTable === null) continue
    const nextPayload: ObjectDataPayload = Object.freeze({ ...t.payload, cellContent: nextTable })
    scene = withUpdatedData(scene, objectData(t.dataId, nextPayload, t.source))
  }
  const nextScene = scene
  const write = withScene(doc, nextScene)
  const changes = changeSummary({
    changedProperties: changedCells.map((c) => ({ owner: objectRef(`${c.x},${c.y},${c.z}`), property: 'cellContent' })),
    structurallyShared: true,
  })
  const withHistory = recordHistory(write.doc, {
    label,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextScene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

/**
 * **写一格（或多格）的逐格内容整体**（最小集 `setCellContent`）。
 *
 * 语义三条（与命令类型的注释逐点对应）：
 *  1. `content === null` ⇒ **删键**（"这一格没有逐格内容"）；
 *  2. 幂等按 `sameCellContent`（内容级等价，不是引用/键序等价）；
 *  3. 与 `setCellTooltip` 共用 {@link cellContentWrite} —— 事务与历史口径同源。
 */
function reduceSetCellContent(state: ApplicationState, cmd: SetCellContentCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value

  if (cmd.cells.length === 0) return rejected(state, missingTarget({ objectId: 'cells[]' }))
  const keys = cmd.cells.map((c) => cellContentKey(c.x, c.y, c.z))
  if (new Set(keys).size !== keys.length) {
    return rejected(state, invalidValue({ reason: 'duplicateCells', count: keys.length }))
  }
  const guard = versionGuard(doc, cmd.expectedVersion)
  if (guard !== null) return rejected(state, guard)

  // 缺席 ≠ 空：`null` 是"整条删掉"，`{}` 是"有键但两类内容都缺席"。
  const next: CellContent | null = cmd.content === null ? null : cellContent(cmd.content)

  // 幂等：全部（目标 × 格）都已语义等于新值 ⇒ `unchanged`
  const targets = blockGridWriteTargets(doc, keys)
  if (targets.list.length === 0 || targets.orphanKey !== null) {
    return rejected(state, missingTarget({ objectId: `cell@${targets.orphanKey ?? keys[0]}` }))
  }
  const alreadyAll = targets.list.every((t) =>
    keys.every((k) => sameCellContent(t.payload.cellContent?.[k], next ?? undefined) && (next !== null || t.payload.cellContent?.[k] === undefined)),
  )
  if (alreadyAll) return unchanged(state, doc.version)

  return cellContentWrite(state, ctx, doc, `cell content @${keys.join(' ')}`, cmd.cells, (payload) => {
    const table: Record<string, CellContent> = { ...(payload.cellContent ?? {}) }
    let dirty = false
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(payload.cells, k)) continue
      const before = payload.cellContent?.[k]
      if (next === null) {
        if (before === undefined) continue
        delete table[k]
        dirty = true
        continue
      }
      if (sameCellContent(before, next)) continue
      table[k] = next
      dirty = true
    }
    return dirty ? normalizeCellContent(table) : null
  })
}

/**
 * **写一格（或多格）的方块身份**（语义见 {@link SetCellIdentityCommand}）。
 *
 * 与 `setCellContent` 共用 {@link blockGridWriteTargets}（目标解析）与
 * {@link cellContentWrite}（事务收尾）—— 三条逐格写命令的"改哪些格 / 怎么收尾"
 * 只有一处实现，故"多帧文档必须同时成立"这条不变量不可能在其中一条上退化。
 */
function reduceSetCellIdentity(state: ApplicationState, cmd: SetCellIdentityCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value

  if (cmd.cells.length === 0) return rejected(state, missingTarget({ objectId: 'cells[]' }))
  const keys = cmd.cells.map((c) => cellContentKey(c.x, c.y, c.z))
  if (new Set(keys).size !== keys.length) {
    return rejected(state, invalidValue({ reason: 'duplicateCells', count: keys.length }))
  }
  const guard = versionGuard(doc, cmd.expectedVersion)
  if (guard !== null) return rejected(state, guard)
  // 空注册名 = 不存在的方块。缺席由 `identity: null` 表达，不用空串冒充。
  if (cmd.identity !== null && cmd.identity.name.length === 0) {
    return rejected(state, invalidValue({ reason: 'emptyBlockName', count: keys.length }))
  }
  if (cmd.identity !== null && cmd.identity.paletteRef.length === 0) {
    return rejected(state, invalidValue({ reason: 'emptyPaletteRef', count: keys.length }))
  }
  const meta = cmd.identity?.meta
  if (meta !== undefined && (!Number.isInteger(meta) || meta < 0)) {
    return rejected(state, invalidValue({ reason: 'malformed-block-id', meta }))
  }

  // 目标解析：与 `setCellContent` / `setCellTooltip` **逐字同口径**。
  //
  // ⚠️ 本命令**不**另立越界判据。格写命令族既有的、一致的口径是
  // 「键必须已存在于 `cells`」⇒ 越界键在任何一个网格的 `cells` 里都不存在，
  // 于是得到 `MissingTarget{orphanKey}`。三条命令同一条判据（`setCellContent`
  // 在本文件里逐字如此），`setCellIdentity` 不得成为异类。
  //
  // 「空网格」与「没有网格」在此**不**区分：两者都不含该键，都报 `MissingTarget`。
  // 这不损失信息 —— 分辨「越界」与「缺席」需要按声明尺寸
  // （`sizeColumn`/`sizeRow`/`sizeZSlice`，`domain/scene.ts` 的 `blockGrid` 载荷确实带、
  // 且 `cells` 是**稀疏**表、尺寸推不出来）反推，而尺寸是**格式边界的建模口径**：
  // 让写命令替边界做这个判断，就是把边界语义漏进内核。
  // 若将来出现**真实生产路径**（非测试合成）让越界键到达本命令，登记为契约缺口后再动共用件。
  const targets = blockGridWriteTargets(doc, keys)
  if (targets.list.length === 0 || targets.orphanKey !== null) {
    return rejected(state, missingTarget({ objectId: `cell@${targets.orphanKey ?? keys[0]}` }))
  }

  // 幂等：全部（目标 × 格）的两表值都已相同 ⇒ `unchanged`（与另两条同口径）。
  const alreadyAll = targets.list.every((t) =>
    keys.every((k) => {
      const curName = t.payload.cells[k]
      const curRef = t.payload.cellPalette?.[k]
      if (cmd.identity === null) return curName === undefined && curRef === undefined
      return curName === cmd.identity.name && curRef === cmd.identity.paletteRef
    }),
  )
  if (alreadyAll) return unchanged(state, doc.version)

  return cellIdentityWrite(state, ctx, doc, `cell identity @${keys.join(' ')}`, cmd.cells, cmd.identity)
}

/**
 * 身份写的事务收尾 —— 与 {@link cellContentWrite} **同形**（目标解析、只读守卫、
 * 租约、变更摘要、历史各一次），差别只在被改的表：`cells` + `cellPalette` 成对。
 *
 * ## 为什么两表必须**同一次**更新且不得各自留旧值
 *
 * `cells` 给"这一格是什么方块"，`cellPalette` 给"它的完整注册名/状态"——
 * 面板显示与投影都读后者。只改 `cells` 会让调色板引用留在**旧**方块上
 * （"身份在 B、内容还在 A"的同族形态）。故两表在同一个 `nextPayload` 里一起落。
 */
function cellIdentityWrite(
  state: ApplicationState,
  ctx: EditContext,
  doc: Document,
  label: string,
  changedCells: readonly CellPosition[],
  identity: CellIdentity | null,
): Transition {
  const keys = changedCells.map((c) => cellContentKey(c.x, c.y, c.z))
  const targets = blockGridWriteTargets(doc, keys)
  if (targets.list.length === 0 || targets.orphanKey !== null) {
    return rejected(state, missingTarget({ objectId: `cell@${targets.orphanKey ?? 'none'}` }))
  }
  const readOnlyTarget = targets.list.find((t) => t.source === 'content')
  if (readOnlyTarget !== undefined) {
    return rejected(state, readOnly({ owner: readOnlyTarget.source, objectId: readOnlyTarget.objectId }))
  }
  const lease = acquireFor(state, doc.id, ctx.id)
  if (!lease.ok) return rejected(state, lease.error)

  let scene: Scene = doc.scene
  for (const t of targets.list) {
    const nextCells: Record<string, string> = { ...t.payload.cells }
    const nextPalette: Record<string, string> = { ...(t.payload.cellPalette ?? {}) }
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(t.payload.cells, k)) continue
      if (identity === null) {
        delete nextCells[k]
        delete nextPalette[k]
      } else {
        nextCells[k] = identity.name
        nextPalette[k] = identity.paletteRef
      }
    }
    const nextPayload: ObjectDataPayload = Object.freeze({
      ...t.payload,
      cells: Object.freeze(nextCells),
      // 空表 ⇒ **删键**（"没有"与"有但是空"必须可区分）。
      ...(Object.keys(nextPalette).length === 0 ? {} : { cellPalette: Object.freeze(nextPalette) }),
    })
    const cleaned = deleteEmptyCellTables(nextPayload)
    scene = withUpdatedData(scene, objectData(t.dataId, cleaned, t.source))
  }
  const nextScene = scene
  const write = withScene(doc, nextScene)
  const changes = changeSummary({
    changedProperties: changedCells.map((c) => ({ owner: objectRef(`${c.x},${c.y},${c.z}`), property: 'blockIdentity' })),
    structurallyShared: true,
  })
  const withHistory = recordHistory(write.doc, {
    label,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextScene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

/**
 * **移动格**（最小集 `moveCells`；领域语义见命令类型的注释）。
 *
 * 实现顺序就是语义的一部分，**不得**重排：
 *  ① 读全部源格的五项逐格事实 → ② 写全部目标格 → ③ 删"自己不是任何目标"的源键。
 * 重排成"逐个搬"会让 `a→b, b→c` 变成链式（依赖 `moves` 的顺序），
 * 而 `moves` 是集合 —— 顺序不是它表达的语义。
 */
function reduceMoveCells(state: ApplicationState, cmd: MoveCellsCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value

  if (cmd.moves.length === 0) return rejected(state, missingTarget({ objectId: 'moves[]' }))
  const obj = findObject(doc.scene, cmd.objectId)
  if (obj === undefined) return rejected(state, missingTarget({ objectId: cmd.objectId }))
  const data = findObjectData(doc.scene, obj.dataId)
  if (data === undefined || data.payload.kind !== 'blockGrid') {
    return rejected(state, missingTarget({ objectId: cmd.objectId, dataKind: data?.payload.kind ?? 'none' }))
  }
  if (data.source === 'content') return rejected(state, readOnly({ owner: data.source, objectId: cmd.objectId }))
  const payload = data.payload

  const froms = cmd.moves.map((m) => cellContentKey(m.from.x, m.from.y, m.from.z))
  const tos = cmd.moves.map((m) => cellContentKey(m.to.x, m.to.y, m.to.z))
  // 同时语义下重复是不确定的：两个源映射到同一目标 ⇒ 谁赢取决于集合遍历
  if (new Set(froms).size !== froms.length || new Set(tos).size !== tos.length) {
    return rejected(state, invalidValue({ reason: 'duplicateCells', count: cmd.moves.length }))
  }
  const guard = versionGuard(doc, cmd.expectedVersion)
  if (guard !== null) return rejected(state, guard)

  // ── ① 源格必须存在（五项逐格表任一有该键即算存在） ─────────────────────
  const perCellTables = () => [
    payload.cells,
    payload.cellContent,
    payload.cellGeometry,
    payload.cellPalette,
    payload.cellPaletteIndex,
  ]
  const tables = perCellTables()
  const hasKey = (k: string): boolean => tables.some((t) => t !== undefined && Object.prototype.hasOwnProperty.call(t, k))
  const missing = froms.find((k) => !hasKey(k))
  if (missing !== undefined) return rejected(state, missingTarget({ objectId: `cell@${missing}` }))

  // ── 目标必须在**声明尺寸**内（越界写不出来；见命令类型的注释） ───────────
  const declared = declaredBounds(payload)
  if (declared !== null) {
    const outside = cmd.moves.find((m) => !insideBounds(m.to, declared))
    if (outside !== undefined) {
      return rejected(
        state,
        invalidValue({ reason: 'outsideDeclaredGrid', x: outside.to.x, y: outside.to.y, z: outside.to.z }),
      )
    }
  }

  // ── 幂等：全部移动都是 from === to ⇒ `unchanged` ────────────────────────
  if (froms.every((k, i) => k === tos[i])) return unchanged(state, doc.version)

  const moved = froms.filter((k) => !tos.includes(k))
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  // ── ②/③ 同时搬：先取全部源值，再写目标，再删只作源的键 ─────────────────
  const nextCells: Record<string, string> = { ...payload.cells }
  const nextContent: Record<string, CellContent> = { ...(payload.cellContent ?? {}) }
  const nextGeometry: Record<string, string> = { ...(payload.cellGeometry ?? {}) }
  const nextPaletteRef: Record<string, string> = { ...(payload.cellPalette ?? {}) }
  const nextPaletteIndex: Record<string, number> = { ...(payload.cellPaletteIndex ?? {}) }

  const pick = <T>(table: Readonly<Record<string, T>> | undefined, k: string): T | undefined => table?.[k]
  // 先快照（源在写入期间可能被覆盖：`a→b, b→c` 中 b 既是目标又是源）
  const snapshot = froms.map((k) => ({
    cells: pick(payload.cells, k),
    content: pick(payload.cellContent, k),
    geometry: pick(payload.cellGeometry, k),
    paletteRef: pick(payload.cellPalette, k),
    paletteIndex: pick(payload.cellPaletteIndex, k),
  }))

  const assign = <T>(table: Record<string, T>, k: string, v: T | undefined): void => {
    if (v === undefined) delete table[k]
    else table[k] = v
  }
  for (let i = 0; i < tos.length; i += 1) {
    const s = snapshot[i] as (typeof snapshot)[number]
    assign(nextCells, tos[i] as string, s.cells)
    assign(nextContent, tos[i] as string, s.content)
    assign(nextGeometry, tos[i] as string, s.geometry)
    assign(nextPaletteRef, tos[i] as string, s.paletteRef)
    assign(nextPaletteIndex, tos[i] as string, s.paletteIndex)
  }
  for (const k of moved) {
    delete nextCells[k]
    delete nextContent[k]
    delete nextGeometry[k]
    delete nextPaletteRef[k]
    delete nextPaletteIndex[k]
  }

  const nextPayload: ObjectDataPayload = Object.freeze({
    ...payload,
    cells: Object.freeze(nextCells),
    // 逐格表在空时必须**缺席**而不是空表（"没有"与"有但是空"可区分）
    ...(Object.keys(nextContent).length === 0 ? {} : { cellContent: normalizeCellContent(nextContent) }),
    ...(Object.keys(nextGeometry).length === 0 ? {} : { cellGeometry: Object.freeze(nextGeometry) }),
    ...(Object.keys(nextPaletteRef).length === 0 ? {} : { cellPalette: Object.freeze(nextPaletteRef) }),
    ...(Object.keys(nextPaletteIndex).length === 0 ? {} : { cellPaletteIndex: Object.freeze(nextPaletteIndex) }),
  })
  // ⚠️ `cellContent`/`cellGeometry`/`cellPalette`/`cellPaletteIndex` 若原本缺席而
  // 本次搬空后仍缺席，`...payload` 会把**原引用**带过来 —— 那是正确的（未变）。
  // 但若原本在场而搬空，必须**显式删除**键，否则空表会冒充"有内容"。
  const cleaned = deleteEmptyCellTables(nextPayload)

  const nextScene = withUpdatedData(doc.scene, objectData(data.id, cleaned, data.source))
  const write = withScene(doc, nextScene)
  const changes = changeSummary({
    changedProperties: cmd.moves.map((m) => ({ owner: objectRef(`${m.from.x},${m.from.y},${m.from.z}`), property: 'cell' })),
    structurallyShared: true,
  })
  const withHistory = recordHistory(write.doc, {
    label: `move cells ${cmd.objectId}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextScene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

/** 声明尺寸（`null` = 载荷未声明，此时越界检查**不适用** —— 不猜一个 1×1×1）。 */
function declaredBounds(payload: {
  readonly sizeColumn?: number
  readonly sizeRow?: number
  readonly sizeZSlice?: number
}): { readonly w: number; readonly h: number; readonly d: number } | null {
  const w = payload.sizeColumn
  const h = payload.sizeRow
  const d = payload.sizeZSlice
  if (typeof w !== 'number' || typeof h !== 'number' || typeof d !== 'number') return null
  if (![w, h, d].every((n) => Number.isInteger(n) && n >= 0)) return null
  return { w, h, d }
}

function insideBounds(
  p: { readonly x: number; readonly y: number; readonly z: number },
  b: { readonly w: number; readonly h: number; readonly d: number },
): boolean {
  return p.x >= 0 && p.y >= 0 && p.z >= 0 && p.x < b.w && p.y < b.h && p.z < b.d
}

/** 逐格表搬空 ⇒ **删键**（空表与"没有"必须可区分，见 `domain/cellContent` 判据 3）。 */
function deleteEmptyCellTables(
  payload: Extract<ObjectDataPayload, { kind: 'blockGrid' }>,
): Extract<ObjectDataPayload, { kind: 'blockGrid' }> {
  const out: Record<string, unknown> = { ...payload }
  for (const key of ['cellContent', 'cellGeometry', 'cellPalette', 'cellPaletteIndex'] as const) {
    const v = out[key]
    if (v !== undefined && typeof v === 'object' && v !== null && Object.keys(v).length === 0) delete out[key]
  }
  return Object.freeze(out) as unknown as Extract<ObjectDataPayload, { kind: 'blockGrid' }>
}

/** 期望版本守卫（三处具名写命令共用的**单点**定义）。 */
function versionGuard(doc: Document, expected: Version | undefined): DomainError | null {
  if (expected === undefined) return null
  if (expected.documentVersion !== doc.version.documentVersion) {
    return versionConflict({ expected: expected.documentVersion, actual: doc.version.documentVersion })
  }
  return null
}

/**
 * **写文档元数据**（最小集 `setDocumentMeta`）。
 *
 * ## 幂等按**逐字段语义等价**（不是"给了 patch 就算改了"）
 *
 * `undefined` 在 `Partial` 里是"不请求改这一字段"，故判定必须**跳过**它；
 * 否则 `{ name: 'x' }` 会被读成"author/description/tags/origin/createdAtMs 都变了"
 * —— 那是把 `Partial` 的缺席语义当成了值。用 `canonicalize` 逐字段比较
 * （`tags`/`origin` 是数组/对象，`===` 比不出语义相等）。
 */
function reduceSetDocumentMeta(state: ApplicationState, cmd: SetDocumentMetaCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value

  const guard = versionGuard(doc, cmd.expectedVersion)
  if (guard !== null) return rejected(state, guard)

  const current = doc.content.metadata
  const requested = Object.keys(cmd.patch).filter((k) => (cmd.patch as Record<string, unknown>)[k] !== undefined)
  if (requested.length === 0) return rejected(state, invalidValue({ reason: 'emptyMetadataPatch' }))

  const changed = requested.filter((k) => {
    const before = (current as unknown as Record<string, unknown>)[k]
    const after = (cmd.patch as Record<string, unknown>)[k]
    return canonicalize(before) !== canonicalize(after)
  })
  if (changed.length === 0) return unchanged(state, doc.version)

  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  const write = withDocumentContent(
    doc,
    documentContent({ ...doc.content, metadata: documentMetadata({ ...current, ...cmd.patch }) }),
  )
  const changes = changeSummary({
    changedProperties: changed.map((k) => ({ owner: documentRef(doc.id), property: `metadata.${k}` })),
    structurallyShared: true,
  })
  const withHistory = recordHistory(write.doc, {
    label: `document meta ${changed.join(',')}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: doc.scene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

// ─────────────────────────────────────────────────────────────────────────────
// 直接变换写
// ─────────────────────────────────────────────────────────────────────────────
function reduceSetTransform(state: ApplicationState, cmd: SetTransformCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const obj = findObject(doc.scene, cmd.objectId)
  if (!obj) return rejected(state, missingTarget({ objectId: cmd.objectId }))
  const guard = writeGuard(doc, obj.id)
  if (guard) return rejected(state, guard)
  if (cmd.expectedVersion && cmd.expectedVersion.documentVersion !== doc.version.documentVersion) {
    return rejected(state, versionConflict({ expected: cmd.expectedVersion.documentVersion, actual: doc.version.documentVersion }))
  }
  // 无变化 ⇒ unchanged（**不**因新建容器而记 applied；契约 §1.4）
  if (sameTransform(obj.transform, cmd.transform)) return unchanged(state, doc.version)
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  const nextScene: Scene = Object.freeze({
    ...doc.scene,
    objects: Object.freeze({ ...doc.scene.objects, [cmd.objectId]: Object.freeze({ ...obj, transform: cmd.transform }) }),
  })
  const write = withScene(doc, nextScene)
  const changes = changeSummary({ changedProperties: [{ owner: objectRef(obj.id), property: 'transform' }], structurallyShared: true })
  const withHistory = recordHistory(write.doc, {
    label: `transform ${cmd.objectId}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextScene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, write.version, changes)
}

// ─────────────────────────────────────────────────────────────────────────────
// 属性写（唯一写路由 + 多选原子性）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 属性写 —— 路由到 **RNA 注册表**（`reduceCommand` 成为唯一写入口）。
 *
 * ## 本函数在收敛前后做的事（这是收敛的核心差别）
 *
 * **收敛前**：本函数自带一整套**内联属性词汇** ——
 * `validatePropertyWrite` 里的 `isStructuralProperty('name'|'visible')` +
 * `doc.types[obj.type].animatableProperties.includes(...)` 白名单，
 * 以及 `applyPropertyValue` 里对 `'name'`/`'visible'`/`'transform.*'`/`'projection.*'`/
 * `'annotation.text'` 的 `switch`。属性语义因此有**两套**（内联表 + RNA 表），
 * 且两套描述的属性集合不相交。
 *
 * **收敛后**：本函数**零属性词汇**。它只做三件事：
 *  1. 从引用解析出文档与绑定的上下文（文档由**引用**决定，不由调用方另填字段决定）；
 *  2. 把注册表、写端口、显式访问环境交给 `applySetProperty` —— 后者按 RNA 描述
 *     算可编辑性、校验值、逐目标聚合失败；
 *  3. 把纯转移结果映射成 `Transition` 并记历史。
 *
 * 于是「新增一种内置属性类型」或「新增一个普通对象类型」只需经
 * `registerValueType`/`registerObjectType` 注册 —— 本函数**必须改**这件事不再成立，
 * 那正是扩展路径的证明。
 *
 * ## 为什么上下文从文档反查（而不是命令携带 `contextId`）
 *
 * 「不提供跨文档编辑事务」⇒ 一条命令只作用于**一个**文档。
 * 而 `contextId` 若由调用方另填，就存在"引用指向文档 A、contextId 指向文档 B"
 * 的矛盾输入，必须额外校验两者一致。让上下文**由目标文档唯一确定**消除了这类
 * 矛盾输入的存在空间 —— 一致性由构造保证，不靠校验兜。
 */
function reduceSetProperty(state: ApplicationState, cmd: SetPropertyCommand, env: ExecutionInputs): Transition {
  // 空引用是**调用方缺陷**（没有目标就没有属性写），显式拒绝而不是静默 unchanged。
  if (cmd.refs.length === 0) return rejected(state, invalidValue({ reason: 'noTargets' }))
  if (cmd.value === 'mixed') return rejected(state, invalidValue({ reason: 'mixedHasNoConcreteValue' }))

  const target = resolvePropertyDocument(state, cmd.refs)
  if (!target.ok) return rejected(state, target.error)
  const { doc, ctx } = target.value

  const lease = acquireFor(state, doc.id, ctx.id)
  if (!lease.ok) return rejected(state, lease.error)

  // 属性词汇的唯一权威：内核 RNA 注册表 + 写端口（支持装配贡献的新类型）。
  //
  // 默认路径**逐字不变**：没有贡献类型时仍是那两个构造期固定的惰性单例
  // （`kernelPropertyRegistry()` / `kernelWritePorts()`），既有类型的行为零改动。
  const contributed = env.contributedObjectTypes
  const hasContributed = contributed !== undefined && contributed.length > 0
  const { registry, errors } = hasContributed ? kernelPropertyRegistry(contributed) : kernelPropertyRegistry()
  if (errors.length > 0) {
    // 内核注册表构造失败是**装配缺陷**，必须显式暴露（不得静默降级为"属性不存在"）。
    // 贡献声明重复/非法（例如声明了内核已有的类型 id）走的就是这条路。
    return rejected(state, unsupportedOperation({ reason: 'kernel-registry-invalid', detail: String(errors[0]!.params.reason ?? errors[0]!.code) }))
  }

  const access = kernelAccessOf(doc, ctx.id, env.capabilities, true)
  const write = applySetProperty<Document>({
    registry,
    ports: hasContributed ? kernelWritePorts(contributed) : kernelWritePorts(),
    state: doc,
    command: cmd,
    env: { baseVersion: doc.version, currentVersion: doc.version },
    access,
  })

  if (write.outcome.status === 'rejected') return rejected(state, write.outcome.error, doc.version)
  if (write.outcome.status === 'unchanged') return unchanged(state, doc.version)

  // 写端口返回的候选文档**已**经 `withScene` 推进过版本（内容身份判据在 `domain/document`），
  // 故此处直接取它的版本 —— 不再二次 `withScene`（那会重复摘要计算且掩盖"谁推进了版本"）。
  const nextDoc = write.candidate as Document
  const changed = write.outcome.changes.changedProperties
  const changes = changeSummary({ changedProperties: changed, structurallyShared: write.outcome.changes.structurallyShared })
  const withHistory = recordHistory(nextDoc, {
    label: cmd.refs.length > 1 ? `set ${cmd.refs.length} properties` : `set ${cmd.refs[0]!.property}`,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: nextDoc.scene,
    afterVersion: nextDoc.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  return applied(next, nextDoc.version, changes)
}

/**
 * 从属性引用解析「目标文档 + 绑定该文档的编辑上下文」。
 *
 * 判据（顺序即优先级）：
 *  1. 引用必须指向 `object` 拥有者 —— 编辑上下文属性有具名命令（`setTime`/`setChannelValue`），
 *     不经通用属性写承载；
 *  2. 对象必须**恰好**存在于一个打开的文档里 —— 找不到是 `MissingTarget`，
 *     出现在多个文档里是身份歧义（`InvalidValue`，不静默取第一个）；
 *  3. 该文档必须有绑定的编辑上下文 —— 没有则无租约可申请（`DocumentBusy`）。
 */
function resolvePropertyDocument(
  state: ApplicationState,
  refs: readonly PropertyRef[],
): Result<{ doc: Document; ctx: EditContext }> {
  const unsupportedKind = refs.find((r) => r.owner.kind !== 'object')
  if (unsupportedKind) {
    return err(unsupportedOperation({ ownerKind: unsupportedKind.owner.kind, property: unsupportedKind.property }))
  }
  const first = refs[0]!

  const matches: { doc: Document; ctx: EditContext }[] = []
  for (const ctx of Object.values(state.contexts)) {
    const doc = getDoc(state, ctx.documentId)
    if (!doc) continue
    if (findObject(doc.scene, first.owner.id)) matches.push({ doc, ctx })
  }
  if (matches.length === 0) return err(missingTarget({ objectId: first.owner.id, property: first.property }))
  if (matches.length > 1) {
    return err(invalidValue({ reason: 'ambiguous-target-document', objectId: first.owner.id, docs: matches.map((m) => m.doc.id).join(',') }))
  }
  return ok(matches[0]!)
}

/**
 * 多目标写拒绝的逐目标聚合 —— **已迁至** `application/property-commands.ts` 的 `aggregateFailure`。
 *
 * 本文件曾有自己的 `aggregatePropertyFailures`，与 RNA 侧的 `aggregateFailure` 同名同义
 * （同样拼 `failedTargets`/`totalTargets`/`reasons`/`homogeneous`）。两份聚合必然漂移，
 * 而漂移的后果是「UI 说为什么拒绝」与「核心说为什么拒绝」不一致 ——
 * 正是「单一来源」要消除的。收敛后 `reduceSetProperty` 直接把结果透出，不再二次聚合。
 */

/** 对象是否可写（存在 + 非只读内容来源）。返回 `null` 表示可写。 */
function writeGuard(doc: Document, objectId: string): DomainError | null {
  const obj = findObject(doc.scene, objectId)
  if (!obj) return missingTarget({ objectId })
  const data = findObjectData(doc.scene, obj.dataId)
  if (!data) return missingTarget({ dataId: obj.dataId })
  if (data.source === 'content') return readOnly({ owner: data.source, objectId })
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 已删除的内联属性词汇（迁移记录，不是注释掉的代码）
// ─────────────────────────────────────────────────────────────────────────────
//
// 本文件曾有 5 个函数承载**内核侧的属性语义**，它们是"`reduceCommand` 不是唯一写入口"
// 的直接原因（属性词汇在两处各有一份，且两套集合不相交）：
//
// | 已删除 | 原职责 | 现在的唯一归属 |
// |---|---|---|
// | `validatePropertyWrite` | 内联白名单：`name`/`visible` + `doc.types[type].animatableProperties` | RNA 描述 + `evaluateEditability`（`properties.ts`）|
// | `isStructuralProperty` | 把 `name`/`visible` 当"结构属性"特例放行 | 注册表里的**普通声明**（`kernel-properties.ts`）|
// | `applyPropertyValue` | 对 `'name'`/`'visible'`/`'transform.*'`/`'projection.*'`/`'annotation.text'` 的 `switch` | 值 handler 校验 + 写端口（`kernel-properties.ts`）|
// | `propertyActuallyChanged` | 按属性名逐个判"是否真变了" | 值 handler 的 `equals`（唯一判据）|
// | `aggregatePropertyFailures` | 第二份多选失败聚合（与 `aggregateFailure` 同名同义）| `aggregateFailure`（`property-commands.ts`）|
//
// 连同 `isVec3`/`isQuat`（只在 `applyPropertyValue` 里用的形状判定）与本地
// `animationDriven`（被 `kernel-properties.ts` 的 `kernelDrivenProperties` 取代）一并删除。
// 这些**不留兼容包装**：留着"以防万一"的包装正是"新门面包旧核心"。

// ─────────────────────────────────────────────────────────────────────────────
// 交互
// ─────────────────────────────────────────────────────────────────────────────

function reduceBeginInteraction(state: ApplicationState, cmd: BeginInteractionCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)
  const r = beginInteraction(ctx, doc, { tool: cmd.tool, targets: cmd.targets })
  if (!r.ok) return rejected(state, r.error)
  const next: ApplicationState = Object.freeze({
    ...state,
    contexts: Object.freeze({ ...state.contexts, [ctx.id]: r.value }),
    leases: Object.freeze({ ...state.leases, [doc.id]: lease.value }),
  })
  // 状态变了（多了活动交互）但**文档内容未变** ⇒ applied + 版本不动
  return applied(next, doc.version, changeSummary({ structurallyShared: true }))
}

function reduceUpdateInteraction(state: ApplicationState, cmd: UpdateInteractionCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const r = updateInteraction(ctx, doc, { displacement: cmd.displacement })
  if (!r.ok) return rejected(state, r.error)
  const next: ApplicationState = Object.freeze({ ...state, contexts: Object.freeze({ ...state.contexts, [ctx.id]: r.value }) })
  // 一次 update **不记历史**、不推进内容版本
  return applied(next, doc.version, changeSummary({ structurallyShared: true }))
}

function reduceCommitInteraction(state: ApplicationState, cmd: CommitInteractionCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  if (ctx.interaction === null) return rejected(state, invalidValue({ reason: 'noActiveInteraction' }))

  const writer: SceneWriter = (scene, interaction) => collectStagedTransforms(scene, interaction)
  const result = commitInteraction(ctx, doc, writer)
  if (result === null) {
    // 净零提交（或起点版本失配）：清空交互，**文档零变化**（「移出再移回」）
    return unchanged(withContext(state, cancelInteraction(ctx)), doc.version)
  }
  const write = withScene(doc, result.scene)
  const withHistory = recordHistory(write.doc, {
    label: cmd.label,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: result.scene,
    afterVersion: write.version,
    changes: result.changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: result.selectionAfter,
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: withHistory }),
    contexts: Object.freeze({ ...state.contexts, [ctx.id]: cancelInteraction(ctx) }),
  })
  return applied(next, write.version, result.changes)
}

/**
 * 把暂存变换收集进场景。
 *
 * 净零（无任何目标真正改变）时返回 `null` —— 候选场景不存在 ⇒ 不产生历史、不推进版本。
 */
function collectStagedTransforms(scene: Scene, interaction: InteractionState): ReturnType<SceneWriter> {
  const objects = { ...scene.objects }
  const changed: PropertyRef[] = []
  for (const id of interaction.targets) {
    const obj = objects[id]
    const nextT = interaction.overrides[id]
    if (!obj || !nextT) continue
    if (sameTransform(obj.transform, nextT)) continue
    objects[id] = Object.freeze({ ...obj, transform: nextT })
    changed.push({ owner: objectRef(id), property: 'transform.position' })
  }
  if (changed.length === 0) return null
  return {
    scene: Object.freeze({ ...scene, objects: Object.freeze(objects) }),
    changes: changeSummary({ changedProperties: changed, structurallyShared: true }),
    selectionAfter: interaction.targets.map((id) => objectRef(id)),
  }
}

function reduceCancelInteraction(state: ApplicationState, cmd: CancelInteractionCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  if (ctx.interaction === null) return unchanged(state, doc.version)
  // 取消：清空暂存 + 释放租约；**文档、历史、脏状态全不变**
  const released = releaseFor(state, doc.id, cmd.contextId)
  return applied(withContext(released, cancelInteraction(ctx)), doc.version, changeSummary({ structurallyShared: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 历史
// ─────────────────────────────────────────────────────────────────────────────

function reduceUndoRedo(state: ApplicationState, contextId: string, kind: 'undo' | 'redo'): Transition {
  const found = contextAndDoc(state, contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  // 撤销前先明确取消当前交互（不因布局调尺寸或观察移动取消 —— 那两条不产生命令）
  const ctxNoInteraction = cancelInteraction(ctx)
  const step = kind === 'undo' ? undoDoc(doc) : redoDoc(doc)
  if (step === null) return unchanged(state, doc.version)
  const nextCtx: EditContext = Object.freeze({
    ...ctxNoInteraction,
    // 「撤销时根据**当前有效对象**解析」——失效引用已被 resolveSelection 丢弃，不悬空
    selection: Object.freeze({
      selected: step.selection,
      active: step.selection.length > 0 ? step.selection[0] : null,
      mode: ctx.selection.mode,
    }),
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: step.doc }),
    contexts: Object.freeze({ ...state.contexts, [ctx.id]: nextCtx }),
  })
  return applied(next, step.doc.version, changeSummary({ structurallyShared: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 保存（核心语义层；适配器接入归文件适配层）
// ─────────────────────────────────────────────────────────────────────────────

function reduceSave(state: ApplicationState, cmd: SaveCommand, env: ExecutionInputs): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const ledger = ledgerOf(state, doc.id)
  const started = beginSave(ledger, doc, ledger.bindingGeneration)
  if (started === null) {
    // 写入**串行化**。已有在途写入 ⇒ 拒绝，不并发、不丢弃（不"仅忽略旧响应"）。
    return rejected(state, invalidValue({ reason: 'saveAlreadyInFlight', documentId: doc.id }))
  }
  const effect: EffectRequest = Object.freeze({
    kind: 'save',
    correlationId: env.correlationId ?? `${doc.id}#${started.request.sequence}`,
    params: Object.freeze({
      documentId: doc.id,
      sequence: started.request.sequence,
      bindingGeneration: started.request.bindingGeneration,
      contentVersion: started.request.capturedVersion.contentVersion ?? 0,
    }),
  })
  const next: ApplicationState = Object.freeze({
    ...state,
    saveLedgers: Object.freeze({ ...state.saveLedgers, [doc.id]: started.ledger }),
    effects: Object.freeze([...state.effects, effect]),
  })
  // 保存**不**改变内容与基线（基线在完成事件里推进）；此处只登记在途与效果描述
  void ctx
  return applied(next, doc.version, changeSummary({ structurallyShared: true }), Object.freeze([effect]))
}

/**
 * 保存完成事件。
 *
 * 三条判据：
 *  1. 结束的必须是**在途**那一次（序号相符）——否则忽略；
 *  2. **绑定代数相符** —— 文档已关闭/重绑则旧事件不得回写（`superseded`）；
 *  3. 只有 `committed` 推进基线，且基线取**该请求捕获的已提交快照**（保存期间的新编辑仍脏）。
 */
function reduceSaveCompleted(state: ApplicationState, cmd: SaveCompletedCommand): Transition {
  const doc = getDoc(state, cmd.documentId)
  if (!doc) {
    // 文档已关闭：迟到事件不得回写（负对照）
    return unchanged(state, { documentVersion: 0 })
  }
  const ledger = ledgerOf(state, doc.id)
  if (ledger.inFlight === null || ledger.inFlight.sequence !== cmd.sequence) {
    return unchanged(state, doc.version)
  }
  const request = ledger.inFlight
  const result = completeSave(ledger, doc, request, cmd.outcome, cmd.bindingGeneration)
  if (!result.applied) {
    const next: ApplicationState = Object.freeze({ ...state, saveLedgers: Object.freeze({ ...state.saveLedgers, [doc.id]: result.ledger }) })
    return unchanged(next, doc.version)
  }
  const next: ApplicationState = Object.freeze({
    ...state,
    docs: Object.freeze({ ...state.docs, [doc.id]: result.doc }),
    saveLedgers: Object.freeze({ ...state.saveLedgers, [doc.id]: result.ledger }),
  })
  return applied(next, result.doc.version, changeSummary({ structurallyShared: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

function has(rec: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key)
}

function getDoc(state: ApplicationState, id: string): Document | undefined {
  return has(state.docs, id) ? state.docs[id] : undefined
}

function ledgerOf(state: ApplicationState, documentId: string): SaveLedger {
  return has(state.saveLedgers, documentId) ? state.saveLedgers[documentId] : createSaveLedger()
}

/** 取上下文与其绑定文档；任一缺失即 `MissingTarget`（不静默降级）。 */
function contextAndDoc(state: ApplicationState, contextId: string): Result<{ ctx: EditContext; doc: Document }> {
  if (!has(state.contexts, contextId)) return err(missingTarget({ contextId }))
  const ctx = state.contexts[contextId]
  if (!has(state.docs, ctx.documentId)) return err(missingTarget({ documentId: ctx.documentId }))
  return ok({ ctx, doc: state.docs[ctx.documentId] })
}

function acquireFor(state: ApplicationState, documentId: string, contextId: string): Result<DocumentLease> {
  const lease = has(state.leases, documentId) ? state.leases[documentId] : createLease(documentId)
  return acquireLease(lease, contextId)
}

function releaseFor(state: ApplicationState, documentId: string, contextId: string): ApplicationState {
  if (!has(state.leases, documentId)) return state
  const lease = state.leases[documentId]
  const next = releaseLease(lease, contextId)
  if (next === lease) return state
  return Object.freeze({ ...state, leases: Object.freeze({ ...state.leases, [documentId]: next }) })
}

function withContext(state: ApplicationState, ctx: EditContext): ApplicationState {
  if (state.contexts[ctx.id] === ctx) return state
  return Object.freeze({ ...state, contexts: Object.freeze({ ...state.contexts, [ctx.id]: ctx }) })
}

/** 记历史；`pushHistory` 返回 `null` 表示净零/仅选择变化 ⇒ 文档原样返回（幽灵历史防御）。 */
function recordHistory(doc: Document, input: Parameters<typeof pushHistory>[1]): Document {
  const h = pushHistory(doc.history, input)
  return h === null ? doc : Object.freeze({ ...doc, history: h })
}

function sameSelection(a: SelectionState, b: SelectionState): boolean {
  if (a.selected.length !== b.selected.length) return false
  for (let i = 0; i < a.selected.length; i++) {
    const x = a.selected[i]
    const y = b.selected[i]
    if (x.kind !== y.kind || x.id !== y.id || x.contentVersion !== y.contentVersion) return false
  }
  const sameActive =
    (a.active === null && b.active === null) ||
    (a.active !== null && b.active !== null && a.active.kind === b.active.kind && a.active.id === b.active.id && a.active.contentVersion === b.active.contentVersion)
  return sameActive && a.mode === b.mode
}

/**
 * 动画轨道索引 —— **已迁至** `application/kernel-properties.ts` 的 `kernelDrivenProperties`。
 *
 * 迁移理由：它服务的 `validatePropertyWrite` 已删除，而"哪些属性被轨道驱动"是
 * **RNA 可编辑性求值的状态事实**（`TargetFacts.drivenByTrack`），归 `propertyAccess` 的
 * 构造处（`kernelAccessOf`）提供，不再由命令层各算一份 —— 两份轨道索引必然漂移，
 * 而漂移会让"动画驱动的属性被拒绝"在两条路径上给出不同答案（负对照）。
 */
/** 默认插值策略（无显式声明时按值类型推断；"采样策略由属性值类型和定义选择"）。 */
function defaultInterpolationFor(valueType: TrackValueType): InterpolationKind {
  switch (valueType) {
    case 'quat':
      return 'slerp'
    case 'integer':
      return 'quantized'
    case 'enum':
    case 'boolean':
    case 'string':
      return 'step'
    case 'vec3':
    case 'number':
      return 'linear'
  }
}

/** 由值推断类型（调用方未声明时的兜底；显式声明优先）。 */
function inferValueType(value: TrackValue): TrackValueType {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'enum'
  if (typeof value === 'object' && value !== null && 'w' in value) return 'quat'
  return 'vec3'
}

/**
 * 插入关键帧。
 *
 * 两条语义要点：
 *  1. **写轨道，不写基础值**：这是"关键帧命令"与"普通基础值写入"的分界。
 *     被驱动属性的基础值写入仍被写权判定拒绝（负对照面），
 *     而本命令永远合法（只要目标可动画）。
 *  2. **值必须过类型与合法域校验**（`sampleTrack` 的同一套判据）：
 *     插入一个非法枚举值会让之后每次采样都失败 —— 与其把坏数据存进文档，
 *     不如在插入点拒绝，并给出同一个 `InvalidValue` 诊断。
 */
function reduceInsertKeyframe(state: ApplicationState, cmd: InsertKeyframeCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const guard = validateAnimationTarget(doc, cmd.target)
  if (guard) return rejected(state, guard)
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)

  const existing = findTrack(doc.animation, cmd.target)
  // 类型优先取**属性声明**（RNA 描述），其次已有轨道，最后才由值推断。
  // 顺序不能颠倒：只从值推断会让"往 vec3 属性插一个数字"变成合法操作。
  //
  // 收敛后类型**不再**由本层的第二张表给出（曾有 `declaredValueType(property)`），
  // 而是向 RNA 注册表解析 —— `validateAnimationTarget` 已保证描述可解析，故此处直接取用。
  const described = describeRnaProperty(kernelPropertyRegistry().registry, cmd.target)
  if (!described.ok) return rejected(state, described.error)
  const declaredType = trackValueTypeOf(described.value.valueType)
  const valueType = cmd.valueType ?? declaredType ?? existing?.valueType ?? inferValueType(cmd.value)
  const interpolation = cmd.interpolation ?? existing?.interpolation ?? defaultInterpolationFor(valueType)
  // 枚举/布尔的合法取值同样取自**声明域**（RNA `ValueDomain`），不另立一份。
  const legalValues = cmd.legalValues ?? existing?.legalValues ?? legalValuesOf(described.value)
  const quantization = cmd.quantization ?? existing?.quantization

  // 值与属性声明类型不符 ⇒ 在写入点拒绝（不把坏数据存进文档）
  if (declaredType !== undefined) {
    const typeError = checkValueAgainstDeclaredType(declaredType, cmd.value)
    if (typeError) return rejected(state, typeError)
  }

  const base: AnimationTrack =
    existing ??
    Object.freeze({
      id: `track:${propertyKey(cmd.target)}`,
      target: cmd.target,
      valueType,
      interpolation,
      enabled: true,
      keys: Object.freeze([]) as readonly AnimationKey[],
      ...(legalValues === undefined ? {} : { legalValues }),
      ...(quantization === undefined ? {} : { quantization }),
    })

  const candidate = insertKeyframe(
    Object.freeze({ ...base, valueType, interpolation, ...(legalValues === undefined ? {} : { legalValues }), ...(quantization === undefined ? {} : { quantization }) }),
    Object.freeze({ time: cmd.time, value: cmd.value }),
  )

  // 校验：用**采样器本身**判定"这份轨道在该时间能否产出合法值"。
  // 这样"插入时接受的"与"采样时产出的"是同一套判据，不会出现
  // "插入成功但每次采样都失败"的文档。
  const check = sampleTrack(candidate, cmd.time)
  if (!check.ok) return rejected(state, check.error)

  return applyAnimationChange(state, doc, ctx, withTrack(doc.animation, candidate), `keyframe ${cmd.target.property}`)
}

function reduceRemoveKeyframe(state: ApplicationState, cmd: RemoveKeyframeCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const track = findTrack(doc.animation, cmd.target)
  if (!track) return rejected(state, missingTarget({ property: cmd.target.property, objectId: cmd.target.owner.id }))
  const next = removeKeyframe(track, cmd.time)
  if (next === track) return unchanged(state, doc.version)
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)
  return applyAnimationChange(
    state,
    doc,
    ctx,
    next.keys.length === 0 ? withoutTrack(doc.animation, cmd.target) : withTrack(doc.animation, next),
    `remove keyframe ${cmd.target.property}`,
  )
}

function reduceSetTrackEnabled(state: ApplicationState, cmd: SetTrackEnabledCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const track = findTrack(doc.animation, cmd.target)
  if (!track) return rejected(state, missingTarget({ property: cmd.target.property, objectId: cmd.target.owner.id }))
  const next = setTrackEnabled(track, cmd.enabled)
  if (next === track) return unchanged(state, doc.version)
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)
  // 禁用轨道 ⇒ 属性回到手动/默认值。这不是"清空轨道数据"，
  // 而是让 `animationDrivenKeys` 不再含它 ⇒ 基础值写入重新被允许。
  return applyAnimationChange(state, doc, ctx, withTrack(doc.animation, next), `${cmd.enabled ? 'enable' : 'disable'} track ${cmd.target.property}`)
}

function reducePublishDefault(state: ApplicationState, cmd: PublishDefaultCommand): Transition {
  const found = contextAndDoc(state, cmd.contextId)
  if (!found.ok) return rejected(state, found.error)
  const { ctx, doc } = found.value
  const guard = validateAnimationTarget(doc, cmd.target)
  if (guard) return rejected(state, guard)
  const lease = acquireFor(state, doc.id, cmd.contextId)
  if (!lease.ok) return rejected(state, lease.error)
  const next = withPublishedDefault(doc.animation, propertyKey(cmd.target), cmd.value)
  return applyAnimationChange(state, doc, ctx, next, `publish default ${cmd.target.property}`)
}

/**
 * RNA 值类型 → 轨道值类型。
 *
 * 两侧的**取值空间不同**，映射是有损的、也是必须显式的一处：
 *  - RNA 的 `PropertyValueType` 是**开放字符串**（`PropertyValueType = string`）
 *    —— 扩展类型可以注册进来，故不能写成封闭联合；
 *  - 轨道的 `TrackValueType` 是**可动画子集**（离散/连续插值各自有明确语义）。
 *
 * 未映射的类型返回 `undefined` ⇒ 调用方回落到"已有轨道类型"或"由值推断"。
 * **不**在这里猜一个类型：猜错会让"不可动画的值类型"被插进轨道。
 */
function trackValueTypeOf(valueType: string): TrackValueType | undefined {
  switch (valueType) {
    case 'number':
    case 'integer':
    case 'vec3':
    case 'quat':
    case 'string':
    case 'boolean':
      return valueType
    default:
      return undefined
  }
}

/**
 * 由 RNA **声明域**推出轨道的合法取值集合（枚举/布尔）。
 *
 * 为什么取自声明域而不是由调用方传：`legalValues` 是"这条轨道允许哪些值"，
 * 而"该属性允许哪些值"是**属性声明的同一事实**。两处各写一份 ⇒ 枚举项
 * 增删后轨道校验静默失效（插入了声明域外的值，直到采样时才暴露）。
 *
 * 返回 `undefined` = 该类型不做成员校验（数值类由域的范围约束在值 handler 里管）。
 */
function legalValuesOf(desc: PropertyDescriptor): readonly TrackValue[] | undefined {
  const domain = desc.domain
  if (!domain) return undefined
  if (domain.kind === 'enum') return domain.items.map((i) => i.value)
  return undefined
}

/** 动画目标的公共校验：目标存在、可写、类型允许动画。 */function validateAnimationTarget(doc: Document, ref: PropertyRef): DomainError | null {
  if (ref.owner.kind !== 'object') {
    return unsupportedOperation({ ownerKind: ref.owner.kind, property: ref.property })
  }
  const obj = findObject(doc.scene, ref.owner.id)
  if (!obj) return missingTarget({ objectId: ref.owner.id, property: ref.property })
  const data = findObjectData(doc.scene, obj.dataId)
  if (!data) return missingTarget({ dataId: obj.dataId, property: ref.property })
  // 写权按拥有者判定：多方块生成物的**内容**只读。
  if (data.source === 'content') return readOnly({ owner: data.source, objectId: ref.owner.id, property: ref.property })
  // 动画资格（`PropertyDescriptor.animatable`）：不可动画的属性不能建轨道，
  // 否则 UI 会提供一个"关键帧按钮点了没反应"的假成功控件（明令禁止）。
  //
  // ## 权威是 **RNA 注册表**（收敛后），不是本层的第二张表
  //
  // 开发期这里读的是 `doc.types[obj.type].animatableProperties`（文档模型自带的
  // 类型描述）。收敛把属性语义的**唯一权威**移到 RNA 注册表（`application/properties`），
  // 内核类型经 `kernel-properties.ts` 注册 —— `doc.types` 已不再是属性词汇的持有者。
  // 若此处仍读旧字段，就会出现"注册表说不可动画、命令层说可以"的两套判据
  // （正是要消除的形态）。故改为向注册表解析描述。
  //
  // `describeProperty` 对未注册属性返回 `UnsupportedOperation`，其错误**原样透出** ——
  // 不折叠成本层的 `propertyNotAnimatable`，否则"未注册"与"已注册但不可动画"
  // 在诊断上会变成同一件事（而两者的处置不同：前者是缺登记，后者是设计如此）。
  const described = describeRnaProperty(kernelPropertyRegistry().registry, ref)
  if (!described.ok) return described.error
  if (!described.value.animatable) {
    return unsupportedOperation({ reason: 'propertyNotAnimatable', property: ref.property, objectType: obj.type })
  }
  return null
}

/**
 * 应用一次动画状态变更：推进内容版本 + 记历史。
 *
 * 与 `reduceSetProperty` 的分工：那条命令走属性写校验（会被轨道驱动拒绝），
 * 本函数走**动画面**（轨道本身的变更）—— 两者都经 `withContent`/`pushHistory`，
 * 因此"内容身份是否真的变了"只有一个判据点（`domain/document`）。
 */
function applyAnimationChange(
  state: ApplicationState,
  doc: Document,
  ctx: EditContext,
  animation: AnimationState,
  label: string,
): Transition {
  const write = withAnimation(doc, animation)
  if (!write.changed) {
    // 内容身份未变（例如插入同时间同值的关键帧）⇒ unchanged，
    // **不**因"新建了容器"而记账（契约 §1.4）。
    return unchanged(write.doc === doc ? state : withDoc(state, write.doc), doc.version)
  }
  const changes = changeSummary({ changedProperties: [], structurallyShared: true })
  const withHistory = recordHistory(write.doc, {
    label,
    beforeScene: doc.scene,
    beforeVersion: doc.version,
    afterScene: doc.scene,
    afterVersion: write.version,
    changes,
    selectionBefore: ctx.selection.selected,
    selectionAfter: ctx.selection.selected,
    beforeAnimation: doc.animation,
    afterAnimation: animation,
  })
  const next = withDocState(state, withHistory, doc.id)
  return applied(next, write.version, changes)
}

/** 把新文档写回状态（动画面用；不碰上下文与租约）。 */
function withDocState(state: ApplicationState, doc: Document, documentId: string): ApplicationState {
  return Object.freeze({ ...state, docs: Object.freeze({ ...state.docs, [documentId]: doc }) })
}

/** 只替换文档值（不推进版本）。 */
function withDoc(state: ApplicationState, doc: Document): ApplicationState {
  return withDocState(state, doc, doc.id)
}

// ─────────────────────────────────────────────────────────────────────────────
// 便捷构造（供接线层与测试；不构成第二写通路 —— 它也是走 reduceCommand）
// ─────────────────────────────────────────────────────────────────────────────

/** 打开一个文档 + 上下文的初始状态，等价于一条 `openDocument` 命令的结果。 */
export function openDocumentState(documentId = 'doc-1', contextId = 'ctx-1', prefix = 'wk'): ApplicationState {
  const t = reduceCommand(
    { docs: {}, contexts: {}, leases: {}, saveLedgers: {}, ids: { prefix, counter: 0 } as IdState, effects: [] },
    { kind: 'openDocument', documentId, contextId },
    defaultExecutionInputs(),
  )
  return t.state
}

/** 便利：状态里 `effects` 的长度（供效果序列对账）。 */
export function effectCount(state: ApplicationState): number {
  return state.effects.length
}

/** 内容是否与保存基线相同（dirty 的对外呈现；判据在 `domain/document`）。 */
export function isDirtyState(state: ApplicationState, documentId: string): boolean {
  const doc = getDoc(state, documentId)
  if (!doc) return false
  return !sameContent(doc.version, doc.saveBaseline)
}
