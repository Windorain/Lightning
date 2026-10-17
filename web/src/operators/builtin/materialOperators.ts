import type { OperatorType } from '@/operators/operatorType'
import type { MaterialQueryItem } from '@/runtime/types'
import { encodeAnimatedGif, probeAnimatedStrip } from '@/workbench/animatedGifEncoder'
import { filenameStem } from '@/pure/string'
import { downloadPng, downloadBlob, copyTextToClipboard } from '@/util/browser'
import { listMaterials } from '@/context/queries'
import { planSequenceLoop } from '@/domain/materials'
import { resolveAnimationTimeline } from '@/render/assets/textureStripAnimation'

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
      const probe = await probeAnimatedStrip(m.textureDataUrl)
      // 声明的**逐帧**时长（唯一解释器：`render/assets/textureStripAnimation#resolveAnimationTimeline`）。
      // 形状必须与 `simpleMaterialLibrary#materialEntryToParsedMcmeta` **同构**，
      // 否则两条路径对同一份声明给出不同帧数 —— 那正是本包要消灭的漂移。
      const parsed = {
        animation: {
          defaultFrametimeTicks: m.animation?.defaultFrametimeTicks ?? 1,
          frameSequence: m.animation?.frameSequence ?? [],
          interpolate: m.animation?.interpolate === true,
        },
      }
      const { durationMsPerFrame } = resolveAnimationTimeline(parsed, probe.frameCount)
      // 时间计划**唯一权威**：逐帧停留由声明算出（旧实现用 `defaultFrametimeTicks * 5` 自算，
      // 忽略 `frameSequence[].timeTicks` ⇒ 不等的帧时长被压成同一个值）。
      const plan = planSequenceLoop([
        { id: materialId, frameCount: probe.frameCount, durationsMs: durationMsPerFrame },
      ])
      if (!plan.ok) {
        throw new Error(`GIF 时间计划失败: ${plan.error.code} ${JSON.stringify(plan.error.params)}`)
      }
      const { blob } = await encodeAnimatedGif(m.textureDataUrl, plan.value.delayCs)
      downloadBlob(`${filenameStem(m, materialId)}.gif`, blob)
    } catch (e) {
      ctx.log?.warn('导出', `GIF 导出失败: ${e}`)
      // 同 `ExportIsoPngOperator`：日志只留诊断，可见性由调用方承担。
      throw e
    }
  },
}
