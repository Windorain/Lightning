/**
 * 资源**归属与引用计数**（「视口销毁只释放其所有权份额，最后引用释放后资源必须回收」；
 * 所有权表「GPU 缓冲、纹理…显式获取、引用计数或独占释放 ⇒ 归属资源 acquire/release
 * 平衡」）。
 *
 * ## 为什么判据必须是显式计数而不是 GC
 *
 * 判据原文：「一方关闭不破坏另一方；**归属资源 acquire/release 平衡**；清空允许缓存后活跃
 * 计数回基线」，并在 §14 尾部明确「用**显式资源计数**作为主判据，浏览器堆和 GPU 统计为
 * 辅助，**不以不稳定 GC 时机作唯一判断**」。
 *
 * 于是本模块的全部状态都是**可查询的整数**：`acquire` / `release` 各记一次。负对照
 * （"少一次 dispose" / "提前释放共享资源"）表现为计数不守恒，或计数提前归零。
 *
 * ## 两个视口共享源数据
 *
 * 归属是**多份引用**而不是"谁创建谁拥有"：两个视口 acquire 同一条目 ⇒ `refCount = 2`；
 * 关闭其一 ⇒ `1`（另一方不受影响，「一方关闭不破坏另一方」）；关闭其二 ⇒ `0` 且
 * **必须**调用一次释放回调（「最后引用释放后资源必须回收」；负对照"少一次 dispose"）。
 *
 * ## CPU 数据多视口共享的边界
 *
 * 本模块只保证**条目生命周期**；"哪些内容允许跨 WebGL context 共享"是
 * `presentation/three` 的职责 —— 见该层 `deviceScope` 的说明。
 */

import type { AssetId, ContentIdentity, ContentVersion } from './assetIdentity'
import { contentIdentityKey } from './assetIdentity'
import type { DeviceGeneration } from './deviceState'

/**
 * 一条归属资源的身份（内容身份 + 其在哪类设备作用域内被实例化）。
 *
 * `deviceScope` 存在的理由：WebGL 句柄**不跨 context 共用**（契约明文）。因此同一
 * 内容身份在两个视口里对应**两条独立的归属条目** —— CPU 侧解码结果可以共享，GPU 侧句柄
 * 必须各自实例化。作用域由呈现层按"渲染器实例"给出（见 `presentation/three`）。
 */
export interface OwnershipEntry {
  readonly identity: ContentIdentity
  readonly deviceScope: string
  /**
   * 该份额属于哪一次**有效设备生命周期**。
   *
   * 它是归属键的独立段：设备恢复会推进代次（`DeviceStateMachine`），
   * 于是"旧设备的份额"与"新设备重建出来的份额"在账上是可区分的两条条目
   * （§7.5:262「不能继续使用旧代次句柄」的账面形式）。
   *
   * 缺省（`undefined`）= 该条目**不绑定 GPU 设备代次**（进程级 CPU 缓存，
   * 如 `ContentCache` 的 `deviceScope: 'cpu'`）—— 它按 `0` 段入键，
   * 不会与任何真实设备代次混同。
   */
  readonly deviceGeneration?: DeviceGeneration
}

/** 归属条目的可查询快照（诊断与资源计数对账面）。 */
export interface OwnershipSnapshot {
  readonly key: string
  readonly id: AssetId
  readonly version: ContentVersion
  readonly deviceScope: string
  readonly deviceGeneration: DeviceGeneration | null
  readonly refCount: number
}

export type ReleaseOutcome =
  | { ok: true; key: string; released: true; disposed: boolean }
  | { ok: false; reason: 'unknown-entry' | 'already-released'; key: string }

interface Entry {
  identity: ContentIdentity
  deviceScope: string
  deviceGeneration: DeviceGeneration | null
  refCount: number
  /** 最后引用释放时调用（**恰好一次**）。 */
  dispose: () => void
  disposed: boolean
}

/**
 * 引用计数注册表。
 *
 * 不变式（每条都有对应断言，见 `__tests__/ownership.test.ts`）：
 *  1. `refCount >= 0`；`release` 不会把计数降到负数（**提前释放**是显式错误）。
 *  2. `refCount === 0` ⇒ 条目被移除且 `dispose` 恰好被调用一次。
 *  3. 同一 `key` 的 `acquire` 累加同一实例的计数（共享而非复制；「共享源数据」）。
 *  4. 未知 `key` 的 `release` 是显式错误（负对照「少一次 acquire」立即暴露）。
 */
