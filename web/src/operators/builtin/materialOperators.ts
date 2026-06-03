import type { OperatorType } from '@/operators/operatorType'
import type { MaterialQueryItem } from '@/context/bContext'
import { encodeAnimatedGif } from '@/workbench/animatedGifEncoder'
import { filenameStem } from '@/pure/string'
import { downloadPng, copyTextToClipboard } from '@/util/browser'
import { listMaterials } from '@/context/queries'

function resolveMaterial(bctx: any, materialId: string): MaterialQueryItem | undefined {
  const materials = listMaterials(bctx)
  return materials.find((item: MaterialQueryItem) => item.materialId === materialId)
}

export const ExportTextureOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_TEXTURE',
  label: '导出纹理 PNG',
  description: '将当前选中的材质纹理导出为 PNG 文件',

  poll(bctx) {
    const materials = listMaterials(bctx)
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

export const CopyMaterialLocatorOperator: OperatorType = {
  id: 'OPERATOR_COPY_MATERIAL_LOCATOR',
  label: '复制定位符',
  description: '复制材质资源定位符到剪贴板',

  poll(bctx) {
    const materials = listMaterials(bctx)
    return materials.some((m: MaterialQueryItem) => !!m.locator)
  },

  async exec(bctx, props) {
    const materialId = (props?.materialId as string) ?? '0'
    const m = resolveMaterial(bctx, materialId)
    if (!m?.locator) {
      bctx.log?.warn('操作', `材质 ${materialId} 无定位符`)
      return
    }
    await copyTextToClipboard(m.locator)
  },
}

export const ExportGifOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_GIF',
  label: '导出 GIF',
  description: '将动画纹理导出为 GIF 动图',

  poll(bctx) {
    return listMaterials(bctx).some(
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
