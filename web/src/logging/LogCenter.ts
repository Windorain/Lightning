/**
 * LogCenter — 统一日志系统。
 *
 * 对标 Blender 的 ReportList + BKE_report。
 * 位掩码级别，全局单例。所有日志、状态消息、会话合并、快照/diff、状态查询均通过此入口。
 *
 * 级别: DEBUG(1) | INFO(2) | OPERATOR(4) | WARN(8) | ERROR(16)
 */

import { ref, shallowRef } from 'vue'
import type { Context } from '@/runtime/context'
import { getFrameBlocks } from '@/context/queries'
import { describeForDiagnostics, rnaCoverage } from '@/editors/workbench-rna'
import { CAPABILITY } from '@/composition/modules'

export const LOG_LEVEL = {
  DEBUG:    1,
  INFO:     2,
  OPERATOR: 4,
  WARN:     8,
  ERROR:    16,
} as const

export type LogLevelValue = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL]

export const LOG_LEVEL_LABEL: Record<LogLevelValue, string> = {
  [LOG_LEVEL.DEBUG]:    'Debug',
  [LOG_LEVEL.INFO]:     'Info',
  [LOG_LEVEL.OPERATOR]: 'Operator',
  [LOG_LEVEL.WARN]:     'Warn',
  [LOG_LEVEL.ERROR]:    'Error',
}

export interface Report {
  id: number
  time: string
  level: LogLevelValue
  source: string
  message: string
  detail?: unknown
  traceId?: string
  sessionId?: string
  sessionPhase?: 'begin' | 'end'
}

export interface Session {
  id: string
  startId: number
  level: LogLevelValue
  source: string
  summary: string
  detail?: unknown
  startTime: string
  endTime?: string
  frameCount: number
}

export interface SessionHandle {
  update(message: string, detail?: unknown): void
  end(message: string, detail?: unknown): void
}

export interface StateDigest {
  logId: number
  blockCount: number
  blocks: Array<{ pos: { x: number; y: number; z: number }; id: string }>
  selectionSize: number
  selection: Array<{ x: number; y: number; z: number }>
  activeOperator: string | null
}

export interface StateDiff {
  sinceLogId: number
  blocksAdded: Array<{ pos: { x: number; y: number; z: number }; id: string }>
  blocksRemoved: Array<{ pos: { x: number; y: number; z: number }; id: string }>
  blocksMoved: Array<{ from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; id: string }>
  selectionChanged: boolean
}

export interface CheckResult {
  pass: boolean
  expected: unknown
  actual: unknown
}

/**
 * **实时状态槽**（#399 缺陷 B）：状态栏「此刻正在发生什么」的独立读面。
 *
 * ## 为什么必须与 `lastDisplayable` / `entries` 三者分开
 *
 * | 槽 | 语义 | 本条选择 |
 * |---|---|---|
 * | `entries` | 全部日志（有界 2000 条） | **不**进：逐图进度若 push 会洪泛，并把诊断通道挤掉 |
 * | `lastDisplayable` | 最后一条非 DEBUG 日志 | **不**写：它一旦被写过就再无代码清（`clear()` 全树零调用）⇒ 状态栏恒显示「初始化视口相机 → FINISHED」，把真实进展**永久遮蔽** |
 * | `liveStatus`（本槽） | 当前生命周期的实时事实 | 单值、有界、可被写入方按需更新/清空 |
 *
 * 这正是 #399 的暗坑：既有 `setStatus()` 的 8 处调用点因上述遮蔽**永远不可见**，
 * 所以"实时状态"不能复用那条路 —— 它必须有自己的槽与自己的渲染优先级。
 *
 * ## 为什么带 `state`（机器可读标签）
 *
 * 文本是给人看的（可本地化、可变形）；判据与诊断要问"现在是不是加载中"，
 * 不能靠对文本做正则猜测，也不能靠固定延时或像素颜色（SPEC §7.4 末句）。
 * 状态标签由**写入方的事实**给出，读面（状态栏 `data-texture-state`、`__log__.liveStatus()`）
 * 直接消费它。
 */