export class OwnershipRegistry {
  private readonly entries = new Map<string, Entry>()
  /** 累计统计 —— "平衡"判据直接读这两个整数。 */
  private acquireTotal = 0
  private releaseTotal = 0
  private disposeTotal = 0
  /** 引用计数**归零**的次数（= 应有几次 dispose）。与 releaseTotal 不同：共享条目上
   *  2 次 acquire / 2 次 release 只产生 1 次归零。 */
  private zeroCrossings = 0
  private abandonedTotal = 0
  private lastAbandonReason = ''

  /**
   * 条目键：内容身份 × 设备作用域 × **设备代次**（同身份跨设备/跨代次 = 独立条目）。
   *
   * 代次段是后加的：恢复后旧代次条目已被 `abandonAll` 清掉，新代次重建出的
   * 份额以 `#g<new>` 入键。若有人复用旧代次号重建，键会与"旧代次仍在服役"同形 ——
   * 这正是"旧代次不服役"在结构上可判定的地方（`deviceGeneration` 与之同源）。
   */
  static key(entry: OwnershipEntry): string {
    return `${contentIdentityKey(entry.identity)}#${entry.deviceScope}#g${entry.deviceGeneration ?? 0}`
  }

  /**
   * 获取一份归属（引用 +1）。
   *
   * `dispose` 只在**首次**获取时登记；后续获取忽略传入的回调 —— 后续调用方看到的是
   * 已被别人拥有的条目（`refCountOf > 0`），它**不**是新拥有者，因此不得覆盖释放回调。
   * 静默覆盖会让释放时调错对象，是"少一次 dispose"的常见成因。
   */
  acquire(entry: OwnershipEntry, dispose: () => void): OwnershipSnapshot {
    const key = OwnershipRegistry.key(entry)
    let e = this.entries.get(key)
    if (e === undefined) {
      e = {
        identity: entry.identity,
        deviceScope: entry.deviceScope,
        deviceGeneration: entry.deviceGeneration ?? null,
        refCount: 0,
        dispose,
        disposed: false,
      }
      this.entries.set(key, e)
    }
    e.refCount += 1
    this.acquireTotal += 1
    return snapshot(key, e)
  }

  /**
   * 释放一份归属（引用 -1）。
   *
   * 返回显式结果而不是静默忽略：未知键（从未 acquire，或已释放到最后）⇒ `unknown-entry`。
   * 这是**违反平衡判据**的事实，必须能让测试看见，不能 catch 掉。
   */
  release(entry: OwnershipEntry): ReleaseOutcome {
    const key = OwnershipRegistry.key(entry)
    const e = this.entries.get(key)
    if (e === undefined) return { ok: false, reason: 'unknown-entry', key }
    if (e.refCount <= 0) return { ok: false, reason: 'already-released', key }

    e.refCount -= 1
    this.releaseTotal += 1

    if (e.refCount === 0) {
      this.zeroCrossings += 1
      if (!e.disposed) {
        e.disposed = true
        this.disposeTotal += 1
        e.dispose()
      }
      this.entries.delete(key)
      return { ok: true, key, released: true, disposed: true }
    }
    return { ok: true, key, released: true, disposed: false }
  }

  /** 条目当前引用数；不存在 ⇒ 0。 */
  refCountOf(entry: OwnershipEntry): number {
    return this.entries.get(OwnershipRegistry.key(entry))?.refCount ?? 0
  }

  /** 活跃条目数（「活跃计数回基线」的主读数）。 */
  activeCount(): number {
    return this.entries.size
  }

  /** 活跃条目快照（稳定排序，便于逐项对账）。 */
  snapshots(): readonly OwnershipSnapshot[] {
    return [...this.entries.entries()]
      .map(([key, e]) => snapshot(key, e))
      .sort((a, b) => a.key.localeCompare(b.key))
  }

