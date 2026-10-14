/**
 * `composition/presenterSession` —— **呈现器的生产接线**（#299 P10e 段②）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `BatchedPresenter` **零生产调用方** | 只被 `e2e/helpers/presentation/probe.ts` 与 `presentation/__tests__` 驱动 | 本模块是生产接线：内核场景 → `PresentationInputs` → `compileScene` → `BatchedPresenter` → 真实 GL |
 * | 逐格拾取经 legacy `mesh.userData.triangleMap` | `render/interaction/scenePick.ts:165-188` | 经 `BatchedPresenter.batchHitOf` → `PickIndex.resolve`（**同一份**生产批次映射） |
 *
 * ## 为什么必须是"会话"（而不能让每个视口自己串一遍）
 *
 * P10c/P10d 的实测结论是：**判定面存在、输入侧无生产者**是这一族缺口的共同形态
 * （`PresentationInputs` 零生产者、纹理链零生产者）。只补"能调通"的那一次，
 * 下一个消费者就会再串一遍 —— 于是"哪条链是权威"又出现两个答案。
 *
 * ⇒ 把整条链收成**一个** `PresenterSession`：它持有编译产物、`PickIndex`、
 * 呈现器三者，并保证它们的 `generation` 始终一致。视口只问它三件事：
 *
 * | 问法 | 回答 |
 * |---|---|
 * | `object3d` | 挂到哪（结构层） |
 * | `applyIfChanged(scene, content, key)` | 本次求值要不要重编/重传（返回诊断） |
 * | `pickAt(raycaster)` | 点到了哪个对象的哪一格（**逐格**） |
 *
 * ## 与 DRW / legacy 渲染链的关系（**本批不切换渲染链**）
 *
 * 本模块**不**替换 DRW 的 `blockMeshProvider` 路径 —— 那是 #301（P10f 子批 C/D）
 * 的渲染链终切内容。本批交付的是：
 *
 *  - 呈现器**在生产里真实上线**（有生产调用方、有真实 GL、有逐像素证据）；
 *  - 交互面**走新层**（拾取/描边规划），且与 legacy 行为可比对。
 *
 * 两者**并存**是显式的、有退出阶段的暂存（登记于 `composition/seams.ts`），
 * 不是"新门面包旧核心"：新层不 import 旧层的任何判定（它只吃内核装配产物）。
 *
 * ## 纯度
 *
 * 本模块在 `composition/`（装配根，允许 import 全部层 + three）。
 * 它**不做判定**：合法性、失效、政策都在 `presentation/` 的纯函数里。
 */

import * as THREE from 'three'
import type { Scene, ObjectDataPayload } from '@/domain/scene'
import type { DocumentContent } from '@/domain/content'
import type { Document } from '@/domain/document'
import type { TimeValue as DomainTimeValue } from '@/domain/animation'
import type { EvaluationKey } from '@/presentation/evaluationKey'
import type { MaterialDescriptor } from '@/presentation/evaluationKey'
import type { PresentationInputs } from '@/presentation/evaluationKey'
import { compileScene, type CompiledScene } from '@/presentation/compileScene'
import { PickIndex, evaluateStalePick, type PickResolution } from '@/presentation/pickingIndex'
import { BatchedPresenter, type TexturePort } from '@/presentation/presenter'
import {
  OverlayPresenter,
  type FaceQuadPort,
  type OutlineStyle,
  type OverlayApplyOutcome,
  type OverlayStats,
} from '@/presentation/overlayPresenter'
import { compileAnnotations, type AnnotationCompiled, type AnnotationInput } from '@/presentation/annotationPlan'
import type { OutlinePlan } from '@/presentation/outlinePlan'
import type { TextureBinding, TextureResource } from '@/presentation/textureBinding'
import { textureBindingsOf } from '@/composition/kernelTextureResources'
import { kernelPresentationInputs } from '@/composition/kernelPresentationInputs'
import { kernelAnnotationInputs } from '@/composition/kernelAnnotationInputs'


/** 一次 `apply` 的结果（**显式**报告，不静默吞）。 */
export interface PresenterApplyOutcome {
  /** 本次是否真的重编并上传（内容身份未变 ⇒ `false`）。 */
  readonly applied: boolean
  /** 编译失败（`Result` 的失败面）。 */
  readonly compileError: string | null
  /** 内核侧跳过（无类型化几何等）。 */
  readonly skipped: readonly { readonly objectId: string; readonly reason: string }[]
  /** 编译期跳过（几何不可用 / 格表形状错）。 */
  readonly compileSkipped: readonly { readonly objectId: string; readonly reason: string }[]
  /** 结构世代（诊断；批次序号只在其内有效）。 */
  readonly generation: string | null
  /** 批次数（= 结构性绘制数估计）。 */
  readonly batches: number
}

/** 一次逐格拾取的结果。 */
export type PresenterPickResult =
  | { readonly kind: 'miss' }
  | {
      readonly kind: 'hit'
      readonly resolution: PickResolution
      /** 命中点的**世界坐标**（与 `resolution` 同一次射线，不重射）。 */
      readonly point: readonly [number, number, number]
      /** 命中距离（相机到命中点；与 legacy `ScenePickBlock#distance` 同口径）。 */
      readonly distance: number
    }  /**
   * 过期画面上的拾取（A12）：**暂停**该类操作并明确状态。
   *
   * 注意它是**独立分支**而不是 `miss`：调用方对两者的处置不同
   * （`miss` ⇒ 清空选中；`stale` ⇒ 保持现状并提示）。
   */
  | { readonly kind: 'stale'; readonly detail: string }

