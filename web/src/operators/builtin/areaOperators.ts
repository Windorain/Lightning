/**
 * `operators/builtin/areaOperators` —— **Area 布局编辑命令的 operator 入口**
 * （Area 产品接线；「Area 支持分割、合并、切类型、恢复」）。
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
 *  - 「Area 可分割、合并、切换类型」在产品里不可达。
 *
 * 本文件就是那个接线：把布局命令暴露成 operator（菜单可列、快捷键可绑、
 * 测试可调），并**唯一**经 `ctx.requireAreaSession()` 写入。
 *
 * ## 为什么经 operator 而不是让组件直接调 `useAreaHost`
 *
 * 三条理由，都是契约的明文要求：
 *
 * 1. **可用性判定只有一处**：`poll()` 读的是**装配结果**（该外壳是否有
 *    `layout.edit` 能力），而不是"当前宿主叫什么"。嵌入外壳没有 Area 会话
 *    ⇒ `poll()` 为假 ⇒ 菜单项灰显、快捷键不响应（不是"UI 上藏了按钮"）；
 * 2. **可被审计**：命令搜索/快捷键/菜单/测试走**同一个** operator id，
 *    于是"谁还能分割 Area"是可枚举的（输入路由的口径）；
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
import { announceRejection } from '@/runtime/rejectionNotice'
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
 * ## ⚠️ 为什么每条命令都实现 `exec`（而不是只实现 `invoke`）—— 实测修正
 *
 * `operatorRegistry` 的两条入口是**分开**的：
 *
 * | 入口 | 调用谁 | 谁在用 |
 * |---|---|---|
 * | `exec(ctx, id, props)` | **只**调 `op.exec` | 菜单、快捷键、`ctx.getOperators().exec`、测试 |
 * | `invoke(ctx, id, props, event, regionId)` | `op.invoke` → `modal` | 指针/键盘交互（模态） |
 *
 * 初版只实现 `invoke` ⇒ 菜单点击与 `exec` **静默什么都不做**（`exec` 里
 * `if (op.exec)` 为假，直接跳过，连日志都没有）。实测症状：
 * `exec('OPERATOR_AREA_SPLIT')` 返回 `undefined`、`areaIds` 仍是 `['a1']`，
 * 而**直接调 session 的同一操作**成功（`{ok:true}`、`a1→a2`）。
 *
 * 布局命令是**一次性**动作（不进入模态、不需要指针事件），故 `exec` 是正确入口；
 * `invoke` 一并提供，使菜单项与交互式调用**走同一实现**（不漂移）。
 */

/** 分割（`exec` 与 `invoke` 共用同一实现，避免两条入口行为漂移）。 */
function doSplit(ctx: Context, props: OperatorProperties): typeof OP_RESULT.FINISHED | typeof OP_RESULT.CANCELLED {
  const session = ctx.hasAreaSession() ? ctx.requireAreaSession() : null
  if (session === null) return fail(ctx, 'splitArea', 'no area session')
  const areaId = resolveAreaId(ctx, props)
  if (areaId === null) return fail(ctx, 'splitArea', 'no target area')

  const direction = resolveDirection(props)
    // 新 Area 的类型固定为 `viewport3d`：验收对象是"分割出第二个 **3D** Area"
    // （产品级判据的前提）。要分割成别的类型请用 `setEditorType` 命令。
  const result = session.split(areaId, direction, { editorType: 'viewport3d' })
  if (!result.ok) return fail(ctx, 'splitArea', result.error)

  // 新 Area 成为活动区：用户刚"分割"，下一步操作的自然对象是新视口。
  const created = session.areaIds.value
  const newest = created[created.length - 1]
  if (newest !== undefined) session.setActive(newest)
  return OP_RESULT.FINISHED
}

export const SplitAreaOperator: OperatorType = {
  id: 'OPERATOR_AREA_SPLIT',
  label: '分割区域',
  description: '把当前区域分割成两个（第二个是新的 3D 视口，机位独立）',

  /**
   * `poll` 读**装配结果**（是否有 Area 会话），不读宿主名。
   *
   * 嵌入外壳（固定布局，装配层就没有 `layout.edit`）没有 Area 会话
   * ⇒ 本命令在嵌入里**不可用**，且这是"装配的后果"而非"UI 藏了按钮"。
   */
  poll(ctx) {
    return ctx.hasAreaSession()
  },

  exec(ctx, props) {
    doSplit(ctx, props)
  },

  invoke(ctx, props) {
    return doSplit(ctx, props)
  },
}

