/**
 * `adapters/plainRoot` —— **取"解析器看到的 plain 形状"**。
 *
 * ## 为什么它在 `adapters/` 而不在 `composition/`
 *
 * 本函数的职责是**解释输入**：把"调用方拿到的解析输入"（信封或裸明文）
 * 变成"无损的 plain 根"。这是**编解码/适配**职责，不是装配职责 ——
 * 与 `adapters/files/envelopeCodec`（信封保真编解码）同层同性质。
 *
 * 第一版把它放在 `composition/documentLoad.ts`，被架构闸门的
 * `gate/no-private-cross-layer` 当场判红：`composition/` 是**新实现**层，
 * 跨层导入 `adapters/files/envelopeCodec`（深度 3）会被拦（公共出口最大深度 2）。
 * 判红是对的 —— 它暴露了"我把编解码判据放进了装配层"这个分层错误。
 *
 * 现在：本文件与 `adapters/files/*` **同层**（同层导入不受跨层规则约束），
 * 而 `composition/` 从本文件（深度 2）导入 —— 符合公共出口约定。
 *
 * ## 为什么必须有这一步（实测的**有损中间层**）
 *
 * `RuntimeDocument.fromV2Plain` 的 `known` 集合列了
 * `label`/`author`/`description`/`gtnhVersion`/`modSource`/`globalConfig`/`schemaVersion`
 * 七个根级键却**从不读它们**，同时又把它们排除在 `_extra` 之外 —— 于是它们
 * **既不在 `meta` 里、也不在 `_extra` 里、更不在 `serialize()` 里**：
 * 从 `RuntimeDocument` 出发**无法**恢复。
 *
 * 实测（真实多方块夹具）：`plain.label` 有值（`'Fixture — EBF (…)'`），
 * 而 `doc.serialize().label === undefined`、`doc.meta.label === undefined`。
 *
 * ⇒ 装配层要吃**未经损失的源**。这不是"多传一个参数"，而是承认
 * `RuntimeDocument` 是**有损**中间层（它只承载被它理解的字段）。
 *
 * ## 为什么用 `decodeEnvelope`
 *
 * 它是既有的**保真**信封编解码：`plain` 是「`inner` 剔除 meta 键后与 `meta`
 * 合并（meta 胜出），并把 `documentFormat` 置为 `'Plain'`」。后者是既有事实 ——
 * 信封根上的 `documentFormat: 'Envelope'` 会折入 meta，合并后必须是 Plain 形，
 * 否则"下载 Plain"仍带 Envelope。它同时处理 `base64(json)` 与 `base64(gzip(json))`。
 *
 * 失败时返回 `undefined`（而非抛错）：调用方据此"如实降级" ——
 * 装配层用 `undefined` 表示"根级元数据不可恢复"，而不是伪造一个空对象。
 */

import { decodeEnvelope } from './files/envelopeCodec'
import { isEnvelopeDocument } from './files/plainCodec'

/**
 * 取"解析器看到的 plain 形状"（信封解包 + meta 合并的产物）。
 *
 * 非信封输入**就是** plain 形状，原样返回（零额外成本）。
 * 非对象输入 ⇒ `undefined`。
 */
export function plainRootOf(raw: unknown): Readonly<Record<string, unknown>> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if (!isEnvelopeDocument(raw)) return raw as Record<string, unknown>
  const decoded = decodeEnvelope(raw)
  if (!decoded.ok) return undefined
  const plain: unknown = decoded.value.plain
  return plain === null || typeof plain !== 'object' || Array.isArray(plain)
    ? undefined
    : (plain as Readonly<Record<string, unknown>>)
}
