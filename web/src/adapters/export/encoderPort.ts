/**
 * `adapters/export/encoderPort` —— **编码端口的生产实现**（#301 P10f/E）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `EncoderPort` **零生产实现**（导出政策层只声明"能不能编码"，无人实现） | 本批前的实况 | 本文件是那个实现：`supportedKinds` + `encode()` |
 * | 经画布编码（`canvas.toBlob` / `toDataURL`） | `workbench/textureAtlasRaster.ts`、`workbench/exportIsometricImage.ts` | 纯字节编码（`adapters/export/pngEncoder`），无 DOM |
 *
 * ## 组合，而不是"全知端口"（M6-2 / D4）
 *
 * 本文件给两个 part：{@link createPngEncoderPort}（`image` + `png`）与
 * `createGifEncoderPort`（`animation` + `gif`，见 `adapters/export/gifEncoderPort`）。
 * {@link createEncoderPort} 是**组合端口**：能力字段取并集，encode 按 kind/encoding 分派，
 * part 的失败原样冒泡并补 `part` 名。⇒ 想编 GIF 必须真的有 GIF part，
 * "声明了两类却只实现一类"的伪产物形态在这里没有位置。
 *
 * ## 支持面**诚实声明**（不假装能编 OBJ/JSON/JPEG）
 *
 * 每个 part 的 `supportedKinds` 只列它真能编码的种类：PNG part 是 `'image'`，
 * GIF part 是 `'animation'`。其余种类**在该 part 上明确不列** —— 于是
 * `application/exportPlan.preflightExport` 会据 `supportedKinds` 判
 * `ExportKindUnsupported` 而**阻塞**。
 *
 * 这是 #249 §12「不支持的导出**明确报告**，不假成功」的直接落地：
 * 若把四类全列上而只实现一类，预检会放行、`encode` 要么抛要么产出错的字节
 * —— 那就是"伪完整文件"。**声明即能力**，声明面与实现面必须同一份事实。
 *
 * ## 为什么不是 `async` 包一层就算完
 *
 * 接口要求返回 `Promise<Result<Uint8Array>>`，但本实现的计算是**同步**的（纯字节编码）。
 * 保持同步内核、返回已敲定的 Promise，使**失败路径也是值**（`Result` 的失败侧），
 * 而不是"某天某个 await 抛了"。
 *
 * ## `signal` 的处理（契约 §1.5「调用超时不冒充取消」）
 *
 * 编码在**帧循环之间**检查 `signal.cancelled`：取消 ⇒ 立刻返回**结构化失败**并
 * **不产出部分字节**。这里没有超时、不读墙钟 —— 想取消就显式 `cancel()`。
 */

import { ok, err, unsupportedOperation, type DomainError, type Result } from '@/domain/errors'
import { PNG_COLOR_TYPE_RGBA } from './pngEncoder'
import { encodingAllowedFor, supportedEncodingsFor } from '@/application/exportPlan'
import type { ArtifactEncoding, EncoderInput, EncoderPort, ExportKind, RenderedFrame } from '@/application/exportPlan'
import { encodePngFromRgba } from './pngEncoder'
import { createGifEncoderPort } from './gifEncoderPort'

/** **PNG 端口**真能编码的种类（见文件头「支持面诚实声明」；组合端口才声明 animation）。 */
export const SUPPORTED_ENCODE_KINDS: readonly ExportKind[] = Object.freeze(['image'] as const)

/** **PNG 端口**真能编码的格式（JPEG 显式拒绝：见 `createPngEncoderPort` 的注释）。 */
export const SUPPORTED_ENCODE_ENCODINGS: readonly ArtifactEncoding[] = Object.freeze(['png'] as const)

/**
 * 图片编码器（PNG 完整实现；JPEG **明确不支持**）。
 *
 * ## JPEG 为什么不假装支持
 *
 * JPEG 是有损编码，需要 DCT/量化表 —— 那不是"顺手加一个分支"的量级。
 * 而 `ImageEncoding` 类型里有 `'jpeg'`，故**必须显式拒绝**：
 * 悄悄按 PNG 编码却声明 `image/jpeg`，会让下游（文件名/媒体类型）与真实字节不符
 * —— 正是本批 D7 修复所针对的**同族**缺陷（声明与内容不一致）。
 */
