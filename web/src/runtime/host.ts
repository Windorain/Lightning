import type { InjectionKey } from 'vue'
import type { Main } from '@/runtime/main'
import type { Context } from '@/runtime/context'
import type { WM } from '@/runtime/wm'
import type { createLogCenter } from '@/logging/LogCenter'
import type { AttachViewportInput } from '@/runtime/attachViewport'
import { attachViewport } from '@/runtime/attachViewport'
import { createKernelOutlinePlanPort } from '@/composition/kernelOutlinePlanPort'
import type { OutlinePlanPort } from '@/runtime/drw'
import { PresenterSession } from '@/composition/presenterSession'
import { createViewportTexturePort, type ViewportTexturePort } from '@/composition/viewportTexturePort'
import { textureResourcesOf } from '@/composition/kernelTextureResources'
import { sceneSeconds } from '@/composition/kernelRuntime'
import { kernelGridObjectIdOf } from '@/runtime/gridRead'
import { resolvePartMaskGeometry } from '@/pure/partMask'

/**
 * **视口呈现会话包**（R1-A C10 的注入面）。
 *
 * ## 为什么是"一个包"而不是四个函数
 *
 * 这几样东西的生命期必须与**视口作用域**一致（会话与纹理端口同生共死；
 * 资源解码与时间换算无状态）。分开注入会让"谁在什么时候 dispose"变成调用方的
 * 自由发挥 —— 而 `THREE.Texture` 的 GPU 句柄不显式释放就是每视口一份泄漏（A19）。
 * 包上带 `dispose()` 使"创建与释放同源"成为结构事实。
 *
 * ## 为什么值依赖只出现在**本文件**（装配边）而不在 `useViewportRuntime`
 *
 * `shared/viewport/useViewportRuntime.ts` 属旧层，向上 import 装配根（`composition/`）
 * 正是接缝 `shared-viewport-upward-imports-assembly-root` 要退役的方向 —— 该接缝
 * **已核销**（R1-β① C10 / 提交 `0219a9eb`：值导入实测 **4 → 0**，登记已从 `SEAMS` 删除）。
 * `HostBase` 是装配边：它**拥有**实现选择，视口只收端口。于是"谁提供实现"与
 * "谁消费端口"在类型层分开，且视口的值导入数可机械计数（4 → 0；常驻判据见
 * `tests/architecture/shared-viewport-upward-import-closure.test.ts`）。
 */
export interface ViewportPresenterBundle {
  /** 呈现会话（画面 + 注解/描边的唯一生产者）。 */
  readonly surface: PresenterSession
  /** 该视口的纹理端口（GPU 句柄账）。 */
  readonly textures: ViewportTexturePort
  /** 内容资源表 → 五态纹理资源（`composition/kernelTextureResources#textureResourcesOf`）。 */
  readonly textureResourcesOf: typeof textureResourcesOf
  /** 场景时间 → 秒（`composition/kernelRuntime#sceneSeconds`）。 */
  readonly sceneSeconds: typeof sceneSeconds
  /** 释放会话与纹理端口（**同一处**：创建与释放同源）。 */
  dispose(): void
}

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
   * （接缝 `shared-viewport-upward-imports-assembly-root` —— 该接缝**已核销**：
   * R1-β① C10 / 提交 `0219a9eb`，本方法即其（甲）子句的具名装配面，登记已从 `SEAMS`
   * 删除、守护搬到 `tests/architecture/shared-viewport-upward-import-closure.test.ts`）。
   * 由宿主构造后**下行注入**，
   * 于是"谁提供实现"与"谁消费端口"在类型层分开。
   *
   * ## 为什么按 regionId 构造而不是无参单例
   *
   * 端口读的是**该视口的呈现会话**（`vpSlot.presenterSurface`：本帧实际编译的图元表 +
   * 当前求值键）。两个 Area 各有自己的会话 ⇒ 端口必须按视口分账，
   * 否则"A 视口悬停、用了 B 视口的几何"是一个不会有报错的静默错位。
   */
  createViewportOutlinePlanner(regionId: string): OutlinePlanPort
  /**
   * **装配根注入面**（R1-A C10）：为某视口构造呈现会话包。
   *
   * 落点由 #387 评论 7292 指定（"优先注入，而不是视口向上 import 装配根"）。
   * 视口（`useViewportRuntime`）只收端口 ⇒ 它对 `@/composition/` 的**值导入为 0**。
   */
  createViewportPresenter(regionId: string): ViewportPresenterBundle
}

export abstract class HostBase implements Host {
  private _detachByRegion = new Map<string, () => void>()
  private _disposed = false

  /**
   * **显式销毁本宿主持有的接线资源**（M7-6；S0-B D8 的另一半）。
   *
   * ## 为什么宿主需要一个 `destroy()`
   *
   * 契约矩阵（`adapters/host/hostCapabilities`）为工作台登记了
   * `destroyEntry: 'WorkbenchHost.destroy'`，而**该类上根本没有这个方法** ——
   * 那是一条"登记了但不存在"的销毁入口（比"没登记"更坏：它让读者以为
   * 寿命问题已经解决）。M7 的退出判据（G7：卸载后资源回基线）要求入口真实存在。
   *
   * ## 它销毁什么、不销毁什么
   *
   * 只销毁**本宿主自己持有的**接线：它登记过的视口 attach（DOM 监听、overlay 绑定）。
   * 组件内资源（renderer/纹理/presenter）由组件 `onBeforeUnmount` 释放 ——
   * 那是就近的作用域，宿主跨过去释放会造出第二份"谁在什么时候 dispose"。
   * 两者顺序不变：Vue 先卸载子树（组件释放呈现资源），随后根组件调用本方法。
   *
   * 幂等：重复调用不重复释放（`_disposed` 守卫）。
   */
  destroy(): void {
    if (this._disposed) return
    this._disposed = true
    for (const region of [...this._detachByRegion.keys()]) this.detachViewport(region)
  }

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
      // 旧层读面在此**下行注入**（装配边持有实现选择；端口文件因此对旧层零值导入）。
      gridObjectIdOf: (frameIndex) => kernelGridObjectIdOf(this.ctx.kernel?.document(), frameIndex),
      resolvePartBoxes: (parts, wholeCell, partLocalId) =>
        resolvePartMaskGeometry(parts, wholeCell, partLocalId)?.boxes ?? null,
    })
  }

  createViewportPresenter(regionId: string): ViewportPresenterBundle {
    const textures = createViewportTexturePort(`viewport:${regionId}`)
    // M8-3：设备相位机按视口从**生产索引**取（`ctx.viewports.devices` 是
    // "其他 Area 继续可用"的读面）；会话持有同一实例 ⇒ 状态权威只有一份。
    const device = this.ctx.viewports.devices.machineFor(regionId)
    const surface = new PresenterSession({ scope: `viewport:${regionId}`, textures, device })
    return {
      surface,
      textures,
      textureResourcesOf,
      sceneSeconds,
      dispose: () => {
        // 顺序与 C8/C5 的既有释放同序：先会话（挂载根）后纹理端口。
        surface.dispose()
        textures.dispose()
        // 视口拆解 ⇒ 退出设备相位索引（已拆解的视口不得继续出现在
        // "可提交视口"读面里）。
        this.ctx.viewports.devices.remove(regionId)
      },
    }
  }
}