/** 一条射线上的**单个**命中（供轮换拾取消费；字段与 `PresenterPickResult#hit` 同源）。 */
export interface PresenterHit {
  readonly resolution: PickResolution
  readonly point: readonly [number, number, number]
  readonly distance: number
  /** 命中面的世界空间法线；`null` = 该命中没有面法线（如点/线几何）。 */
  readonly normal: readonly [number, number, number] | null
}

/** 一条**注解**命中（`userData.objectId` = 内核对象 id，形如 `annotation:<legacyId>`）。 */
export interface PresenterAnnotationHit {
  readonly objectId: string
  readonly distance: number
  readonly point: readonly [number, number, number]
}

/** 一次"穿透全部候选"拾取的结果。 */
export type PresenterPickAllResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'hits'; readonly hits: readonly PresenterHit[] }
  | { readonly kind: 'stale'; readonly detail: string }

export interface PresenterSessionOptions {
  /** 设备作用域（一个渲染器实例一个；WebGL 句柄不跨 context 共用）。 */
  readonly scope: string
  /** 纹理取用端口（五态链的消费端；缺省 = 不消费纹理）。 */
  readonly textures?: TexturePort
  /** 面标注的几何端口（`blockPos + quadIndex` → 烘焙四边形）。 */
  readonly faceQuads?: FaceQuadPort
}

/**
 * 一个视口的**呈现会话**。
 *
 * 一个视口一个实例：批次对象挂在它自己的 `object3d` 下，故两个 Area 各自
 * `apply` 同一份内核场景时会得到两套独立 GPU 资源（A19「关其一不破坏另一方」
 * 的实现基础 —— 作用域进归属键）。
 */
export class PresenterSession {
  private readonly presenter: BatchedPresenter
  private compiled: CompiledScene | null = null
  private index: PickIndex | null = null
  /** 上次编译用的**内容身份**（决定"要不要重编"的唯一依据）。 */
  private lastIdentity: string | null = null
  /** 上次生效的求值键（A12 的比对基准）。 */
  private currentKey: EvaluationKey | null = null
  /**
   * **需要重建 GPU 资源**（`#262` P11-F 段②：A30 残余缺口的修复点）。
   *
   * ## 为什么必须有一个显式标志（而不是继续靠"调用方记得再 apply 一次"）
   *
   * `BatchedPresenter.handleContextLost()` 会放弃全部 GPU 句柄并把实际世代置 `null`
   * （旧句柄不复用 —— A30 明文）；恢复的唯一路径是"用当前有效版本重新 `apply()` 一次"。
   * 而本会话的公开入口 `applyIfChanged`/`applyKernelDocument` 在**内容身份未变**时
   * **提前返回**（那是 A11 的同一性保证，必须保留）——于是"内容没变的上下文丢失"
   * **永远等不到那次重建**：画面永久空白，且同一时刻会话**返回结果**里还有世代
   * （CPU 侧 `compiled.generation`）、`session.generation` 却是 `null`，两者不一致且静默。
   *
   * ## 语义边界（为什么它不破坏 A11 的同一性）
   *
   * 它**只**由 `handleContextLost()` 置位（= 一个外部设备事件，不是"调用方说脏了"），
   * 且只在**一次**真实重建后复位。故"机位/布局变化不得重建几何"与
   * "同一输入两次调用不重编"两条保证逐字不变 —— 判据见
   * `presenterSession.test.ts` 的反向控制段（未发生丢失时 `applied === false`）。
   */
  private needsRebuild = false

  /**
   * **分层预览**（R1-β① C8）：呈现侧的**可见层过滤**，由视口接线按当前层设置。
   *
   * ## 为什么它是会话状态而不是求值键的一维
   *
   * `EvaluationKey`（契约 §4）是**冻结**类型（六个维度逐字来自契约文本），
   * 而"看哪一层"不是求值输入、是**呈现过滤**（与 legacy `blockMeshProvider.build(def, lib,
   * {layerPreview})` 同性质）。把它塞进冻结键会同时改契约与核心类型 ——
   * 那是 #385 明令要走 GF 登记的事，而本批只需要把既有能力接住。
   *
   * ⚠️ 它**进**内容身份（`contentIdentityOf` 的 `lp:` 段）：同一文档换一层必须重编，
   * 否则"选了 Y=3 画面不动"。缺省 `'all'` = 不分层（导出/探针等非视口调用方的语义）。
   */
  private layerWorldY: number | null = null

