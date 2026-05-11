/**
 * 本地 dev：URL 参数与默认 UI → PreviewConfig；场景来自 `data/scenes/<id>.json` 构建期打包。
 */

import type { PreviewConfig, PreviewFeatures } from '@/preview/previewConfig'
import { defaultEmbedUi } from '@/preview/previewConfig'
import { getDevSceneDocument, listDevSceneIds } from '@/dev/devScenes'
import { DEFAULT_PREVIEW_SCENE_ID, loadPreviewSessionFromDocument } from '@/preview/previewSession'
import { sceneStableStringIdFromDocument } from '@/render/data/compactSceneDocument'

function parseBool(s: string | null): boolean | undefined {
  if (s === null || s === '') return undefined
  const t = s.toLowerCase()
  if (t === '1' || t === 'true' || t === 'yes') return true
  if (t === '0' || t === 'false' || t === 'no') return false
  return undefined
}

function parseHex6(s: string | null): number | undefined {
  if (s === null || s === '') return undefined
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim())
  if (!m) return undefined
  return parseInt(m[1], 16)
}

/**
 * 本地 dev 入口 URL 查询参数（白名单）。与 resolveDevPreviewConfigAsync 合并（覆盖默认值）。
 */
function parseUrlPreviewParams(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): Partial<PreviewConfig> {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  const out: Partial<PreviewConfig> = {}
  const feat: Partial<PreviewFeatures> = {}

  const sceneId = params.get('sceneId')
  if (sceneId !== null && sceneId !== '') {
    out.sceneId = sceneId
  }

  const layer = params.get('layer')
  if (layer !== null && layer !== '') {
    const n = Number(layer)
    if (Number.isFinite(n)) out.initialLayerWorldY = n
  }

  const stats = parseBool(params.get('stats'))
  if (stats !== undefined) feat.blockStatsSidebar = stats

  const layerBar = parseBool(params.get('layerBar'))
  if (layerBar !== undefined) feat.layerBar = layerBar

  const debug = parseBool(params.get('debug'))
  if (debug !== undefined) out.debug = debug

  if (Object.keys(feat).length > 0) {
    out.features = { ...feat } as PreviewConfig['features']
  }

  const bg = parseHex6(params.get('bg'))
  if (bg !== undefined) out.sceneBackground = bg

  const bco: Partial<PreviewConfig['blockIconCacheOptions']> = {}
  const sizePx = params.get('iconSizePx')
  if (sizePx !== null && sizePx !== '') {
    const n = Math.round(Number(sizePx))
    if (Number.isFinite(n) && n >= 8) bco.sizePx = n
  }
  const orthoHalf = params.get('orthoHalf')
  if (orthoHalf !== null && orthoHalf !== '') {
    const n = Number(orthoHalf)
    if (Number.isFinite(n) && n > 0) bco.orthoHalf = n
  }
  const clearColor = parseHex6(params.get('clearColor'))
  if (clearColor !== undefined) bco.clearColor = clearColor
  const clearAlphaParam = params.get('clearAlpha')
  if (clearAlphaParam !== null && clearAlphaParam !== '') {
    const n = Number(clearAlphaParam)
    if (Number.isFinite(n) && n >= 0 && n <= 1) bco.clearAlpha = n
  }
  if (Object.keys(bco).length > 0) {
    out.blockIconCacheOptions = bco as PreviewConfig['blockIconCacheOptions']
  }

  return out
}

const defaultDevPreviewBase: Omit<PreviewConfig, 'renderBundle' | 'materialLibrary' | 'sceneId'> = {
  ...defaultEmbedUi,
  features: {
    ...defaultEmbedUi.features,
    blockStatsSidebar: true,
    layerBar: true,
    debugStatusBar: true,
  },
}

function resolveSceneId(config: Partial<PreviewConfig>): string {
  const s = config.sceneId
  if (s === undefined || s === '') return DEFAULT_PREVIEW_SCENE_ID
  return s
}

export async function resolveDevPreviewConfigAsync(): Promise<PreviewConfig> {
  const url = parseUrlPreviewParams()
  const { features: urlFeatures, ...urlRest } = url

  const mergedBase: Omit<PreviewConfig, 'renderBundle' | 'materialLibrary' | 'sceneId'> = {
    ...defaultDevPreviewBase,
    ...urlRest,
    features: {
      ...defaultDevPreviewBase.features,
      ...(urlFeatures ?? {}),
    },
    blockIconCacheOptions: {
      ...defaultDevPreviewBase.blockIconCacheOptions,
      ...(url.blockIconCacheOptions ?? {}),
    },
  }

  const sceneId = resolveSceneId({ ...mergedBase, ...url })
  const document = getDevSceneDocument(sceneId)
  const { renderBundle, materialLibrary } = await loadPreviewSessionFromDocument(document)
  const stableId = sceneStableStringIdFromDocument(renderBundle.document)
  const docId = stableId !== 'scene' ? stableId : sceneId

  const out: PreviewConfig = {
    ...mergedBase,
    features: {
      ...defaultDevPreviewBase.features,
      ...(urlFeatures ?? {}),
    },
    sceneId: typeof docId === 'string' && docId.length > 0 ? docId : sceneId,
    renderBundle,
    materialLibrary,
    okMessage: mergedBase.okMessage ?? defaultEmbedUi.okMessage,
    loadingMessage: mergedBase.loadingMessage ?? defaultEmbedUi.loadingMessage,
  }
  return out
}

export { listDevSceneIds }
