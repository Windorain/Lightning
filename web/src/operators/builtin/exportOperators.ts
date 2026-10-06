import type { OperatorType } from '@/operators/operatorType'
import { buildEnvelopePackage } from '@/render/data/sceneExport'
import { loadStructureOrWorld } from '@/render/data/bundleResolve'
import { downloadBlob, downloadJson } from '@/util/browser'
import { buildStructureBundleZip } from '@/workbench/export/bundleMeshAssembly'
import { bakeIsometricStructurePngDataUrl, dataUrlToPngBlob } from '@/workbench/exportIsometricImage'
import { bakeShotPngDataUrl } from '@/workbench/exportShotImage'
import { mcSpecToShotCamera, type McCameraSpec } from '@/pure/mcShotCamera'
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

  poll(ctx) {
    return ctx.getDoc().value !== null
  },

  exec(ctx, _props) {
    const doc = (ctx.getDoc().value?.serialize() ?? null) as Record<string, unknown> | null
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
    return ctx.getDoc().value !== null
  },

  exec(ctx, _props) {
    const doc = (ctx.getDoc().value?.serialize() ?? null) as Record<string, unknown> | null
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
    return ctx.getDoc().value !== null
  },

  async exec(ctx, _props) {
    const doc = ctx.getDoc().value?.serialize()
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
    return ctx.getDoc().value !== null
  },

  async exec(ctx, _props) {
    const direction = (_props.direction as string) ?? 'nw'
    const directionIndex = ISO_DIRECTION_MAP[direction] ?? 0
    const doc = ctx.getDoc().value?.serialize()
    if (!doc) return
    try {
      const dataUrl = await bakeIsometricStructurePngDataUrl(doc, directionIndex)
      const blob = dataUrlToPngBlob(dataUrl)
      downloadBlob(`iso-${direction}.png`, blob)
    } catch (e) {
      ctx.log.warn('导出', `等轴 PNG 导出失败: ${e}`)
    }
  },
}

function asVec3(value: unknown, field: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${field} 必须是长度 3 的数组，实际 ${JSON.stringify(value)}`)
  }
  const out = value.map((v) => Number(v))
  for (const v of out) {
    if (!Number.isFinite(v)) throw new Error(`${field} 含非有限分量：${JSON.stringify(value)}`)
  }
  return [out[0]!, out[1]!, out[2]!]
}

function asFiniteNumber(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${field} 必须是有限数，实际 ${JSON.stringify(value)}`)
  return n
}

function asPositiveInt(value: unknown, field: string): number {
  const n = asFiniteNumber(value, field)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${field} 必须是正整数，实际 ${n}`)
  return n
}

/**
 * 指定正交机位出图（#87 验收器具）。
 *
 * 与 `OPERATOR_EXPORT_ISO_PNG` 的区别：机位（落点 / 方位 / 俯仰 / 正交全高 / 分辨率）**全部由调用方给定**，
 * 不做等轴四向、不做 AABB 自动贴合；`pos` / `yaw` / `pitch` 走 **MC 控制面口径**，
 * 经 `pure/mcShotCamera.ts` 换算成 web 口径后出图 → 保证与游戏内 CameraSpec 同机位。
 *
 * props（MC 口径）：
 *  - `pos: [x,y,z]`  MC 世界坐标相机落点
 *  - `yaw` / `pitch`  MC 偏航 / 俯仰（度，pitch 正 = 俯视）
 *  - `orthoHeight`    正交竖直全高（方块数）
 *  - `width` / `height` 输出分辨率（任意，不 clamp）
 *  - `center: [x,y,z]` **结构中心的 MC 世界坐标（必传）**——世界锚点在 web 解析链上丢失，
 *                      只能由调用方从 SDE `scanBounds` + `cellGrid` 尺寸复原
 *                      （见 `structureCenterFromScanBounds`）
 *  - `name?`          文件名（`shot-<name||'unnamed'>.png`）
 *
 * 仅支持**普通（非多方块）文档**：多方块文档的网格是装配产物、无单一世界锚点，本器具不服务。
 */
export const ExportShotPngOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_SHOT_PNG',
  label: '导出指定机位 PNG',
  description: '按 MC 控制面 CameraSpec（指定落点/方位/俯仰/正交全高/分辨率）渲染 PNG',

  poll(ctx) {
    return ctx.getDoc().value !== null
  },

  async exec(ctx, props) {
    const docRuntime = ctx.getDoc().value
    if (!docRuntime) throw new Error('OPERATOR_EXPORT_SHOT_PNG：当前无文档')
    if (docRuntime.isMultiblock) {
      throw new Error(
        'OPERATOR_EXPORT_SHOT_PNG：不支持「多方块为主」文档（网格为装配产物、无单一世界锚点）；本器具当前只服务单结构验收',
      )
    }
    const doc = docRuntime.serialize()

    const mc: McCameraSpec = {
      pos: asVec3(props.pos, 'pos'),
      yaw: asFiniteNumber(props.yaw, 'yaw'),
      pitch: asFiniteNumber(props.pitch, 'pitch'),
      orthoHeight: asFiniteNumber(props.orthoHeight, 'orthoHeight'),
      width: asPositiveInt(props.width, 'width'),
      height: asPositiveInt(props.height, 'height'),
    }
    if (mc.orthoHeight <= 0) {
      throw new Error(`orthoHeight 必须为正，实际 ${mc.orthoHeight}`)
    }
    const center = asVec3(props.center, 'center')
    const name = typeof props.name === 'string' && props.name.length > 0 ? props.name : 'unnamed'

    const spec = mcSpecToShotCamera(mc, center)
    const dataUrl = await bakeShotPngDataUrl(doc, spec)
    const blob = dataUrlToPngBlob(dataUrl)
    downloadBlob(`shot-${name}.png`, blob)
  },
}
