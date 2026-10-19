/**
 * `application/exportAssetCarrier` —— **资源清单随产物同行的载体**（R3-2 ②）。
 *
 * ## 为什么在 `application/` 而不是 `adapters/host/`
 *
 * 载体形态是**政策决定**（"哪种产物用什么载体"必须只有一处口径），且本模块是
 * **纯字节函数**（无 IO/DOM/Node/外部依赖）。放在 `adapters/host/` 时
 * `runtime/exportJob.ts` 导入它属**跨层深度 3**（`gate/no-private-cross-layer`
 * 公共出口最大深度 2，实测判红）⇒ 那会逼出"为一个纯函数造一条适配器出口"的倒置。
 * 故载体口径收在这里，与 `mediaTypeOf`/`fileExtensionOf`（同在 `application/`）同层。
 *
 * ## 为什么需要这一层（不是"顺手加个字段"）
 *
 * `composition/seams.ts` 的 `export-asset-manifest-unwired` 登记的缺口是**设计缺口**：
 * 既有的两个产物信封（`domain/captureSpec.ts#SnapshotPayload`、
 * `adapters/host/buildManifest.ts#BuildManifest`）都是**刻意封闭**的 —— 前者是
 * "请求里有什么"的快照，后者是**构建期**产物清单。两者都不是"这份导出产物依赖了
 * 哪些资源"的载体，且都不该被塞进无关字段。⇒ 载体必须**新开一处**。
 *
 * ## 三条硬约束（决定了本文件的三形态分流）
 *
 *  1. **清单随产物同行**：清单必须能被产物自己携带（或与产物同事务产出），
 *     不能只活在作业返回值里等调用方"记得存"。
 *  2. **单文件下载契约不得破坏**：`image`/`animation` 的既有下载就是**那份 PNG/GIF
 *     字节本身**（`mediaTypeOf` / `fileExtensionOf` 决定扩展名与 MIME）。
 *     往字节里塞东西会改变文件、往 ZIP 里包一层会改变下载形态 ⇒ **单文件一律不碰字节**。
 *  3. **多文件场景走包内条目**：`geometry` 的产物本来就是 ZIP 容器
 *     （`application/zip`，多条目）⇒ 清单作为**包内一个条目**是真同行。
 *
 * | kind | mediaType | 载体 | 产物字节 |
 * |---|---|---|---|
 * | `project` | `application/json` | **embedded-field**（顶层加 `assetManifest`） | 字段级附加 |
 * | `geometry` | `application/zip` | **in-package-entry**（`asset-manifest.json`） | 包内多一条目 |
 * | `image`/`animation` | `image/png`/`image/gif` | **sidecar**（同事务具名伴生） | **逐字节不变** |
 *
 * ## 不静默降级
 *
 * ZIP 追加遇到**处理不了的形态**（找不着 EOCD、带 EOCD 注释、zip64）⇒ 返回
 * **结构化失败原因**并回落到 `sidecar`，`fallbackReason` 非空 ⇒ 调用方与判据都看得见
 * "这条清单没进包"。绝不假装进包了。
 *
 * ## 纯性
 *
 * 本文件不读 IO、不读墙钟、不依赖 DOM/three；ZIP 追加是**确定性纯函数**
 * （固定时间戳 1980-01-01、UTF-8 名、stored 无压缩、无 extra field）
 * ⇒ 同一输入两次调用的字节**逐位相同**（判据可断言）。
 */

import type { ExportAssetManifest } from '@/application/exportPlan'

/** 清单在产物里的**载体形态**。 */
export type ArtifactCarrier = 'embedded-field' | 'in-package-entry' | 'sidecar'

/** 包内条目名（多文件产物的载体位置）。 */
export const EXPORT_ASSET_MANIFEST_ENTRY = 'asset-manifest.json'

/** sidecar 载体的伴生文件名。 */
export const EXPORT_ASSET_MANIFEST_SIDECAR = 'asset-manifest.json'

