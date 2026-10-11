/**
 * `operators/builtin/areaOperators` —— **Area 布局编辑命令的 operator 入口**
 * （#282 P10b Area 产品接线；#257 A21「Area 支持分割、合并、切类型、恢复」）。
 *
 * ## 本文件补齐的缺口
 *
 * `composition/profiles.ts` 的 `M_LAYOUT_EDIT` 早已**声明**了五条命令
 * （`splitArea`/`mergeArea`/`setEditorType`/`setSplitRatio`/`restoreWorkspace`），
 * `editors/useAreaHost.ts` 也早已**实现**了它们（纯转移 + 实例生命周期），
 * 但两者之间**没有任何生产代码**把它们接起来 —— 于是：
 *
 *  - 菜单/快捷键/UI 上**没有**任何入口能触发分割（实测全树零调用方）；
 *  - `AreaHost.vue`/`useAreaHost.ts` 只被两处注释提到；
 *  - #249 §13 的「Area 可分割、合并、切换类型」在产品里不可达。
 *
 * 本文件就是那个接线：把布局命令暴露成 operator（菜单可列、快捷键可绑、
 * 测试可调），并**唯一**经 `ctx.requireAreaSession()` 写入。
 *
 * ## 为什么经 operator 而不是让组件直接调 `useAreaHost`
 *
 * 三条理由，都是 #249 的明文要求：
 *
 * 1. **可用性判定只有一处**：`poll()` 读的是**装配结果**（该外壳是否有
 *    `layout.edit` 能力），而不是"当前宿主叫什么"。嵌入外壳没有 Area 会话
 *    ⇒ `poll()` 为假 ⇒ 菜单项灰显、快捷键不响应（不是"UI 上藏了按钮"）；
 * 2. **可被审计**：命令搜索/快捷键/菜单/测试走**同一个** operator id，
 *    于是"谁还能分割 Area"是可枚举的（§19.1 的口径）；
 * 3. **组件不做业务决定**：`domain/workspace` 决定"切类型要不要保留局部状态"，
 *    本文件只调它并**如实报告**结果（含结构化失败原因）。
 *
 * ## 失败必须响亮
 *
 * 每条命令失败时返回 `CANCELLED` 并把 `DomainError` 写进日志 —— 不静默。
 * "点了分割没反应"正是 §13 禁止的假成功控件形态。
 */

import type { OperatorType, OperatorProperties } from '@/operators/operatorType'
import { OP_RESULT } from '@/operators/operatorType'
import type { Context } from '@/runtime/context'
import type { SplitDirection } from '@/domain/workspace'

/**
 * 解析"要操作哪个 Area"。
 *
 * 优先级：显式 `props.areaId` → **活动 Area** → 布局里的第一个。
 *
 * 为什么需要"活动 Area"这一档：菜单项不知道用户刚点的是哪个视口，而
 * `useAreaHost` 的 `setActive` 记着它（点视口时由外壳更新）。缺这一档会让
 * "分割"永远切第一个 Area —— 用户点了第二个视口再分割，切的是第一个，
 * 那是**错误的操作对象**（而界面看起来"成功"了）。
 */
function resolveAreaId(ctx: Context, props: OperatorProperties): string | null {
  const explicit = props.areaId
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const session = ctx.hasAreaSession() ? ctx.requireAreaSession() : null
  if (session === null) return null
  const active = session.activeAreaId.value
  if (active !== null) return active
  const first = session.areaIds.value[0]
  return first ?? null
}

/** 把结构化失败原因写进日志并返回 `CANCELLED`（**不**静默）。 */
function fail(ctx: Context, command: string, error: unknown): typeof OP_RESULT.CANCELLED {
  ctx.log.warn('Area 布局', `${command} 失败`, error)
  return OP_RESULT.CANCELLED
}

/** 分割方向：`props.direction` 显式给出；缺省按 `props.vertical` 兼容旧键位。 */
function resolveDirection(props: OperatorProperties): SplitDirection {
  const d = props.direction
  if (d === 'horizontal' || d === 'vertical') return d
  return props.vertical === true ? 'vertical' : 'horizontal'
}

/**
 * 分配新 Area / Split 的稳定 id（**显式输入**）。
 *
 * ## 为什么这里**不**自己造 id
 *
 * `useAreaHost.split()` 已经负责 id 分配（`nextAreaId`/`nextSplitId`，内部按
 * "未使用的 id"顺延），且它的规则与 `domain/workspace` 的"纯函数不造 id"
 * （#249 §2.1）一致 —— id 由**接线层**作为显式输入传进纯转移。
 *
 * 本文件若再实现一遍 id 生成，就会出现**两份**"下一个 Area 叫什么"的规则
 * （漂移风险），且 `split()` 的 `opts` 根本不接受外部 id。故这里不重复造它。
 */

