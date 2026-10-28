/**
 * `adapters/recoveryStore` —— **恢复副本存储的公共出口**。
 *
 * ## 为什么需要这一层（不是"多包一层"）
 *
 * `application/recovery` 的端口实现住在 `adapters/storage/browser`（深度 3）。
 * 装配层（`composition/`）是**新实现**层，按「公共出口最大深度 2」
 * 只能从深度 ≤ 2 的模块导入 —— 与 `adapters/plainRoot`、`adapters/projectFile`
 * 完全同形的处置（闸门 `gate/no-private-cross-layer` 会判红直引）。
 *
 * ## 为什么存储表示要压缩（实测，不是"省一点"）
 *
 * 恢复副本载荷是**整份已提交内容**（场景 + 动画 + 内容三块）。真实信封夹具
 * （仓外 `structuredata/structuredata-exported-envelope.json`）装配后
 * `serializeRecoveryCopy` 的 JSON 是 **11 208 046 字符**（场景里的调色板几何与
 * 几何资产目录各存一份，共 ~10.7 MB）—— 而宿主键值存储的配额是 MB 级：
 * 原样写会**必然** `QuotaExceededError`，"刷新后副本在场"就成了空话。
 *
 * 同一份 JSON 经 gzip 是 **734 648 字节**、base64 后 979 532 字符（≈ 12:1）——
 * 三份保留共约 2.9 M 字符，落在配额内。
 *
 * ⇒ 存储表示 = `lkrc1:` + base64(gzip(utf8(json)))，MTIME 钉死（0）使同一内容
 * 压缩结果**逐字相同**（保留策略的"内容未变不重复写"据此成立）。
 * **纯层不变**：`serializeRecoveryCopy` 产出的仍是 JSON，`validateRecoveryCopy`
 * 收到的仍是 JSON —— 编解码只在存储边界。
 *
 * ## 读取必须**同时**接受两种形态（不是兼容旧版，而是判据需要）
 *
 * 没有 `lkrc1:` 前缀的值**原样**交给校验：显式注入的损坏副本就是裸 JSON/垃圾，
 * 它们必须仍被 `validateRecoveryCopy` 判成坏副本（`notJson`/`schemaVersionMismatch`…），
 * 而不是被当成"解不开的存储格式"另开一类沉默。前缀在但解不开 ⇒ 同样回退原样文本，
 * 让校验给出结构化原因。
 */

import pako from 'pako'

import { browserStoragePort, type StorageLike } from './storage/browser'
import type { RecoveryStorePort } from '@/application/recovery'

export type { StorageLike }

/** 压缩形态的存储表示前缀（**不是**键族的一部分；键仍是 `lk.recovery.v1.*`）。 */
export const RECOVERY_VALUE_PREFIX = 'lkrc1:'

/** gzip 头 MTIME 钉死（0 = 未设置；gzip 规范允许）。同一内容 ⇒ 同一字节。 */
const GZIP_MTIME_PINNED = 0

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** JSON 文本 → 存储表示（压缩 + base64；失败时抛出，由调用方按"序列化失败"上报）。 */
export function encodeRecoveryValue(json: string): string {
  const bytes = new TextEncoder().encode(json)
  const gz = pako.gzip(bytes, { header: { time: GZIP_MTIME_PINNED } } as pako.DeflateOptions)
  return RECOVERY_VALUE_PREFIX + bytesToBase64(gz)
}

/**
 * 存储表示 → JSON 文本。
 *
 * 非本编码（裸 JSON、注入的垃圾、别的实现写的值）**原样**返回；
 * 前缀在但解不开也原样返回（让 `validateRecoveryCopy` 给出结构化原因）。
 */
export function decodeRecoveryValue(stored: string): string {
  if (!stored.startsWith(RECOVERY_VALUE_PREFIX)) return stored
  try {
    return new TextDecoder().decode(pako.ungzip(base64ToBytes(stored.slice(RECOVERY_VALUE_PREFIX.length))))
  } catch {
    return stored
  }
}

export interface RecoveryStoreOptions {
  /** 注入的存储；`undefined` ⇒ 取宿主 `localStorage`；`null` ⇒ 显式"没有存储"。 */
  readonly storage?: StorageLike | null
  /** 端口身份（诊断用；多端口在场时区分）。 */
  readonly id?: string
}

/**
 * 造一个恢复副本存储端口。
 *
 * 失败路径全部走 `browserStoragePort` 的判别式（配额不足/不可用/抛错三类分开），
 * 本函数**不** catch、**不**降级成"读到空值"。
 */
export function recoveryStorePort(options: RecoveryStoreOptions = {}): RecoveryStorePort {
  return browserStoragePort({ storage: options.storage, id: options.id ?? 'recovery-local' })
}