/** JSON 产物里承载清单的顶层字段名。 */
export const EXPORT_ASSET_MANIFEST_FIELD = 'assetManifest'

/** 打好的产物：字节 + 载体说明 + 清单本体（供机械对账）。 */
export interface PackagedArtifact {
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly carrier: ArtifactCarrier
  /**
   * 清单**在产物里**的位置：
   *  - `embedded-field` ⇒ JSON 顶层字段名；
   *  - `in-package-entry` ⇒ 包内条目名；
   *  - `sidecar` ⇒ 伴生文件名。
   */
  readonly manifestLocation: string
  /** 清单字节（JSON/UTF-8；sidecar 下即伴生条目的内容）。 */
  readonly manifestBytes: Uint8Array
  /** 对账口径：产物内（或伴生）清单的规范串，**必须**等于 `manifest.canonical`。 */
  readonly canonical: string
  /** 对账口径：`manifest.digest`。 */
  readonly digest: number
  /** 载体回落原因（非空 ⇒ 请求的载体没做成，**已如实报告**）。 */
  readonly fallbackReason: string | null
}

/** 清单 → 规范 JSON 文本（LF 结尾；稳定字段顺序 ⇒ 可逐字节对账）。 */
export function manifestJsonText(manifest: ExportAssetManifest): string {
  return `${JSON.stringify(
    {
      manifestVersion: manifest.manifestVersion,
      assembled: manifest.assembled,
      reason: manifest.reason,
      digest: manifest.digest,
      canonical: manifest.canonical,
      entries: manifest.entries,
    },
    null,
    2,
  )}\n`
}

/** 清单 → UTF-8 字节。 */
export function manifestBytes(manifest: ExportAssetManifest): Uint8Array {
  return utf8Bytes(manifestJsonText(manifest))
}

/**
 * **按产物形态把清单装进产物**（②的主入口；由 `runtime/exportJob` 在完成时调用）。
 *
 * 返回值里 `bytes` 就是**最终产物字节** —— 调用方不得再拼一遍，否则载体说明会与实际不符。
 */
export function packageExportArtifact(input: {
  readonly mediaType: string
  readonly bytes: Uint8Array
  readonly manifest: ExportAssetManifest
}): PackagedArtifact {
  const manifestBytesOut = manifestBytes(input.manifest)

  if (input.mediaType === 'application/zip') {
    // 多文件 ⇒ **包内条目**（约束 3）。
    const appended = appendStoredZipEntry(input.bytes, EXPORT_ASSET_MANIFEST_ENTRY, manifestBytesOut)
    if (appended.ok) {
      return Object.freeze({
        bytes: appended.bytes,
        mediaType: input.mediaType,
        carrier: 'in-package-entry' as const,
        manifestLocation: EXPORT_ASSET_MANIFEST_ENTRY,
        manifestBytes: manifestBytesOut,
        canonical: input.manifest.canonical,
        digest: input.manifest.digest,
        fallbackReason: null,
      })
    }
    // 处理不了的 ZIP 形态 ⇒ 回落到 sidecar，并**如实报告**原因（不假装进包了）。
    return sidecar(input.bytes, input.mediaType, manifestBytesOut, input.manifest, `in-package-entry:${appended.reason}`)
  }

  if (input.mediaType === 'application/json') {
    // 本项目自有 JSON 产物 ⇒ 顶层附加字段（附加不破既有读取契约：消费者忽略未知字段）。
    const parsed = parseJsonObject(input.bytes)
    if (!parsed.ok) {
      return sidecar(input.bytes, input.mediaType, manifestBytesOut, input.manifest, `embedded-field:${parsed.reason}`)
    }
    const withManifest = { ...parsed.value, [EXPORT_ASSET_MANIFEST_FIELD]: JSON.parse(manifestJsonText(input.manifest)) }
    return Object.freeze({
      bytes: utf8Bytes(`${JSON.stringify(withManifest, null, 2)}\n`),
      mediaType: input.mediaType,
      carrier: 'embedded-field' as const,
      manifestLocation: EXPORT_ASSET_MANIFEST_FIELD,
      manifestBytes: manifestBytesOut,
      canonical: input.manifest.canonical,
      digest: input.manifest.digest,
      fallbackReason: null,
    })
  }

  // 单文件二进制（PNG/GIF/…）⇒ **逐字节不变**（约束 2），清单走同事务伴生。
  return sidecar(input.bytes, input.mediaType, manifestBytesOut, input.manifest, null)
}