export interface LiveStatus {
  message: string
  level: LogLevelValue
  /** 机器可读状态标签（纹理资源五态；编辑拒绝不带状态）。`null` = 只有文本、无结构状态。 */
  state: string | null
  /**
   * 写入方渠道（M4-3）。
   *
   * ## 为什么需要它（而不是靠 state 区分）
   *
   * 纹理链是**唯一**生产者时，"这条状态是不是纹理的"可以从 `state` 读出来。
   * 编辑被拒（M4-3 R2）也写这个槽，但它**没有**机器可读状态（`state: null`），
   * 于是两条链在 `state` 上无法区分。而"写成功时清掉**我自己的**拒绝文案、
   * 不动纹理结论"这件事必须有判据 —— 否则一次成功提交会把「纹理就绪 4/4」
   * 从底栏抹掉（纹理链按**内容身份**去重，不会自动重写回来）。
   *
   * `null` = 无渠道信息的其它写入方（既有调用点保持原语义）。
   */
  origin: LiveStatusOrigin
}

/** 实时状态槽的写入方渠道。 */
export type LiveStatusOrigin = 'texture' | 'rejection' | null

export function createLogCenter() {
  const MAX_ENTRIES = 2000

  let nextId = 1
  function uid(): number { return nextId++ }

  function hhmmss(): string {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  }

  function posKey(p: { x: number; y: number; z: number }): string {
    return `${p.x},${p.y},${p.z}`
  }

  function posEq(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
    return a.x === b.x && a.y === b.y && a.z === b.z
  }

  const entries = shallowRef<Report[]>([])
  const lastDisplayable = ref<Report | null>(null)
  /**
   * 实时状态（单值、有界；见 `LiveStatus` 的说明：#399 缺陷 B 的写点与读面）。
   * 独立于 `entries`/`lastDisplayable`，故不会被"最后一条日志"的永久遮蔽吞掉。
   */
  const liveStatus = ref<LiveStatus | null>(null)
  const sessions = new Map<string, Session>()

  let _traceId: string | null = null
  const _displayMessage = ref('')
  const _displayLevel = ref<LogLevelValue>(LOG_LEVEL.INFO)

  // State query refs (injected by assembly)
  let _sceneRef: (() => any) | null = null
  let _selectionRef: (() => any[]) | null = null
  let _toolRegistryRef: (() => {
    activeToolId: string; canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null
  }) | null = null
  let _gizmoPos: { x: number; y: number; z: number } | null = null
  let _cameraState: { position: [number, number, number]; target: [number, number, number] } | null = null

  /** Append a log entry. NOTE: also updates lastDisplayable, displayMessage/Level refs, and console in DEV. */
  function push(level: LogLevelValue, source: string, message: string, detail?: unknown): Report {
    const report: Report = {
      id: uid(),
      time: hhmmss(),
      level,
      source,
      message,
      detail,
      traceId: _traceId ?? undefined,
    }

    const list = entries.value
    list.push(report)
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
    entries.value = list

    if (level !== LOG_LEVEL.DEBUG) {
      lastDisplayable.value = report
      _displayMessage.value = message
      _displayLevel.value = level
    }

    if (typeof window !== 'undefined' && import.meta.env.DEV) {
      const lvlName = LOG_LEVEL_LABEL[level] ?? '?'
      const args: unknown[] = [`[${lvlName}] ${source}: ${message}`]
      if (detail !== undefined) args.push(detail)
      if (level >= LOG_LEVEL.WARN) console.warn(...args)
      else if (level === LOG_LEVEL.DEBUG) console.debug(...args)
      else console.info(...args)
    }

    return report
  }

  return {
    entries,
    lastDisplayable,
    liveStatus,

    debug(source: string, message: string, detail?: unknown): Report {
      return push(LOG_LEVEL.DEBUG, source, message, detail)
    },

    info(source: string, message: string, detail?: unknown): Report {
      return push(LOG_LEVEL.INFO, source, message, detail)
    },

    operator(source: string, message: string, detail?: unknown): Report {
      return push(LOG_LEVEL.OPERATOR, source, message, detail)
    },

    warn(source: string, message: string, detail?: unknown): Report {
      return push(LOG_LEVEL.WARN, source, message, detail)
    },

    error(source: string, message: string, detail?: unknown): Report {
      return push(LOG_LEVEL.ERROR, source, message, detail)
    },

    recent(levelMask?: number, count = 20): Report[] {
      let list = entries.value
      if (levelMask !== undefined) {
        list = list.filter(r => (r.level & levelMask) !== 0)
      }
      return list.slice(-count)
    },

    contains(levelMask: number): boolean {
      return entries.value.some(r => (r.level & levelMask) !== 0)
    },

    clear(): void {
      entries.value = []
      lastDisplayable.value = null
      liveStatus.value = null
      _displayMessage.value = ''
    },

    /* —— Trace —— */

    beginTrace(source: string, event: Event): string {
      const id = `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      _traceId = id
      this.debug(source, `trace:begin ${event.type}`, { traceId: id })
      return id
    },

    get currentTraceId(): string | null {
      return _traceId
    },

    endTrace(result: string): void {
      if (_traceId) {
        this.debug('Trace', `trace:end ${result}`, { traceId: _traceId })
        _traceId = null
      }
    },

    /* —— Session (合并连续操作为单条日志) —— */

    beginSession(source: string, message: string, detail?: unknown): SessionHandle {
      const sessionId = `sess_${uid()}`
      const r = push(LOG_LEVEL.OPERATOR, source, message, { ...(detail ?? {}), sessionId, sessionPhase: 'begin' })
      const session: Session = {
        id: sessionId,
        startId: r.id,
        level: LOG_LEVEL.OPERATOR,
        source,
        summary: message,
        detail,
        startTime: r.time,
        frameCount: 0,
      }
      sessions.set(sessionId, session)

      return {
        update(msg: string, d?: unknown) {
          session.frameCount++
          const idx = entries.value.findIndex(e => e.sessionId === sessionId && e.sessionPhase === 'begin')
          if (idx >= 0) {
            const updated = { ...entries.value[idx], message: msg, detail: d }
            entries.value = [...entries.value.slice(0, idx), updated, ...entries.value.slice(idx + 1)]
          }
          session.summary = msg
          session.detail = d
        },
        end(msg: string, d?: unknown) {
          session.endTime = hhmmss()
          session.summary = msg
          session.detail = d
          const idx = entries.value.findIndex(e => e.sessionId === sessionId)
          if (idx >= 0) {
            const merged: Report = {
              ...entries.value[idx],
              message: msg,
              detail: { ...(d as any ?? {}), frameCount: session.frameCount, duration: session.endTime },
              sessionPhase: 'end',
            }
            entries.value = [...entries.value.slice(0, idx), merged, ...entries.value.slice(idx + 1)]
          }
          sessions.set(sessionId, session)
        },
      }
    },

    sessionSummaries(): Session[] {
      return [...sessions.values()].filter(s => s.endTime != null)
    },

    /* —— Snapshot / Diff —— */

    snapshot(ctx: Context): StateDigest {
      const id = nextId
      const blocks = getFrameBlocks(ctx)
      const blockDigest = blocks.map(b => ({ pos: { ...b.pos }, id: b.block_state_id }))
      // M7-5：摘要里的「选择集 / 活动算子」两项是**工作台会话的诊断读面**
      // （选择服务与工具注册表由 `createWorkbenchHost` 的宿主依赖提供，装配声明为
      // `shell.workbench`）。没有该外壳的实例（嵌入）只报**内容块**这一项事实，
      // 而不是"假装选择为空"——后者会与"确实没选中"同形（SPEC §10.7）。
      //
      // ⚠️ 实例隔离不在这里（GE-3 / M7-6）：本文件仍是模块级单例，
      // `window.__log__` 仍只装一次。本处只做"去宿主判断"，不动实例化。
      if (!ctx.hasCapability(CAPABILITY.SHELL_WORKBENCH)) {
        return {
          logId: id,
          blockCount: blocks.length,
          blocks: blockDigest,
          selectionSize: 0,
          selection: [],
          activeOperator: null,
        }
      }
      const sel = [...ctx.getSelection().items.value].filter(e => e.kind === 'block')
      return {
        logId: id,
        blockCount: blocks.length,
        blocks: blockDigest,
        selectionSize: sel.length,
        selection: sel.map(s => ({ ...s.ref.pos })),
        activeOperator: ctx.getToolRegistry().activeTool.value?.id ?? null,
      }
    },

    diff(snap: StateDigest, ctx: Context): StateDiff {
      const now = getFrameBlocks(ctx)
      const diff: StateDiff = {
        sinceLogId: snap.logId,
        blocksAdded: [],
        blocksRemoved: [],
        blocksMoved: [],
        selectionChanged: false,
      }

      const oldMap = new Map(snap.blocks.map(b => [posKey(b.pos), b]))
      const newMap = new Map(now.map(b => [posKey(b.pos), { pos: { ...b.pos }, id: b.block_state_id }]))

      for (const [key, b] of newMap) {
        if (!oldMap.has(key)) diff.blocksAdded.push(b)
      }
      for (const [key, b] of oldMap) {
        if (!newMap.has(key)) diff.blocksRemoved.push(b)
      }

      if (ctx.hasCapability(CAPABILITY.SHELL_WORKBENCH)) {
        const nowSel = [...ctx.getSelection().items.value].filter(e => e.kind === 'block')
        diff.selectionChanged =
          snap.selectionSize !== nowSel.length ||
          !snap.selection.every((s, i) => posEq(s, nowSel[i]?.ref.pos ?? { x: NaN, y: NaN, z: NaN }))
      }

      return diff
    },

    /* —— Checks (AI-friendly, structured) —— */

    check: {
      selectionSize(ctx: Context, n: number): CheckResult {
        const actual = ctx.getSelection().items.value.size
        return { pass: actual === n, expected: n, actual }
      },
      blockCount(ctx: Context, n: number): CheckResult {
        const actual = getFrameBlocks(ctx).length
        return { pass: actual === n, expected: n, actual }
      },
      operatorActive(ctx: Context, id: string): CheckResult {
        const actual = ctx.getToolRegistry().activeTool.value?.id ?? null
        return { pass: actual === id, expected: id, actual }
      },
      blockAt(ctx: Context, pos: { x: number; y: number; z: number }, id?: string): CheckResult {
        const blocks = getFrameBlocks(ctx)
        const found = blocks.find(
          b => b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z &&
            (id === undefined || b.block_state_id === id),
        )
        return {
          pass: !!found,
          expected: `block at (${pos.x},${pos.y},${pos.z}) id=${id ?? 'any'}`,
          actual: found ? `found id=${found.block_state_id}` : 'not found',
        }
      },
    } as const,

    /* —— Live status（实时状态槽，#399 缺陷 B） —— */

    /**
     * 写实时状态（**不**进 `entries`、**不**写 `lastDisplayable`）。
     *
     * ## 为什么在入口去重
     *
     * 写点位于**每帧**调用的链上（`useViewportRuntime#syncPresenterTextures`）与
     * 逐图结算回调里：同值重复写会让状态栏每帧触发一次渲染。去重放在**唯一入口**
     * 比让每个调用方各自记"上一条是什么"更可靠（后者漏一处就是每帧重渲染）。
     *
     * @param state 机器可读状态标签（如 `'loading'`/`'ready'`/`'missing'`/`'failed'`）；
     *              读面据此判定，不解析文本（SPEC §7.4）。
     * @param origin 写入方渠道（M4-3：纹理五态 / 编辑拒绝）。缺省 `null` = 未声明渠道。
     */
    setLiveStatus(
      message: string,
      level: LogLevelValue = LOG_LEVEL.INFO,
      state: string | null = null,
      origin: LiveStatusOrigin = null,
    ): void {
      const cur = liveStatus.value
      if (cur !== null && cur.message === message && cur.level === level && cur.state === state && cur.origin === origin) return
      liveStatus.value = { message, level, state, origin }
    },

    /** 清空实时状态（文档关闭 / 视口卸载 / 无资源可报时）。 */
    clearLiveStatus(): void {
      if (liveStatus.value !== null) liveStatus.value = null
    },

    /**
     * 只清**编辑拒绝**写下的实时状态（M4-3 R2）。
     *
     * ## 为什么不是 `clearLiveStatus`
     *
     * 纹理链按**内容身份**去重（`useViewportRuntime#syncPresenterTextures`）——
     * 资源表没变就不会重写状态。若一次成功提交把槽整个清空，「纹理就绪 4/4」
     * 就永久消失，直到下一次资源身份变化（那是**回退**，不是清理）。
     * 故清空必须**按渠道**：只处理自己写下的那一条。
     */
    clearRejectionStatus(): void {
      const cur = liveStatus.value
      if (cur !== null && cur.origin === 'rejection') liveStatus.value = null
    },

    /* —— Status message —— */

    setStatus(message: string, level: LogLevelValue = LOG_LEVEL.INFO): void {
      _displayMessage.value = message
      _displayLevel.value = level
    },

    get statusMessage(): string { return _displayMessage.value },
    get statusLevel(): LogLevelValue { return _displayLevel.value },

    /* —— State refs (formerly debugLog) —— */

    injectStateRefs(refs: {
      scene: () => any
      selection: () => any[]
      toolRegistry: () => {
        activeToolId: string; canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null
      }
    }): void {
      _sceneRef = refs.scene
      _selectionRef = refs.selection
      _toolRegistryRef = refs.toolRegistry
    },

    updateGizmoState(pos: { x: number; y: number; z: number } | null): void {
      _gizmoPos = pos
    },

    updateCameraState(state: { position: [number, number, number]; target: [number, number, number] } | null): void {
      _cameraState = state
    },

    /* —— State queries (formerly window.__wb_debug__) —— */

    getScene(): any { return _sceneRef?.() ?? null },
    getSelection(): any[] { return _selectionRef?.() ?? [] },
    getActiveTool(): string { return _toolRegistryRef?.().activeToolId ?? 'none' },
    getEditHistory(): { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null } {
      const r = _toolRegistryRef?.()
      return r
        ? { canUndo: r.canUndo, canRedo: r.canRedo, undoLabel: r.undoLabel, redoLabel: r.redoLabel }
        : { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }
    },
    getGizmoPosition(): { x: number; y: number; z: number } | null { return _gizmoPos },
    getCameraState(): { position: [number, number, number]; target: [number, number, number] } | null {
      return _cameraState
    },
  }
}

/** Default singleton instance — shared across production code. Tests can call `createLogCenter()` for a fresh instance. */
export const logCenter = createLogCenter()

/* —— Window API —— */

export function installUnifiedLogApi(ctx: Context): void {
  if (typeof window === 'undefined') return
  ;(window as any).__log__ = {
    // Logs
    recent: (levelMask?: number, count?: number) => logCenter.recent(levelMask, count),
    since: (lastId: number) => {
      const all = logCenter.recent()
      const idx = all.findIndex(e => e.id === lastId)
      const entries = idx >= 0 ? all.slice(idx + 1) : all
      return { entries, count: entries.length }
    },
    contains: (mask: number) => logCenter.contains(mask),
    lastDisplayable: () => logCenter.lastDisplayable.value,
    /** 实时状态读面（#399）：诊断/e2e 不解析状态栏文本即可判定加载/就绪/缺失/失败。 */
    liveStatus: () => logCenter.liveStatus.value,
    clear: () => logCenter.clear(),
    statusMessage: () => logCenter.statusMessage,

    // Sessions
    sessionSummaries: () => logCenter.sessionSummaries(),
    isModalActive: () => ctx.wm.events.modalDepth('r-viewport') > 0,

    // Snapshot / Diff
    snapshot: () => logCenter.snapshot(ctx),
    diff: (snap: StateDigest) => logCenter.diff(snap, ctx),

    // Checks
    check: {
      selectionSize: (n: number) => logCenter.check.selectionSize(ctx, n),
      blockCount: (n: number) => logCenter.check.blockCount(ctx, n),
      blockAt: (pos: { x: number; y: number; z: number }, id?: string) => logCenter.check.blockAt(ctx, pos, id),
      operatorActive: (id: string) => logCenter.check.operatorActive(ctx, id),
    },

    // State queries
    getScene: () => logCenter.getScene(),
    getSelection: () => logCenter.getSelection(),
    getActiveTool: () => logCenter.getActiveTool(),
    getEditHistory: () => logCenter.getEditHistory(),
    getGizmoPosition: () => logCenter.getGizmoPosition(),
    getCameraState: () => logCenter.getCameraState(),

    // RNA（#253 P2）
    //
    // 旧的这一对是**失真的观测面**（#251 B7 的 E-9）：
    //  - `getRNA` 调 `desc.get({})` —— 传空对象当 owner，对任何真实属性都取不到值；
    //  - `listRNA` 调 `registry.list?.()`，而 registry **没有** `list`，故**恒返回 `[]`**。
    //    自动化验收拿到一个假空集，还以为「没有属性」。
    //
    // 新实现直接问 RNA 覆盖度与逐属性诊断面（`describeForDiagnostics`），
    // 于是「有多少属性、哪些没有布局位置、此刻为何只读」都是**真事实**。
    getRNA: (propertyId: string) => {
      const d = describeForDiagnostics(ctx, propertyId)
      if (!d) return null
      return {
        value: d.value,
        type: d.valueType,
        label: propertyId,
        readOnlyReason: d.liveReadOnlyReason,
        mixed: d.mixed,
        targets: d.targets,
      }
    },
    listRNA: () => rnaCoverage().map((c) => ({ path: c.propertyId, objectType: c.objectTypeId, inLayout: c.inLayout })),

    // Operators
    listOperators: () => ctx.getOperators().all().map((o: any) => ({ id: o.id, label: o.label })),

    // Layout queries
    boundsOfByOperator: (opId: string) => ctx.getUi().boundsOfByOperator(opId),
    boundsOfByRNAPath: (rnaPath: string) => ctx.getUi().boundsOfByRNAPath(rnaPath),

    // Settle
    settle: () => {
      return new Promise<void>((resolve) => {
        const ed = ctx.wm.events
        if (!ed || ed.modalDepth('r-viewport') === 0) { resolve(); return }
        const check = () => {
          if (ed.modalDepth('r-viewport') === 0) resolve()
          else requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      })
    },
  }
}
