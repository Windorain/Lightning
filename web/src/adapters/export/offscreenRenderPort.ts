/**
 * `adapters/export/offscreenRenderPort` —— **离屏渲染端口的生产实现**。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | 导出器自建 `WebGLRenderer` + 临时画布，经 `toDataURL` 取产物 | `workbench/exportIsometricImage.ts:105,172` | 走冻结的 `ExportRequest` → 内核求值/呈现 → 渲染目标 → `readRenderTargetPixels` |
 * | `OffscreenRenderPort` **零生产实现**（`ExportJob` 因此不可执行） | 此前实况 | 本文件是那个实现：`acquire/renderFrame/release` 三方法各有生产语义 |
 *
 * ## 为什么实现能同时被两端真跑（关键结构）
 *
 * 「离屏渲染」被切成两层（见 `adapters/export/renderDevice` 的文件头）：
 *
 *  - **本文件**：取景、逐帧求值键、场景→呈现输入→编译→挂载、资源记账、释放 ——
 *    **全部与 GL 无关**，vitest 可全跑；
 *  - **设备端口**：建渲染器/目标/读回/释放 —— 真 GL 那一层，e2e 用 Three 实现、
 *    vitest 用受控实现。
 *
 * 于是"这条链在生产里真的存在且能跑"**不是**一句源码指纹，而是
 * 「注入受控设备即可在 vitest 里跑完整 `ExportJob` 并断言 PNG 字节」。
 *
 * ## 导出纪律在本文件的落点
 *
 * | 纪律 | 本文件的做法 |
 * |---|---|
 * | 产物对应**捕获时的场景** | 每一帧的求值键由 `evaluationKeyOf(request, frame, …)` 派生 —— 时间取自**冻结的** `request.frames[i]`，内容取自 `request.payload.scene`；**没有**"再问一次编辑器"的入口 |
 * | **不改变**工作区时间/选择/机位 | 本文件不持有 `EditorClient`/`EditContext`/视口；相机由**值**（`request.camera`）映射而来（`presentation/offscreenCamera`） |
 * | 缺资源 / 不支持映射 ⇒ **预检失败** | 预检在作业启动前由 `application/exportPlan.preflightExport` 完成；本文件的 `acquire` **不**在预检失败时被调用（作业保证），且自身失败是**结构化**的 |
 *
 * ## 内容面为什么在**构造期**注入（一处必须说清的设计）
 *
 * `OffscreenRenderPort.acquire(request)` 只拿到冻结的 `ExportRequest`。它带
 * `payload.scene`（内核 `Scene`）、`camera`、`render`、`frames`、`channels`，
 * 但**不带** `DocumentContent`（纹理/材质资源表），而
 * `composition/kernelPresentationInputs` 造 `materialPalette` 需要它。
 *
 * ⇒ 内容在**构造期**作为一个**值**注入（捕获时的场景值，与 request 同一时刻取得）。
 * 这不违反「不读实时编辑器」：注入的是值，不是取值入口/回调/句柄 ——
 * 构造签名里**没有** `getContent`/`() => …` 这类惰性形态。
 * 「同一时刻捕获的两个值不会漂移」由调用方（组装点）保证，并由判据
 * 断言"渲染只用构造值与 request，不读任何实时面"。
 */

import type * as THREE from 'three'
import { err, ok, unsupportedOperation, type DomainError, type Result } from '@/domain/errors'
import type { ExportRequest, RenderSettings } from '@/domain/captureSpec'
import type { DocumentContent } from '@/domain/content'
import type { Scene } from '@/domain/scene'
import type { RenderedFrame } from '@/application/exportPlan'
import { evaluationKeyOf } from '@/application/exportPlan'
import type { OffscreenRenderPort } from '@/runtime/exportJob'
import { createPresenterSession, type PresenterSession } from '@/composition/presenterSession'
import { threeCameraOf } from '@/presentation/offscreenCamera'
import type { OffscreenDeviceFactory, OffscreenDevice } from './renderDevice'
import type { TexturePort } from '@/presentation/presenter'
import type { TextureResource } from '@/presentation/textureBinding'
import type { FrameSamplingReport } from '@/runtime/exportJob'