function sidecar(
  bytes: Uint8Array,
  mediaType: string,
  manifestBytesOut: Uint8Array,
  manifest: ExportAssetManifest,
  fallbackReason: string | null,
): PackagedArtifact {
  return Object.freeze({
    bytes,
    mediaType,
    carrier: 'sidecar' as const,
    manifestLocation: EXPORT_ASSET_MANIFEST_SIDECAR,
    manifestBytes: manifestBytesOut,
    canonical: manifest.canonical,
    digest: manifest.digest,
    fallbackReason,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP：向既有包**追加**一个 stored 条目（无依赖）
// ─────────────────────────────────────────────────────────────────────────────

export type ZipAppendResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: string }

/**
 * 把 `data` 作为名为 `name` 的 **stored（无压缩）** 条目追加进 `zipBytes`。
 *
 * ## 布局（为什么这样追加不会动到原有条目）
 *
 * 原文件 = `[局部条目区][中央目录][EOCD]`。新文件 =
 * `[局部条目区][新局部条目][原中央目录][新中央条目][新EOCD]`。
 * 原有局部条目的**偏移不变**（它们全在插入点之前），而原中央目录里的偏移依旧有效
 * ⇒ 原条目逐字节保留，只是中央目录多了一条、EOCD 的计数/尺寸/偏移更新。
 *
 * ## 拒绝的形态（结构化失败，**不**猜）
 *
 *  - 找不到 EOCD 签名（不是 ZIP / 被截断）；
 *  - EOCD 带注释（需要重排尾部，超出本函数保证的范围）；
 *  - zip64（计数/偏移为哨兵值）—— 本函数只处理经典 ZIP；
 *  - 中央目录越界（损坏）。
 */
export function appendStoredZipEntry(zipBytes: Uint8Array, name: string, data: Uint8Array): ZipAppendResult {
  const EOCD_SIG = 0x06054b50
  const min = Math.max(0, zipBytes.length - (22 + 0xffff))
  let eocd = -1
  for (let i = zipBytes.length - 22; i >= min; i--) {
    if (readU32LE(zipBytes, i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return { ok: false, reason: 'zipEocdNotFound' }

  const commentLength = readU16LE(zipBytes, eocd + 20)
  if (commentLength !== 0) return { ok: false, reason: 'zipEocdCommentUnsupported' }
  const entryCount = readU16LE(zipBytes, eocd + 10)
  const cdSize = readU32LE(zipBytes, eocd + 12)
  const cdOffset = readU32LE(zipBytes, eocd + 16)
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ok: false, reason: 'zip64Unsupported' }
  }
  if (cdOffset + cdSize > eocd) return { ok: false, reason: 'zipCentralDirectoryOutOfRange' }
  if (entryCount === 0) return { ok: false, reason: 'zipEmptyArchive' }

  const nameBytes = utf8Bytes(name)
  if (nameBytes.length > 0xffff) return { ok: false, reason: 'zipEntryNameTooLong' }
  if (data.length > 0xffffffff) return { ok: false, reason: 'zipEntryDataTooLarge' }

  const crc = crc32(data)
  const local = new Uint8Array(30 + nameBytes.length + data.length)
  writeU32LE(local, 0, 0x04034b50)
  writeU16LE(local, 4, 20) // version needed
  writeU16LE(local, 6, 0x0800) // flags: UTF-8 名称
  writeU16LE(local, 8, 0) // method: stored
  writeU16LE(local, 10, 0) // time（固定 ⇒ 确定性）
  writeU16LE(local, 12, 0x21) // date = 1980-01-01（固定 ⇒ 确定性）
  writeU32LE(local, 14, crc)
  writeU32LE(local, 18, data.length)
  writeU32LE(local, 22, data.length)
  writeU16LE(local, 26, nameBytes.length)
  writeU16LE(local, 28, 0) // extra 长度
  local.set(nameBytes, 30)
  local.set(data, 30 + nameBytes.length)

  const cdEntry = new Uint8Array(46 + nameBytes.length)
  writeU32LE(cdEntry, 0, 0x02014b50)
  writeU16LE(cdEntry, 4, 20) // version made by
  writeU16LE(cdEntry, 6, 20) // version needed
  writeU16LE(cdEntry, 8, 0x0800)
  writeU16LE(cdEntry, 10, 0)
  writeU16LE(cdEntry, 12, 0)
  writeU16LE(cdEntry, 14, 0x21)
  writeU32LE(cdEntry, 16, crc)
  writeU32LE(cdEntry, 20, data.length)
  writeU32LE(cdEntry, 24, data.length)
  writeU16LE(cdEntry, 28, nameBytes.length)
  writeU16LE(cdEntry, 30, 0) // extra
  writeU16LE(cdEntry, 32, 0) // comment
  writeU16LE(cdEntry, 34, 0) // disk
  writeU16LE(cdEntry, 36, 0) // internal attrs
  writeU32LE(cdEntry, 38, 0) // external attrs
  writeU32LE(cdEntry, 42, cdOffset) // 新条目的局部头偏移 = 原中央目录起点
  cdEntry.set(nameBytes, 46)

  const newCdOffset = cdOffset + local.length
  const out = new Uint8Array(cdOffset + local.length + cdSize + cdEntry.length + 22)
  out.set(zipBytes.subarray(0, cdOffset), 0)
  out.set(local, cdOffset)
  out.set(zipBytes.subarray(cdOffset, cdOffset + cdSize), cdOffset + local.length)
  out.set(cdEntry, newCdOffset + cdSize)
  const eocdOut = cdOffset + local.length + cdSize + cdEntry.length
  writeU32LE(out, eocdOut, 0x06054b50)
  writeU16LE(out, eocdOut + 8, entryCount + 1)
  writeU16LE(out, eocdOut + 10, entryCount + 1)
  writeU32LE(out, eocdOut + 12, cdSize + cdEntry.length)
  writeU32LE(out, eocdOut + 16, newCdOffset)
  writeU16LE(out, eocdOut + 20, 0)

  return { ok: true, bytes: out }
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具（纯）
// ─────────────────────────────────────────────────────────────────────────────

/** CRC-32（IEEE 802.3，多字节小端，与 ZIP 条目校验口径一致）。 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function parseJsonObject(bytes: Uint8Array): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  let text: string
  try {
    text = new TextDecoder().decode(bytes)
  } catch {
    return { ok: false, reason: 'jsonDecodeFailed' }
  }
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'jsonNotObject' }
    return { ok: true, value: value as Record<string, unknown> }
  } catch {
    return { ok: false, reason: 'jsonParseFailed' }
  }
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function readU16LE(b: Uint8Array, at: number): number {
  return ((b[at]! | (b[at + 1]! << 8)) >>> 0) & 0xffff
}

function readU32LE(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
}

function writeU16LE(b: Uint8Array, at: number, value: number): void {
  b[at] = value & 0xff
  b[at + 1] = (value >>> 8) & 0xff
}

function writeU32LE(b: Uint8Array, at: number, value: number): void {
  b[at] = value & 0xff
  b[at + 1] = (value >>> 8) & 0xff
  b[at + 2] = (value >>> 16) & 0xff
  b[at + 3] = (value >>> 24) & 0xff
}
