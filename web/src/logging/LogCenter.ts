/**
 * LogCenter — 统一日志系统。
 *
 * 对标 Blender 的 ReportList + BKE_report。
 * 位掩码级别。所有日志、状态消息、会话合并、快照/diff、状态查询均通过此入口。
 *
 * ## 实例归属（M7-6；S0-A D8/D9）
 *
 * 本模块**不再是模块级单例**：`createLogCenter()` 由**宿主**各建一份
 * （`createWorkbenchHost` / `createEmbedHost`），挂在 `Context.log` 上。
 * 消费点签名因此一个都不用改（`Context` 一直持有 `log` 构造参数）。
 *
 * 这解决了 S0-A D8 的形状：同页两个嵌入过去共用一份 `entries`/`liveStatus`，
 * 于是 A 的"纹理加载中 3/57"会出现在 B 的状态栏读面上，而 B 的一次
 * `clearLiveStatus()` 会抹掉 A 的结论 —— 典型"最后写者胜"。
 *
 * ⚠️ `window.__log__` 是**按实例登记**的（见文件末尾）：全局只有**一个**读取器，
 * 但它的缺省读面指向**第一个在册实例**，要读别的实例必须 `forInstance(id)` 指明。
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
  /**
   * **稳定诊断码**（M8-6；S0-B §4.3 第 3 条："LogCenter.Report 无稳定码"）。
   *
   * 只有由诊断面（C1）投影出来的条目才带它 —— 见 `event()`。
   * 普通日志条目保持 `undefined`：它们不是诊断，不该被按码聚合。
   */
  code?: string
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

/**
 * 实时状态槽的写入方渠道。
 *
 * `'device'`（M8-3）：设备丢失/恢复的用户可见提示（SPEC §10.7:309「失败必须说明
 * 实际后果」）。它**不**被 `clearRejectionStatus` 清、也不被纹理链的 `clearLiveStatus`
 * 之外的写点悄悄覆盖语义 —— 恢复事件之后的纹理加载会正常顶替它（资源生命周期
 * 重新开始 ⇒「正在加载」比「设备已恢复」更该显示）。
 *
 * `'recovery'`（M8-4）：恢复副本的检测/采纳/放弃/写入失败提示（SPEC §9:299）。
 * 它同样不被 `clearRejectionStatus` 清；提示的**持久化入口**在状态栏（副本候选
 * 与损坏数各有一条常驻行），liveStatus 只负责"刚刚发生了什么"的那一句 ——
 * 否则纹理链的 `loading/ready` 一写就会把"有一份可采纳副本"顶掉。
 */
