/**
 * 资源**内容身份**（#249 §19.3「资源引用包含稳定资源 ID 和内容版本/哈希，URL 仅为获取位置」；
 * 契约 §4「资源 URL 仅为获取位置，缓存必须按内容身份/版本而非 URL」）。
 *
 * ## 为什么身份与获取位置必须分开
 *
 * 按 URL 缓存有两个无法局部修复的后果：
 *  1. 同一张图换 URL（CDN 轮换、Wiki 附件重传）⇒ 缓存未命中，白下载一份新纹理；
 *  2. 同一 URL 换了内容（覆盖上传）⇒ 缓存命中，**永远显示旧图**。
 *
 * A28 的负对照原文就是「按 URL 而不按内容版本缓存」，A36 要求"版本替换"可判定。
 *
 * ## 纯数据纪律
 *
 * 本模块不含 three、不含 DOM、不含 I/O —— 身份判定与哈希必须能在
 * 无 GPU、无浏览器环境下断言（A36 的判据面，也是 A02 同族的纯性纪律）。
 */

/** 稳定资源 ID（跨保存/重开不变；不是 URL、不是文件路径）。 */
export type AssetId = string

/**
 * 内容版本：同一 `AssetId` 下内容变化的标识。
 *
 * 约定（冻结口径）：由内容字节派生（哈希），或由后端给出的修订号提供。
 * **不得**用「获取顺序计数器」或「时间戳」代替 —— 那会让"内容没变"与"内容变了"
 * 不可区分，于是"替换资源时旧请求晚到"（A28）无法判定。
 */
export type ContentVersion = string

export type ContentIdentity = Readonly<{
  /** 稳定资源 ID（缓存键的**身份**部分）。 */
  id: AssetId
  /** 内容版本/哈希（缓存键的**版本**部分）。 */
  version: ContentVersion
}>

/** 内容身份 → 缓存键（扁平字符串；便于诊断按任一维度分组，契约 §4 选择理由）。 */
export function contentIdentityKey(identity: ContentIdentity): string {
  return `${identity.id}@${identity.version}`
}

export function contentIdentityEquals(a: ContentIdentity, b: ContentIdentity): boolean {
  return a.id === b.id && a.version === b.version
}

/**
 * 资源**获取位置**。刻意不参与身份判定。
 *
 * `kind` 区分获取通道（宿主打包资源 / 外部 URL / 内嵌数据），因为 #249 §19.6 要求
 * 「本地打包资源与外部资源获取按宿主端口能力区分」—— 同一份内容经不同通道取到，
 * 身份仍相同。
 */
export type AssetLocator = Readonly<{
  kind: 'bundled' | 'external' | 'inline'
  url: string
}>

export type AssetRequest = Readonly<{
  identity: ContentIdentity
  locator: AssetLocator
  /** 必需资源未就绪不得冒充完整（G4 / A36）；可选资源缺失只降级不阻断。 */
  required: boolean
}>

/**
 * 内容字节 → 内容版本（FNV-1a 32bit）。
 *
 * 只用于**没有后端修订号**的内嵌资源（如 `textureBlobs`）。外部资源应优先使用服务端
 * 给出的修订号（如 Wiki `revid`）—— 那才是"同一 URL 换内容"的可靠信号。
 * 长度一并纳入，使"截断到同一哈希前缀"不可能被误判为同一版本。
 */
export function contentVersionOfBytes(bytes: Uint8Array | string): ContentVersion {
  const data = typeof bytes === 'string' ? textToBytes(bytes) : bytes
  let hash = 0x811c9dc5
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i]!
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}:${data.length}`
}

function textToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/** 从身份构造一条请求（便捷；`locator` 不参与身份判定）。 */
export function assetRequest(
  identity: ContentIdentity,
  locator: AssetLocator,
  required: boolean,
): AssetRequest {
  return { identity, locator, required }
}

/** 请求的稳定排序（诊断与对账可复现）。 */
export function sortAssetRequests(requests: readonly AssetRequest[]): readonly AssetRequest[] {
  return [...requests].sort((a, b) =>
    contentIdentityKey(a.identity).localeCompare(contentIdentityKey(b.identity)),
  )
}