/** 合并（`exec` 与 `invoke` 共用）。 */
function doMerge(ctx: Context, props: OperatorProperties): typeof OP_RESULT.FINISHED | typeof OP_RESULT.CANCELLED {
  const session = ctx.hasAreaSession() ? ctx.requireAreaSession() : null
  if (session === null) return fail(ctx, 'mergeArea', 'no area session')
  const areaId = resolveAreaId(ctx, props)
  if (areaId === null) return fail(ctx, 'mergeArea', 'no target area')

  const result = session.merge(areaId)
  if (!result.ok) {
    /**
     * **拒绝必须用户可见**：最后一个 Area 不可合并。
     *
     * 走已建立的**唯一拒绝写点**（`announceRejection` → `LogCenter.liveStatus`，
     * `origin: 'rejection'` ⇒ 状态栏最高优先级 + `__log__.liveStatus()` 读面）。
     * **不**用 `ctx.log.setStatus`/`entries` 老路 —— 那条路被 `lastDisplayable`
     * 永久遮蔽（已知暗坑）。
     *
     * 底栏因此显示成句原因「区域操作被拒：至少保留一个区域」，而不是
     * 只把破坏性动作报成 FINISHED。
     */
    // `LayoutCommandResult.error` 在类型上是可选的；失败时它必然在（接线层的约定）。
    // 万一缺席也不编造原因：仍然落诊断日志（`fail`），不静默。
    if (result.error !== undefined) announceRejection(ctx, result.error, 'areaLayout')
    return fail(ctx, 'mergeArea', result.error)
  }

    // 被释放的实例如实报告（「关闭 Area 释放运行资源」的可测量事实）
  if (result.disposedInstances !== undefined && result.disposedInstances.length > 0) {
    ctx.log.info('Area 布局', `合并 ${areaId} 释放实例：${result.disposedInstances.join(', ')}`)
  }
  const remaining = session.areaIds.value[0]
  if (remaining !== undefined) session.setActive(remaining)
  return OP_RESULT.FINISHED
}

export const MergeAreaOperator: OperatorType = {
  id: 'OPERATOR_AREA_MERGE',
  label: '合并区域',
  description: '关闭当前区域，其空间归还给相邻区域',

  poll(ctx) {
    return ctx.hasAreaSession()
  },

  exec(ctx, props) {
    doMerge(ctx, props)
  },

  invoke(ctx, props) {
    return doMerge(ctx, props)
  },
}

/** 切换区域编辑器类型（`exec` 与 `invoke` 共用）。 */
function doSetEditorType(ctx: Context, props: OperatorProperties): typeof OP_RESULT.FINISHED | typeof OP_RESULT.CANCELLED {
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
}

export const SetAreaEditorTypeOperator: OperatorType = {
  id: 'OPERATOR_AREA_SET_EDITOR_TYPE',
  label: '切换区域类型',
  description: '把当前区域切换成另一种编辑器类型（局部状态保留，切回恢复）',

  poll(ctx) {
    return ctx.hasAreaSession()
  },

  exec(ctx, props) {
    doSetEditorType(ctx, props)
  },

  invoke(ctx, props) {
    return doSetEditorType(ctx, props)
  },
}

/** 调整分割比例（`exec` 与 `invoke` 共用）。 */
function doSetRatio(ctx: Context, props: OperatorProperties): typeof OP_RESULT.FINISHED | typeof OP_RESULT.CANCELLED {
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
}

export const SetAreaSplitRatioOperator: OperatorType = {
  id: 'OPERATOR_AREA_SET_SPLIT_RATIO',
  label: '调整区域比例',
  description: '调整某次分割两侧的尺寸比例',

  poll(ctx) {
    return ctx.hasAreaSession()
  },

  exec(ctx, props) {
    doSetRatio(ctx, props)
  },

  invoke(ctx, props) {
    return doSetRatio(ctx, props)
  },
}

export const AREA_OPERATORS: readonly OperatorType[] = Object.freeze([
  SplitAreaOperator,
  MergeAreaOperator,
  SetAreaEditorTypeOperator,
  SetAreaSplitRatioOperator,
])