  /**
   * 累计对账（主判据）。
   *
   * 守恒式必须**区分**两件不同的事实，否则共享条目会被误判为泄漏：
   *
   * | 量 | 含义 |
   * |---|---|
   * | `acquireTotal` | 累计 acquire 次数（多视口共享 ⇒ 可 > 条目数） |
   * | `releaseTotal` | 累计 release 次数 |
   * | `zeroCrossings` | 引用计数**归零**的次数（= 应有几次 dispose） |
   * | `disposeTotal` | 实际 dispose 次数 |
   *
   * ## `balanced` 的口径（acquire 的**三去向**守恒）
   *
   * 每一次 acquire 最终只有一个去向：**正常释放**（`releaseTotal`）、**设备丢失放弃**
   * （`abandonedTotal`，单列、**不**混进 releaseTotal）、或**仍然活跃**
   * （`liveRefs` = 各条目 `refCount` 之和；注意它不是 `activeCount`：共享条目
   * 一次 acquire 只加一份引用）。于是守恒式是：
   *
   * ```text
   * acquireTotal === releaseTotal + abandonedTotal + liveRefs
   * ```
   *
   * 丢失期 `liveRefs === 0` ⇒ 它就是守恒式 `acquired === released + abandoned`。
   * 恢复后新代次重新 acquire ⇒ `liveRefs > 0`，守恒式**仍然**成立
   * （同时要求 `activeCount > 0` 与 `balanced === true`，只有这一口径能同时成立）。
   *
   * 另一条独立事实：`zeroCrossings === disposeTotal`（每次引用归零恰好 dispose 一次 ——
   * 不多不少）。早期版本把守恒写成 `disposeTotal === releaseTotal`，这在**共享**条目上
   * 必然为假（2 次 acquire / 2 次 release 只产生 1 次 dispose）—— 会把自己**正确**的
   * 共享行为误报成泄漏。该错误由 `__tests__/assetState.test.ts` 的
   * "同一作用域内多次获取"用例抓出。
   *
   * **`atBaseline`** 是旧的"回基线"判据（`activeCount === 0` 且守恒）：
   * "清空允许缓存后活跃计数回基线"用它；而 `balanced` 回答的是"账有没有说谎"
   * （含设备丢失的单列记账），两者在**寿命未结束**时故意不同 —— 这正是要把
   * "仍在服役"与"漏释放/被放弃"分开的原因。
   *
   * **与 GC 时机无关**（契约明文）：本判据全部由显式整数构成。
   */
  ledger(): Readonly<{
    acquireTotal: number
    releaseTotal: number
    disposeTotal: number
    zeroCrossings: number
    activeCount: number
    /** 当前活跃条目的引用数之和（共享条目 > activeCount；守恒式的"仍在服役"项）。 */
    liveRefs: number
    /** 设备丢失时**放弃**的份额数（单列；不混进 releaseTotal）。 */
    abandonedTotal: number
    /** 最近一次放弃的原因（`''` = 从未放弃）。 */
    lastAbandonReason: string
    /** 三去向守恒 + 每次归零恰好 dispose 一次（见上方口径说明）。 */
    balanced: boolean
    /** 活跃计数回基线（`activeCount === 0` 且 `balanced`）—— 旧的"回基线"读面。 */
    atBaseline: boolean
  }> {
    const liveRefs = this.liveRefs()
    const balanced =
      this.acquireTotal === this.releaseTotal + this.abandonedTotal + liveRefs &&
      this.zeroCrossings === this.disposeTotal
    return {
      acquireTotal: this.acquireTotal,
      releaseTotal: this.releaseTotal,
      disposeTotal: this.disposeTotal,
      zeroCrossings: this.zeroCrossings,
      activeCount: this.entries.size,
      liveRefs,
      abandonedTotal: this.abandonedTotal,
      lastAbandonReason: this.lastAbandonReason,
      balanced,
      atBaseline: this.entries.size === 0 && balanced,
    }
  }

  /**
   * **强制**放弃全部条目（WebGL 丢失时旧句柄不再有意义；见 `presentation/three`）。
   *
   * 与 `release` 的区别：这是"设备没了"的处置 —— 计数清到基线，但**不**逐条走正常
   * release（旧 GPU 句柄已不可用，其 dispose 通常会失败）。因此单独记 `abandonedTotal`，
   * 使"正常回收"与"设备丢失放弃"在账上可区分（要求"无旧 GPU 句柄复用"可判定）。
   */
  abandonAll(reason: string): number {
    // 放弃的是**份额**（各条目 refCount 之和），不是条目数：守恒式按 acquire 次数记账，
    // 共享条目（refCount > 1）若按条目计数会让 `balanced` 永远差这几份。
    const n = this.liveRefs()
    for (const e of this.entries.values()) e.disposed = true
    this.entries.clear()
    this.abandonedTotal += n
    this.lastAbandonReason = reason
    return n
  }

  /** 活跃条目的引用数之和（`abandonAll` 与 `ledger().liveRefs` 的同一口径）。 */
  private liveRefs(): number {
    let n = 0
    for (const e of this.entries.values()) n += e.refCount
    return n
  }

  get abandoned(): Readonly<{ total: number; lastReason: string }> {
    return { total: this.abandonedTotal, lastReason: this.lastAbandonReason }
  }
}

function snapshot(key: string, e: Entry): OwnershipSnapshot {
  return {
    key,
    id: e.identity.id,
    version: e.identity.version,
    deviceScope: e.deviceScope,
    deviceGeneration: e.deviceGeneration,
    refCount: e.refCount,
  }
}