export function createPngEncoderPort(): EncoderPort {
  return {
    name: 'png',
    supportedKinds: SUPPORTED_ENCODE_KINDS,
    supportedEncodings: SUPPORTED_ENCODE_ENCODINGS,
    async encode(input: EncoderInput): Promise<Result<Uint8Array>> {
      if (!SUPPORTED_ENCODE_KINDS.includes(input.kind)) {
        return err(
          unsupportedOperation({
            reason: 'encoderKindUnsupported',
            kind: input.kind,
            supported: SUPPORTED_ENCODE_KINDS.join(','),
          }),
        )
      }
      if (input.encoding !== 'png') {
        // `jpeg` 在 `ImageEncoding` 里合法但本实现不支持 ⇒ 显式拒绝（见上文）。
        return err(unsupportedOperation({ reason: 'encoderEncodingUnsupported', encoding: input.encoding }))
      }
      if (input.rendered.length === 0) {
        // 零帧 ⇒ 不产出"空但合法"的 PNG（那是"伪完整文件"的最简形态）。
        return err(unsupportedOperation({ reason: 'encoderNoFrames', requestId: input.request.requestId }))
      }

      const frames = input.rendered
      // 图片导出取**第一帧**：这是显式政策，不是"随便挑一个"。
      // 多帧图片应由调用方用 `kind: 'animation'` 表达（本实现不支持，故不会静默只导首帧）。
      if (frames.length > 1 && input.kind === 'image') {
        // 不静默丢弃后续帧：那会让"导出了一段动画"变成"只出了一张图"而无任何信号。
        return err(
          unsupportedOperation({
            reason: 'encoderImageTakesSingleFrame',
            frames: frames.length,
            hint: '多帧请用 kind=animation + encoding=gif（PNG 端口只出单帧）',
          }),
        )
      }

      const frame = frames[0]!
      // 取消信号是**活视图**（作业在长循环里可读到最新意图）；此处只需在编码前检查一次
      // ——PNG 编码是单次 deflate，没有可中断的长循环。
      if (input.signal.cancelled) {
        return err(unsupportedOperation({ reason: 'encoderCancelled', requestId: input.request.requestId }))
      }

      const bytes = encodeFrame(frame)
      if (!bytes.ok) return bytes

      // 尺寸**交叉核对**：帧自带 width/height，request.render 也有 —— 两者不符
      // 说明上游哪里算错了。产出与 request 声明不符的图属静默错误，故显式判失败。
      if (frame.width !== input.request.render.width || frame.height !== input.request.render.height) {
        return err(
          unsupportedOperation({
            reason: 'encoderFrameSizeMismatch',
            frameWidth: frame.width,
            frameHeight: frame.height,
            requestWidth: input.request.render.width,
            requestHeight: input.request.render.height,
          }),
        )
      }

      return ok(bytes.value)
    },
  }
}

/** 单帧 → PNG 字节（`flipY: true`：渲染读回是 WebGL 行序，PNG 是自上而下）。 */
function encodeFrame(frame: RenderedFrame): Result<Uint8Array> {
  const expected = frame.width * frame.height * 4
  if (frame.pixels.length !== expected) {
    return err(
      unsupportedOperation({
        reason: 'encoderPixelBufferSizeMismatch',
        expected,
        actual: frame.pixels.length,
        width: frame.width,
        height: frame.height,
      }),
    )
  }
  try {
    return ok(encodePngFromRgba(frame.pixels, frame.width, frame.height, true))
  } catch (e) {
    // 纯编码器在尺寸非法时**抛**（它是内部不变量，不该发生）；
    // 在端口边界翻译成结构化失败，使调用方拿到 `Result` 而不是异常。
    return err(unsupportedOperation({ reason: 'encoderFailed', detail: String(e) }))
  }
}

