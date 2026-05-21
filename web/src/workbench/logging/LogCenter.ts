/**
 * LogCenter — 统一日志系统。
 *
 * 对标 Blender 的 ReportList + BKE_report。
 * 位掩码级别，全局单例。所有日志、状态消息、会话合并、快照/diff、状态查询均通过此入口。
 *
 * 级别: DEBUG(1) | INFO(2) | OPERATOR(4) | WARN(8) | ERROR(16)
 */

import { ref, shallowRef } from 'vue'
import type { BContext } from '@/workbench/context/bContext'

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
const sessions = new Map<string, Session>()

let _traceId: string | null = null
let _displayMessage = ''
let _displayLevel: LogLevelValue = LOG_LEVEL.INFO

// State query refs (injected by WorkbenchRoot)
let _sceneRef: (() => any) | null = null
let _selectionRef: (() => any[]) | null = null
let _toolRegistryRef: (() => {
  activeToolId: string; canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null
}) | null = null
let _gizmoPos: { x: number; y: number; z: number } | null = null
let _cameraState: { position: [number, number, number]; target: [number, number, number] } | null = null

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
    _displayMessage = message
    _displayLevel = level
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

export const logCenter = {
  entries,
  lastDisplayable,

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
    _displayMessage = ''
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

  snapshot(ctx: BContext): StateDigest {
    const id = nextId
    const blocks = ctx.queries.getFrameBlocks()
    const sel = [...ctx.selection.items.value]
    return {
      logId: id,
      blockCount: blocks.length,
      blocks: blocks.map(b => ({ pos: { ...b.pos }, id: b.block_state_id })),
      selectionSize: sel.length,
      selection: sel.map(s => ({ ...s.pos })),
      activeOperator: ctx.toolRegistry.activeTool.value?.id ?? null,
    }
  },

  diff(snap: StateDigest, ctx: BContext): StateDiff {
    const now = ctx.queries.getFrameBlocks()
    const nowSel = [...ctx.selection.items.value]
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

    diff.selectionChanged =
      snap.selectionSize !== nowSel.length ||
      !snap.selection.every((s, i) => posEq(s, nowSel[i]?.pos ?? { x: NaN, y: NaN, z: NaN }))

    return diff
  },

  /* —— Checks (AI-friendly, structured) —— */

  check: {
    selectionSize(ctx: BContext, n: number): CheckResult {
      const actual = ctx.selection.items.value.size
      return { pass: actual === n, expected: n, actual }
    },
    blockCount(ctx: BContext, n: number): CheckResult {
      const actual = ctx.queries.getFrameBlocks().length
      return { pass: actual === n, expected: n, actual }
    },
    operatorActive(ctx: BContext, id: string): CheckResult {
      const actual = ctx.toolRegistry.activeTool.value?.id ?? null
      return { pass: actual === id, expected: id, actual }
    },
    blockAt(ctx: BContext, pos: { x: number; y: number; z: number }, id?: string): CheckResult {
      const blocks = ctx.queries.getFrameBlocks()
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

  /* —— Status message —— */

  setStatus(message: string, level: LogLevelValue = LOG_LEVEL.INFO): void {
    _displayMessage = message
    _displayLevel = level
  },

  get statusMessage(): string { return _displayMessage },
  get statusLevel(): LogLevelValue { return _displayLevel },

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

/* —— Window API —— */

export function installUnifiedLogApi(bctx: BContext): void {
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
    clear: () => logCenter.clear(),
    statusMessage: () => logCenter.statusMessage,

    // Sessions
    sessionSummaries: () => logCenter.sessionSummaries(),
    isModalActive: () => (bctx as any).eventDispatcher?.modalDepth > 0,

    // Snapshot / Diff
    snapshot: () => logCenter.snapshot(bctx),
    diff: (snap: StateDigest) => logCenter.diff(snap, bctx),

    // Checks
    check: {
      selectionSize: (n: number) => logCenter.check.selectionSize(bctx, n),
      blockCount: (n: number) => logCenter.check.blockCount(bctx, n),
      blockAt: (pos: { x: number; y: number; z: number }, id?: string) => logCenter.check.blockAt(bctx, pos, id),
      operatorActive: (id: string) => logCenter.check.operatorActive(bctx, id),
    },

    // State queries
    getScene: () => logCenter.getScene(),
    getSelection: () => logCenter.getSelection(),
    getActiveTool: () => logCenter.getActiveTool(),
    getEditHistory: () => logCenter.getEditHistory(),
    getGizmoPosition: () => logCenter.getGizmoPosition(),
    getCameraState: () => logCenter.getCameraState(),

    // RNA
    getRNA: (path: string) => {
      const desc = bctx.rna.resolve(path)
      if (!desc) return null
      return { value: desc.get({}), type: desc.type, label: desc.label }
    },
    listRNA: () => (bctx.rna as any).list?.() ?? [],

    // Operators
    listOperators: () => bctx.operators.all().map((o: any) => ({ id: o.id, label: o.label })),

    // Layout queries
    boundsOfByOperator: (opId: string) => bctx.ui.boundsOfByOperator(opId),
    boundsOfByRNAPath: (rnaPath: string) => bctx.ui.boundsOfByRNAPath(rnaPath),

    // Settle
    settle: () => {
      return new Promise<void>((resolve) => {
        const ed = (bctx as any).eventDispatcher
        if (!ed || ed.modalDepth === 0) { resolve(); return }
        const check = () => {
          if (ed.modalDepth === 0) resolve()
          else requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      })
    },
  }
}

/** @deprecated 使用 installUnifiedLogApi 替代 */
export function installLogCenter(): void {
  installUnifiedLogApi({} as BContext) // bctx-less fallback — only exposes log subset
}
