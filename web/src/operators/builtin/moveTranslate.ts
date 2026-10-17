import * as THREE from 'three'
import type { Context } from '@/runtime/context'
import { KERNEL_CONTEXT_ID } from '@/runtime/kernelSession'
import type { OperatorType, OperatorProperties } from '@/operators/operatorType'
import type { ViewportSlot } from '@/runtime/types'
import { OP_RESULT } from '@/operators/operatorType'
import { pickVoxel } from '@/context/queries'
import { roundVector } from '@/pure/vec'
import { kernelAccepted, settlementOf } from '@/domain/editSettlement'
import { announceRejection } from '@/runtime/rejectionNotice'

const WORLD_AXES: Record<string, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}

interface ScreenProjection {
  screenDirX: number
  screenDirY: number
  k: number
}

/**
 * **事件来源 region**（M4-1 双区归属）。
 *
 * 解析顺序：调用方显式给的 `props.regionId` → 本算子被 invoke 时登记的目标区
 * （`OperatorRegistry#invoke` 写 `_regionId`）→ 当前输入区的兜底读面。
 * `null` = 没有任何区域线索（脚本直调），此时退回"活动视口"（旧行为）。
 */
function regionIdOf(ctx: Context, props: OperatorProperties): string | null {
  const explicit = props.regionId ?? props._regionId
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return ctx.resolveInputRegionId(props)
}

/**
 * 取**事件来源 region** 的视口槽位（机位/画布）。
 *
 * 旧实现一律用 `ctx.getViewport()`（= `viewports.active`），而 activeId 是"最后装配的
 * 那个视口" ⇒ 在 B 区拖 gizmo 时投影用的是 A 区的相机（拖动方向错乱）。
 * 有 region 线索就用该区槽位；没有才回落到 active。
 */
function viewportOf(ctx: Context, props: OperatorProperties): ViewportSlot {
  const rid = regionIdOf(ctx, props)
  if (rid !== null) {
    const slot = ctx.viewports.get(rid)
    if (slot) return slot
  }
  return ctx.getViewport()
}
/** Project a world-space direction vector to screen-space at the given origin point. */
function projectAxis(
  ctx: Context,
  props: OperatorProperties,
  origin: { x: number; y: number; z: number },
  dir: THREE.Vector3,
): ScreenProjection {
  const viewport = viewportOf(ctx, props)
  const camera = viewport.camera.value
  const domEl = viewport.domElement.value
  if (!camera || !domEl) return { screenDirX: 0, screenDirY: 0, k: 0 }
  const rect = domEl.getBoundingClientRect()
  const p1 = new THREE.Vector3(origin.x, origin.y, origin.z).project(camera)
  const p2 = new THREE.Vector3(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z).project(camera)
  const sx = ((p2.x - p1.x) / 2) * rect.width
  const sy = -((p2.y - p1.y) / 2) * rect.height
  const screenLen = Math.sqrt(sx * sx + sy * sy)
  if (screenLen < 0.001) return { screenDirX: 0, screenDirY: 0, k: 0 }
  return { screenDirX: sx / screenLen, screenDirY: sy / screenLen, k: 1 / screenLen }
}

