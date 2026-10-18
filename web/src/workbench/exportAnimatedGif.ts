/**
 * 场景 GIF：等轴烘焙链上的**真实场景动画导出**（M5-4）。
 *
 * ## 为什么走等轴烘焙链而不是内核快照作业（选型理由，**不是**懒）
 *
 * ⚠️ 设计稿 §4.3 原来的理由之一是"呈现链不采纹理时间，经它出的 GIF 画面不动"——
 * **那条理由已被 M5-3 作废**：`presentation/presenter` 现在确实按场景时间写
 * `repeat.y`/`offset.y`（`presenter.ts` 的竖条裁切段）。维持本选型的**当前**理由是：
 *
 *  1. **同链判据**：PNG 与 GIF 同渲染器/同相机/同尺寸/同材质库 ⇒ "GIF 首帧 ≈ 同参数 PNG"
 *     才能作为一条可观测判据（e2e C9）。两条链各画一张，这条判据就退化成"两张图差不多"。
 *  2. ~~**作业面表达不了逐帧 hold**~~ —— **该理由已被 M6-2 作废**：
 *     `domain/captureSpec` 现已有 `scene-holds`（逐帧驻留是唯一权威）与
 *     `CaptureTime.holdMs`，`RenderedFrame.holdMs` 随帧搬运，
 *     `adapters/export/gifEncoderPort` 也真的能编 `animation` + `gif`。
 *     ⇒ 现在**只剩**上面第 1 条（同链判据）与"呈现链纹理域尚未接线"（M6-3 的前置）。
 *     本文件随 seam `isometric-export-legacy-bake` 一起退出，不是因为这条已消失的理由。
 *
 * 于是本包复用与等轴 PNG **同一条**烘焙链（`workbench/exportIsometricImage#openIsometricStage`），
 * 时间序列本身则完全冻结（`planSequenceLoop` 一次算完）。M6 整链替换时本文件一并退出。
 *
 * ## 时间从哪来
 *
 * `materialLibrary.animatedSequences()` 报告"这个库实际会采样的帧条"（帧数 + 每帧毫秒），
 * `domain/materials#planSequenceLoop` 把它排成**共同循环**的逐帧采样点与厘秒时延。
 * 本文件自己**不**解释 mcmeta、不累加 tick、不读墙钟 —— 时间序列一次性算完即冻结。
 */

import type * as THREE from 'three'

import { planSequenceLoop } from '@/domain/materials'
import { encodeGifFrames, type RgbaFrame } from '@/workbench/animatedGifEncoder'
import { openIsometricStage } from '@/workbench/exportIsometricImage'

export interface AnimatedGifBakeResult {
  readonly blob: Blob
  readonly frameCount: number
  readonly totalMs: number
  readonly delayCs: readonly number[]
  /** 与 `CaptureTime{index,time,seconds}` 同构的采样序列（缺 `time: TimeValue`，接线时由 `timeValue(frame,fps)` 补）。 */
  readonly frames: readonly { readonly atMs: number; readonly seconds: number }[]
  readonly materialIds: readonly string[]
}

/** 读一帧的像素（WebGL 原点在左下 ⇒ 由 `encodeGifFrames({flipY:true})` **只翻一次**）。 */
function readStagePixels(renderer: THREE.WebGLRenderer, size: number): RgbaFrame {
  const gl = renderer.getContext()
  const buf = new Uint8Array(size * size * 4)
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  return { data: buf, width: size, height: size }
}

function nextMicrotask(): Promise<void> {
  // 只让出微任务队列（不引入 setTimeout/rAF/墙钟：导出不读运行时间）。
  return Promise.resolve()
}

/**
 * 把**场景**渲染成"纹理序列一个循环"的 GIF89a。
 *
 * @param directionIndex 0..3（与等轴 PNG 同一张四向表）
 * @param options.pixelSize 边长（默认 480，夹 64..1024 —— 与 PNG 同口径）
 * @throws 没有动画序列 / 循环超限 / 渲染或编码失败（**不**产出静图冒充 GIF）
 */
export async function bakeIsometricGifBlob(
  document: unknown,
  directionIndex: number,
  options?: { pixelSize?: number },
): Promise<AnimatedGifBakeResult> {
  const size = Math.max(64, Math.min(1024, options?.pixelSize ?? 480))
  const stage = await openIsometricStage(document, directionIndex, { pixelSize: size, seconds: 0 })
  try {
    // ② 库自己报告"它实际会采样什么"（唯一解释器；不从 plain doc 再解析一遍）。
    const sequences = stage.materialLibrary.animatedSequences()
    // ③ 一个共同循环的逐帧时间计划（纯函数）。`materialId` 在这里映射成计划的稳定 `id`。
    const plan = planSequenceLoop(sequences.map((s) => ({
      id: s.materialId,
      frameCount: s.frameCount,
      durationsMs: s.durationsMs,
    })))
    if (!plan.ok) {
      throw new Error(`GIF 时间计划失败: ${plan.error.code} ${JSON.stringify(plan.error.params)}`)
    }
    const { atMs, delayCs, totalMs } = plan.value

    // ④ 逐帧：写时间 → 渲染 → 读回。**每帧都必须重新 render** ——
    //    只改 offset 不重绘会得到同一张图（"渲染一次复制 N 帧"的假动画）。
    const frames: RgbaFrame[] = []
    for (const ms of atMs) {
      stage.materialLibrary.setSceneTime(ms / 1000)
      stage.renderer.render(stage.scene, stage.ortho)
      frames.push(readStagePixels(stage.renderer, size))
      await nextMicrotask()
    }

    // ⑤ 编码：WebGL 行序在 encodeGifFrames 里翻**一次**（flipY: true）。
    const blob = await encodeGifFrames(frames, delayCs, { palette: 'frame', flipY: true })
    return {
      blob,
      frameCount: plan.value.frameCount,
      totalMs,
      delayCs,
      frames: atMs.map((ms) => ({ atMs: ms, seconds: ms / 1000 })),
      materialIds: sequences.map((s) => s.materialId),
    }
  } finally {
    // ⑥ 释放与 PNG 同一顺序（stage.dispose 幂等）。
    stage.dispose()
  }
}
