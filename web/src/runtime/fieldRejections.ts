/**
 * M4-3 R2 · **字段级拒绝回执的运行时共享读面**。
 *
 * ## 它替代了什么（为什么不能留在组件局部态）
 *
 * 旧形态里「上一次拒绝原因」住在 `PropertyInspector.vue` 的 `PanelSession` 里，
 * 只有**无草稿控件**的 emit 能写到它（`applyOutcome`）。文本控件的提交走
 * 输入端口（`inputSession` → `inputCommands` → `commitDraftControlValue`），
 * 那条路**结构上拿不到组件局部态** ⇒ 文本字段的拒写永远是"输入了没反应"
 * （S0 域 2 ①）。内核拒绝只进 trace（容量 256，无 UI 消费者）与日志。
 *
 * 所以回执必须**下沉到运行时**：写点在唯一写路由的结算处（`submitPropertyWrite`），
 * 读点是字段模型构造（`buildField`）。两者都在 `Context` 可达的层级，与组件生命周期无关。
 *
 * ## 键为什么是**属性描述符 id**（而不是设计简报建议的"局部 id"）
 *
 * 局部 id（`id`/`tooltip`/`title`）在**不同对象类型之间会撞名**
 * （`lightning.block.id` 与将来任何 `*.id`），而写点只有描述符 id。
 * 用描述符 id 作键使"写点与读点用同一个值"，不需要任何形状转换
 * —— P10c 核销过的那条镜像正是死在"写键与读键不同"（写 `tooltip`、读 `block.tooltip`，
 * 生产 84 个属性无一命中）。本存储刻意不复制那个错误。
 *
 * ## 生命周期
 *
 * - 写：`submitPropertyWrite` 结算为 `rejected` ⇒ 记下该字段的**全部**目标属性 id；
 * - 清：同一入口结算为 `applied`/`unchanged`（写成功）⇒ 清掉这些 id；
 *   字段重新获得焦点开始新草稿 ⇒ 由 `PropertyField` 调 `clear`（旧拒绝不压在
 *   正在输入的新值旁边）；
 * - 换文档：`Context` 级实例随文档一起被丢弃/重置（`clearAll`）。
 *
 * ## 为什么用 `shallowRef` 承载整张表
 *
 * 表是"小、写少、读多"的：一次写入生成一个新对象即可让 Vue 的依赖图看到变化，
 * 不必为每个字段建一个 ref（那会让 84 个字段各占一条依赖，且清理时机分散）。
 */

import { shallowRef, type Ref } from 'vue'
import type { DomainError } from '@/application/contracts'

/** 一条字段拒绝回执。 */
export type FieldRejection = Readonly<{
  /** 结构化原因（成句文本由 `domain/rejectionText` 在**读**时派生，语言随实例）。 */
  error: DomainError
  /** 写入时刻（`Date.now()`；只用于诊断，不参与判定）。 */
  at: number
}>

/** 只读表（属性描述符 id → 回执）。 */
export type FieldRejectionTable = Readonly<Record<string, FieldRejection>>

export interface FieldRejectionStore {
  /** 响应式读面：表变化即触发重渲染（内容只读）。 */
  readonly table: Readonly<Ref<FieldRejectionTable>>
  /** 某字段的最近一次拒绝（无则 `null`）。 */
  get(propertyId: string): FieldRejection | null
  /** 记录一次拒绝（同一错误重复写入不产生新对象 ⇒ 不触发无意义的重渲染）。 */
  reject(propertyId: string, error: DomainError): void
  /** 清掉某字段的拒绝记录（写成功 / 新草稿开始）。 */
  clear(propertyId: string): void
  /** 清空（换文档 / 卸载）。 */
  clearAll(): void
}

export function createFieldRejectionStore(): FieldRejectionStore {
  const table = shallowRef<FieldRejectionTable>(Object.freeze({}))

  return {
    table,

    get(propertyId: string): FieldRejection | null {
      return table.value[propertyId] ?? null
    },

    reject(propertyId: string, error: DomainError): void {
      const cur = table.value[propertyId]
      // 同一字段同一错误重复写：保留**首次**时间戳，且不换对象（避免每帧重渲染）。
      if (cur !== undefined && cur.error.code === error.code && sameParams(cur.error, error)) return
      table.value = Object.freeze({ ...table.value, [propertyId]: Object.freeze({ error, at: Date.now() }) })
    },

    clear(propertyId: string): void {
      if (table.value[propertyId] === undefined) return
      const next = { ...table.value }
      delete next[propertyId]
      table.value = Object.freeze(next)
    },

    clearAll(): void {
      if (Object.keys(table.value).length === 0) return
      table.value = Object.freeze({})
    },
  }
}

/** 同一码 + 同一组参数（值语义）。 */
function sameParams(a: DomainError, b: DomainError): boolean {
  const ka = Object.keys(a.params)
  const kb = Object.keys(b.params)
  if (ka.length !== kb.length) return false
  return ka.every((k) => a.params[k] === b.params[k])
}