/** Build the list of (worldDir, screenProjection) pairs for the current drag mode. */
function buildProjectionAxes(
  ctx: Context,
  props: OperatorProperties,
  s: MoveModalState,
): Array<{ dir: THREE.Vector3; proj: ScreenProjection }> {
  const origin = { x: s._originX, y: s._originY, z: s._originZ }

  // Axis lock overrides everything
  if (s._axisLock) {
    const dir = WORLD_AXES[s._axisLock]
    return [{ dir, proj: projectAxis(ctx, props, origin, dir) }]
  }

  // Gizmo single axis
  if (s._gizmoAxis && s._gizmoAxis.length === 1) {
    const dir = WORLD_AXES[s._gizmoAxis]
    return [{ dir, proj: { screenDirX: s._screenDirX, screenDirY: s._screenDirY, k: s._k } }]
  }

  // Gizmo plane (xy, xz, yz)
  if (s._gizmoAxis && s._gizmoAxis.length === 2) {
    return [
      { dir: WORLD_AXES[s._gizmoAxis[0]], proj: { screenDirX: s._screenDirX1, screenDirY: s._screenDirY1, k: s._k1 } },
      { dir: WORLD_AXES[s._gizmoAxis[1]], proj: { screenDirX: s._screenDirX2, screenDirY: s._screenDirY2, k: s._k2 } },
    ]
  }

  // Free move: camera right and up（机位取**事件来源 region**，见 `viewportOf`）
  const camera = viewportOf(ctx, props).camera.value
  if (!camera) return []
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
  return [
    { dir: right, proj: projectAxis(ctx, props, origin, right) },
    { dir: up, proj: projectAxis(ctx, props, origin, up) },
  ]
}

/**
 * 取本次拖动用的 gizmo。
 *
 * 优先用调用方随属性传来的实例（gizmo 自己的 `onPointerDown` 传的是**本区那一只**）；
 * 否则问工具注册表要**事件来源 region** 的 move gizmo —— 不要用"全局最后 ready 的
 * 那个"，那正是 A/B 两区共用一个 gizmo 的形态（S0 域 1 缺口 ④）。
 */
function getGizmo(ctx: Context, props: OperatorProperties): { root: THREE.Group } | null {
  const direct = (props as any).gizmo as { root: THREE.Group } | null
  if (direct) return direct
  const rid = regionIdOf(ctx, props)
  if (rid === null) return null
  return ctx.getToolRegistry().gizmoOf('move', rid) as { root: THREE.Group } | null
}

interface MoveModalState {
  _gizmoAxis: string | null
  _axisLock: string | null
  _freeMove: boolean
  _originX: number; _originY: number; _originZ: number
  _startX: number; _startY: number
  _initialPositions: Array<{ x: number; y: number; z: number }>
  _precision: boolean
  _hasMoved: boolean
  _pointerId: number
  // Single-axis params (existing)
  _screenDirX: number; _screenDirY: number; _k: number
  // Second axis params (plane drag)
  _screenDirX1: number; _screenDirY1: number; _k1: number
  _screenDirX2: number; _screenDirY2: number; _k2: number
}

function toState(props: OperatorProperties): MoveModalState {
  return props as unknown as MoveModalState
}

