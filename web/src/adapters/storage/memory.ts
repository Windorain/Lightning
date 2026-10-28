/**
 * `adapters/storageMemory` —— **恢复副本存储的内存实现**（存储端口实现）。
 *
 * ## 它实现什么
 *
 * `application/recovery` 的 {@link RecoveryStorePort}（端口定义在纯层，实现在这里，
 * 于是两侧都只依赖契约 —— 详见该文件"与适配器的分工"）。
 *
 * ## 为什么内存实现也要支持**注入故障**
 *
 * 判据里有一条是「**存储失败、配额不足和不可用必须可见**」，
 * 且必须配**负对照**（「负对照必须证明确实破坏了目标保证」）。
 * 若内存实现永远成功，那么"失败可见"就只能靠 mock 库去伪造一个抛异常的
 * `localStorage` —— 而 mock 出来的形态与真实实现的形态**不必相同**，
 * 于是"测过的失败路径"与"生产会走的失败路径"是两条路。
 *
 * ⇒ 本实现把三类故障做成一等输入（`failOn`），使同一段生产代码路径
 * （`writeRecoveryCopy` → 端口 → 判别式）在成功与三类失败下都被真的走一遍。
 * 同时它**不含**任何"catch 后返回成功"的路径：故障注入点就是 `set` 的返回值本身，
 * 没有异常可以吞。
 *
 * ## 它同时是一个**可读回的**存储
 *
 * `keys()` 返回全部键（含正式保存键），便于测试断言"恢复副本键与正式保存键确实不同
 * 且各自能解析回去"。真实浏览器实现的 `keys()` 走 `Storage.key(i)`，语义相同。
 */

import type {
  RecoveryStorePort,
  StorageAck,
  StorageFailure,
  StorageKeysRead,
  StorageRead,
  StorageUnavailableReason,
} from '@/application/recovery'

/** 可注入的故障（按**键**选择；`'*'` 表示所有键）。 */
export interface InjectedStorageFailure {
  /** 命中的键；`'*'` = 任意键。 */
  readonly key: string
  /** 该键上的失败形态。 */
  readonly failure: StorageFailure
}

export interface MemoryStorageOptions {
  /** 初值（用于"上一个标签页留下的内容"这类夹具）。 */
  readonly initial?: Readonly<Record<string, string>>;
  /**
   * 注入故障表（按顺序取第一条命中的）。
   *
   * 故意**不是**一个 `throwOnSet: boolean`：配额不足与不可用是**不同**的失败，
   * 而判据要求两者都可区分地对用户可见。
   */
  readonly failures?: readonly InjectedStorageFailure[]
  /** 某键是否"不可用" —— 与故障注入正交：不可用是**能力**缺失，不是一次写失败。 */
  readonly blockedKeys?: readonly string[]
}

/**
 * 内存存储端口。
 *
 * 全部方法同步返回判别式；**没有**任何 `try/catch`（因此没有"吞掉异常"的可能）。
 */
export function createMemoryStoragePort(options: MemoryStorageOptions = {}): RecoveryStorePort {
  const map = new Map<string, string>(Object.entries(options.initial ?? {}))
  const failures = options.failures ?? []
  const blocked = new Set(options.blockedKeys ?? [])

  const failureFor = (key: string): StorageFailure | null => {
    if (blocked.has(key) || blocked.has('*')) {
      return Object.freeze({ status: 'unavailable', reason: 'blocked' })
    }
    for (const f of failures) {
      if (f.key === key || f.key === '*') return f.failure
    }
    return null
  }

  return {
    id: 'memory',

    get(key: string): StorageRead {
      const failure = failureFor(key)
      if (failure) return failure
      // `null` 的唯一含义：键不存在（与失败分支不兼表）。
      return Object.freeze({ status: 'ok', value: map.has(key) ? map.get(key)! : null })
    },

    set(key: string, value: string): StorageAck {
      const failure = failureFor(key)
      if (failure) return failure
      map.set(key, value)
      return Object.freeze({ status: 'ok' })
    },

    remove(key: string): StorageAck {
      const failure = failureFor(key)
      if (failure) return failure
      map.delete(key)
      return Object.freeze({ status: 'ok' })
    },

    keys(): StorageKeysRead {
      const failure = failureFor('*')
      if (failure) return failure
      return Object.freeze({ status: 'ok', value: Object.freeze([...map.keys()].sort()) })
    },
  }
}

/** 造一条"配额不足"注入项（判据用的标准形态）。 */
export function quotaFailureOn(key: string, detail = 'injected quota'): InjectedStorageFailure {
  return Object.freeze({ key, failure: Object.freeze({ status: 'quotaExceeded', detail }) })
}

/** 造一条"不可用"注入项。 */
export function unavailableFailureOn(key: string, reason: StorageUnavailableReason = 'noStorage'): InjectedStorageFailure {
  return Object.freeze({ key, failure: Object.freeze({ status: 'unavailable', reason }) })
}
