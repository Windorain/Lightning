/**
 * LogCenter — 对标 Blender 的 ReportList + BKE_report。
 *
 * 位掩码级别，全局单例，统一所有日志入口。
 * - StatusBar 消费最近一条 warn/error
 * - window.__log__ 暴露给 AI (browser-test-loop)
 * - debug-eval "getLogs()" 查询结构化日志
 *
 * 级别: DEBUG(1) | INFO(2) | OPERATOR(4) | WARN(8) | ERROR(16)
 */

import { ref, shallowRef } from 'vue'

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
  id: number           // 全局自增 ID (对标 session_uid)
  time: string         // HH:MM:SS
  level: LogLevelValue
  source: string       // 模块名 (如 "sceneContext", "formatDispatcher")
  message: string      // 人类可读
  detail?: unknown     // 结构化附加上下文 (AI 可解析)
}

const MAX_ENTRIES = 2000

let nextId = 1
function uid(): number { return nextId++ }

function hhmmss(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
}

const entries = shallowRef<Report[]>([])
const lastDisplayable = ref<Report | null>(null)

function push(level: LogLevelValue, source: string, message: string, detail?: unknown): Report {
  const report: Report = {
    id: uid(),
    time: hhmmss(),
    level,
    source,
    message,
    detail,
  }

  const list = entries.value
  list.push(report)
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
  entries.value = list

  // lastDisplayable: 最近一条非 DEBUG
  if (level !== LOG_LEVEL.DEBUG) {
    lastDisplayable.value = report
  }

  // Console 输出
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

  /** 查询最近 N 条 (AI 友好) */
  recent(levelMask?: number, count = 20): Report[] {
    let list = entries.value
    if (levelMask !== undefined) {
      list = list.filter(r => (r.level & levelMask) !== 0)
    }
    return list.slice(-count)
  },

  /** 是否包含某级别 */
  contains(levelMask: number): boolean {
    return entries.value.some(r => (r.level & levelMask) !== 0)
  },

  clear(): void {
    entries.value = []
    lastDisplayable.value = null
  },
}

// 暴露到 window 供 SDD / browser-test-loop 查询
export function installLogCenter(): void {
  if (typeof window === 'undefined') return
  ;(window as any).__log__ = {
    recent: (levelMask?: number, count?: number) => logCenter.recent(levelMask, count),
    contains: (mask: number) => logCenter.contains(mask),
    lastDisplayable: () => logCenter.lastDisplayable.value,
    clear: () => logCenter.clear(),
  }
}
