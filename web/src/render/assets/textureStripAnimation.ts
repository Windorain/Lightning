/**
 * 竖条多帧纹理动画：与 Java 版 `.png.mcmeta` 中 `animation` 字段**形状**对齐的配置解析与时间轴。
 * 实际数据来自 StructureData `materialPalette[].animation` 与 PNG 尺寸；**不**通过 HTTP 加载独立 `.mcmeta` 文件。
 * 行为参考 Java版：竖直帧条、frametime 以 tick 计（1 tick = 1/20 s）。
 */

/** Java 版：1 tick = 50 ms */
export const MINECRAFT_TICK_MS = 50

export interface McmetaFrameSpec {
  index: number
  /** 本帧持续 tick 数；缺省用全局 frametime */
  timeTicks?: number
}

export interface ParsedMcmetaAnimation {
  /** 默认每帧 tick（animation.frametime，默认 1） */
  defaultFrametimeTicks: number
  /** 帧序列：自上而下第 0 帧为 PNG 最上一格；若缺省则 0..frameCount-1 */
  frameSequence: McmetaFrameSpec[]
  interpolate: boolean
}

export interface ParsedMcmeta {
  animation?: ParsedMcmetaAnimation
}

/** 自图像尺寸推导竖直条带帧数（每帧正方形边长 = 宽） */
export function frameCountFromImageSize(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1
  if (height % width !== 0) {
    throw new Error(
      `动画纹理高度须为宽度的整数倍：width=${width} height=${height}`,
    )
  }
  const n = height / width
  if (n < 1) return 1
  return n
}

export function parseMcmetaJson(text: string): ParsedMcmeta {
  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch {
    return {}
  }
  if (!data || typeof data !== 'object') return {}
  const root = data as Record<string, unknown>
  const anim = root.animation
  if (!anim || typeof anim !== 'object') return {}

  const a = anim as Record<string, unknown>
  const defaultFrametimeTicks =
    typeof a.frametime === 'number' && a.frametime > 0 ? Math.floor(a.frametime) : 1
  const interpolate = a.interpolate === true

  const framesRaw = a.frames
  const frameSequence: McmetaFrameSpec[] = []

  if (Array.isArray(framesRaw)) {
    for (const item of framesRaw) {
      if (typeof item === 'number') {
        frameSequence.push({ index: item })
      } else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        const idx = typeof o.index === 'number' ? o.index : Number(o.index)
        if (!Number.isFinite(idx)) continue
        const timeTicks =
          typeof o.time === 'number' && o.time > 0 ? Math.floor(o.time) : undefined
        frameSequence.push({ index: idx, timeTicks })
      }
    }
  }

  const animation: ParsedMcmetaAnimation = {
    defaultFrametimeTicks,
    frameSequence,
    interpolate,
  }

  return { animation }
}

/**
 * 在已知帧条帧数下，得到完整帧序与每帧持续毫秒（循环播放）。
 * 若配置未指定 frames，则顺序播放 0..frameCount-1。
 */
export function resolveAnimationTimeline(
  parsed: ParsedMcmeta,
  frameCount: number,
): { frames: McmetaFrameSpec[]; durationMsPerFrame: number[] } {
  const anim = parsed.animation
  if (!anim || frameCount < 1) {
    return {
      frames: [{ index: 0 }],
      durationMsPerFrame: [MINECRAFT_TICK_MS],
    }
  }

  let seq = anim.frameSequence
  if (seq.length === 0) {
    seq = Array.from({ length: frameCount }, (_, i) => ({ index: i }))
  }

  const frames: McmetaFrameSpec[] = seq.map((f) => ({
    index: ((f.index % frameCount) + frameCount) % frameCount,
    timeTicks: f.timeTicks,
  }))

  const durationMsPerFrame = frames.map((f) => {
    const ticks = f.timeTicks ?? anim.defaultFrametimeTicks
    return ticks * MINECRAFT_TICK_MS
  })

  return { frames, durationMsPerFrame }
}
