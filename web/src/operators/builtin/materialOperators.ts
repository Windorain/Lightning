/**
 * 材质面板的算子：导出**静态**纹理 PNG、复制定位符。
 *
 * ## 材质卡的「导出 GIF」入口**已退出**
 *
 * 它导的是**贴图条本身**（2D 材质审阅），而场景 GIF 导的是**模型画面**（3D）。
 * 两个入口合并成一个（导出页签的「动画 GIF」卡片）⇒ 本文件不再有
 * `ExportGifOperator`、`workbench/animatedGifEncoder` 整文件删除。
 *
 * **能力后果（如实记录）**："把某张材质的动画单独导出成 GIF"**不再有入口**；
 * 静态纹理仍可经 {@link ExportTextureOperator} 导出 PNG。若日后需要，属新需求。
 */

import type { OperatorType } from '@/operators/operatorType'
import type { MaterialQueryItem } from '@/runtime/types'
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
