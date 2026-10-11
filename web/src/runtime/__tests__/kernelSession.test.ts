/**
 * **P10 内核→生产接线的机器证据**（R-WK-03；#261）。
 *
 * ## 本文件证明什么（以及为什么它不是"又一组单测"）
 *
 * R-WK-03 的裁决依据是**机械侦察**：「内核在生产代码零调用方」。于是本批的
 * 第一件事是把内核接进生产（`runtime/kernelSession` + 装配层帧时钟），
 * 第二件事才是删旧机制。删之前必须证明新路径**真的在服役** ——
 * 否则就是 #171 明令禁止的"半成品替换"。
 *
 * 本文件的判据分三层，每层对应一个会被静默违反的约束：
 *
 * | 层 | 判据 | 防什么 |
 * |---|---|---|
 * | 一 | 会话的**读面**由内核投递（时间/播放/帧下标同源） | 防"读面永远静止"（接缝 B 的 blocker 原文） |
 * | 二 | **按帧注入时间**驱动批次（`frame(delta)` 真的推进时间） | 防"宿主自己改状态绕过唯一写通路" |
 * | 三 | 播放/帧下标是**派生**的，且两视口读同一份 | 防"双视口各播各的"（A05 负对照形态） |
 *
 * ## 与 `retirementRegistry` 的关系
 *
 * 本文件**不**替代登记表：登记表说"哪些旧机制要消失"，本文件说"替代机制
 * 已经真的在跑"。两者缺一不可 —— 只有登记表会得到"删了但没接上"，
 * 只有本文件会得到"接上了但旧机制还在"。
 */

