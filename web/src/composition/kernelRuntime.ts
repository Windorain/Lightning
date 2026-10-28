/**
 * `composition/kernelRuntime` —— **内核会话的装配与帧时钟**（接线落点）。
 *
 * ## 为什么帧时钟在 `composition/` 而不是 `runtime/`
 *
 * | 层 | 纪律 | 后果 |
 * |---|---|---|
 * | `runtime/` | `corePurity: true` —— 不得 import Vue/Three/DOM，不得读全局时钟 | 内核**不能**自持 `requestAnimationFrame`（那正是要退役的形态） |
 * | `composition/` | 装配根：把各层装到一起、持有宿主端口与资源 | 帧时钟、DOM 事件、视口生命周期都在这里 |
 *
 * 于是"业务推进可枚举"有一条**结构性**保证：
 * 全树唯一的业务帧时钟就在本文件，它做的事只有一件 ——
 * 算出经过的秒数并交给 `KernelSession.frame(delta)`。
 *
 * ## 与旧 `renderEngine` RAF 的区别（判据不是"有没有 RAF"）
 *
 * `presentation-purity` 闸门的判据原文是「**所有业务推进可枚举**；
 * **局部绘制唤醒不写领域状态**」——它**不**要求零 RAF。违规的是
 * 「多 RAF 分别推进业务」。旧形态的病灶是**同一个 RAF 里混了两件事**：
 *
 * ```ts
 * const tick = () => {
 *   requestAnimationFrame(tick)
 *   opts.materialLibrary.tick(clock.getDelta() * 1000)  // ← 业务：每材质自行累计时间
 *   ...
 *   vp.renderMain()                                      // ← 绘制
 * }
 * ```
 *
 * 本模块把两者**分开**：本文件的 RAF 只做业务推进（把 delta 交给内核），
 * `RenderEngine` 的 RAF 只做绘制（不再持有任何时间语义）。
 * 于是"绘制唤醒不写领域状态"成为结构事实，而不是纪律要求。
 *
 * ## 帧时钟的两种输入（显式区分，不混）
 *
 *  - **逻辑秒数**：由 `performance.now()` 的差值算出，作为 `advancePlayback`
 *    命令的参数注入内核。它是"经过了多少逻辑时间"这一**输入**；
 *  - **墙钟**：只在本文件出现，**不**进内核（内核不读时钟）。
 *
 * 暂停时内核判 `unchanged`，故"暂停时仍每帧发推进命令"是零副作用的
 * —— 宿主不必自己判断（那个判断会变成第二份播放状态判据）。
 */

import type { KernelSession } from '@/runtime/kernelSession'
import type { TimeValue } from '@/domain/animation'
import { sceneSecondsOf } from '@/domain/animation'

/**
 * 帧时钟的对外面。
 *
 * `dispose()` 必须停掉 RAF —— 与 `RenderEngine.dispose()` 同一纪律：
 * 残留的 RAF 会在组件卸载后继续推进内核时间（一次真实的"幽灵推进"）。
 */
export interface FrameClock {
  /** 是否正在运行。 */
  readonly running: boolean
  /** 启动（幂等）。 */
  start(): void
  /** 停止（幂等）；**不**重置时间（时间归内核）。 */
  stop(): void
  /**
   * 每帧推进后的观测回调（供呈现消费）。
   *
   * 返回取消注册函数。回调**只读**语义：它不得写内核状态
   * （写必须经 `submit`，即唯一写通路）。
   */
  onFrame(fn: (info: FrameTickInfo) => void): () => void
}

/** 一次帧推进的事实（供呈现判断"要不要重绘"）。 */
export interface FrameTickInfo {
  /** 本帧注入的逻辑秒数。 */
  readonly deltaSeconds: number
  /** 推进后的时间（内核权威值）。 */
  readonly time: TimeValue
  /** 推进后的帧下标（派生值）。 */
  readonly frameIndex: number
  /** 本次推进是否真的改变了时间（暂停/倍率 0 ⇒ `false`）。 */
  readonly advanced: boolean
}