  /** 注解/描边的呈现子树（与批次同根，故一个会话只有一个挂载点）。 */
  private readonly overlay: OverlayPresenter
  private readonly root = new THREE.Group()
  private lastAnnotations: AnnotationCompiled | null = null
  private lastOutline: { plan: OutlinePlan; style?: OutlineStyle } | null = null
  /**
   * 上次编译**实际用过**的呈现输入（`kernelPresentationInputs` 的产物）。
   *
   * ## 为什么必须有它（C9 描边几何承载的供源）
   *
   * `presentation/outlinePlan#OutlineGeometrySource.boundsOf` / `topologyVersionOf`
   * 的权威来源就是 `EvaluatedPrimitive` 的 `bounds` / `geometry.version`
   * —— 而那份图元表只在这里产出（`applyIfChanged` 内）。
   * 若让描边侧**自己再算一遍** `kernelPresentationInputs`，就会出现第二份
   * "本帧图元长什么样"的判定，而它与真正画出来的批次漂移的后果是
   * 「描边框住的对象比画出来的多/少」且没有任何判据会响。
   *
   * ⇒ 记住本次输入，供描边端口取 `bounds`/版本（**同一份**数据，不是复刻）。
   */
  private lastInputs: PresentationInputs | null = null

  constructor(options: PresenterSessionOptions) {
    this.presenter = new BatchedPresenter({
      scope: options.scope,
      ...(options.textures === undefined ? {} : { textures: options.textures }),
    })
    this.overlay = new OverlayPresenter({
      scope: options.scope,
      ...(options.faceQuads === undefined ? {} : { faceQuads: options.faceQuads }),
    })
    this.root.name = `presentation-session:${options.scope}`
    this.root.add(this.presenter.object3d, this.overlay.object3d)
  }

  /** 挂载根（调用方把它加进视口的结构层）。 */
  get object3d(): THREE.Group {
    return this.root
  }

  /** 当前结构世代（`null` = 尚未 apply 过）。 */
  get generation(): string | null {
    return this.presenter.currentGeneration
  }

  /** 当前生效的求值键（A12 比对基准；`null` = 尚未 apply 过）。 */
  get activeKey(): EvaluationKey | null {
    return this.currentKey
  }

  /**
   * 上次编译**实际用过**的呈现输入（见 `lastInputs` 的说明；未编译过 ⇒ `null`）。
   *
   * 消费方是描边几何端口（`composition/kernelOutlinePlanPort`）：
   * `object` 目标的 `boundsOf` 与元素目标的 `topologyVersionOf` 都取自这里的图元。
   */
  inputsSnapshot(): PresentationInputs | null {
    return this.lastInputs
  }

  /** 呈现器统计（诊断 / A18/A19 观测面）。 */
  statsSnapshot(): ReturnType<BatchedPresenter['statsSnapshot']> {
    return this.presenter.statsSnapshot()
  }

  /** 归属账（A19 主判据）。 */
  ledger(): ReturnType<BatchedPresenter['ledger']> {
    return this.presenter.ledger()
  }

  /**
   * 按**内容身份**应用一次内核场景。
   *
   * ## 为什么身份由"内核承载的内容"派生而不是调用方传
   *
   * 若让调用方传一个 `dirty` 布尔，那就出现了**第二份**"该不该重建"的判据
   * —— 而 #249 §15 第 5 条要退役的正是"调用方手动刷新/版本补丁"。
   * 身份由（场景对象序 + 载荷内容版本 + 帧下标 + 图层预览）机械派生：
   * **同一输入 ⇒ 同一身份 ⇒ 不重编**（同一性；不是"调用方说没变"）。
   *
   * ## 参数为什么带 `frameIndex`
   *
   * 帧下标改变被采集的几何（换帧 = 换一整份网格），故它**是**内容的一部分。
   * 而机位/选择/布局**不在**入参里 ⇒ 它们不可能影响身份（A11）。
   */
  applyIfChanged(input: {
    readonly scene: Scene
    readonly content: DocumentContent
    readonly key: EvaluationKey
  }): PresenterApplyOutcome {
    const identity = contentIdentityOf(input.scene, input.content, input.key, this.layerWorldY)
    if (!this.needsRebuild && identity === this.lastIdentity && this.compiled !== null) {
      // 内容身份未变：**不**重编、**不**重传。但仍要更新当前键 ——
      // 机位变化会改 `viewProjection`（非结构维度），拾取仍应视为"当前"
      // （`structurallyEqual` 不比它）。
      //
      // ⚠️ `!this.needsRebuild` 是 P11-F 段② 的修复点：上下文丢失后**必须**绕过本短路
      // （见 `needsRebuild` 的说明），否则"内容没变的丢失"永远等不到重建 = 画面永久空白。
      this.currentKey = input.key
      return {
        applied: false,
        compileError: null,
        skipped: [],
        compileSkipped: [],
        // 世代与**实际**同源（不是 CPU 侧 `compiled.generation`）：丢失后实际为 `null`，
        // 返回值也必须如实说 `null` —— 静默不一致会让调用方无法判断"该重建"。
        generation: this.presenter.currentGeneration,
        batches: this.compiled.payloads.length,
      }
    }

    const produced = kernelPresentationInputs({
      scene: input.scene,
      content: input.content,
      key: input.key,
      layerWorldY: this.layerWorldY,
    })
    const compiled = compileScene(produced.inputs)
    // 记住本次**实际**图元表（`bounds`/几何版本的供源，见 `lastInputs`）——
    // 与下面的编译分支无关：编译失败时图元仍是"本帧的真实产物"，如实保留。
    this.lastInputs = produced.inputs
    if (!compiled.ok) {
      // 失败**不清空**上一次的呈现产物：清空会让画面闪空（"编译失败 ⇒ 什么都看不见"），
      // 而调用方拿到的是显式错误 —— 处置权在它手里。
      //
      // `needsRebuild` **不复位**：本次没有真重建，下次调用仍须尝试（否则一次失败的
      // 重建会把"仍需重建"这件事悄悄吞掉 —— 与"不清空产物"是同一条纪律）。
      return {
        applied: false,
        compileError: `${compiled.error.code}`,
        skipped: produced.skipped,
        compileSkipped: [],
        generation: this.presenter.currentGeneration,
        batches: this.compiled?.payloads.length ?? 0,
      }
    }

    this.presenter.apply(compiled.value)
    this.compiled = compiled.value
    this.index = new PickIndex(compiled.value)
    this.lastIdentity = identity
    this.currentKey = input.key
    // 真重建已发生 ⇒ 复位（一次丢失只需一次重建）
    this.needsRebuild = false

    return {
      applied: true,
      compileError: null,
      skipped: produced.skipped,
      compileSkipped: compiled.value.skipped.map((s) => ({ objectId: s.objectId, reason: s.reason })),
      generation: this.presenter.currentGeneration,
      batches: compiled.value.payloads.length,
    }
  }