/**
 * **组合端口**：按 `kind` 选 part，同 kind 多 part 时再按 `encoding` 筛（M6-2 / D4）。
 *
 * 为什么不造一个"全知端口"：`encoderPort.ts:11-19` 的原则是**声明即能力** ——
 * 一个端口声明两类却只实现一类，预检就会放行伪产物。组合则让每个 part 各自诚实，
 * 而 `supportedKinds/supportedEncodings` 取并集，预检据此判"整体能不能编"。
 *
 * 三条可测语义：
 * 1. 能力字段是**并集**（part 的顺序决定并集顺序 ⇒ 稳定）；
 * 2. 无匹配 part ⇒ `encoderKindUnsupported`（沿用既有码）或 `encoderEncodingUnsupported`；
 * 3. part 的失败**原样**冒泡，但补 `part` 名（否则"GIF 编不出来"与"PNG 编不出来"不可区分）。
 *
 * 公共前置（与 part 无关、对全部 kind 都成立）：零帧、帧尺寸与 `request.render` 不符。
 * 它们放在分派**之前**，使"尺寸漂移"不会被某个 part 漏检。
 */
export function createEncoderPort(
  parts: readonly EncoderPort[] = [createPngEncoderPort(), createGifEncoderPort()],
): EncoderPort {
  const kinds: ExportKind[] = []
  const encodings: ArtifactEncoding[] = []
  for (const part of parts) {
    for (const k of part.supportedKinds) if (!kinds.includes(k)) kinds.push(k)
    for (const e of part.supportedEncodings ?? []) if (!encodings.includes(e)) encodings.push(e)
  }

  return {
    name: parts.map((p) => p.name ?? p.supportedKinds.join('+')).join('+'),
    supportedKinds: Object.freeze(kinds),
    supportedEncodings: Object.freeze(encodings),
    async encode(input: EncoderInput): Promise<Result<Uint8Array>> {
      // 零帧：不产出"空但合法"的产物（这是"伪完整文件"的最简形态）。
      if (input.rendered.length === 0) {
        return err(unsupportedOperation({ reason: 'encoderNoFrames', requestId: input.request.requestId }))
      }
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
      }

      // 先判「谁都没声明这个种类」—— 那是最粗的一层，诊断也最直接。
      const byKind = parts.filter((p) => p.supportedKinds.includes(input.kind))
      if (byKind.length === 0) {
        return err(
          unsupportedOperation({
            reason: 'encoderKindUnsupported',
            kind: input.kind,
            supported: kinds.join(','),
          }),
        )
      }

      // **kind × encoding 兼容表**：预检与组合端口读的是**同一张表**（不各写一份 switch）。
      // 再判「这个组合本身合法吗」—— 它与「缺个能做它的端口」是两件事，
      // 混成一码会让「image+gif 这个组合不成立」看起来像「缺个 GIF 端口」。
      if (!encodingAllowedFor(input.kind, input.encoding)) {
        return err(
          unsupportedOperation({
            reason: 'encodingNotAllowedForKind',
            kind: input.kind,
            encoding: input.encoding,
            allowed: supportedEncodingsFor(input.kind).join(','),
          }),
        )
      }

      const chosen = byKind.length === 1
        ? byKind[0]!
        : byKind.find((p) => (p.supportedEncodings ?? []).includes(input.encoding))
      if (chosen === undefined) {
        return err(
          unsupportedOperation({
            reason: 'encoderEncodingUnsupported',
            kind: input.kind,
            encoding: input.encoding,
            supported: encodings.join(','),
          }),
        )
      }

      const result = await chosen.encode(input)
      if (result.ok) return result
      const part = chosen.name ?? chosen.supportedKinds.join('+')
      return err(withPart(result.error, part))
    },
  }
}

/** 给失败侧补 `part`（保留原 code 与全部 params —— 判据仍按原 reason 断言）。 */
function withPart(error: DomainError, part: string): DomainError {
  return Object.freeze({ ...error, params: Object.freeze({ ...error.params, part }) })
}

/** 未使用占位：保持 `PNG_COLOR_TYPE_RGBA` 可达（判据经它核对 IHDR 色彩类型）。 */
export const __PNG_COLOR_TYPE_RGBA = PNG_COLOR_TYPE_RGBA
