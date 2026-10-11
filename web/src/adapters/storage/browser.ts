/**
 * `adapters/storageBrowser` —— **恢复副本存储的浏览器实现**（`localStorage` 包装；
 * #249 §4 规则 4 + §19.5；#260 A31）。
 *
 * ## 它替代什么旧机制
 *
 * | 旧写法 | 位置 | 问题 | 本实现 |
 * |---|---|---|---|
 * | 存储写入的异常被**空 catch 吞掉** | `viewer/preferences.ts` | 配额不足/隐私模式被吞，调用方拿到的是"没报错" | {@link browserStoragePort} 把每一次访问的结果翻成判别式：`QuotaExceededError` ⇒ `quotaExceeded`，SecurityError ⇒ `unavailable('security')`，其余 ⇒ `failed(code)` |
 * | `typeof localStorage === 'undefined' ? null : localStorage.getItem(k)` | `runtime/shellSettings.ts` | "没有 localStorage" 与 "值不存在"都变成 `null` | `noStorage` 是**显式**的 `unavailable` 分支；`value: null` 只表示键不存在 |
 * | 裸 `localStorage.getItem(...)` + `JSON.parse` 无 try | `keymap/index.ts` | 存储里的坏 JSON 直接抛到调用栈上层 | 取值与解析**分开**：`get` 只回原始文本；解析与校验在 `application/recovery` 的 `validateRecoveryCopy`（`notJson` 是一个结构化的拒绝原因） |
 *
 * ## 两条设计纪律
 *
 * ### 1. 逻辑放在**注入的对象**上，不直接摸全局
 *
 * `Storage` 由参数传入（`storage?: StorageLike | null`）。于是：
 *  - vitest 里可以传一个**假的** `Storage` 对象（不需要 jsdom 真环境）——
 *    这也是 A31 存储失败用例的驱动方式；
 *  - 本文件的 `localStorage` 只在**默认取值**那**一处**出现（薄适配），
 *    其余逻辑对注入对象生效。
 *
 * ### 2. 失败**只能**以判别式出现
 *
 * 每个方法的 `try/catch` 都**必须**返回 `StorageFailure` 的某个分支；
 * 不存在"catch 之后返回空串/返回成功"的路径。这正是 #249 §19.5
 * 「不能 catch 后宣称恢复可用」在代码上的可检查形态。
 */

import type {
  RecoveryStorePort,
  StorageAck,
  StorageFailure,
  StorageKeysRead,
  StorageRead,
  StorageUnavailableReason,
} from '@/application/recovery'

/**
 * 与 `lib.dom` 的 `Storage` 结构兼容的**最小**面。
 *
 * 只声明本适配器真正用到的四个成员：`Storage` 上还有 `clear()` 等方法，
 * 把它们写进来只会让"假 Storage"夹具被迫实现无关方法。
 */
export interface StorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 取默认的浏览器存储（不存在则 `null`；**不**抛）。 */
function defaultStorage(): StorageLike | null {
  // 唯一的全局访问点：类型上按 `StorageLike` 收窄，避免把 `localStorage`
  // 的类型签进本模块的其余函数（那里只认注入对象）。
  const g = globalThis as unknown as { localStorage?: StorageLike | null }
  return g.localStorage ?? null
}

/** 从异常里取稳定诊断码（**不**吞：没有名称就用构造名）。 */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') return name
  }
  return 'UnknownError'
}

/**
 * 把浏览器异常**分类**（判别式，不是布尔）。
 *
 * - `QuotaExceededError` / `NS_ERROR_DOM_QUOTA_REACHED`（Firefox）⇒ `quotaExceeded`：
 *   用户**可以**通过清理空间或降低保留数量让它过去，故必须与"环境不支持"分开；
 * - `SecurityError` ⇒ `unavailable('security')`：隐私模式/被策略禁用，重试无意义；
 * - 其余 ⇒ `failed(code)`：保留稳定码供诊断关联（#249 §19.9）。
 */
