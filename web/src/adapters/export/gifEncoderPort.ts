/**
 * `adapters/export/gifEncoderPort` —— **动画（GIF）编码端口**（M6-2）。
 *
 * ## 诚实声明
 *
 * `supportedKinds = ['animation']`、`supportedEncodings = ['gif']`：本端口**只**编动画 GIF。
 * PNG/JPEG 由 {@link createPngEncoderPort} 声明 —— 组合端口（`createEncoderPort`）把两者
 * 按 kind/encoding 分派。一个端口声明两类却只实现一类，预检就会放行伪产物（D4 的理由）。
 *
 * ## 失败面逐条（每条一个 distinct reason）
 *
 * | 输入 | reason |
 * |---|---|
 * | 非 `animation` | `encoderKindUnsupported` |
 * | 非 `gif` | `encoderEncodingUnsupported` |
 * | 零帧 | `encoderNoFrames` |
 * | 帧数 ≠ 请求的采样数 | `encoderFrameCountMismatch`（否则"少渲一帧"会被静默编成短 GIF） |
 * | 帧尺寸 ≠ `request.render` | `encoderFrameSizeMismatch` |
 * | 某帧 `holdMs` 缺席 / 非法 | `encoderHoldMissing` / `encoderHoldInvalid`（**不**用帧率补一个） |
 * | `loopCount` 非整数或 < 0 | `encoderLoopCountInvalid` |
 * | `Σ delayCs < 帧数`（1 厘秒地板撞总量） | `textureLoopTooShort`（**domain 码原样透出**，带 `part`） |
 * | 取消（帧循环之间） | `encoderCancelled` + **零字节** |
 *
 * ## 时延从哪来
 *
 * `delayCsOf(CaptureTime.holdMs[])` —— 与 `planSequenceLoop` **同一个**换算点。
 * 本端口不按帧率自算、不读 tick、不四舍五入。
 */

import { err, invalidValue, unsupportedOperation, type Result } from '@/domain/errors'
import { delayCsOf } from '@/domain/materials'
import type { DomainError } from '@/domain/errors'
import { encodeGifBytes, type GifFrame } from './gifEncoder'
import type { ArtifactEncoding, EncoderInput, EncoderPort, ExportKind } from '@/application/exportPlan'

/** 本端口**真能编码**的种类（诚实声明；不列 PNG 之外的任何种类）。 */
export const SUPPORTED_ANIMATION_ENCODE_KINDS: readonly ExportKind[] = Object.freeze(['animation'] as const)

/** 本端口支持的编码格式。 */
export const SUPPORTED_ANIMATION_ENCODINGS: readonly ArtifactEncoding[] = Object.freeze(['gif'] as const)

/** 把 domain 错误原样搬到端口失败侧，并补上 `part`（使"GIF 编不出来"可归因）。 */
function tagged(error: DomainError, part: string): DomainError {
  const params = Object.freeze({ ...error.params, part })
  return Object.freeze({ ...error, params })
}

export function createGifEncoderPort(): EncoderPort {
  return {
    name: 'gif',
    supportedKinds: SUPPORTED_ANIMATION_ENCODE_KINDS,
    supportedEncodings: SUPPORTED_ANIMATION_ENCODINGS,
    async encode(input: EncoderInput): Promise<Result<Uint8Array>> {
      if (!SUPPORTED_ANIMATION_ENCODE_KINDS.includes(input.kind)) {
        return err(
          unsupportedOperation({
            reason: 'encoderKindUnsupported',
            kind: input.kind,
            supported: SUPPORTED_ANIMATION_ENCODE_KINDS.join(','),
          }),
        )
      }
      if (input.encoding !== 'gif') {
        return err(unsupportedOperation({ reason: 'encoderEncodingUnsupported', encoding: input.encoding }))
      }
      if (input.rendered.length === 0) {
        return err(unsupportedOperation({ reason: 'encoderNoFrames', requestId: input.request.requestId }))
      }
      // 帧数必须等于请求的采样数：否则"少渲一帧"会被静默编成更短的 GIF（时长与声明的分叉）。
      if (input.rendered.length !== input.request.frames.length) {
        return err(
          unsupportedOperation({
            reason: 'encoderFrameCountMismatch',
            rendered: input.rendered.length,
            frames: input.request.frames.length,
          }),
        )
      }

      const holds: number[] = []
      for (let i = 0; i < input.rendered.length; i++) {
        const frame = input.rendered[i]!
        if (frame.width !== input.request.render.width || frame.height !== input.request.render.height) {
          return err(
            unsupportedOperation({
              reason: 'encoderFrameSizeMismatch',
              frameIndex: i,
              frameWidth: frame.width,
              frameHeight: frame.height,
              requestWidth: input.request.render.width,
              requestHeight: input.request.render.height,
            }),
          )
        }
        // 驻留**只**认帧上那个值（缺席就是缺席 —— 不按帧率补一个默认）。
        if (frame.holdMs === undefined) {
          return err(unsupportedOperation({ reason: 'encoderHoldMissing', index: i }))
        }
        if (!Number.isInteger(frame.holdMs) || frame.holdMs < 1) {
          return err(invalidValue({ reason: 'encoderHoldInvalid', index: i, holdMs: frame.holdMs }))
        }
        holds.push(frame.holdMs)
      }

      const loopCount = input.loopCount ?? 0
      if (!Number.isInteger(loopCount) || loopCount < 0) {
        return err(invalidValue({ reason: 'encoderLoopCountInvalid', loopCount }))
      }

      // 取消：编码前一次（长循环内部还会逐帧重读）。
      if (input.signal.cancelled) {
        return err(unsupportedOperation({ reason: 'encoderCancelled', requestId: input.request.requestId }))
      }

      // 唯一换算点：ms → 厘秒（与 planSequenceLoop 同一个函数）。
      const delays = delayCsOf(holds)
      if (!delays.ok) return err(tagged(delays.error, 'gif'))

      const frames: GifFrame[] = input.rendered.map((f) => ({ pixels: f.pixels, width: f.width, height: f.height }))
      const bytes = encodeGifBytes(frames, delays.value, {
        palette: 'frame',
        // WebGL 读回原点在左下 ⇒ GIF 是上左原点，**翻一次**。
        flipY: true,
        loopCount,
        signal: input.signal,
      })
      if (!bytes.ok) return err(tagged(bytes.error, 'gif'))
      return bytes
    },
  }
}