  /**
   * 按**内容身份**应用一份内核文档（生产调用点的便利入口）。
   *
   * ## 为什么单独一个入口（而不是让调用点自己拆 `doc.scene`/`doc.content`）
   *
   * "内核文档有哪两个半边（场景 + 内容）"是**内核承载的形状**这一事实。
   * 让每个调用点自己拆，就在每个调用点复制了一遍该事实 —— 而形状一旦扩展
   * （例如内容面再长出第三个半边），那些复制点会**静默少传一个**，
   * 表现为"某类内容不显示"。收在一处使扩展只需改一个地方。
   *
   * ## 求值键的构造
   *
   * 由文档版本 + 场景身份 + 场景时间 + 帧下标派生（**不含机位** —— A11）。
   * `documentVersion` 取内核文档自身的 `version`，故"文档变了"必然换身份，
   * 而"只是转了个视角"不会。
   */
  applyKernelDocument(doc: Document, time: DomainTimeValue): PresenterApplyOutcome {
    return this.applyIfChanged({
      scene: doc.scene,
      content: doc.content,
      key: {
        documentVersion: doc.version.documentVersion,
        scene: doc.scene.id,
        time: presentationTimeOf(time),
        parameterVersion: 0,
        contentResourceVersions: resourceVersionsOf(doc.content),
      },
    })
  }

  /** 装纹理绑定（材质身份 → 纹理内容身份；五态链的消费端）。 */
  setTextureBindings(bindings: ReadonlyMap<string, TextureBinding>): void {
    this.presenter.setTextureBindings(bindings)
  }

  /**
   * **设置分层预览**（呈现侧过滤；见 `layerPreview` 字段的说明）。
   *
   * 只改"下一次 apply 的可见层"：它进内容身份 ⇒ 下一次 `applyKernelDocument`
   * 必然重编（同一文档换一层也是**不同画面**）。不回读旧值 ⇒ 没有第二份权威。
   */
  setLayerPreview(worldY: number | null): void {
    this.layerWorldY = worldY
  }

  /**
   * 上次编译用到的**材质描述符**（按 `id` 去重；未编译过 ⇒ 空）。
   *
   * 为什么要有它：绑定键是 `MaterialDescriptor.id`（`presenter.ts:420` 的
   * `textureBindings.get(payload.material.id)`），而材质描述符**只有编译产物知道**。
   * 若让调用方自己从内核场景推一份材质清单，那就会出现**第二份**"哪些材质要贴图"的
   * 判定 —— 而它与真实批次漂移的后果是"某些批次静默无贴图"（比没贴图更难查）。
   */
  materialDescriptors(): readonly MaterialDescriptor[] {
    const c = this.compiled
    if (c === null) return []
    const byId = new Map<string, MaterialDescriptor>()
    for (const p of c.payloads) {
      byId.set(p.material.id, p.material)
      /**
       * **合并批次**里批次级材质只是代表值，成员各自还有自己的材质（逐 `materialIndex` 分组，
       * 见 `compileScene#BatchInstance.material`）。漏掉它们 ⇒ 那些成员拿不到纹理绑定
       * ⇒ 画面少贴一批图，而**不会有任何报错**（本批实测：真实信封夹具 39 组只绑了 32 个）。
       */
      for (const instance of p.instances) {
        if (instance.material !== undefined) byId.set(instance.material.id, instance.material)
      }
    }
    return Object.freeze([...byId.values()])
  }

