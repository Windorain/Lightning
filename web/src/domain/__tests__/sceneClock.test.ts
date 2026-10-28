/**
 * **场景秒数唯一化**（`domain/animation#sceneClockOf`）的判定面。
 *
 * ## 本文件钉什么
 *
 * 呈现侧此前有三处"各算一份"的换算：`composition/kernelRuntime#sceneSeconds`
 * （连续）、`composition/presenterSession#presentationTimeOf`（连续复制件）、
 * `workbench/ux/panels/MaterialGallery#sceneSeconds`（**离散**：Σ 之前各帧
 * `durationMs`，缺省 50 ms）。三者只在"整数帧、等长帧时长"这份特例上巧合一致。
 *
 * 现在权威只有 `sceneClockOf`，本文件把它的判据钉住：
 *
 *  1. **连续口径**：秒 = 帧 / 帧率（有理精确）；
 *  2. **非法帧率 ⇒ 0**（**不得**回落到 `secondsOf` 的 20 fps 缺省）；
 *  3. **负对照（能区分离散口径）**：不等帧时长轴上，同一时刻的"连续秒"与
 *     "Σ durations 到当前帧起点"**必须不同** —— 若有人把权威换回离散公式，本用例红。
 *
 * ## 为什么负对照里要显式写一份"旧公式"
 *
 * 只断言 `0.025 === 0.025` 抓不到退化：真正的风险是"实现被换回离散口径而测试
 * 还在比同一个函数"。故这里把**旧面板公式**逐字写出来作对照物（它本来就不是被测实现），
 * 两侧都读同一份帧时长轴 —— 差异来自**口径**，不是来自夹具。
 */
import { describe, expect, it } from 'vitest'
import { sceneClockOf, sceneSecondsOf, framesPerSecond, secondsOf, timeValue } from '@/domain/animation'
import { stripTimeline } from '@/domain/materials'

/** 有理帧率（`FrameRateSpec` 的 `{num,den}` 形态）。 */
const FPS_29_97 = Object.freeze({ num: 30000, den: 1001 })

describe('场景时钟：连续口径（唯一权威）', () => {
  it('整数帧：frame/fps（0 ⇒ 0、10@20 ⇒ 0.5）', () => {
    expect(sceneClockOf(timeValue(0, 20)).seconds).toBe(0)
    expect(sceneSecondsOf(timeValue(0, 20))).toBe(0)
    expect(sceneClockOf(timeValue(10, 20)).seconds).toBe(0.5)
  })

  it('有理帧率：精确为 1001/30000（不是浮点近似后再比）', () => {
    const clock = sceneClockOf(timeValue(1, FPS_29_97))
    expect(Math.abs(clock.seconds - 1001 / 30000)).toBeLessThan(1e-12)
    // 与 domain 的精确有理秒**同一结果**（同一条换算，不得二次取整）
    const exact = secondsOf(timeValue(1, FPS_29_97))
    expect(clock.seconds).toBe(exact.num / exact.den)
  })

  it('numerator 是帧号；整数帧率时 denominator 是帧率', () => {
    expect(sceneClockOf(timeValue(7, 20)).numerator).toBe(7)
    expect(sceneClockOf(timeValue(7, 20)).denominator).toBe(20)
    // 有理帧率的分母给 1（键序列化只做诊断；seconds 才是判定值）
    expect(sceneClockOf(timeValue(7, FPS_29_97)).denominator).toBe(1)
    expect(sceneClockOf(timeValue(0.5, 20)).numerator).toBe(0.5)
  })

  it('非法帧率 ⇒ 全零，**不得**回落到 20 fps 缺省', () => {
    for (const fps of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const clock = sceneClockOf({ frame: 10, fps })
      expect(clock, `fps=${String(fps)} 必须给全零`).toEqual({ seconds: 0, numerator: 0, denominator: 1 })
    }
    // 对照：`secondsOf` 自己的缺省是 DEFAULT_FRAME_RATE=20 —— 这正是不能用它的原因。
    expect(framesPerSecond(0)).toBe(0)
    expect(secondsOf({ frame: 10, fps: 0 }).num / secondsOf({ frame: 10, fps: 0 }).den).toBe(0.5)
  })
})

describe('负对照：连续口径 ≠ 离散帧轴口径', () => {
  /** 不等帧时长轴：帧 0/1/2 各 100/300/50 ms（与设计 §5.2-① 同形）。 */
  const timeline = stripTimeline([0, 1, 2], [100, 300, 50])

  /**
   * **旧面板公式**（逐字复刻）：Σ 当前帧**之前**各帧 durationMs，缺项回落 50 ms。
   *
   * 它是被删除的实现，不是被测权威；保留在这里是为了让"换回它会红"可被机械判定。
   */
  function legacyPanelSceneSeconds(frameIndex: number): number {
    let ms = 0
    for (let i = 0; i < frameIndex; i++) {
      const d = timeline.durationMs[i]
      ms += typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 50
    }
    return ms / 1000
  }

  it('frame=0.5@20fps ⇒ 0.025 s，而"Σ 到第 0 帧起点"是 0 —— 两个口径必须不同', () => {
    const clock = sceneClockOf(timeValue(0.5, 20))
    expect(clock.seconds).toBe(0.025)
    expect(legacyPanelSceneSeconds(0)).toBe(0)
    expect(clock.seconds, '离散口径给 0；权威给 0.025 —— 若相等说明口径又被合并了').not.toBe(
      legacyPanelSceneSeconds(0),
    )
  })

  it('帧内时刻不进离散阶跃：1.5 帧仍是连续 0.075 s（离散口径停在 0.1 s 的起点 0）', () => {
    expect(sceneClockOf(timeValue(1.5, 20)).seconds).toBe(0.075)
    expect(legacyPanelSceneSeconds(1), '离散口径在帧 1 起点给 0.1 s').toBeCloseTo(0.1, 12)
  })
})
