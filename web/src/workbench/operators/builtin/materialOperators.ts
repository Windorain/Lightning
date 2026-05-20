import type { OperatorType } from '@/workbench/operators/operatorType'
import type { MaterialQueryItem } from '@/workbench/context/bContext'

/** Resolve the dataUrl of the material — shared helper */
function resolveMaterialDataUrl(bctx: any, materialId: string): string | null {
  const materials = bctx.queries?.listMaterials?.() ?? []
  const m = materials.find((item: MaterialQueryItem) => item.materialId === materialId)
  return m?.textureDataUrl ?? null
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
    const dataUrl = resolveMaterialDataUrl(bctx, materialId)
    if (!dataUrl) {
      bctx.log?.warn('导出', `材质 ${materialId} 无纹理数据`)
      return
    }
    const materials = bctx.queries?.listMaterials?.() ?? []
    const m = materials.find((item: MaterialQueryItem) => item.materialId === materialId)
    const name = m?.locator
      ? m.locator.replace(/^.*[\\/]/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
      : `material_${materialId}`
    downloadPng(dataUrl, name)
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
      const name = m.locator
        ? m.locator.replace(/^.*[\\/]/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
        : `material_${m.materialId}`
      // Slight delay between downloads to avoid browser blocking
      setTimeout(() => downloadPng(m.textureDataUrl!, name), count * 100)
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
    const materials = bctx.queries?.listMaterials?.() ?? []
    const m = materials.find((item: MaterialQueryItem) => item.materialId === materialId)
    if (!m?.locator) {
      bctx.log?.warn('操作', `材质 ${materialId} 无定位符`)
      return
    }
    try {
      await navigator.clipboard.writeText(m.locator)
    } catch {
      // Fallback for older browsers
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