  /**
   * **按当前资源表重绑纹理**（#301 P10f D3「材质统一」的落点）。
   *
   * ## 它做两件事，顺序是判据的一部分
   *
   * 1. `textureBindingsOf`（**唯一**绑定生产点）算出「材质 → 纹理内容身份 + 五态」；
   * 2. `setTextureBindings` 触发按新绑定的重建（呈现器自己做卸载 → 重挂，
   *    见 `presentation/presenter#setTextureBindings` 的说明）。
   *
   * ⚠️ 调用方必须**先**把像素交给 `TexturePort`（`composition/viewportTexturePort#sync`）：
   * 绑定只描述"该配哪张"，纹理本体由端口按内容身份提供。顺序反了 => 重建时端口里
   * 还没有那张纹理 => 该批次走中性色（**静默比其他批次平**）。
   *
   * @param requiredIndexes 哪些调色板下标的资源是**必需**的；缺省 = 全部必需（与
   *   `textureBindingsOf` 的口径一致）。预览场景传"全部必需"会让可选贴图缺失被记为
   *   `missingRequired`，故视口侧应按自身口径传。
   */
  bindTextures(
    resources: readonly TextureResource[],
    requiredIndexes?: readonly number[],
  ): { readonly bindings: number; readonly missingRequired: number } {
    const materials = this.materialDescriptors()
    const bindings = textureBindingsOf({
      materials: materials as never,
      resources,
      ...(requiredIndexes === undefined ? {} : { requiredIndexes }),
    })
    const map = new Map<string, TextureBinding>()
    let missingRequired = 0
    for (const b of bindings) {
      map.set(b.materialId, b)
      if (b.missingRequired) missingRequired += 1
    }
    this.setTextureBindings(map)
    return Object.freeze({ bindings: map.size, missingRequired })
  }

  /**
   * 用一条射线做**逐格**拾取（交互面的入口）。
   *
   * ## 为什么用 `intersectObjects(targets, true)` 而不是 `intersectObject(root, true)`
   *
   * `pickTargets()` 给出的是**本会话挂载的**批次对象，于是"命中 → 批次"的映射
   * 只可能落在本会话内。若直接对挂载根做递归求交，任何**后来被加进同一根**的
   * 非批次物体（例如 future 的描边 mesh）都会被算进来 —— 而它们的
   * `userData.presentationBatch` 是 `undefined`，于是解不出、表现为"点不中"。
   *
   * ## 第一个**可解**的命中才算命中（不是第一个几何命中）
   *
   * 射线可能先穿过一个可解批次的**背面**，或穿过一个不可解物体。
   * 逐命中尝试解算，取第一个能解出对象身份的 —— 这与 legacy `scenePick`
   * 的"遍历按距离排序的命中、跳过解不出的"同一手法（`scenePick.ts:152-188`）。
   */
  pickAt(raycaster: THREE.Raycaster): PresenterPickResult {
    if (this.index === null || this.currentKey === null) return { kind: 'miss' }
    const targets = this.presenter.pickTargets()
    if (targets.length === 0) return { kind: 'miss' }

    // ⚠️ **必须**先刷新世界矩阵。`Raycaster.intersectObjects` 读的是
    // `object.matrixWorld`，而它只在**渲染**（或显式 `updateMatrixWorld`）时更新。
    // 本批的呈现会话与既有渲染链**并行**（见本文件头「与 DRW 的关系」）——
    // 它挂在场景树上但**不被每帧渲染**，于是 `matrixWorld` 会停在构造时的单位矩阵，
    // 拾取解出的世界坐标全错。而错法是**静默**的：仍然"命中了"，
    // 只是命中位置不对（用户看到"点这里选中了那里"）。
    // 显式刷新把正确性建立在 `pickAt` **自己**身上，不依赖调用方是否也在渲染它。
    for (const t of targets) t.updateMatrixWorld(true)

    const hits = raycaster.intersectObjects([...targets], true)
    for (const hit of hits) {
      const ref = this.presenter.batchHitOf(hit)
      if (ref === null) continue
      const res = this.index.resolve(ref)
      if (res === null) continue
      // A12：拾取与显示版本一致。过期 ⇒ **暂停**并给出可展示的原因
      // （`evaluateStalePick` 的判别式；调用方据此决定提示还是丢弃）。
      const verdict = evaluateStalePick(res, this.currentKey)
      if (verdict === null) continue
      if (verdict.kind === 'suspend') return { kind: 'stale', detail: verdict.detail }
      return {
        kind: 'hit',
        resolution: verdict.resolution,
        // 命中点/距离随结果一起给：R1-β① C7 的**内核拾取适配**要把它们映射成
        // `ScenePickBlock#point`（部件级拾取 `pickPartForScenePick` 读它），
        // 而 `PickResolution` 是**身份**面（对象/元素/格），本就不含世界坐标。
        // 让调用方自己再射一次线会引入第二条射线（两条可能不一致）。
        point: [hit.point.x, hit.point.y, hit.point.z],
        distance: hit.distance,
      }
    }
    return { kind: 'miss' }
  }

