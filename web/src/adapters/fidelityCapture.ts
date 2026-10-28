/**
 * `adapters/fidelityCapture` —— **保真字段的产物侧挂点**（采集接线）。
 *
 * ## 它替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 未知顶层字段**只被计数**、从未进产物 | `composition/documentLoad.ts:138`（`unknownFields: Object.keys(...).length` 写进一条日志） | 由本模块把 `AssembledDocument.unknownFields` 采成保真记录，供**保存/导出投影**写回产物 |
 *
 * ## ⚠️ 为什么它在 `adapters/` 的**扁平**路径（深度 2），而不是包一层薄出口
 *
 * 这一条是**实测**出来的，不是偏好（跑了 `gate/no-private-cross-layer` 与
 * `gate/no-barrel-smuggling` 两条规则本身）：
 *
 * 1. 采集实现 `captureFidelity` 在 `adapters/files/fidelityRecord.ts` ⇒ **深度 3**；
 * 2. 而 `composition/` 是**整层的闸门执行面**（`resolveGateLayers` 里它不声明
 *    `activeSubpaths`）⇒ `composition/` → `adapters/files/*` 被判
 *    "深于公共出口的实现（深度 3 > 2）"；
 * 3. **再导出一层也不行**：`APPROVED_BARRELS = []`（空表）⇒
 *    `adapters/` 下的跨目录 barrel 转出口被 `gate/no-barrel-smuggling` 拦下。
 *
 * 三次尝试都指向同一件事：**"给 `composition/` 用的那部分"应当自己就是深度 2 的模块**。
 * 这与 `adapters/tooltipPool.ts` 的模块头记录的是**同一个问题、同一个解法**
 * （它第一版写在 `composition/`，同样三撞闸门，最终"放到 `adapters/` 扁平路径"解决）。
 *
 * ## 它**不做**什么（避免第二份实现）
 *
 * 本模块**只**做：取装配产物里的未知字段 → 调**同层**的 `captureFidelity`（同层 ⇒ 不受深度约束）
 * → 返回投影需要的 `fidelityFields` 形状。
 * 它**不**重新遍历 `raw`、**不**自己判断"哪些键能被解释"
 * （那是 `captureFidelity` 的 `knownKeys` 语义）、**不**碰 `_extra` 规则
 * （由 `captureFidelity` 内部排除）。
 *
 * ⚠️ 第二条尤其重要：若在这里再写一遍"排除 `_extra` / 跳过已知键"，
 * 就出现了**两份会漂移的实现**——而 `_extra` 恰好是本项目反复强调的那条纪律。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无时钟；输入输出都是纯数据（与 `adapters/tooltipPool` 同纪律）。
 */

import { captureFidelity, type FidelityRecord } from './files/fidelityRecord'

/**
 * 装配产物里与保真有关的那些事实（**结构化输入**，不是整个 `AssembledDocument`）。
 *
 * 收窄成这三样而不是吃整个装配产物：
 *  - 让本模块**不**依赖 `composition/` 的类型（那会造出一条反向依赖）；
 *  - 让调用方清楚"保真只关心这三样"（源格式、源版本、未知字段）。
 */
export interface FidelityCaptureInput {
  /** 源格式标识（装配产物的 `sourceFormat`）。 */
  readonly sourceFormat: string
  /** 源版本（装配产物的 `sourceVersion`）。 */
  readonly sourceVersion: string
  /** 装配期收集的未知顶层字段（`AssembledDocument.unknownFields`）。 */
  readonly unknownFields: Readonly<Record<string, unknown>>
  /**
   * `meta.` 前缀之外的键会被投影写回 plain **根**；`meta.` 前缀的写回 `meta` 子树。
   *
   * 装配期已按这个约定给未知 meta 键加了 `meta.` 前缀
   * （`kernelAssembly.ts` 的 `meta.` 收集），故本模块**原样透传**键名，不再加工。
   */
}