export type LiveStatusOrigin = 'texture' | 'rejection' | 'device' | 'recovery' | null

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

  /**
   * Append a log entry. NOTE: also updates lastDisplayable, displayMessage/Level refs, and console in DEV.
   *
   * `code`（M8-6）：由诊断面投影来的条目带上稳定码；`takeOverDisplay=false` 时**不**更新
   * `lastDisplayable`（诊断日志不得抢占"最后一条操作反馈"的位置，见 `event()`）。
   */
  function push(
    level: LogLevelValue,
    source: string,
    message: string,
    detail?: unknown,
    options: { readonly code?: string; readonly takeOverDisplay?: boolean } = {},
  ): Report {
    const report: Report = {
      id: uid(),
      time: hhmmss(),
      level,
      source,
      message,
      detail,
      ...(options.code === undefined ? {} : { code: options.code }),
      traceId: _traceId ?? undefined,
    }

    const list = entries.value
    list.push(report)
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
    entries.value = list

    if (level !== LOG_LEVEL.DEBUG && options.takeOverDisplay !== false) {
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

    /**
     * **诊断投影条目**（M8-6）：把一条诊断记录写成带稳定码的人读日志。
     *
     * ## 为什么不是 `warn()`/`error()`
     *
     * 1. **必须带码**：`code` 是必填参数 —— 由诊断面（`wm.diagnostics`）投影来的条目
     *    才有资格进这条通道，于是"日志里有一条看起来像诊断、却无码可聚合"的形态
     *    在类型上不可表达（S0-B §4.3 第 3 条的修复落点）。
     * 2. **不抢显示位**：`lastDisplayable` 是"最后一条操作反馈"，它一旦被写过就再无
     *    代码清（`clear()` 零生产调用）。诊断条目若也写它，拖拽一次就会把操作反馈
     *    永久压在一条资源记录下面。用户可读的诊断面是底栏那个**可点开的列表**
     *    （数据源仍是 C1），不是这里。
     *
     * `source` 传**通道名**（不是模块名）：按通道检索日志时与 `byChannel` 同口径。
     */
    event(entry: {
      readonly code: string
      readonly channel: string
      readonly level: LogLevelValue
      readonly message: string
      readonly detail?: unknown
    }): Report {
      return push(entry.level, entry.channel, entry.message, entry.detail, {
        code: entry.code,
        takeOverDisplay: false,
      })
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
      // M7-6：本函数是**实例方法**（`ctx.log` 由宿主各建一份），故"谁的快照"
      // 由调用方持有的 `ctx` 决定，不需要在这里再判实例。
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

/* —— Window API：按实例登记（M7-6 / D9） —— */

/**
 * 一个实例的统一日志读面（`window.__log__` 与 `forInstance(id)` 的元素）。
 *
 * 每个方法都**闭包到本实例的 `ctx.log`**：同页两个实例各自读自己的
 * `entries`/`liveStatus`，不存在共享槽。
 */
export type UnifiedLogApi = ReturnType<typeof createUnifiedLogApi>

/** 带实例身份的统一日志读面（`__log__.instances()` 的元素）。 */
export type UnifiedLogInstance = UnifiedLogApi & { readonly instanceId: string }

interface RegisteredLog {
  readonly instanceId: string
  readonly ctx: Context
  readonly api: UnifiedLogApi
}

/**
 * **按实例登记**（照抄 `embed/embedAssemblyProbe` 的 `register`/`probes` 形态）。
 *
 * 为什么不是"每次 install 覆盖 `window.__log__`"：那正是 D9 的"最后写者胜"——
 * 同页第二个实例挂载后，e2e/诊断读到的全是**后来者**的状态。
 * 现在注册表是唯一真源，全局读取器只是它的**只读投影**：
 * 缺省读面取**第一个在册实例**（保住既有单实例页面的读数），
 * 要读某个实例必须**指明** id（`forInstance`），不存在隐式"最后一个"。
 */
const registeredLogs: RegisteredLog[] = []

function createUnifiedLogApi(ctx: Context) {
  const log = ctx.log
  return {
    // Logs
    recent: (levelMask?: number, count?: number) => log.recent(levelMask, count),
    since: (lastId: number) => {
      const all = log.recent()
      const idx = all.findIndex(e => e.id === lastId)
      const entries = idx >= 0 ? all.slice(idx + 1) : all
      return { entries, count: entries.length }
    },
    contains: (mask: number) => log.contains(mask),
    lastDisplayable: () => log.lastDisplayable.value,
    /** 实时状态读面（#399）：诊断/e2e 不解析状态栏文本即可判定加载/就绪/缺失/失败。 */
    liveStatus: () => log.liveStatus.value,
    clear: () => log.clear(),
    statusMessage: () => log.statusMessage,

    // Sessions
    sessionSummaries: () => log.sessionSummaries(),
    isModalActive: () => ctx.wm.events.modalDepth('r-viewport') > 0,

    // Snapshot / Diff
    snapshot: () => log.snapshot(ctx),
    diff: (snap: StateDigest) => log.diff(snap, ctx),

    // Checks
    check: {
      selectionSize: (n: number) => log.check.selectionSize(ctx, n),
      blockCount: (n: number) => log.check.blockCount(ctx, n),
      blockAt: (pos: { x: number; y: number; z: number }, id?: string) => log.check.blockAt(ctx, pos, id),
      operatorActive: (id: string) => log.check.operatorActive(ctx, id),
    },

    // State queries
    getScene: () => log.getScene(),
    getSelection: () => log.getSelection(),
    getActiveTool: () => log.getActiveTool(),
    getEditHistory: () => log.getEditHistory(),
    getGizmoPosition: () => log.getGizmoPosition(),
    getCameraState: () => log.getCameraState(),

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

/**
 * 把全局读取器重建成"注册表的只读投影"。
 *
 * 缺省方法投影到**第一个在册实例**（不是最后安装者）。注册表变化（挂载/卸载）
 * 时重建，于是"第一个"也随实际在册集合变化 —— 仍不会退化成最后写者胜。
 */
function publishUnifiedLogApi(): void {
  if (typeof window === 'undefined') return
  const primary = registeredLogs[0]
  if (primary === undefined) {
    delete (window as any).__log__
    return
  }
  ;(window as any).__log__ = {
    ...primary.api,
    /** 在册实例 id（顺序 = 登记顺序）。 */
    instanceIds: () => registeredLogs.map((r) => r.instanceId),
    /** 全部在册实例的读面（每个都带 `instanceId`）。 */
    instances: (): UnifiedLogInstance[] => registeredLogs.map((r) => ({ instanceId: r.instanceId, ...r.api })),
    /**
     * 指明实例的读面；不在册 ⇒ `null`（**不**回落到缺省实例 ——
     * 那会让"读错实例"与"实例已卸载"同形）。
     */
    forInstance: (instanceId: string): UnifiedLogInstance | null => {
      const found = registeredLogs.find((r) => r.instanceId === instanceId)
      return found === undefined ? null : { instanceId: found.instanceId, ...found.api }
    },
  }
}

/**
 * 登记**本实例**的统一日志读面（返回注销函数；调用方在卸载时调用）。
 *
 * 消费点（`ctx.log`）签名不变：日志实例由宿主创建、挂在 `Context.log` 上；
 * 本函数只把它投影成一个按实例登记的全局读面。
 */
export type UnifiedLogDisposer = () => void

export function installUnifiedLogApi(ctx: Context): UnifiedLogDisposer {
  if (typeof window === 'undefined') return () => {}
  const existing = registeredLogs.find((r) => r.ctx === ctx)
  if (existing !== undefined) return () => { /* 已登记：注销由首次调用方负责 */ }
  /**
   * **实例身份唯一**：同一个 `instanceId` 不允许登记两次。
   *
   * 两个不同 ctx 拿到同一个 id 只会在一种情形下发生：同页两个**工作台**
   * （工作台身份固定为 `workbench`，见 Q3 的"结构禁止"）。那时的正确处置不是
   * "后写覆盖"（D9 的老毛病），也不是"编一个 workbench#2"（伪造身份），
   * 而是**拒绝登记**：第二个实例的观测面不存在，用户拿到的是一句人话提示
   * （`workbench/singleWorkbenchNotice`）。它的 `ctx.log` 本身照常работает ——
   * 缺的只是"经 `window.__log__` 指名读它"这个跨实例观测面。
   */
  if (registeredLogs.some((r) => r.instanceId === ctx.instanceId)) {
    // M8-6：这条事实此前只有一句 `console.warn`（用户看不到、判据读不到）。
    // 它描述的是"本实例拿不到跨实例观测面"，属"命令/能力在当前状态下不可用"——
    // 用既有 `command.unsupported` 承载，关联字段带实例身份。
    ctx.wm.diagnostics.record({
      channel: 'command',
      code: 'command.unsupported',
      params: { source: 'LogCenter.installUnifiedLogApi', reason: 'instance-already-registered', instanceId: ctx.instanceId },
      correlation: {},
    })
    return () => {}
  }
  const entry: RegisteredLog = { instanceId: ctx.instanceId, ctx, api: createUnifiedLogApi(ctx) }
  registeredLogs.push(entry)
  publishUnifiedLogApi()
  return () => {
    const i = registeredLogs.indexOf(entry)
    if (i < 0) return
    registeredLogs.splice(i, 1)
    publishUnifiedLogApi()
  }
}

/** 测试/诊断：当前在册的实例 id（只读快照）。 */
export function registeredLogInstanceIds(): readonly string[] {
  return Object.freeze(registeredLogs.map((r) => r.instanceId))
}