  /** 由屏幕 NDC 构造射线并拾取（便利方法；相机由调用方给）。 */
  pickAtNdc(camera: THREE.Camera, ndc: THREE.Vector2): PresenterPickResult {
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, camera)
    return this.pickAt(raycaster)
  }

  /**
   * **一条射线上的全部命中**（按距离升序），供"轮换拾取"（`pickAll`）用。
   *
   * ## 为什么单独一个方法（而不是让调用方循环 `pickAt` 过滤）
   *
   * `pickAt` 的语义是"最近的一个" —— 它在第一次可解析命中处 `return`。
   * 轮换拾取要知道**穿透的全部候选**（`scenePickAllFromPointer` 的语义），
   * 而那必须遍历同一次射线解出的**全部** `intersection`。让调用方反复调用 `pickAt`
   * 无法表达这件事（它永远只给最近那个），于是"轮换"会退化成"同一个反复"。
   *
   * ## 与 `pickAt` 的一致性（同一条映射，不是第二份实现）
   *
   * 两者共用 `batchHitOf` → `PickIndex.resolve` → `evaluateStalePick` 这一条链；
   * 差别只在**是否提前返回**：`pickAt` 遇到 `suspend` 立即返回 `stale`（A12：
   * 过期画面上不得选中任何东西），本方法同样如此 —— 过期就是过期，
   * 不是"跳过这一条继续找下一条"（那会在过期画面上给出一个**新旧混用**的候选集）。
   */
  pickAllAt(raycaster: THREE.Raycaster): PresenterPickAllResult {
    const targets = this.presenter.pickTargets()
    if (targets.length === 0) return { kind: 'empty' }
    for (const t of targets) t.updateMatrixWorld(true)

    const hits = raycaster.intersectObjects([...targets], true)
    const out: PresenterHit[] = []
    const index = this.index
    const currentKey = this.currentKey
    if (index === null || currentKey === null) return { kind: 'hits', hits: Object.freeze(out) }
    for (const hit of hits) {
      const ref = this.presenter.batchHitOf(hit)
      if (ref === null) continue
      const res = index.resolve(ref)
      if (res === null) continue
      const verdict = evaluateStalePick(res, currentKey)
      if (verdict === null) continue
      if (verdict.kind === 'suspend') return { kind: 'stale', detail: verdict.detail }
      out.push({
        resolution: verdict.resolution,
        point: [hit.point.x, hit.point.y, hit.point.z],
        distance: hit.distance,
        // 法线取**命中面**并转到世界空间（与 legacy 的同一算法：`hit.face.normal`
        // 经 `matrixWorld` 的方向变换；缺失 ⇒ 如实给 `undefined`，不编一个）。
        normal:
          hit.face === undefined || hit.face === null
            ? null
            : (() => {
                const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
                return [n.x, n.y, n.z] as const
              })(),
      })
    }
    return { kind: 'hits', hits: Object.freeze(out) }
  }

  /** 由屏幕 NDC 构造射线并取全部命中（便利方法）。 */
  pickAllAtNdc(camera: THREE.Camera, ndc: THREE.Vector2): PresenterPickAllResult {
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, camera)
    return this.pickAllAt(raycaster)
  }

  /**
   * **注解命中**（R1-β① C8 第 2 项：拾取切内核链）。
   *
   * ## 为什么注解走单独一条通道（而不是并进 `pickAt`）
   *
   * 批次的命中身份在 `PickIndex`（对象/元素/**格**），而注解的命中身份是
   * **对象**（`userData.objectId`）—— 两者的解算依据不同，混进一个返回值会让
   * "这条命中的 `cell` 为什么缺席"变得需要猜。故注解单独返回，由调用方
   * （`composition/viewportPick`）与批次命中按距离裁决。
   *
   * ## 为什么射线打**注解子树**而不是整个根
   *
   * `root` 下同时挂着批次对象与注解对象；对整根递归求交会把批次对象也算进来
   * （它们没有 `objectId`，于是解不出、表现为"注解点不中"）。
   *
   * ⚠️ 与 `pickAt` 同一纪律：**显式刷新世界矩阵**。本会话的对象虽在场景树里，
   * 但其 `matrixWorld` 只在渲染时更新，而拾取可能发生在两次渲染之间
   * （`pickAnnotationsAt` 是同步读，不能依赖调用方先渲染）。
   */
  pickAnnotationsAt(raycaster: THREE.Raycaster): readonly PresenterAnnotationHit[] {
    const root = this.overlay.object3d
    root.updateMatrixWorld(true)
    const hits = raycaster.intersectObject(root, true)
    const out: PresenterAnnotationHit[] = []
    for (const hit of hits) {
      const objectId = (hit.object.userData as { objectId?: unknown }).objectId
      // 注解网格由 `presentation/overlayPresenter` 建，`userData.objectId` 是它的身份面。
      // 无该字段 ⇒ 不是注解对象（例如未来加进同一子树的其它物体）⇒ 跳过，不猜。
      if (typeof objectId !== 'string') continue
      out.push(
        Object.freeze({
          objectId,
          distance: hit.distance,
          point: [hit.point.x, hit.point.y, hit.point.z] as const,
        }),
      )
    }
    return Object.freeze(out)
  }

  /** 释放本会话的全部 GPU 份额。 */
  dispose(): void {
    this.presenter.dispose()
    this.overlay.dispose()
    this.compiled = null
    this.index = null
    this.lastIdentity = null
    this.currentKey = null
    this.lastAnnotations = null
    this.lastOutline = null
    // `dispose()` 之后一切都没了：下次 apply 必然走重建路径（`lastIdentity === null`），
    // 故标志无意义 —— 复位它，避免"已释放却自称待重建"的误导状态。
    this.needsRebuild = false
  }

  /** WebGL 上下文丢失（旧句柄全部放弃；恢复时用当前有效版本重新 apply）。 */
  handleContextLost(): number {
    const n = this.presenter.handleContextLost()
    // 编译产物**保留**（它是 CPU 侧纯数据，可重建 GPU 句柄而不必重编）。
    // 但 `PickIndex` 与呈现器世代的对应关系已断 ⇒ 拾取必须等下一次 apply。
    this.index = null
    // P11-F 段②：旧 GPU 句柄已全部放弃 ⇒ 下一次 apply **必须**真重建
    // （绕过内容身份短路；否则"内容未变的丢失"永远等不到重建 = 画面永久空白）。
    this.needsRebuild = true
    return n
  }

  /** WebGL 上下文恢复（调用方随后用**当前有效版本**重新 apply 一次）。 */
  handleContextRestored(): void {
    this.presenter.handleContextRestored()
    // 注解/描边不属于批次账（它们各自的几何/材质由 overlay 自己持有）⇒ 恢复时
    // 用**上次的编译产物**重画一次，保证"恢复后画面与丢失前同内容"。
    if (this.lastAnnotations !== null) this.overlay.applyAnnotations(this.lastAnnotations)
    if (this.lastOutline !== null) {
      this.overlay.applyOutline(this.lastOutline.plan, this.lastOutline.style)
    }
  }

  /**
   * 应用**已编译**的注解图元（内核 `presentation/annotationPlan` 的产物）。
   *
   * 这是注解进入 GPU 的唯一入口：编译在 `annotationPlan`（纯），上传在本会话。
   */
  applyAnnotations(compiled: AnnotationCompiled): OverlayApplyOutcome {
    this.lastAnnotations = compiled
    return this.overlay.applyAnnotations(compiled)
  }

  /**
   * 内核注解对象 → 编译 → 呈现（一条调用完成）。
   *
   * `inputs` 来自 `composition/kernelAnnotationInputs`（内核场景 → 注解输入），
   * 故生产路径上"内核里有没有注解"与"画面里有没有注解"由同一份数据决定。
   */
  setAnnotations(inputs: readonly AnnotationInput[]): OverlayApplyOutcome {
    return this.applyAnnotations(compileAnnotations(inputs))
  }

  /**
   * 由**内核文档**直接同步注解（含视口可见性过滤）—— 装配层的唯一调用点。
   *
   * ## 为什么把"读内核场景"这一步收进本模块（而不是留给视口接线）
   *
   * 视口接线（`shared/viewport/useViewportRuntime`）属**旧层**，而它曾**向上依赖**
   * 装配根 —— 那笔债就是接缝 `shared-viewport-upward-imports-assembly-root`
   * （计数历史 **C7 前 4 → C7 后不得增长**）。该接缝**已核销**（R1-β① C10 / 提交
   * `0219a9eb`：呈现在装配边 `Host#createViewportPresenter(regionId)` 构造后**下行注入**，
   * 其登记文件的值导入**实测为 0** ⇒ 登记从 `composition/seams.ts` 的 `SEAMS` 删除，
   * 常驻判据见 `tests/architecture/shared-viewport-upward-import-closure.test.ts`）。
   * 核销**不改变**本节这条纪律的来历：接线层若再 import `composition/kernelAnnotationInputs`，
   * 就是把已退的债重新借回来（核销前的计数口径下 = 4 涨到 5）
   * —— "登记是为了可见与可判定，不是为了合法化增长"。
   *
   * 装配根**内部**依赖（`composition/ → composition/`）不是向上依赖：
   * 把 `kernelAnnotationInputs` 的调用收在这里，接线层只需用它**本来就已导入**的
   * `PresenterSession` ⇒ 计数不变。
   *
   * `visible === false` ⇒ 清空（注解可见性是**视口状态**，不是文档内容；
   * 见 `kernelAnnotationInputs` 的 `visible` 恒 `true` 说明）。
   */
  syncKernelAnnotations(scene: Scene, visible: boolean): OverlayApplyOutcome {
    if (!visible) return this.setAnnotations([])
    return this.setAnnotations(kernelAnnotationInputs(scene).inputs)
  }

  /** 应用描边计划（`null` = 清空；描边颜色是**呈现侧政策**，不进计划）。 */
  applyOutline(plan: OutlinePlan | null, style?: OutlineStyle): OverlayApplyOutcome {
    this.lastOutline = plan === null ? null : { plan, ...(style === undefined ? {} : { style }) }
    if (plan === null) {
      this.overlay.clearOutline()
      return { drawn: 0, unrendered: [] }
    }
    return style === undefined ? this.overlay.applyOutline(plan) : this.overlay.applyOutline(plan, style)
  }

  /** 注解/描边子树的实时读数（诊断/判据面）。 */
  overlayStatsSnapshot(): OverlayStats {
    return this.overlay.statsSnapshot()
  }

  /**
   * 是否有**待重建**的 GPU 份额（诊断/判据面）。
   *
   * 只读事实，不是控制入口：置位/复位的唯一路径是 `handleContextLost()`（置位）
   * 与一次成功重建（复位）。`dispose()` 也会复位（一切都没了，"待重建"不再有意义）。
   */
  get pendingRebuild(): boolean {
    return this.needsRebuild
  }
}