export const SplitAreaOperator: OperatorType = {
  id: 'OPERATOR_AREA_SPLIT',
  label: '分割区域',
  description: '把当前区域分割成两个（第二个是新的 3D 视口，机位独立）',

  /**
   * `poll` 读**装配结果**（是否有 Area 会话），不读宿主名。
   *
   * 嵌入外壳（固定布局，#257 在装配层就没有 `layout.edit`）没有 Area 会话
   * ⇒ 本命令在嵌入里**不可用**，且这是"装配的后果"而非"UI 藏了按钮"。
   */
  poll(ctx) {
    return ctx.hasAreaSession()
  },

  invoke(ctx, props) {
    const session = ctx.hasAreaSession() ? ctx.requireAreaSession() : null
    if (session === null) return fail(ctx, 'splitArea', 'no area session')
    const areaId = resolveAreaId(ctx, props)
    if (areaId === null) return fail(ctx, 'splitArea', 'no target area')

    const direction = resolveDirection(props)
    // 新 Area 的类型固定为 `viewport3d`：本批的验收对象是"分割出第二个 **3D** Area"
    // （A05/A17 产品级判据的前提）。要分割成别的类型请用 `setEditorType` 命令。
    const result = session.split(areaId, direction, { editorType: 'viewport3d' })
    if (!result.ok) return fail(ctx, 'splitArea', result.error)

    // 新 Area 成为活动区：用户刚"分割"，下一步操作的自然对象是新视口。
    const created = session.areaIds.value
    const newest = created[created.length - 1]
    if (newest !== undefined) session.setActive(newest)
    return OP_RESULT.FINISHED
  },
}

export const MergeAreaOperator: OperatorType = {
  id: 'OPERATOR_AREA_MERGE',
  label: '合并区域',
  description: '关闭当前区域，其空间归还给相邻区域',

  poll(ctx) {
    return ctx.hasAreaSession()
  },

  invoke(ctx, props) {
    const session = ctx.hasAreaSession() ? ctx.requireAreaSession() : null
    if (session === null) return fail(ctx, 'mergeArea', 'no area session')
    const areaId = resolveAreaId(ctx, props)
    if (areaId === null) return fail(ctx, 'mergeArea', 'no target area')

    const result = session.merge(areaId)
    if (!result.ok) return fail(ctx, 'mergeArea', result.error)

    // 被释放的实例如实报告（A13「关闭 Area 释放运行资源」的可测量事实）
    if (result.disposedInstances !== undefined && result.disposedInstances.length > 0) {
      ctx.log.info('Area 布局', `合并 ${areaId} 释放实例：${result.disposedInstances.join(', ')}`)
    }
    const remaining = session.areaIds.value[0]
    if (remaining !== undefined) session.setActive(remaining)
    return OP_RESULT.FINISHED
  },
}

export const SetAreaEditorTypeOperator: OperatorType = {
  id: 'OPERATOR_AREA_SET_EDITOR_TYPE',
  label: '切换区域类型',
  description: '把当前区域切换成另一种编辑器类型（局部状态保留，切回恢复）',

  poll(ctx) {
    return ctx.hasAreaSession()
  },

  invoke(ctx, props) {
    const session = ctx.hasAreaSession() ? ctx.requireAreaSession() : null
    if (session === null) return fail(ctx, 'setEditorType', 'no area session')
    const areaId = resolveAreaId(ctx, props)
    if (areaId === null) return fail(ctx, 'setEditorType', 'no target area')
    const editorType = props.editorType
    if (typeof editorType !== 'string' || editorType.length === 0) {
      return fail(ctx, 'setEditorType', 'missing editorType')
    }

    const result = session.setEditorType(areaId, editorType)
    if (!result.ok) return fail(ctx, 'setEditorType', result.error)
    return OP_RESULT.FINISHED
  },
}

export const SetAreaSplitRatioOperator: OperatorType = {
  id: 'OPERATOR_AREA_SET_SPLIT_RATIO',
  label: '调整区域比例',
  description: '调整某次分割两侧的尺寸比例',

  poll(ctx) {
    return ctx.hasAreaSession()
  },

  invoke(ctx, props) {
    const session = ctx.hasAreaSession() ? ctx.requireAreaSession() : null
    if (session === null) return fail(ctx, 'setSplitRatio', 'no area session')
    const splitId = props.splitId
    const ratio = props.ratio
    if (typeof splitId !== 'string' || typeof ratio !== 'number') {
      return fail(ctx, 'setSplitRatio', 'missing splitId/ratio')
    }
    const result = session.setRatio(splitId, ratio)
    if (!result.ok) return fail(ctx, 'setSplitRatio', result.error)
    return OP_RESULT.FINISHED
  },
}

export const AREA_OPERATORS: readonly OperatorType[] = Object.freeze([
  SplitAreaOperator,
  MergeAreaOperator,
  SetAreaEditorTypeOperator,
  SetAreaSplitRatioOperator,
])
