import type { OperatorType } from '@/workbench/operators/operatorType'
import { buildEnvelopePackage } from '@/render/data/sceneExport'
import { loadStructureOrWorld } from '@/render/data/bundleResolve'
import { downloadBlob, downloadJson } from '@/util/browser'
import { buildStructureBundleZip } from '@/workbench/structureBundleExport'
import { bakeIsometricStructurePngDataUrl, dataUrlToPngBlob } from '@/workbench/exportIsometricImage'
import { sceneStableStringIdFromDocument } from '@/render/data/compactSceneDocument'

const ISO_DIRECTION_MAP: Record<string, number> = {
  nw: 0,
  ne: 1,
  sw: 2,
  se: 3,
}

export const ExportPlainOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_PLAIN',
  label: '导出 Plain JSON',
  description: '下载完整明文 JSON',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  exec(bctx, _props) {
    const doc = (bctx.doc.value?.toRaw() ?? null) as Record<string, unknown> | null
    if (!doc) return
    const baseName = sceneStableStringIdFromDocument(doc)
    downloadJson(`${baseName}-plain`, doc, true)
  },
}

export const ExportEnvelopeOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_ENVELOPE',
  label: '导出 Envelope JSON',
  description: '下载 gzip+Base64 信封格式',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  exec(bctx, _props) {
    const doc = (bctx.doc.value?.toRaw() ?? null) as Record<string, unknown> | null
    if (!doc) return
    const baseName = sceneStableStringIdFromDocument(doc)
    downloadJson(`${baseName}-envelope`, buildEnvelopePackage(doc), true)
  },
}

export const ExportObjOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_OBJ',
  label: '导出 OBJ',
  description: '导出 Wavefront OBJ+MTL 打包为 zip',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  async exec(bctx, _props) {
    const doc = bctx.doc.value?.toRaw()
    if (!doc) return
    const connected = (_props.connected as boolean) ?? false
    const mode = connected ? 'connected' : 'block'
    const baseName = sceneStableStringIdFromDocument(doc)
    const def = loadStructureOrWorld(doc, undefined)
    const blob = await buildStructureBundleZip(def, doc, { mode })
    downloadBlob(`${baseName}-${mode}.zip`, blob)
  },
}

export const ExportIsoPngOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_ISO_PNG',
  label: '导出等轴 PNG',
  description: '将等轴方向渲染输出为 PNG',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  async exec(bctx, _props) {
    const direction = (_props.direction as string) ?? 'nw'
    const directionIndex = ISO_DIRECTION_MAP[direction] ?? 0
    const doc = bctx.doc.value?.toRaw()
    if (!doc) return
    try {
      const dataUrl = await bakeIsometricStructurePngDataUrl(doc, directionIndex)
      const blob = dataUrlToPngBlob(dataUrl)
      downloadBlob(`iso-${direction}.png`, blob)
    } catch (e) {
      bctx.log.warn('导出', `等轴 PNG 导出失败: ${e}`)
    }
  },
}
