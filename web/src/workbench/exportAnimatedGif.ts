/**
 * 场景 GIF：等轴烘焙链上的**真实场景动画导出**（M5-4）。
 *
 * ## 为什么走 legacy 烘焙链而不是内核快照作业（选型理由，**不是**懒）
 *
 * 内核离屏快照链（`adapters/export/snapshotExportJob` + `SnapshotOffscreenRenderPort`）今天
 * 表达不了"纹理序列的一个循环"：
 *
 *  1. `domain/captureSpec` 的 `TimeMapping` 只有**均匀** `stepFrames`（`planCaptureFrames` 也
 *     只按 `baseFrame + step*i` 生成）⇒ "逐帧不等 hold"在作业面上**不可表达**；
 *  2. `EncoderInput` 没有逐帧 hold 字段 ⇒ GIF 编码端口拿不到时延；
 *  3. 更关键的是**画面**：`presentation/presenter` 尚不按时间裁切帧条（M5-2 的另一半），
 *     经那条链出的 GIF 会把整条竖帧贴图压到一个面上 —— 产物"看起来没动"却报成功。
 *
 * 因此本包复用与等轴 PNG **同一条**烘焙链（`workbench/exportIsometricImage#openIsometricStage`）：
 * 同渲染器、同相机、同尺寸、同材质库 ⇒ "GIF 第 k 帧"与"同 `seconds` 的 PNG"
 * 从结构上就是同一张图（e2e C9 就把这条当作可观测判据）。
 * 作业面缺口已登记进 seams（M6 前置），不是被忽略。
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