export const MoveOperator: OperatorType = {
  id: 'OPERATOR_MOVE',
  label: '移动',
  description: '拖拽 Gizmo 或空白区域移动选中方块，X/Y/Z 锁定轴向',

  poll(ctx) {
    // #301 P10f B′：存在性判定走 GF-15 读面。
    // ⚠️ 本文件另有一处 `grid.moveBlock(...)`（`:313`/`:330`）**本批刻意未换** ——
    // 那是**写**路径，而读面返回的投影 `Grid` 每次调用都是**新对象**
    // （实测探针：`gridOf(doc,0) !== gridOf(doc,0)`，经它写入后重新读**改动丢失**）。
    // 详见 `runtime/context.ts` 中撤回说明与 B′ 完工报。
    return ctx.hasLoadedDocument()
  },

  initModalState(): OperatorProperties {
    return {
      _gizmoAxis: null,
      _axisLock: null,
      _freeMove: false,
      _originX: 0, _originY: 0, _originZ: 0,
      _startX: 0, _startY: 0,
      _initialPositions: [],
      _precision: false,
      _hasMoved: false,
      _pointerId: -1,
      _screenDirX: 0, _screenDirY: 0, _k: 0,
      _screenDirX1: 0, _screenDirY1: 0, _k1: 0,
      _screenDirX2: 0, _screenDirY2: 0, _k2: 0,
    }
  },

  invoke(ctx, props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED

    // ---- Gizmo drag (single axis or plane) ----
    if (props.gizmoAxis) {
      const gizmo = getGizmo(ctx, props)
      if (!gizmo) return OP_RESULT.CANCELLED

      const target = event.target as HTMLElement | null
      target?.setPointerCapture(event.pointerId)

      Object.assign(props, {
        _gizmoAxis: props.gizmoAxis as string,
        _axisLock: null,
        _freeMove: false,
        _originX: gizmo.root.position.x,
        _originY: gizmo.root.position.y,
        _originZ: gizmo.root.position.z,
        _startX: event.clientX,
        _startY: event.clientY,
        _initialPositions: [...ctx.getSelection().items.value]
          .filter(e => e.kind === 'block')
          .map(e => ({ ...e.ref.pos })),
        _precision: false,
        _hasMoved: false,
        _pointerId: event.pointerId,
        // Single axis params
        _screenDirX: (props.screenDirX as number) ?? 0,
        _screenDirY: (props.screenDirY as number) ?? 0,
        _k: (props.k as number) ?? 0,
        // Plane params (second axis)
        _screenDirX1: (props.screenDirX1 as number) ?? 0,
        _screenDirY1: (props.screenDirY1 as number) ?? 0,
        _k1: (props.k1 as number) ?? 0,
        _screenDirX2: (props.screenDirX2 as number) ?? 0,
        _screenDirY2: (props.screenDirY2 as number) ?? 0,
        _k2: (props.k2 as number) ?? 0,
      })
      return OP_RESULT.RUNNING_MODAL
    }

    // ---- Non-gizmo: block pick → select ----
    ctx.getSelection().resetCycle()
    const picked = pickVoxel(ctx, event)
    if (picked) {
      if (event.shiftKey) {
        ctx.getSelection().add([picked])
      } else if (event.ctrlKey || event.metaKey) {
        ctx.getSelection().remove([picked])
      } else {
        ctx.getSelection().select(picked)
      }
      return OP_RESULT.FINISHED
    }

    // ---- Non-gizmo: empty space → free move or deselect ----
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const sel = [...ctx.getSelection().items.value].filter(e => e.kind === 'block')
      const isMoveTool = ctx.getToolRegistry().activeTool.value?.id === 'move'

      if (isMoveTool && sel.length > 0) {
        // Free move
        const gizmo = getGizmo(ctx, props)
        const target = event.target as HTMLElement | null
        target?.setPointerCapture(event.pointerId)

        Object.assign(props, {
          _gizmoAxis: null,
          _axisLock: null,
          _freeMove: true,
          _originX: gizmo?.root.position.x ?? 0,
          _originY: gizmo?.root.position.y ?? 0,
          _originZ: gizmo?.root.position.z ?? 0,
          _startX: event.clientX,
          _startY: event.clientY,
          _initialPositions: sel.map(e => ({ ...e.ref.pos })),
          _precision: false,
          _hasMoved: false,
          _pointerId: event.pointerId,
          _screenDirX: 0, _screenDirY: 0, _k: 0,
          _screenDirX1: 0, _screenDirY1: 0, _k1: 0,
          _screenDirX2: 0, _screenDirY2: 0, _k2: 0,
        })
        return OP_RESULT.RUNNING_MODAL
      }

      // Select tool or no selection: deselect-watch
      Object.assign(props, {
        _startX: event.clientX,
        _startY: event.clientY,
        _hasMoved: false,
        _pointerId: event.pointerId,
      })
      return OP_RESULT.RUNNING_MODAL
    }

    return OP_RESULT.FINISHED
  },

  modal(ctx, props, event) {
    const s = toState(props)

    // ---- Keyboard: MODAL_MAP events ----
    if ((event as any).type === 'MODAL_MAP') {
      switch ((event as any).value) {
        case 'CANCEL': return OP_RESULT.CANCELLED
        case 'CONFIRM': return OP_RESULT.FINISHED
        case 'PRECISION_TOGGLE':
          s._precision = !s._precision
          return OP_RESULT.RUNNING_MODAL
      }
      return OP_RESULT.RUNNING_MODAL
    }

    // ---- Keyboard: direct key events ----
    if (event instanceof KeyboardEvent) {
      if (event.key === 'Escape') return OP_RESULT.CANCELLED
      if (event.key === 'Enter') return OP_RESULT.FINISHED
      if (event.key === 'Shift') {
        s._precision = !s._precision
        return OP_RESULT.RUNNING_MODAL
      }
      // Axis lock
      if (event.key === 'x' || event.key === 'X' || event.key === 'y' || event.key === 'Y' || event.key === 'z' || event.key === 'Z') {
        const axis = event.key.toLowerCase()
        s._axisLock = s._axisLock === axis ? null : axis
        return OP_RESULT.RUNNING_MODAL
      }
      return OP_RESULT.RUNNING_MODAL
    }

    // ---- Free move or gizmo drag ----
    if (s._gizmoAxis || s._freeMove) {
      if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH

      const gizmo = getGizmo(ctx, props)
      if (!gizmo) return OP_RESULT.CANCELLED

      if (event.type === 'pointermove') {
        const axes = buildProjectionAxes(ctx, props, s)
        const dx = event.clientX - s._startX
        const dy = event.clientY - s._startY

        let totalDelta = new THREE.Vector3()
        for (const { dir, proj } of axes) {
          let d = dx * proj.screenDirX + dy * proj.screenDirY
          d *= proj.k
          if (s._precision) d = Math.round(d * 10) / 10
          totalDelta.addScaledVector(dir, d)
        }

        gizmo.root.position.set(
          s._originX + totalDelta.x,
          s._originY + totalDelta.y,
          s._originZ + totalDelta.z,
        )
        return OP_RESULT.RUNNING_MODAL
      }

      if (event.type === 'pointerup') {
        const origin = { x: s._originX, y: s._originY, z: s._originZ }
        const cur = gizmo.root.position
        const delta = roundVector({
          x: cur.x - origin.x,
          y: cur.y - origin.y,
          z: cur.z - origin.z,
        })

        if (delta.x !== 0 || delta.y !== 0 || delta.z !== 0) {
          // ── R1-β① C1：本处**不再是**旧数据模型的写路径 ──────────────────────
          //
          // 修前这里取具名编辑句柄 `ctx.legacyGridForEdit(frameIndex)`（旧 `Grid` 本体），
          // 把 `grid.moveBlock(from,to)` 捕获进旧撤销项的 `execute`/`undo` 闭包，
          // 并 `ctx.getEditHistory().push(...)`。那是**两条独立历史**：
          // 旧栈记一份 snapshot，内核侧另有一条 `moveCells` —— "写了撤不掉"的歧义
          //（#385 评论 6988 裁决① 点名禁止的中间态）。
          //
          // 现在：**内核命令是唯一的写者与唯一的历史**。
          //   `submitContentEdit({kind:'moveCells'})` → `KernelSession.submit`
          //   → `Editor.drain` → `reduceMoveCells` → 内核历史
          //   → `syncLegacyFromKernel` 把内核网格投影回 legacy 载体（渲染/保存读它）。
          //
          // ⚠️ 为什么**不能**用地板上的"读面"（`ctx.kernelGrid`）来写：读面每次新建
          // 不可变视图对象 ⇒ 在它上面 `moveBlock` 的改动**静默丢失**（B′ 实测的撤回
          // 理由①）。故这里的正确解法不是"换个读面"，而是**不再在载体上写** ——
          // 把"移动"表达成一条**语义命令**，由内核改它自己的内容。
          //
          // ⚠️ 多个格一次提交（`moves`）而不是逐格 submit：`reduceMoveCells` 的语义
          // 是**同时**的（先读全部源 → 再写全部目标 → 再删纯源），一次 `submit` =
          // 一个事务 = **一条**历史 ⇒ 一次撤销回到拖动前（而不是 N 次）。
          const moves = s._initialPositions.map(initPos => ({
            from: { x: initPos.x, y: initPos.y, z: initPos.z },
            to: { x: initPos.x + delta.x, y: initPos.y + delta.y, z: initPos.z + delta.z },
          }))

          const gridObjectId = ctx.kernelGridObjectId(ctx.getFrameIndex())
          if (gridObjectId !== null) {
            // M4-3 R3：取**结算**而不是布尔（布尔把 rejected 与 not-assembled 压成一个 false，
            // 于是"越界/只读/重复格被拒"与"内核没装上"在界面上同形 —— 都是拖了没反应）。
            const settlement = settlementOf(ctx.submitContentEditSettlement({
              kind: 'moveCells',
              contextId: KERNEL_CONTEXT_ID,
              objectId: gridObjectId,
              moves,
            }))
            // ⚠️ 只有内核真的受理（`applied`/`unchanged`）才动选择集。
            //
            // 修前选择集更新写在撤销项的 `execute` 里 ⇒ 它是"执行了就说成功"。
            // 而布尔形态把两种**不同**的失败压成同一个 `false`
            // （未装配 / 命令被拒：越界、重复、只读、版本冲突）—— 两者都必须**如实**表现，
            // 而不是照样把方块画到新位置（那正是 #249 §6 禁止的"假成功控件"形态）。
            if (settlement.kind === 'not-assembled') {
              announceRejection(
                ctx,
                { code: 'UnsupportedOperation', params: { reason: 'kernel-not-adopted' } },
                'move',
              )
            } else if (settlement.kind === 'rejected') {
              announceRejection(ctx, settlement.error, 'move')
            }
            if (kernelAccepted(settlement)) {
              const sel = ctx.getSelection()
              const newItems = [...sel.items.value].map(item => {
                if (item.kind !== 'block') return item
                const m = moves.find(
                  mm =>
                    mm.from.x === item.ref.pos.x &&
                    mm.from.y === item.ref.pos.y &&
                    mm.from.z === item.ref.pos.z,
                )
                return m
                  ? { ...item, ref: { ...item.ref, pos: { x: m.to.x, y: m.to.y, z: m.to.z } } }
                  : item
              })
              sel.items.value = new Set(newItems)
            }
          }
        }

        const el = event.target as HTMLElement | null
        el?.releasePointerCapture(event.pointerId)
        return OP_RESULT.FINISHED
      }

      if (event.type === 'pointercancel') return OP_RESULT.CANCELLED

      return OP_RESULT.PASS_THROUGH
    }

    // ---- Deselect-watch mode (select tool, no gizmo) ----
    if (!(event instanceof PointerEvent)) return OP_RESULT.PASS_THROUGH

    if (event.type === 'pointermove') {
      s._hasMoved = true
      return OP_RESULT.RUNNING_MODAL
    }

    if (event.type === 'pointerup' && event.button === 0) {
      const dx = event.clientX - s._startX
      const dy = event.clientY - s._startY
      if (dx * dx + dy * dy < 25) {
        ctx.getSelection().clear()
      }
      return OP_RESULT.FINISHED
    }

    if (event.type === 'pointercancel') return OP_RESULT.FINISHED

    return OP_RESULT.PASS_THROUGH
  },

  cancel(ctx, props) {
    const s = toState(props)

    if (s._gizmoAxis || s._freeMove) {
      const gizmo = getGizmo(ctx, props)
      if (gizmo) {
        gizmo.root.position.set(s._originX, s._originY, s._originZ)
      }
      if (s._pointerId >= 0) {
        const el = viewportOf(ctx, props).domElement.value
        try {
          el?.releasePointerCapture(s._pointerId)
        } catch {
          /* already released */
        }
      }
    }
  },
}
