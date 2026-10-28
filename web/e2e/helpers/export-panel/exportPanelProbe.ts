/**
 * **面板对账探针**：用生产捕获入口独立重算 A 块（canonical/digest）与 B 块（资源明细）。
 *
 * 为什么另起一份捕获而不是读 UI 状态：
 *  - 面板若自己"算"清单，它当然会与自己一致（恒真）；
 *  - 本探针走的是**生产捕获链路**（`captureExportSnapshot` + 同一份 `textureBindingsOf`），
 *    与卡片导出同一个求值点，但**不经过**面板组件 ⇒ 两边对得上才有意义。
 *
 * 只捕获、不渲染：判据关心的是清单身份与绑定事实，像素面由别的 spec 负责。
 */
import { assetManifestCanonicalText, assetManifestDigest, type ExportCaptureFacts } from '@/application/exportPlan'
import { captureExportSnapshot } from '@/composition/exportCapture'
import { createDomTextureDecoder } from '@/adapters/textureDecode'

export interface ExportPanelProbeResult {
  readonly ok: boolean
  readonly reason: string | null
  readonly canonical: string
  readonly digest: number
  readonly facts: ExportCaptureFacts | null
}

export async function runExportPanelProbe(options: { seconds?: number; directionIndex?: number; pixelSize?: number } = {}): Promise<ExportPanelProbeResult> {
  const ctx = (window as unknown as { __vm__?: Parameters<typeof captureExportSnapshot>[0] }).__vm__
  if (ctx === undefined) return { ok: false, reason: 'no-live-context', canonical: '', digest: 0, facts: null }
  const captured = await captureExportSnapshot(ctx, {
    kind: 'image',
    directionIndex: options.directionIndex ?? 0,
    pixelSize: options.pixelSize ?? 480,
    seconds: options.seconds ?? 0,
    decoder: createDomTextureDecoder(),
    now: 0,
  })
  if (!captured.ok) {
    return { ok: false, reason: captured.error.code + ':' + String(captured.error.params.reason ?? ''), canonical: '', digest: 0, facts: null }
  }
  const capture = captured.value
  return {
    ok: true,
    reason: null,
    canonical: assetManifestCanonicalText(capture.assetNeeds.assets),
    digest: assetManifestDigest(capture.assetNeeds.assets),
    facts: capture.captureFacts,
  }
}
