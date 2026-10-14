import type { InjectionKey } from 'vue'
import type { Main } from '@/runtime/main'
import type { Context } from '@/runtime/context'
import type { WM } from '@/runtime/wm'
import type { createLogCenter } from '@/logging/LogCenter'
import type { AttachViewportInput } from '@/runtime/attachViewport'
import { attachViewport } from '@/runtime/attachViewport'
import { createKernelOutlinePlanPort } from '@/composition/kernelOutlinePlanPort'
import type { OutlinePlanPort } from '@/runtime/drw'

export const hostKey: InjectionKey<Host> = Symbol('host')

export interface Host {
  readonly main: Main
  readonly ctx: Context
  readonly wm: WM
  readonly log: ReturnType<typeof createLogCenter>
  start(): Promise<void>
  attachViewport(regionId: string, input: AttachViewportInput): Promise<() => void>
  detachViewport(regionId: string): void
  /**
   * **装配根注入面**（R1-A C9）：为某视口构造描边规划端口。
   *
   * ## 为什么是方法而不是让视口组件自己 import
   *
   * "描边用哪份几何"的实现在 `composition/`（装配根）。视口组件
   * （`shared/viewport/EmbedViewport.vue`、`workbench/components/WorkbenchViewport.vue`）
   * 与 `shared/viewport/useViewportRuntime.ts` 属**旧层** ⇒ 它们不得向上 import 装配根
   * （接缝 `shared-viewport-upward-imports-assembly-root`）。由宿主构造后**下行注入**，
   * 于是"谁提供实现"与"谁消费端口"在类型层分开。
   *
   * ## 为什么按 regionId 构造而不是无参单例
   *
   * 端口读的是**该视口的呈现会话**（`vpSlot.presenterSurface`：本帧实际编译的图元表 +
   * 当前求值键）。两个 Area 各有自己的会话 ⇒ 端口必须按视口分账，
   * 否则"A 视口悬停、用了 B 视口的几何"是一个不会有报错的静默错位。
   */
  createViewportOutlinePlanner(regionId: string): OutlinePlanPort
}

export abstract class HostBase implements Host {
  private _detachByRegion = new Map<string, () => void>()

  abstract readonly main: Main
  abstract readonly ctx: Context
  abstract readonly wm: WM
  abstract readonly log: ReturnType<typeof createLogCenter>
  abstract start(): Promise<void>

  async attachViewport(regionId: string, input: AttachViewportInput): Promise<() => void> {
    this.detachViewport(regionId)
    const unbind = await attachViewport(this.ctx, regionId, input)
    this._detachByRegion.set(regionId, unbind)
    return unbind
  }

  detachViewport(regionId: string): void {
    const fn = this._detachByRegion.get(regionId)
    if (fn) {
      fn()
      this._detachByRegion.delete(regionId)
    }
  }

  createViewportOutlinePlanner(regionId: string): OutlinePlanPort {
    return createKernelOutlinePlanPort({
      ctx: this.ctx,
      frameIndex: () => this.ctx.getFrameIndex(),
      // 每帧**现读**该视口的会话（不是构造时快照）：会话可能在装配稍后建立，
      // 也可能在重挂时被替换 —— 快照会让"重挂后描边用旧会话的几何"静默发生。
      inputsOf: () => this.ctx.viewports.get(regionId)?.presenterSurface?.inputsSnapshot() ?? null,
      currentKey: () => this.ctx.viewports.get(regionId)?.presenterSurface?.activeKey ?? null,
    })
  }
}