/**
 * 采集保真记录。
 *
 * ## 为什么"空记录也返回"（与 `captureFidelity` 同口径）
 *
 * `fields: {}` 与 `null` 语义不同：前者是"**确实没有**未知字段"，
 * 后者会与"采集失败"混淆。下游（`judgeFidelityAfterEdit` 的三态裁定）需要区分它们。
 *
 * ## 入参形态：把 `unknownFields` 当作"已经筛过的未知字段表"
 *
 * ⚠️ 这里有一个**刻意的简化**，必须写明，否则下一个人会以为漏了筛：
 * 装配产物给出的 `unknownFields` **已经**是"未知字段"（它的产地在
 * `composition/kernelAssembly.ts`，那里已经跳过已知键与 `_extra`）。
 * 而 `captureFidelity` 的契约是"给我**原始** raw + 我能解释的 knownKeys，我来筛"。
 * 两者形状不同 ⇒ 本模块**不**把 `unknownFields` 当 raw 传进去（那会让
 * `captureFidelity` 用 `knownKeys: []` 把**全部**键收下 —— 结果恰好相同，
 * 但**语义**是"我没说清"，一旦 `unknownFields` 的产地改变就会静默出错）。
 *
 * ⇒ 本模块走 `captureFidelity({ raw: unknownFields, knownKeys: [] })`，
 * 并**显式**在下面注明该调用成立的前提是"入参已是筛过的未知字段表"。
 * 这样 `_extra` 排除规则仍由 `captureFidelity` **单点**把守
 * （它内部 `if (key === CORE_EXTRA_BAG_KEY) continue`），本模块不复制该规则。
 */
function captureFidelityFields(input: FidelityCaptureInput): FidelityRecord {
  const captured = captureFidelity({
    sourceFormat: input.sourceFormat,
    sourceVersion: input.sourceVersion,
    // ⚠️ 前提：`input.unknownFields` 已是"筛过的未知字段表"（见上文说明）。
    raw: input.unknownFields,
    // 无额外的"已知键"要跳过（筛工作在产地已完成）——
    // 故 `knownKeys: []`，而 `_extra` 仍由 `captureFidelity` 内部排除。
    knownKeys: [],
  })
  // `captureFidelity` 只在"raw 不是对象"时失败；`unknownFields` 的类型保证它是对象。
  // ⇒ 走到 `err` 分支意味着**调用方违反了类型契约**（不是业务失败）。
  // 此时返回空记录（而不是抛）：纯层不抛（`domain/errors` 的纪律），
  // 且"没有保真字段"是**保守**方向 —— 让产物照常写出，只是不带未知字段。
  return captured.ok ? captured.value : Object.freeze({ sourceFormat: input.sourceFormat, sourceVersion: input.sourceVersion, fields: Object.freeze({}) })
}

/**
 * **只要字段表**的那条出口（本模块**唯一**的公开函数）。
 *
 * ## ⚠️ 为什么是"只要字段表"（深度闸门的硬约束，不是便利性选择）
 *
 * `FidelityRecord` 类型定义在 `adapters/files/fidelityRecord.ts` ⇒ 引用它是**深度 3**。
 * `runtime/kernelSession.ts` 是**闸门执行面**（登记在 `runtime/` 的 `activeSubpaths` 里）
 * ⇒ 它从 `adapters/files/*` 取类型会被判"深于公共出口"（实测经由规则本体确认）。
 *
 * 而 `FidelityRecord` 的元信息（`sourceFormat`/`sourceVersion`）**本模块内部**已经消费掉了
 * （它参与 `captureFidelity` 的构造）。会话侧真正需要的只有**字段表本身**。
 *
 * ⇒ 本函数返回**纯 `Record`**，于是调用方（内核会话、投影入口）**无需**引任何深度 3 类型。
 * ⚠️ 本模块**不**导出 `FidelityRecord` 类型本身：那会构成
 * `adapters/` → `adapters/files/` 的跨目录 `export-from`，
 * 而 `APPROVED_BARRELS = []`（空表）⇒ 被 `gate/no-barrel-smuggling` 判红
 * （`adapters/files/fidelityRecord.ts` 本身是闸门执行面 ⇒ 该规则对本条成立）。
 *
 * ## ⚠️ 为什么"取 `.fields`"这件事必须在这里做（而不是让调用方自己取）
 *
 * 投影侧（`composition/kernelProjection.ts:1201`）读的是
 * `Object.entries(input.fidelityFields ?? {})` —— 它要的就是**键值表**本身。
 * 若调用方误传整个 `FidelityRecord`（`{sourceFormat, sourceVersion, fields}`），
 * 那三个**元**键会被当成未知字段写回产物（`sourceFormat` 出现在 plain 根上）
 * ⇒ 产物被污染，且**不会报错**。本函数让调用方没有机会传错。
 *
 * ## 为什么不额外导出"返回整条记录"的版本（实测删掉了那个多余出口）
 *
 * 第一版还导出了 `captureFidelityFields`（返回 `FidelityRecord`），
 * 但**全树零调用方**（唯一消费者只要字段表）⇒ 那是**死代码**，
 * 且它的名字会让"产物侧挂点是否已接线"的判据把它误认成 `fidelityFields` 的传值方。
 * ⇒ 收成模块私有。**不需要的东西不留**（"不留半成品"同一纪律）。
 */
export function captureFidelityFieldMap(input: FidelityCaptureInput): Readonly<Record<string, unknown>> {
  return captureFidelityFields(input).fields
}