/**
 * 资源版本表（`EvaluationKey.contentResourceVersions`）。
 *
 * 与 `composition/presenterSession` 的私有同名辅助**同一口径**（`assetId → contentVersion`）。
 * 本文件不复用那个私有函数（它在另一层且未导出）——而是**从同一个值**（`DocumentContent`）
 * 按同一规则派生，故两者不可能漂移：它们读的是同一个字段。
 */
function resourceVersionsOf(content: DocumentContent): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const r of content.resources) out[r.ref.assetId] = r.ref.contentVersion
  return out
}

export interface OffscreenRenderPortOptions {
  /** 离屏设备工厂（e2e 注真实 Three 实现；vitest 注受控实现）。 */
  readonly devices: OffscreenDeviceFactory
  /**
   * 内核**内容面**（捕获时的场景值：纹理/材质资源表）。
   *
   * 见文件头「内容面为什么在构造期注入」。它是**值**，不是取值入口。
   */
  readonly content: DocumentContent
  /** 设备作用域（一个渲染器一个；进呈现层的归属键，使两个实例的 GPU 份额互不干扰）。 */
  readonly scope: string
  /** 纹理取用端口（五态链的消费端；缺省 = 不消费纹理，材质走中性色）。 */
  readonly textures?: TexturePort
  /**
   * **捕获期那一份** `TextureResource[]`（接线事实）。
   *
   * ## 为什么必须与设备的 `resources` 是*同一个数组值*
   *
   * 竖条格数 `stripFrameCount` 来自解码后的像素高度比（`domain/textureAnimation`），
   * 而离屏设备的像素来自 `textureResourcesOf`。若"传给设备的 resources"与
   * "参与绑定的 resources"是两份各自算出来的表，格数与帧序列就可能分叉 ——
   * 表现为"GIF 的帧数来自 A 表、画面裁切来自 B 表"，静默。
   * ⇒ 实现约束：调用方只允许从**捕获期那一个变量**取（`captureExportSnapshot` 的产物）。
   *
   * 缺省 = 不绑纹理（受控设备测试 / 不消费纹理的端口配置）。
   */
  readonly textureResources?: readonly TextureResource[]
}

/**
 * **离屏渲染端口的生产实现。**
 *
 * 生命周期严格三态（`release()` **必须幂等**，作业在四条路径上都会调它）：
 *
 * ```
 *   idle ──acquire()──▶ active ──release()──▶ released（再 acquire 不合法，明确失败）
 *     │                    │
 *     └──renderFrame() 在此失败（结构化，不抛）
 * ```
 *
 * 「未 acquire 就 renderFrame」与「acquire 失败」都必须**可区分**：
 * 前者是调用方用错（`InvalidValue`-族），后者是环境/资源给不出（`UnsupportedOperation`）。
 * 把它们压成同一个结果正是「不支持的导出明确报告」要防的形态。
 */
export class SnapshotOffscreenRenderPort implements OffscreenRenderPort {
  private device: OffscreenDevice | null = null
  private session: PresenterSession | null = null
  private allocated = 0
  private released = false
  /**
   * 纹理绑定是否已做过（**只做一次**：内容在请求里冻结 ⇒ 绑定不会变）。
   *
   * 时机是判据的一部分：必须在**首次真重建**的 `applyIfChanged` **之后**
   * （`materialDescriptors()` 在编译产物里，早于它调用会绑 0 条且静默无贴图）。
   */
  private boundTextureResources = false
  /** 逐帧采样读数（只读诊断面；见 `samplingReport()`）。 */
  private readonly sampling: FrameSamplingReport[] = []

  constructor(private readonly options: OffscreenRenderPortOptions) {}