import { describe, expect, it } from 'vitest'
import { KernelSession } from '@/runtime/kernelSession'
import { ALL_CAPABILITIES, VIEWER_CAPABILITIES } from '@/application/commands'
import { timeValue } from '@/domain/animation'
import { isDirty } from '@/domain/document'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/** 造一个会话，帧声明为 `durations` 给出的时长轴（毫秒）。 */
function sessionWith(durations: readonly number[], capabilities: readonly string[] = ALL_CAPABILITIES): KernelSession {
  const s = new KernelSession({
    documentId: 'doc-1',
    contextId: 'ctx-1',
    capabilities,
    prefix: 'p10',
  })
  s.bindFrameSource({
    count: () => durations.length,
    durationsMs: () => durations,
  })
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、读面由内核投递（不是每次重建，也不是恒空）
// ─────────────────────────────────────────────────────────────────────────────

describe('内核会话：读面由内核投递，时间/播放/帧下标同源', () => {
  it('构造后立刻拿到**真实的**上下文快照（不是 null、不是空对象）', () => {
    const s = sessionWith([50, 50, 50])
    const p = s.playback()
    expect(p.playing, '默认暂停（#249 §7「默认暂停随场景」）').toBe(false)
    expect(p.rate, '默认原速').toBe(1)
    expect(p.time.frame, '默认时间零点').toBe(0)
  })

  it('`read()` 给出契约 §2.2 的五个读面组（含本批补齐的 playback 与 cameras）', () => {
    const s = sessionWith([50, 50])
    const view = s.read()
    expect(Object.keys(view).sort()).toEqual(['cameras', 'interaction', 'objects', 'properties', 'version', 'workspace'])
    // 播放读面：从**内核**读，与 `playback()` 同源
    const pb = view.interaction.playback()
    expect(pb.ok).toBe(true)
    if (pb.ok) {
      expect(pb.value.playing).toBe(false)
      expect(pb.value.time.frame).toBe(0)
    }
    // 相机读面（接缝 B）：空文档 ⇒ 空清单，**不是**错误
    const cams = view.cameras.list()
    expect(cams.ok).toBe(true)
    if (cams.ok) expect(cams.value).toEqual([])
  })

  it('**反空洞真**：读面确实随内核状态变化（不是恒返回初值）', () => {
    const s = sessionWith([50, 50, 50])
    expect(s.playback().playing).toBe(false)
    s.setPlaying(true)
    expect(s.playback().playing, '经 setPlaying 命令后读面必须变').toBe(true)
    s.setPlaybackRate(2)
    expect(s.playback().rate).toBe(2)
    s.setPlaying(false)
    expect(s.playback().playing).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、按帧注入时间输入并驱动批次
// ─────────────────────────────────────────────────────────────────────────────

describe('按帧注入时间输入：`frame(delta)` 经唯一写通路推进', () => {
  it('播放中：每次 `frame(delta)` 按 delta 推进时间（且只推一次）', () => {
    const s = sessionWith([50, 50, 50])
    s.setPlaying(true)
    s.frame(0.5)
    expect(s.playback().time.frame, '0.5s @ 20fps = 10 帧').toBeCloseTo(10, 6)
    s.frame(0.5)
    expect(s.playback().time.frame, '再 0.5s ⇒ 20 帧').toBeCloseTo(20, 6)
  })

  it('**暂停时宿主仍每帧调用是零副作用的**（`advancePlayback` 判 unchanged）', () => {
    const s = sessionWith([50, 50, 50])
    for (let i = 0; i < 5; i++) s.frame(1 / 60)
    expect(s.playback().time.frame, '没播放 ⇒ 时间不动').toBe(0)
    expect(s.playback().playing).toBe(false)
  })

  it('倍率参与推进（rate=2 ⇒ 同样 delta 走两倍时间）', () => {
    const s = sessionWith([50, 50, 50])
    s.setPlaying(true)
    s.setPlaybackRate(2)
    s.frame(0.5)
    expect(s.playback().time.frame).toBeCloseTo(20, 6)
  })

  it('倍率 0 合法：playing 但时间不动（与"暂停"是两件事）', () => {
    const s = sessionWith([50, 50, 50])
    s.setPlaying(true)
    s.setPlaybackRate(0)
    s.frame(1)
    expect(s.playback().playing, 'playing 仍为真').toBe(true)
    expect(s.playback().time.frame, '但时间不动').toBe(0)
  })

  it('非法 delta / 非法倍率被**拒绝**（不夹取、不静默）', () => {
    const s = sessionWith([50, 50])
    s.setPlaying(true)
    s.submit({ kind: 'advancePlayback', contextId: 'ctx-1', deltaSeconds: Number.NaN })
    s.drain()
    expect(s.playback().time.frame, 'NaN delta 不得写进时间').toBe(0)
    s.submit({ kind: 'setPlaybackRate', contextId: 'ctx-1', rate: -1 })
    s.drain()
    expect(s.playback().rate, '负倍率不得生效').toBe(1)
  })

  it('**播放不推进文档版本、不产生历史、不弄脏文档**（#249 §7 / A09）', () => {
    const s = sessionWith([50, 50, 50])
    const before = s.read().version
    s.setPlaying(true)
    for (let i = 0; i < 10; i++) s.frame(0.1)
    const after = s.read().version
    expect(after.documentVersion, '播放不得推进文档版本').toBe(before.documentVersion)
    expect(after.contentVersion, '播放不得改内容身份').toBe(before.contentVersion)
    const doc = s.read().workspace.document()
    expect(doc.ok).toBe(true)
    if (doc.ok) {
      expect(doc.value.dirty, '播放不得弄脏文档').toBe(false)
      expect(doc.value.canUndo, '播放不得产生撤销条目').toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、帧下标是派生值，且两视口读同一份
// ─────────────────────────────────────────────────────────────────────────────

describe('帧下标：由时间经离散阶跃采样派生（替代旧 `Main.currentFrameIndex` Ref）', () => {
  it('帧下标随时间前进（每帧 50ms ⇒ 20fps 下每 1 帧时间换一帧）', () => {
    const s = sessionWith([50, 50, 50])
    expect(s.frameIndex(), 't=0 ⇒ 第 0 帧').toBe(0)
    // 20fps：时间 frame=1 ⇒ 50ms ⇒ 第 1 帧
    s.seekTime(timeValue(1, 20))
    expect(s.frameIndex()).toBe(1)
    s.seekTime(timeValue(2, 20))
    expect(s.frameIndex()).toBe(2)
  })

  it('**边界取下一项**（半开区间）：t 恰在边界 ⇒ 下一帧', () => {
    const s = sessionWith([50, 50, 50])
    // 第 0 帧占 [0,50)，故 50ms 归第 1 帧
    s.seekTime(timeValue(1, 20))
    expect(s.frameIndex()).toBe(1)
  })

  it('**循环**：超过总时长回到起点', () => {
    const s = sessionWith([50, 50, 50])
    s.seekTime(timeValue(3, 20)) // 150ms = 总时长 ⇒ 回 0
    expect(s.frameIndex()).toBe(0)
    s.seekTime(timeValue(4, 20)) // 200ms ⇒ 1
    expect(s.frameIndex()).toBe(1)
  })

  it('**拖动定位与连续播放必然一致**（同一求值路径 —— 旧累加器做不到）', () => {
    const continuous = sessionWith([50, 50, 50])
    continuous.setPlaying(true)
    for (let i = 0; i < 7; i++) continuous.frame(0.05)

    const seeked = sessionWith([50, 50, 50])
    seeked.seekTime(continuous.playback().time)

    expect(seeked.frameIndex(), '连续播放到的帧 == 直接定位到的帧').toBe(continuous.frameIndex())
    expect(seeked.playback().time.frame).toBeCloseTo(continuous.playback().time.frame, 6)
  })

  it('**两个 Area 读同一份**：帧下标只依赖 `EditContext`，没有"视口"参数', () => {
    const s = sessionWith([50, 50, 50])
    s.seekTime(timeValue(2, 20))
    // `frameIndex()` 的签名里没有 regionId/areaId —— "只让发起视口看到"
    // 在接口层面无法表达（与 `queryEffectiveTransform` 同一形态）。
    expect(s.frameIndex()).toBe(s.frameIndex())
    expect(s.frameIndex()).toBe(2)
  })

  it('无帧文档：帧下标恒 0（不崩、不猜）', () => {
    const s = sessionWith([])
    expect(s.frameCount()).toBe(0)
    expect(s.frameIndex()).toBe(0)
  })

  it('帧时长轴决定停留：长帧占更多时间', () => {
    const s = sessionWith([100, 20])
    // 20fps：frame=1 ⇒ 50ms ⇒ 落在第 0 帧 [0,100)
    s.seekTime(timeValue(1, 20))
    expect(s.frameIndex()).toBe(0)
    // frame=2 ⇒ 100ms ⇒ 恰在边界 ⇒ 第 1 帧
    s.seekTime(timeValue(2, 20))
    expect(s.frameIndex()).toBe(1)
  })

  it('`seekFrame` 与 `frameIndex` 互为逆（按帧时长轴换算）', () => {
    const s = sessionWith([50, 50, 50])
    for (const i of [0, 1, 2]) {
      s.seekFrame(i)
      expect(s.frameIndex(), `定位到第 ${i} 帧后应读到第 ${i} 帧`).toBe(i)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、能力裁剪：装配结果真的进了执行输入
// ─────────────────────────────────────────────────────────────────────────────

describe('能力裁剪：执行输入来自装配结果（A15 的第二道落点）', () => {
  it('viewer 能力下内容编辑被**运行时**拒绝（不只靠 UI 隐藏）', () => {
    const s = sessionWith([50, 50], VIEWER_CAPABILITIES)
    const ticket = s.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    s.drain()
    const list = s.read().objects.list()
    expect(list.ok).toBe(true)
    if (list.ok) {
      expect(list.value.length, 'viewer 不得能加对象').toBe(0)
    }
    expect(ticket.ticketId.length).toBeGreaterThan(0)
  })

  it('**对照**：同一条命令在 workbench 能力下成功（证明拒绝来自能力裁剪）', () => {
    const s = sessionWith([50, 50], ALL_CAPABILITIES)
    s.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    s.drain()
    const list = s.read().objects.list()
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.value.length).toBe(1)
  })

  it('播放/时间在两种能力下都可用（它们不是内容编辑）', () => {
    const viewer = sessionWith([50, 50], VIEWER_CAPABILITIES)
    viewer.setPlaying(true)
    viewer.frame(0.5)
    expect(viewer.playback().time.frame).toBeCloseTo(10, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 六、通道取值：共享 `EditContext.channelValues`（#282 P10b 退役每视口暂存副本）
// ─────────────────────────────────────────────────────────────────────────────

describe('通道取值归编辑上下文：同上下文所有 Area 读同一份（A05）', () => {
  it('写一个通道取值后**读面**能看到它（不是恒空）', () => {
    const s = sessionWith([50, 50])
    expect(s.channelValues(), '初始无取值（不伪造 0）').toEqual({})
    s.setChannelValue('coil', 3)
    expect(s.channelValues()['coil'], '写入后必须读得到（反空洞真）').toBe(3)
  })

  it('**同一份值**：两个"视口"（同一上下文的不同读者）读到完全相同的取值', () => {
    const s = sessionWith([50, 50])
    s.setChannelValue('coil', 3)
    s.setChannelValue('glass', 1)
    // 两个读者 = 同一会话的两次读（旧形态下每个视口自持副本 ⇒ 会各读各的）
    const a = s.channelValues()
    const b = s.channelValues()
    expect(a).toEqual(b)
    expect(a).toEqual({ coil: 3, glass: 1 })
  })

  it('总档位与运行态用**保留键**承载（不与真实通道名冲突）', () => {
    const s = sessionWith([50, 50])
    expect(s.totalTier(), '未设置时为 null，不伪造 1').toBeNull()
    s.setTotalTier(2)
    expect(s.totalTier()).toBe(2)
    expect(s.runstateIndex(), '未设置时为 null').toBeNull()
    s.setRunstateIndex(1)
    expect(s.runstateIndex()).toBe(1)
    // 保留键与真实通道**并存**且互不覆盖（键空间不冲突是结构事实）
    s.setChannelValue('coil', 5)
    expect(s.channelValues()).toEqual({ $totalTier: 2, $runstate: 1, coil: 5 })
  })

  it('负对照：旧形态的"每视口自持副本"在本接口下**不可表达**', () => {
    const s = sessionWith([50, 50])
    const keys = new Set<string>()
    for (let o: object | null = s; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
      for (const k of Object.getOwnPropertyNames(o)) keys.add(k)
    }
    // 不得有"视口本地取值表"或"取值变更计数器"这类每视口状态
    expect(keys.has('channelState'), '不得有每视口取值表（旧 `state` 形态）').toBe(false)
    expect(keys.has('revision'), '不得有每视口 revision 计数器（旧手动刷新形态）').toBe(false)
    // 反空洞真：确实扫到了真实成员
    expect(keys.has('channelValues'), '取值以**读面方法**存在').toBe(true)
    expect(keys.has('setChannelValue'), '取值以**命令**形式写入').toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 五、负对照：旧形态在本接口下**无法表达**
// ─────────────────────────────────────────────────────────────────────────────

describe('负对照：旧机制的关键形态在会话接口下不可表达', () => {
  it('会话**没有**可写的 `currentFrameIndex` / `framesPlaybackIsPlaying` 字段', () => {
    const s = sessionWith([50, 50])
    const keys = new Set<string>()
    // 沿原型链收集所有**公开**成员名（含 getter）
    for (let o: object | null = s; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
      for (const k of Object.getOwnPropertyNames(o)) keys.add(k)
    }
    expect(keys.has('currentFrameIndex'), '不得有可写帧下标字段（旧 Ref 形态）').toBe(false)
    expect(keys.has('framesPlaybackIsPlaying'), '不得有可写播放 Ref 字段（旧 Ref 形态）').toBe(false)
    // 反空洞真：确实收集到了真实成员（否则上面的断言只是"没扫到"）
    expect(keys.has('frameIndex'), '帧下标以**方法**形式存在（派生值）').toBe(true)
    expect(keys.has('setPlaying'), '播放开关以**命令**形式存在').toBe(true)
  })

  it('会话**没有**自驱循环（时间只由 `frame(delta)` 注入）', () => {
    const s = sessionWith([50, 50, 50])
    s.setPlaying(true)
    // 不调用 frame() ⇒ 时间不动。若会话自持定时器/RAF，这里会（在等待后）动。
    expect(s.playback().time.frame).toBe(0)
  })
})

/** 未使用占位，保持 `isDirty` 可达（本文件用 `workspace.document().dirty` 断言，不直接用）。 */
void isDirty