/**
 * 内容身份（决定"要不要重编"）。
 *
 * ## 为什么不用一个 `dirty` 布尔或全局版本计数器
 *
 * 它们是 #249 §15 第 5 条要退役的形态（调用方手动刷新 / 版本补丁）。
 * 本函数由**内核承载的内容**机械派生，因此：
 *  - 机位/选择/布局**不在**入参里 ⇒ 不可能影响身份（A11）；
 *  - 同输入两次调用 ⇒ 同身份 ⇒ 第二次不重编（同一性，可断言）。
 *
 * ## 覆盖哪些维度
 *
 * 场景对象序 + 每个对象的载荷**内容版本** + 几何/逐格目录的键集 + 帧下标。
 * 用"键集"而不是"值的深比较"：载荷内容变时 `contentVersion` 由领域层推进
 * （`domain/scene#ObjectData`），故逐值深比较是**重复判据**（会与领域层漂移）。
 */
function contentIdentityOf(scene: Scene, content: DocumentContent, key: EvaluationKey, layerWorldY: number | null): string {
  const parts: string[] = [
    `k:${key.documentVersion}`,
    `s:${key.scene}`,
    `t:${key.time.numerator}/${key.time.denominator}`,
    // 分层预览进身份：同一文档换一层 ⇒ 必须重编（否则"选了 Y=3 画面不动"）。
    `lp:${layerWorldY === null ? 'all' : `y${layerWorldY}`}`,
  ]
  for (const objectId of scene.order) {
    const obj = scene.objects[objectId]
    if (obj === undefined) continue
    const data = scene.data[obj.dataId]
    if (data === undefined) {
      parts.push(`${objectId}:nodata`)
      continue
    }
    const p = data.payload as ObjectDataPayload
    if (p.kind !== 'blockGrid') {
      parts.push(`${objectId}:${p.kind}:${data.contentVersion}`)
      continue
    }
    const cells = Object.keys(p.cells)
    parts.push(
      [
        objectId,
        `v${data.contentVersion}`,
        `t${data.topologyVersion}`,
        `c${cells.length}:${cells.sort().join(';')}`,
        `g${Object.keys(p.geometry ?? {}).sort().join(';')}`,
        `cg${Object.keys(p.cellGeometry ?? {}).sort().join(';')}`,
      ].join('|'),
    )
  }
  // 资源内容版本（换贴图 ⇒ 内容变 ⇒ 必须重编，否则画面永远显示旧图）
  for (const r of content.resources) parts.push(`r:${r.ref.assetId}@${r.ref.contentVersion}`)
  parts.push(`fr:${content.frameAxis.frames.length}`)
  return parts.join('\u0001')
}

