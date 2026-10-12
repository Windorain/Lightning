import type { OperatorType } from '@/operators/operatorType'
import { buildEnvelopePackage } from '@/render/data/sceneExport'
import { loadStructureOrWorld } from '@/render/data/bundleResolve'
import { downloadBlob, downloadJson } from '@/util/browser'
import { buildStructureBundleZip } from '@/workbench/export/bundleMeshAssembly'
import { bakeIsometricStructurePngDataUrl, dataUrlToPngBlob } from '@/workbench/exportIsometricImage'
import { sceneStableStringIdFromDocument } from '@/render/data/compactSceneDocument'

const ISO_DIRECTION_MAP: Record<string, number> = {
  nw: 0,
  ne: 1,
  sw: 2,
  se: 3,
}

/**
 * 把 `direction` 归一成 **0..3**（等轴四向的渲染下标）。
 *
 * ## 为什么必须有这个**唯一**入口（#301 P10f/E 修复 D7）
 *
 * 修复前 `ExportIsoPngOperator.exec` 里有两处**各自**解释 `props.direction`：
 *
 *  - 渲染下标：`ISO_DIRECTION_MAP[direction] ?? 0` —— 而 `direction` 取成 `string`
 *    （`(_props.direction as string) ?? 'nw'`），调用方 `ExportWorkspace.vue:54` 传的却是
 *    **number**（`{ direction: isoDir.value }`）⇒ number 键入 string 表**恒 miss** ⇒ 恒 0；
 *  - 文件名：`` `iso-${direction}.png` `` —— 插值的是**原始 props 值**（number 2 得 `iso-2.png`）。
 *
 * 于是两者的口径可以分叉，而分叉的表现是**名实不符**：下载名为 `iso-2.png`，
 * 内容却是方向 0 的图；四个方向下载出**同一张**图（实测见本批证据）。
 *
 * ⇒ 归一化收成一处，**渲染下标与文件名同源**。分叉在结构上不再可表达：
 * 两处都只能引用本函数的返回值。
 *
 * ## 口径（宽进严出，但不虚构能力）
 *
 * | 输入 | 结果 |
 * |---|---|
 * | `number`（含小数/负数/越界） | `((floor(n) % 4) + 4) % 4` ⇒ `-1→3`、`4→0`、`2.7→2` |
 * | `string`（`'nw'`/`'ne'`/`'sw'`/`'se'`） | 查 {@link ISO_DIRECTION_MAP}（**文档化的字符串口径**，保留） |
 * | 其余字符串 / `NaN` / `Infinity` / 其他类型 | `0`（与修复前的回落一致，不抛） |
 *
 * 返回值恒在 `0..3`：调用方拿它去索引四向表**不可能越界**。
 */
export function resolveIsoDirection(raw: unknown): number {
  if (typeof raw === 'number') {
    // `NaN`/`Infinity` 走回落分支：`Math.floor(NaN)` 是 NaN，取模仍是 NaN，
    // 会让下标悄悄变成 `NaN` 并索引出 `undefined` 方向（静默坏画面）。
    if (!Number.isFinite(raw)) return 0
    return ((Math.floor(raw) % 4) + 4) % 4
  }
  if (typeof raw === 'string') return ISO_DIRECTION_MAP[raw] ?? 0
  return 0
}

export const ExportPlainOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_PLAIN',
  label: '导出 Plain JSON',
  description: '下载完整明文 JSON',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  exec(ctx, _props) {
    // #301 P10f D2：产物改由**内核投影**给出（未装配自动回落旧文档）。
    const doc = (ctx.plainForSave().plain ?? null) as Record<string, unknown> | null
    if (!doc) return
    const baseName = sceneStableStringIdFromDocument(doc)
    downloadJson(`${baseName}-plain`, doc, true)
  },
}

export const ExportEnvelopeOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_ENVELOPE',
  label: '导出 Envelope JSON',
  description: '下载 gzip+Base64 信封格式',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  exec(ctx, _props) {
    // #301 P10f D2：产物改由**内核投影**给出（未装配自动回落旧文档）。
    const doc = (ctx.plainForSave().plain ?? null) as Record<string, unknown> | null
    if (!doc) return
    const baseName = sceneStableStringIdFromDocument(doc)
    downloadJson(`${baseName}-envelope`, buildEnvelopePackage(doc), true)
  },
}

export const ExportObjOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_OBJ',
  label: '导出 OBJ',
  description: '导出 Wavefront OBJ+MTL 打包为 zip',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  async exec(ctx, _props) {
    // #301 P10f D2：产物改由**内核投影**给出（未装配自动回落旧文档）。
    const doc = ctx.plainForSave().plain
    if (!doc) return
    const explicit = (_props.mode as string | undefined)
    const connected = (_props.connected as boolean) ?? false
    const mode = explicit ?? (connected ? 'connected' : 'block')
    const baseName = sceneStableStringIdFromDocument(doc)
    const def = loadStructureOrWorld(doc, undefined)
    const blob = await buildStructureBundleZip(def, doc, { mode: mode as any })
    // 插桩：验证 ZIP 文件头
    const sigBytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
    const sigHex = Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    if (sigHex !== '504b0304') {
      ctx.log.warn('导出', `ZIP 文件头异常: 期望 504b0304, 实际 ${sigHex}, 大小 ${blob.size}`)
    }
    downloadBlob(`${baseName}-${mode}.zip`, blob)
  },
}

export const ExportIsoPngOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_ISO_PNG',
  label: '导出等轴 PNG',
  description: '将等轴方向渲染输出为 PNG',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  async exec(ctx, _props) {
    // #301 P10f/E 修复 D7：渲染下标与文件名**同源**（都取自 `directionIndex`）。
    // 修复前文件名插值的是原始 `props.direction`，与查表得到的渲染下标是两个来源
    // ⇒ 实测表现为"名为 iso-2.png、内容是方向 0"。见 `resolveIsoDirection` 的说明。
    const directionIndex = resolveIsoDirection(_props.direction)
    // #301 P10f D2：产物改由**内核投影**给出（未装配自动回落旧文档）。
    const doc = ctx.plainForSave().plain
    if (!doc) return
    try {
      const dataUrl = await bakeIsometricStructurePngDataUrl(doc, directionIndex)
      const blob = dataUrlToPngBlob(dataUrl)
      downloadBlob(`iso-${directionIndex}.png`, blob)
    } catch (e) {
      ctx.log.warn('导出', `等轴 PNG 导出失败: ${e}`)
    }
  },
}
