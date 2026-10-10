/**
 * 资源缓存与**设备作用域**（#249 §11「资源缓存按内容身份持有，多个视口可以共享允许共享的
 * CPU 数据；跨 WebGL context 不能直接假设 GPU 句柄共用。视口销毁只释放其所有权份额，
 * 最后引用释放后资源必须回收」）。
 *
 * ## 三层结构，各自回答一个不同的问题
 *
 * ```text
 *   ContentCache（进程级，**可跨视口共享的 CPU 侧内容**）
 *     └─ 按内容身份缓存"不依赖任何 GL 上下文的中间产物"（解码后的像素/属性）
 *   BatchedPresenter（每设备作用域一个）
 *     └─ 按内容身份缓存 GPU 句柄（THREE.Material / BufferGeometry）—— **不跨作用域**
 *   OwnershipRegistry（纯计数，presentation/ownership.ts）
 *     └─ 谁持有谁、什么时候该真释放
 * ```
 *
 * ## 为什么 CPU 数据可以共享而 GPU 句柄不能
 *
 * 解码后的字节/属性不依赖任何 context，可以跨视口共享；而 `WebGLTexture` /
 * `WebGLBuffer` 由**某个**渲染器拥有 —— 两个 `WebGLRenderer` 各有自己的 GL 上下文，
 * 句柄不可互换。本文件的 `DeviceScope` 把"这是哪个渲染器"变成**可查询的事实**，
 * 而不是一条靠人记住的约定。
 *
 * ## A19 / A30 的落点
 *
 *  - A19：`ContentCache` 的 acquire/release 直通 `OwnershipRegistry`（单一账本，
 *    不在本层另记一套计数，避免两套账对不上）；
 *  - A30：`handleContextLost()` 走 `abandonAll`（旧句柄不复用），
 *    `handleContextRestored()` 由呈现器用当前有效版本重建。
 */

let deviceScopeSerial = 0
/**
 * **设备作用域**标识（一个 `WebGLRenderer` 实例 = 一个作用域）。
 *
 * 由 `nextDeviceScope()` 分配，**不**由调用方按名字构造 —— 让"两个视口是否共享 GL
 * 上下文"成为可查询的事实。序列号使同一进程内两个渲染器**必然**得到不同作用域，
 * 即使它们同名（"两个视口同名"是真实场景：主工作台与 Wiki 预览都叫 viewport）。
 */
export type DeviceScope = string

export function nextDeviceScope(hint = 'renderer'): DeviceScope {
  deviceScopeSerial += 1
  return `${hint}#${deviceScopeSerial}`
}

/** 调试/测试用：当前已分配的作用域数。 */
export function deviceScopeCount(): number {
  return deviceScopeSerial
}

import type { ContentIdentity } from './assetIdentity'
import { contentIdentityKey } from './assetIdentity'
import { OwnershipRegistry, type OwnershipEntry } from './ownership'

/** 可跨视口共享的 CPU 侧条目种类（诊断用；不参与身份）。 */
export type CpuResourceKind = 'pixels' | 'attributes' | 'payload'

/**
 * CPU 侧内容缓存（进程级）。
 *
 * `create()` 只在未命中时调用；`dispose(value)` 在**最后一个**引用释放时调用
 * （由 `OwnershipRegistry` 触发），因此创建方不需要自己管生命周期 —— 只提供释放方式。
 */
export class ContentCache {
  private readonly ownership = new OwnershipRegistry()
  private readonly entries = new Map<string, { identity: ContentIdentity; value: unknown }>()

  /**
   * 获取一份 CPU 侧资源（不存在则用 `create` 造）。
   *
   * 命中时返回**同一实例**（共享而非复制）—— A19「两个视口共享源数据」的字面落地。
   */
  acquire<T>(
    identity: ContentIdentity,
    kind: CpuResourceKind,
    create: () => T,
    dispose: (value: T) => void,
  ): T {
    void kind
    const key = contentIdentityKey(identity)
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      this.ownership.acquire(this.entryOf(identity), () => {})
      return existing.value as T
    }
    const value = create()
    this.entries.set(key, { identity, value })
    this.ownership.acquire(this.entryOf(identity), () => {
      this.entries.delete(key)
      dispose(value)
    })
    return value
  }

  /** 释放一份引用；最后一个引用释放时真正 dispose（A19「最后引用释放后资源必须回收」）。 */
  release(identity: ContentIdentity): ReturnType<OwnershipRegistry['release']> {
    return this.ownership.release(this.entryOf(identity))
  }

  /** 是否已缓存（**不**增加引用）。 */
  has(identity: ContentIdentity): boolean {
    return this.entries.has(contentIdentityKey(identity))
  }

  activeCount(): number {
    return this.ownership.activeCount()
  }

  /** 归属对账（A19 主判据：`balanced`）。 */
  ledger(): ReturnType<OwnershipRegistry['ledger']> {
    return this.ownership.ledger()
  }

  snapshots(): ReturnType<OwnershipRegistry['snapshots']> {
    return this.ownership.snapshots()
  }

  /**
   * 放弃全部条目（WebGL 丢失 / 强制清空允许缓存）。
   *
   * **不**逐条 dispose：设备丢失后旧句柄已不可用，逐条 dispose 通常抛错。计数单列在
   * `abandoned` 上，使"正常回收"与"放弃"在账上可区分（A30）。
   */
  abandonAll(reason: string): number {
    this.entries.clear()
    return this.ownership.abandonAll(reason)
  }

  private entryOf(identity: ContentIdentity): OwnershipEntry {
    return { identity, deviceScope: 'cpu' }
  }
}