/** 构造一个呈现会话（装配层用）。 */
export function createPresenterSession(options: PresenterSessionOptions): PresenterSession {
  return new PresenterSession(options)
}

/**
 * 内容资源版本表（`EvaluationKey.contentResourceVersions`）。
 *
 * 键是 `assetId`、值是内容版本 —— 与 `presentation/evaluationKey` 的类型逐字一致。
 * 放在本文件而不是 `domain/`：它是**呈现键的派生**，不是领域事实
 * （领域只承诺"资源有稳定身份 + 内容版本"，怎么进求值键是呈现侧的约定）。
 */
function resourceVersionsOf(content: DocumentContent): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const r of content.resources) out[r.ref.assetId] = r.ref.contentVersion
  return out
}

/**
 * **领域时间 → 呈现求值键的时间表示**（两个同名不同类型的**唯一**换算点）。
 *
 * ## 为什么这里有一个真实的坑（本批实测撞到）
 *
 * 全仓有**两个**叫 `TimeValue` 的类型，形状**不同**：
 *
 * | 归属 | 形状 | 用途 |
 * |---|---|---|
 * | `domain/animation#TimeValue` | `{ frame: number; fps: FrameRateSpec }` | **领域**的时间事实（GF-3 的有理帧率） |
 * | `presentation/evaluationKey#TimeValue` | `{ seconds; numerator; denominator }` | 呈现**求值键**的时间维度 |
 *
 * 同名不同形 ⇒ 直接把领域时间塞进求值键**编译不过**（本批实测：`TS2739`）。
 * 这不是障碍而是**保护**：它逼着写出这个换算，于是"呈现键里的时间怎么来的"
 * 有唯一答案。
 *
 * ## 换算口径
 *
 * `numerator/denominator` 取**帧号与帧率的有理表示**（`framesPerSecond` 已把
 * `number | {num,den}` 归一），`seconds = frame / fps` —— 与
 * `composition/kernelRuntime#sceneSeconds` **同一算法**（那是场景秒数的既有唯一定义点）。
 *
 * ⚠️ 这里**不 import** `sceneSeconds`：本函数还要产出分子/分母（那个函数只给秒数），
 * 而重复写一次 `frame/fps` 是有意的 —— 判据（`presenterSession.test.ts`）把两者
 * 的**一致性**钉住，这比"只写一处但少一半信息"更安全。
 */
function presentationTimeOf(time: DomainTimeValue): import('@/presentation/evaluationKey').TimeValue {
  const spec = time.fps
  const num = typeof spec === 'number' ? spec : spec.num / spec.den
  const den = 1
  const fps = num / den
  return Object.freeze({
    seconds: fps > 0 ? time.frame / fps : 0,
    numerator: time.frame,
    denominator: Number.isInteger(fps) && fps > 0 ? fps : 1,
  })
}