function classify(error: unknown): StorageFailure {
  const code = codeOf(error)
  if (code === 'QuotaExceededError' || code === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return Object.freeze({ status: 'quotaExceeded', detail: code })
  }
  if (code === 'SecurityError') {
    return Object.freeze({ status: 'unavailable', reason: 'security' })
  }
  return Object.freeze({ status: 'failed', code, detail: 'storage operation threw' })
}

export interface BrowserStorageOptions {
  /** 注入的存储；`undefined` ⇒ 取 `globalThis.localStorage`；`null` ⇒ 显式"没有存储"。 */
  readonly storage?: StorageLike | null
  /** 端口身份（诊断用；多端口（含内存端口）在场时用于区分）。 */
  readonly id?: string
}

/**
 * 造一个浏览器存储端口。
 *
 * 所有方法的失败路径都经 {@link classify}，即所有平台差异
 * （Chrome 的 `QuotaExceededError`、Firefox 的 `NS_ERROR_DOM_QUOTA_REACHED`、
 * 隐私模式的 `SecurityError`）在**一处**被翻译成同一组判别式。
 */
export function browserStoragePort(options: BrowserStorageOptions = {}): RecoveryStorePort {
  const resolve = (): StorageLike | null => (options.storage === undefined ? defaultStorage() : options.storage)
  const id = options.id ?? 'browser'

  /** 存储缺失 ⇒ 显式 `unavailable`（**不**退化成"读到空值"）。 */
  const missing = (): StorageFailure => Object.freeze({ status: 'unavailable', reason: 'noStorage' satisfies StorageUnavailableReason })

  return {
    id,

    get(key: string): StorageRead {
      const storage = resolve()
      if (storage === null) return missing()
      try {
        const raw = storage.getItem(key)
        return Object.freeze({ status: 'ok', value: raw === undefined ? null : raw })
      } catch (e) {
        return classify(e)
      }
    },

    set(key: string, value: string): StorageAck {
      const storage = resolve()
      if (storage === null) return missing()
      try {
        storage.setItem(key, value)
        return Object.freeze({ status: 'ok' })
      } catch (e) {
        return classify(e)
      }
    },

    remove(key: string): StorageAck {
      const storage = resolve()
      if (storage === null) return missing()
      try {
        storage.removeItem(key)
        return Object.freeze({ status: 'ok' })
      } catch (e) {
        return classify(e)
      }
    },

    keys(): StorageKeysRead {
      const storage = resolve()
      if (storage === null) return missing()
      try {
        const out: string[] = []
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i)
          if (k !== null) out.push(k)
        }
        // 排序：让"哪一份副本"在多标签对账里可复现（`Storage` 的枚举顺序无契约保证）。
        return Object.freeze({ status: 'ok', value: Object.freeze(out.sort()) })
      } catch (e) {
        return classify(e)
      }
    },
  }
}

/**
 * 由普通对象造一个 `StorageLike`（**测试夹具 / 宿主替身**）。
 *
 * 为什么放在适配器而不是测试里：`keys()` 的枚举契约（`length` + `key(i)` 的一致性）
 * 是**实现**必须满足的前置条件，把它做成一个具名构造子，
 * 才能让"假 Storage 与真 Storage 行为一致"成为可复用的前提而不是各测试各写一遍。
 */
export function storageLikeFromRecord(record: Record<string, string>): StorageLike {
  const map = new Map<string, string>(Object.entries(record))
  return {
    get length() {
      return map.size
    },
    key(index: number): string | null {
      return [...map.keys()][index] ?? null
    },
    getItem(key: string): string | null {
      return map.has(key) ? map.get(key)! : null
    },
    setItem(key: string, value: string): void {
      map.set(key, value)
    },
    removeItem(key: string): void {
      map.delete(key)
    },
  }
}
