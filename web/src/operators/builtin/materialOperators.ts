import type { OperatorType } from '@/operators/operatorType'
import type { MaterialQueryItem } from '@/runtime/types'
import { encodeAnimatedGif } from '@/workbench/animatedGifEncoder'
import { filenameStem } from '@/pure/string'
import { downloadPng, copyTextToClipboard } from '@/util/browser'
import { listMaterials } from '@/context/queries'

function resolveMaterial(ctx: any, materialId: string): MaterialQueryItem | undefined {
  const materials = listMaterials(ctx)
  return materials.find((item: MaterialQueryItem) => item.materialId === materialId)
}

export const ExportTextureOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_TEXTURE',
  label: '导出纹理 PNG',
  description: '将当前选中的材质纹理导出为 PNG 文件',

  poll(ctx) {
    const materials = listMaterials(ctx)
    return materials.length > 0
  },

  exec(ctx, props) {
    const materialId = (props?.materialId as string) ?? '0'
    const m = resolveMaterial(ctx, materialId)
    if (!m?.textureDataUrl) {
      ctx.log?.warn('导出', `材质 ${materialId} 无纹理数据`)
      return
    }
    downloadPng(m.textureDataUrl, filenameStem(m, materialId))
  },
}

export const CopyMaterialLocatorOperator: OperatorType = {
  id: 'OPERATOR_COPY_MATERIAL_LOCATOR',
  label: '复制定位符',
  description: '复制材质资源定位符到剪贴板',

  poll(ctx) {
    const materials = listMaterials(ctx)
    return materials.some((m: MaterialQueryItem) => !!m.locator)
  },

  async exec(ctx, props) {
    const materialId = (props?.materialId as string) ?? '0'
    const m = resolveMaterial(ctx, materialId)
    if (!m?.locator) {
      ctx.log?.warn('操作', `材质 ${materialId} 无定位符`)
      return
    }
    await copyTextToClipboard(m.locator)
  },
}

export const ExportGifOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_GIF',
  label: '导出 GIF',
  description: '将动画纹理导出为 GIF 动图',

  poll(ctx) {
    return listMaterials(ctx).some(
      (m: MaterialQueryItem) => m.kind === 'animated' && m.textureDataUrl !== null,
    )
  },

  async exec(ctx, props) {
    const materialId = (props?.materialId as string) ?? '0'
    const m = resolveMaterial(ctx, materialId)
    if (!m?.textureDataUrl || m.kind !== 'animated') {
      ctx.log?.warn('导出', `材质 ${materialId} 不是动画纹理`)
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
      ctx.log?.warn('导出', `GIF 导出失败: ${e}`)
    }
  },
}
