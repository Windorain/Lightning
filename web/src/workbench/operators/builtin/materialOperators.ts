import type { OperatorType } from '@/workbench/operators/operatorType'
import type { MaterialQueryItem } from '@/workbench/context/bContext'
import { encodeAnimatedGif } from '@/workbench/animatedGifEncoder'

function resolveMaterial(bctx: any, materialId: string): MaterialQueryItem | undefined {
  const materials = bctx.queries?.listMaterials?.() ?? []
  return materials.find((item: MaterialQueryItem) => item.materialId === materialId)
}

/** Download a data URL as a PNG file */
function downloadPng(dataUrl: string, filename: string): void {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename.endsWith('.png') ? filename : `${filename}.png`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/** Derive a safe filename stem from a material */
function filenameStem(m: MaterialQueryItem | undefined, materialId: string): string {
  return m?.locator
    ? m.locator.replace(/^.*[\\/]/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
    : `material_${materialId}`
}

export const ExportTextureOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_TEXTURE',
  label: '导出纹理 PNG',
  description: '将当前选中的材质纹理导出为 PNG 文件',

  poll(bctx) {
    const materials = bctx.queries?.listMaterials?.() ?? []
    return materials.length > 0
  },

  exec(bctx, props) {
    const materialId = (props?.materialId as string) ?? '0'
    const m = resolveMaterial(bctx, materialId)
    if (!m?.textureDataUrl) {
      bctx.log?.warn('导出', `材质 ${materialId} 无纹理数据`)
      return
    }
    downloadPng(m.textureDataUrl, filenameStem(m, materialId))
  },
}

export const ExportAllTexturesOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_ALL_TEXTURES',
  label: '导出全部纹理',
  description: '将所有材质纹理逐个导出为 PNG 文件',

  poll(bctx) {
    return (bctx.queries?.listMaterials?.() ?? []).some(
      (m: MaterialQueryItem) => m.textureDataUrl !== null,
    )
  },

  exec(bctx, _props) {
    const materials = bctx.queries?.listMaterials?.() ?? []
    let count = 0
    for (const m of materials) {
      if (!m.textureDataUrl) continue
      // Slight delay between downloads to avoid browser blocking
      setTimeout(() => downloadPng(m.textureDataUrl!, filenameStem(m, m.materialId)), count * 100)
      count++
    }
    if (count === 0) {
      bctx.log?.warn('导出', '没有可导出的纹理')
    }
  },
}

export const CopyMaterialLocatorOperator: OperatorType = {
  id: 'OPERATOR_COPY_MATERIAL_LOCATOR',
  label: '复制定位符',
  description: '复制材质资源定位符到剪贴板',

  poll(bctx) {
    const materials = bctx.queries?.listMaterials?.() ?? []
    return materials.some((m: MaterialQueryItem) => !!m.locator)
  },

  async exec(bctx, props) {
    const materialId = (props?.materialId as string) ?? '0'
    const m = resolveMaterial(bctx, materialId)
    if (!m?.locator) {
      bctx.log?.warn('操作', `材质 ${materialId} 无定位符`)
      return
    }
    try {
      await navigator.clipboard.writeText(m.locator)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = m.locator
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
  },
}

export const ExportGifOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_GIF',
  label: '导出 GIF',
  description: '将动画纹理导出为 GIF 动图',

  poll(bctx) {
    return (bctx.queries?.listMaterials?.() ?? []).some(
      (m: MaterialQueryItem) => m.kind === 'animated' && m.textureDataUrl !== null,
    )
  },

  async exec(bctx, props) {
    const materialId = (props?.materialId as string) ?? '0'
    const m = resolveMaterial(bctx, materialId)
    if (!m?.textureDataUrl || m.kind !== 'animated') {
      bctx.log?.warn('导出', `材质 ${materialId} 不是动画纹理`)
      return
    }
    try {
      const delay = (m.animation?.defaultFrametimeTicks ?? 1) * 5 // ticks to centiseconds
      const { blob } = await encodeAnimatedGif(m.textureDataUrl, delay)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filenameStem(m, materialId)}.gif`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      bctx.log?.warn('导出', `GIF 导出失败: ${e}`)
    }
  },
}