  /**
   * 分配离屏资源：设备（渲染器 + 渲染目标）与**呈现会话**。
   *
   * 返回本次分配的**资源句柄数** —— 它进作业的 `releasedFor`，
   * 使"分配了几个、释放了几个"成为可对账的事实（「取消释放资源」的读数）。
   * `+1` 是呈现会话自己持有的批次对象份额（它的账由 `PresenterSession.ledger()` 另计，
   * 此处只报**本端口**承诺释放的句柄数）。
   */
  acquire(request: ExportRequest): Result<{ readonly allocated: number }> {
    if (this.released) {
      return err(unsupportedOperation({ reason: 'offscreenPortReleased', requestId: request.requestId }))
    }
    if (this.device !== null) {
      // 重复 acquire 会**泄漏**上一份设备（无人再持有它）—— 显式拒绝而不是静默覆盖。
      return err(unsupportedOperation({ reason: 'offscreenPortAlreadyAcquired', requestId: request.requestId }))
    }

    const acquired = this.options.devices.acquire(request.render)
    if (!acquired.ok) {
      // 分配失败 ⇒ **没有任何资源归本次作业所有** ⇒ 作业不得调 `release()`
      // （`releasedFor: 0` 是这条判据的可断言形态，见 `ExportJob.run`）。
      return err(acquired.error)
    }

    try {
      // 设备自建的纹理域优先（`renderDevice#acquire` 在**本次**渲染器上造出它）。
      // 构造期注入的 `textures` 只是受控设备/测试替身的回落 —— 生产路径上设备的域名才是
      // 唯一拥有本 GL 上下文的那个（跨上下文共用句柄是不成立的）。
      const textures = acquired.value.textures ?? this.options.textures
      this.session = createPresenterSession({
        scope: this.options.scope,
        ...(textures === undefined ? {} : { textures }),
      })
    } catch (e) {
      // 会话建不出来：设备已经拿到手，必须**当场**释放（否则这份设备永远无人回收）。
      acquired.value.device.dispose()
      return err(unsupportedOperation({ reason: 'offscreenSessionFailed', detail: String(e) }))
    }

    this.device = acquired.value.device
    // 设备句柄数 + 呈现会话自身的份额（1）
    this.allocated = acquired.value.allocated + 1
    return ok({ allocated: this.allocated })
  }