export interface FrameClockOptions {
  readonly session: KernelSession
  /**
   * 帧时钟的驱动源（`requestAnimationFrame`）。
   *
   * 显式注入而不是直接调全局：`composition` 层虽然允许碰 DOM，
   * 但**测试**需要在不启动真 RAF 的情况下验证"每帧注入一次 delta"。
   * 注入后，测试可以喂一个确定性的驱动源，于是"每帧一次"这条判据
   * 可以被精确断言，而不是靠等待真实帧。
   */
  readonly raf?: {
    request(cb: (t: number) => void): number
    cancel(handle: number): void
  }
  /** 单调时钟（毫秒）。缺省 `performance.now`；测试可注入。 */
  readonly now?: () => number
  /**
   * 单帧 delta 的**上限**（秒）。
   *
   * 为什么需要：切回标签页、断点调试、系统休眠都会产生一个巨大的
   * `performance.now()` 差值。若原样注入，播放会**瞬移**到很晚的时间
   * （旧 `simpleMaterialLibrary.tick` 用 `Math.min(256, …)` 挡的正是同一件事）。
   *
   * 与旧做法的差别：旧实现是"截断后仍累加进 `accMs`"，于是被丢掉的时间
   * 永久丢失、且累加器状态不可复现；这里截断的是**注入的输入**
   * （`deltaSeconds`），内核状态仍只有"当前时间"一个权威 ——
   * 故"同一时间 ⇒ 同一样本"不受影响。
   */
  readonly maxDeltaSeconds?: number
  /**
   * 订阅者抛错时的上报口：宿主把它接到诊断面。
   *
   * 为什么需要：`onFrame` 的订阅者（视口、观测、叠加层）各自有缺陷，一个抛错不能
   * 打断其它订阅者，也不能打断帧推进 —— 于是它此前只写了一句 `console.error`，
   * 而用户看到的是"画面偶尔不动"且没有任何可查记录。
   */
  readonly onListenerError?: (error: unknown) => void
}

/** 缺省单帧上限：0.25 秒（约 4fps 以上都正常；更长的间隔视为"离屏"）。 */
export const DEFAULT_MAX_DELTA_SECONDS = 0.25

/**
 * 造一个帧时钟。
 *
 * 注意它**不**在构造时启动 —— 启动由宿主在挂载点决定（`start()`），
 * 这样"什么时候开始推进业务"是显式的，不是构造的副作用。
 */
export function createFrameClock(opts: FrameClockOptions): FrameClock {
  const session = opts.session
  const raf = opts.raf ?? {
    request: (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0),
    cancel: (h) => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h)
    },
  }
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
  const maxDelta = opts.maxDeltaSeconds ?? DEFAULT_MAX_DELTA_SECONDS

  let handle: number | null = null
  let lastMs: number | null = null
  const listeners = new Set<(info: FrameTickInfo) => void>()

  const tick = (): void => {
    handle = null
    const t = now()
    // 首帧没有"上一次"⇒ delta 为 0（不把"从会话构造到现在"的整段时间算进去，
    // 那会让第一次播放瞬移到很晚）。
    const rawDeltaMs = lastMs === null ? 0 : t - lastMs
    lastMs = t
    const deltaSeconds = Math.min(maxDelta, Math.max(0, rawDeltaMs / 1000))

    const before = session.playback().time
    session.frame(deltaSeconds)
    const after = session.playback().time
    const advanced = before.frame !== after.frame

    const info: FrameTickInfo = Object.freeze({
      deltaSeconds,
      time: after,
      frameIndex: session.frameIndex(),
      advanced,
    })
    for (const fn of listeners) {
      try {
        fn(info)
      } catch (e) {
        // 单个订阅者抛错不影响其它订阅者，也不回滚内核状态
        // （状态已原子发布；异常属于订阅者自己的缺陷）。
        // 改由宿主注入的上报口进诊断面（缺省没人接 = 静默，但结构上不再直写控制台）。
        opts.onListenerError?.(e)
      }
    }
    if (handle === null && running) handle = raf.request(tick)
  }

  let running = false

  return {
    get running() {
      return running
    },
    start(): void {
      if (running) return
      running = true
      lastMs = null
      handle = raf.request(tick)
    },
    stop(): void {
      running = false
      if (handle !== null) {
        raf.cancel(handle)
        handle = null
      }
      lastMs = null
    },
    onFrame(fn: (info: FrameTickInfo) => void): () => void {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/**
 * 由内核播放快照算出**场景秒数**（纹理/通道动画的统一时间输入）。
 *
 * ## 权威在 `domain/animation#sceneClockOf`
 *
 * 内容面契约要求纹理序列"默认绑定**场景时间**"，且「所有影响输出的时间来源
 * 与参数进入相应求值键」。于是"场景秒数"必须**只有一个**定义点 ——
 * 否则材质面板、渲染侧、导出各算一份，同一时刻会得到不同的采样结果
 * （那正是「双 Area/跳帧/离屏导出一致」判据要判红的形态）。
 *
 * 本导出**只是宿主端口**（`runtime/host.ts` 注入 `ViewportPresenterBundle.sceneSeconds`）
 * 的稳定入口：函数体委托 `domain` 的唯一实现，不在装配层重写算法。
 *
 * 与旧做法的关键差别：旧 `MaterialGallery.sceneSeconds()` 是"累加当前帧**之前**
 * 各帧的 `durationMs`"（一个**离散帧**口径），而旧 `simpleMaterialLibrary.accMs`
 * 是"每材质自持的毫秒累加器"（一个**连续**口径）。两个口径不同源 ⇒
 * 面板里看到的帧与视口里看到的帧可以不一致。权威函数是**连续**口径
 * （时间 × 帧率），且它是**唯一**的。
 */
export function sceneSeconds(time: TimeValue): number {
  return sceneSecondsOf(time)
}