  /**
   * 渲染第 `frameIndex` 帧并读回像素（**纯数据出参**，不含 GPU 句柄）。
   *
   * 时间**只**来自 `request.frames[frameIndex]`（冻结序列）——
   * 这就是「导出期间继续编辑不改变本次快照」在实现上的落点：
   * 本方法读不到"现在第几帧"。
   */
  renderFrame(request: ExportRequest, frameIndex: number): Result<RenderedFrame> {
    const device = this.device
    const session = this.session
    if (device === null || session === null) {
      return err(unsupportedOperation({ reason: 'offscreenPortNotAcquired', frameIndex }))
    }
    const time = request.frames[frameIndex]
    if (time === undefined) {
      // 越界不是"夹取到最后一帧"的理由：那会静默产出一帧重复内容。
      return err(unsupportedOperation({ reason: 'frameIndexOutOfRange', frameIndex, frames: request.frames.length }))
    }

    // ① 逐帧求值键：**唯一**时间来源是冻结序列里的这一项（纯层已交付的算法，不另立一份）。
    const key = evaluationKeyOf(request, time, resourceVersionsOf(this.options.content))

    // ② 内核承载的内容 → 呈现编译输入 → 编译 → 挂载（与实时视口走**同一条**呈现链）。
    const outcome = session.applyIfChanged({
      scene: request.payload.scene as Scene,
      content: this.options.content,
      key,
    })
    if (outcome.compileError !== null) {
      return err(unsupportedOperation({ reason: 'offscreenCompileFailed', frameIndex, detail: outcome.compileError }))
    }

    // ③ **诚实失败**：场景里有对象却一个批次都产不出 ⇒ 不产出"看起来成功"的空图。
    //
    //    这正是 `composition/seams.ts` 为 OBJ 导出登记的缺口形态（「内核投影不带回显时
    //     triangles=0 ⇒ 静默产出空几何」）。判成失败使"缺内容面"变成**可见**的事实，
    //    而不是一张全透明 PNG 冒充成功。
    if (outcome.batches === 0) {
      const reasons = [...outcome.skipped, ...outcome.compileSkipped]
        .map((s) => `${s.objectId}:${s.reason}`)
        .join(',')
      return err(
        unsupportedOperation({
          reason: 'offscreenNoDrawableContent',
          frameIndex,
          objects: request.payload.scene.order.length,
          skipped: reasons,
        }),
      )
    }

    // ③b：把捕获期那份资源表绑给会话（唯一绑定生产点是 `bindTextures`）。
    //
    // 顺序：必须在**首次真重建**之后（`materialDescriptors()` 来自编译产物；
    // 早于首次 apply 会绑 0 条 ⇒ 材质走中性色且**没有任何报错**）。
    // 只做一次：内容在 `request.payload` 里冻结 ⇒ 绑定表不会变。
    if (!this.boundTextureResources && this.options.textureResources !== undefined) {
      this.boundTextureResources = true
      // 绑定条数与"材质描述符条数"由判据对账（`exportPorts.test.ts` 的绑定组）。
      session.bindTextures(this.options.textureResources)
    }

    // ④ 取景由**冻结值**映射（不是"借一台相机"—— 见 `presentation/offscreenCamera`）。
    const camera = threeCameraOf(request.camera, request.render)

    // ⑤ 真 GL 那一层（设备端口；vitest 注入受控实现）。
    const read = device.renderAndRead(session.object3d as THREE.Object3D, camera)
    if (!read.ok) return err(read.error)

    const expected = request.render.width * request.render.height * 4
    if (read.value.length !== expected) {
      // 读回长度与渲染设置不符 ⇒ 产物会与 request 声明不一致（静默的"尺寸漂移"）。
      return err(
        unsupportedOperation({
          reason: 'offscreenReadbackSizeMismatch',
          frameIndex,
          expected,
          actual: read.value.length,
        }),
      )
    }

    // ⑤b **只读诊断**：把本帧的采样读数留一份（不参与渲染，不改状态机）。
    //
    // 与屏上同一份读面（`presenterSession.textureSamples()`），故"离屏与屏上同样本"
    // 可以**逐字段**对账（判据 ②）。复制成纯数据，避免把呈现器的内部对象泄漏给作业。
    this.sampling.push(
      Object.freeze({
        frameIndex,
        seconds: time.seconds,
        samples: Object.freeze(session.textureSamples().map((s) => Object.freeze({ ...s }))),
        stats: Object.freeze({ ...session.textureSampleStats() }),
      }),
    )

    return ok(
      Object.freeze({
        index: frameIndex,
        time,
        pixels: read.value,
        width: request.render.width,
        height: request.render.height,
        // 驻留**搬运**自冻结序列（不是这里按帧率重算 —— 那会成为第二套时间权威）。
        ...(time.holdMs === undefined ? {} : { holdMs: time.holdMs }),
      }),
    )
  }

  /**
   * 释放 `acquire` 分配的全部资源。**幂等**（重复调用不重复释放）。
   *
   * 顺序：先放呈现份额（批次对象/几何/材质），再放设备（渲染器 + 目标）。
   * 反过来的话，呈现层的 `dispose()` 可能在已释放的 GL 上下文上做删除调用。
   */
  release(): void {
    if (this.released) return
    this.released = true
    this.session?.dispose()
    this.session = null
    this.device?.dispose()
    this.device = null
  }

  /** 本端口已分配/已释放的句柄数（诊断与对账；`ExportJob.releasedFor` 的来源之一）。 */
  get allocatedCount(): number {
    return this.allocated
  }

  /**
   * **逐帧采样读数的只读快照**。
   *
   * 返回副本（不是内部数组）：调用方拿到它之后不可能改写本端口的诊断面。
   * 取消/失败路径上作业**不读**它（`JobOutcome` 只在完成分支带 `sampling`）。
   */
  samplingReport(): readonly FrameSamplingReport[] {
    return Object.freeze([...this.sampling])
  }
}

/** 便于装配层构造（与 `createPresenterSession` 同族的工厂风格）。 */
export function createSnapshotOffscreenRenderPort(options: OffscreenRenderPortOptions): SnapshotOffscreenRenderPort {
  return new SnapshotOffscreenRenderPort(options)
}

/** 未使用占位：保持 `RenderSettings`/`DomainError` 的类型可达性（诊断用）。 */
export type { RenderSettings, DomainError }
