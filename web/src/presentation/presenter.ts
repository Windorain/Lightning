/**
 * GPU 合批呈现器（#249 §11；#256 `presentation/three`）。
 *
 * ## 纯数据投影与 GPU 上传**分开**（§11 明文，本文件的核心纪律）
 *
 * | 阶段 | 谁做 | 副作用 |
 * |---|---|---|
 * | 批次划分 / provenance / 纯数据投影 | `presentation/compileScene.ts` | **无**（纯函数） |
 * | 建 `BufferGeometry`、`InstancedMesh`、绑材质 | 本文件 `apply()` | GPU 资源创建 |
 *
 * 于是"编译"能在无浏览器环境里断言（vitest），"上传"才需要真 GL。同时这也让
 * **A18 的两个数字可分开测量**：
 *  - **结构性绘制数** = `CompiledScene.drawCallEstimate`（vitest 可断言）；
 *  - **实测绘制数** = `WebGLRenderer.info.render.calls`（e2e 在真浏览器读）。
 *
 * ## 实例化路径与回退
 *
 * - 同质 + 同几何 + `deform === 'shared'` + 成员 > 1 ⇒ `InstancedMesh`（1 draw call / 批次）；
 * - 同质但独立变形 ⇒ 每实例一个 `Mesh`，**共享几何**（同几何 ⇒ 同 BufferGeometry）；
 * - 合并批次（非同质）⇒ 逐成员材质/几何（**不**用代表值糊过去，见 `batchPlan.homogeneous`）。
 *
 * `BatchedMesh` 在锁定版本 r174 可用（已在 `node_modules/three/build/three.core.js`
 * 核实 `class BatchedMesh extends Mesh`）。本呈现器**不**用它作为默认路径 —— 因为
 * `InstancedMesh` 已满足 A18 的同质夹具门槛，而 `BatchedMesh` 的
 * `addGeometry/addInstance` 动态容量管理会掩盖"几何是否被重建"这一 G1 观测点
 * （`setGeometrySize` 复用缓冲使重建不可见）。异构几何的批处理由**逐成员 Mesh + 共享
 * 几何缓存**承担，其可观测性更好。此取舍记于本单汇报的遗留缺口。
 *
 * ## 资源身份与释放（A19）
 *
 * 材质与几何都按**内容身份**（几何身份；材质身份含 blend/tint/顶点色）持有一份，并由
 * `OwnershipRegistry` 显式计数。`dispose()` 释放本呈现器的全部份额；两个视口共享同一条目
 * 时关闭其一不影响另一方。
 */

import * as THREE from 'three'
import type { BatchPayload, CompiledScene, CompileGeneration } from './compileScene'
import type { BatchHitRef } from './pickingIndex'
import type { GeometryAttributes, MaterialDescriptor } from './evaluationKey'
import { texturePhaseKeyOf } from './evaluationKey'
import type { ContentIdentity } from './assetIdentity'
import { sampleBoundTexture, type TextureBinding } from './textureBinding'
import { contentIdentityKey } from './assetIdentity'
import { OwnershipRegistry, type OwnershipEntry } from './ownership'
import type { DeviceGeneration } from './deviceState'

/** 呈现器可查询的运行统计（诊断与 A18/A19 观测面）。 */
export interface PresenterStats {
  /** `apply()` 调用次数。 */
  applies: number
  /** 新建的 `BufferGeometry` 数 —— **几何重建数**，G1/A11 的主读数。 */
  geometryBuilds: number
  /** 几何缓存复用次数 —— G1「变一个注解文字不重建方块几何」的正面对照。 */
  geometryReuses: number
  /** 新建材质数。 */
  materialBuilds: number
  /** 材质缓存命中数。 */
  materialReuses: number
  /** 迁移已有批次对象（未重建）的次数。 */
  batchReuses: number
  /** 新建批次对象次数。 */
  batchBuilds: number
  /** 真正 `dispose()` 的对象数（A19：与配置的 acquire 平衡）。 */
  disposals: number
  /** 当前挂载的批次对象数（主色彩 pass 的**对象**数，不是 draw call 数）。 */
  batchObjects: number
  /** 当前批次里实例总数。 */
  instanceCount: number
  /**
   * **必需纹理未就绪**的材质数（#289 P10d；G4 / A36 的观测面）。
   *
   * 非零 ⇒ 画面上有材质走了"无贴图的中性色"路径。它不是崩溃，但**必须可见**：
   * A36 明文要求「必需资源未就绪**不得假装完整**」——
   * 这个计数就是"没有假装"的可机械读出形式。
   */
  missingRequiredTextures: number
}

/**
 * **纹理取用端口**（呈现侧；#289 P10d）。
 *
 * ## 为什么是端口而不是"呈现器自己去解码"
 *
 * 纹理字节来自文档资源（`domain/content#ContentResource` 的 `payload`/`locator`），
 * 解码是**适配器**的职责（#249 §4 规则 4：「适配器实现端口」）。
 * 呈现层只声明"我要按**内容身份**取一张 `THREE.Texture`"，由装配层注入实现 ——
 * 于是"呈现层不碰 IO"这条纯度纪律成立，且 e2e 可以注入一个真实实现的探针。
 *
 * ## 返回 `null` 的语义（**不得**用占位冒充）
 *
 * `null` = 该内容身份对应的纹理**当前不可用**（未请求/加载中/缺失/失败）。
 * 呈现器据此**不设** `map` 并累计 `missingRequiredTextures` ——
 * 而不是拿一张默认图顶上（那正是"假装完整"）。
 */
export interface TexturePort {
  /** 按内容身份取纹理；`null` = 当前不可用。 */
  textureFor(identity: ContentIdentity): THREE.Texture | null
}

/**
 * 一次**纹理样本**的读数（呈现侧诊断面；e2e 与单测的观测点）。
 *
 * 它回答"这一帧画面里的竖条贴图取了哪一段"，与像素断言互补：像素证明"offset 真的
 * 进了画面"，本读数证明"进的是哪一个样本"（同一输入时间 ⇒ 同一读数）。
 */
export interface TextureSampleReport {
  readonly assetId: string
  readonly contentVersion: string
  /** 采样用的场景秒（**唯一权威** `domain/animation#sceneClockOf` 的投影）。 */
  readonly seconds: number
  /** 序列声明索引（已归一到 `0..stripFrameCount-1`）。 */
  readonly frame: number
  readonly nextFrame: number
  /** 无混合声明时恒 0；非 0 表示**声明了** interp 而 M5 只做阶跃（见 `textureSampleStats`）。 */
  readonly mix: number
  readonly stripFrameCount: number
  readonly offsetY: number
  readonly repeatY: number
}

export interface PresenterOptions {
  /** 设备作用域（一个渲染器实例一个；由 `nextDeviceScope()` 分配）。 */
  scope: string
  /**
   * 纹理取用端口（#289 P10d）。缺省 = 该呈现器不消费纹理
   * （顶点色/线框专用，或测试路径）—— 那是**显式**配置，不是"忘了接"。
   */
  textures?: TexturePort
  /**
   * 材质 → 纹理绑定（#289 P10d）。缺省 = 全部材质无贴图。
   *
   * 键是 `MaterialDescriptor.id`（绘制批次按材质身份分批，故每个批次一个绑定）。
   *
   * ## 为什么它是**可变**字段（本类唯一可变配置）
   *
   * 纹理是**异步**到位的（五态链：未请求/加载中/可用/缺失/失败）。呈现器构造时
   * 资源往往还没解码完，而绑定必须能随后更新 —— 否则"贴图到位了但画面不变"
   * 会成为常态。更新入口是 {@link BatchedPresenter.setTextureBindings}，
   * 它**同时**卸载受影响批次（理由见该方法的说明）。
   */
  textureBindings?: ReadonlyMap<string, TextureBinding>
}

/**
 * 合批呈现器。
 *
 * 每个 `scope` 一个实例。`apply(scene)` 可反复调用（每次编译后一次）；`dispose()` 释放
 * 全部份额。`apply()` 对**未变的批次**做增量复用（几何/材质缓存命中 + 批次对象迁移），
 * 这是 G1 的实现落点。
 */
export class BatchedPresenter {
  private readonly group = new THREE.Group()
  private readonly ownership = new OwnershipRegistry()
  private readonly mounted = new Map<string, MountedBatch>()
  private readonly materialCache = new Map<string, CachedRef<THREE.Material>>()
  private readonly geometryCache = new Map<string, CachedRef<THREE.BufferGeometry>>()
  private generation: CompileGeneration | null = null
  private restoreCount = 0
  /**
   * 本呈现器当前份额所属的**设备代次**（SPEC §6:206；与 `generation` 不同空间）。
   *
   * 权威不在本类：`PresenterSession` 的设备状态机推进代次后，经
   * `beginDeviceGeneration()` 下发（装配边只在这里**镜像**一份用于归属键）。
   * 它进归属键 ⇒ 旧代次的条目在账上与新代次条目可区分（§7.5:262）。
   */
  private deviceGeneration: DeviceGeneration = 1
  /**
   * 上一次 `apply` 的场景（**供换纹理绑定时重放**）。
   *
   * 存整份引用而不只存"批次键集"：重放需要完整的 payloads 才能按新绑定重建材质。
   * `CompiledScene` 是**可丢弃**的纯数据（契约 §6），故多持一份引用不构成新的权威
   * —— 它随时可由 `compileScene` 重建。
   */
  private lastScene: CompiledScene | null = null

  /**
   * 已挂载的**动画材质**：材质键 → (纹理, 绑定)。纹理按内容身份共享，采样时按纹理去重。
   *
   * ## 为什么按"材质键"登记而不是"按材质对象"
   *
   * 材质缓存键（materialIdentityOf 的 identityKey）就是卸载时的检索键
   * （releaseMaterialRef）；用同一把钥匙登记，登记与释放不会各说各话。
   * 而**采样**是纹理级操作（offset/repeat 是 THREE.Texture 的属性）⇒
   * 一次 applySceneTime 里对同一张纹理只写一次（见该方法）。
   */
  private readonly animatedMaterials = new Map<string, { texture: THREE.Texture; binding: TextureBinding }>()
  /**
   * 当前场景秒数（**唯一**时间输入；由 PresenterSession 每帧经 setSceneTime 落进来）。
   *
   * 呈现器**不读时钟、不累加 delta**：它只保存"这一帧的时间是什么"，
   * 于是同一时间必然得到同一样本（跳帧/倒退/离屏冻结序列都走这一个值）。
   */
  private sceneSeconds = 0
  /** 上次写入的样本（按 assetId 去重；诊断读面）。 */
  private readonly lastSamples = new Map<string, TextureSampleReport>()
  /** 采样失败次数（**不**回落 0 帧冒充成功）。 */
  private sampleErrors = 0
  /** 声明了帧混合而被**阶跃**呈现的样本数（M5 的显式能力缺口，不静默假装）。 */
  private blendedSamples = 0
  /** 因相位绑定而**未登记**动画的材质数（同一纹理被多相位共享时 offset 会互相覆盖）。 */
  private phaseAnimationSkipped = 0
  /** 已诊断过的混合素材（每个 assetId 只告警一次，避免每帧刷屏）。 */
  private readonly blendReported = new Set<string>()

  private readonly stats: PresenterStats = {
    applies: 0,
    geometryBuilds: 0,
    geometryReuses: 0,
    materialBuilds: 0,
    materialReuses: 0,
    batchReuses: 0,
    batchBuilds: 0,
    disposals: 0,
    batchObjects: 0,
    instanceCount: 0,
    missingRequiredTextures: 0,
  }

  constructor(private readonly options: PresenterOptions) {
    this.group.name = `presentation-batches:${options.scope}`
  }

  /** 挂载根（调用方把它加进主场景的 structure 层）。 */
  get object3d(): THREE.Group {
    return this.group
  }

  get currentGeneration(): CompileGeneration | null {
    return this.generation
  }

  get deviceScope(): string {
    return this.options.scope
  }

  get restores(): number {
    return this.restoreCount
  }

  /** 当前份额所属的设备代次（诊断/判据面）。 */
  get currentDeviceGeneration(): DeviceGeneration {
    return this.deviceGeneration
  }

  /**
   * 切到**新的设备代次**（只允许在旧代次份额被全部放弃之后）。
   *
   * ## 为什么必须显式给代次而不是本地自增
   *
   * 代次的唯一权威是 `DeviceStateMachine`（它是"第几次有效设备生命周期"的持有者）。
   * 呈现器若自己再数一份，就会出现两个答案 —— 而"旧代次不服役"的判据正是
   * 比对这个数字。故本方法只接受**已推进**的代次，并拒绝两种违约形态：
   *  - 没有推进（`generation <= current`）⇒ no-op（重复恢复事件幂等）；
   *  - 旧份额仍在服役（`activeCount > 0`）⇒ 抛错（那会让旧句柄带着新代次号复活）。
   */
  beginDeviceGeneration(generation: DeviceGeneration): void {
    if (generation <= this.deviceGeneration) return
    if (this.ownership.activeCount() !== 0) {
      throw new Error(
        `presenter: 旧代次仍有 ${this.ownership.activeCount()} 条活跃份额，不能切到设备代次 ${generation}`,
      )
    }
    this.deviceGeneration = generation
  }

  /**
   * 当前可查询的运行统计。
   *
   * `batchObjects` / `instanceCount` 是**实时**读数（不是累计），其余为累计。
   */
  statsSnapshot(): PresenterStats & {
    generation: CompileGeneration | null
    deviceGeneration: DeviceGeneration
    scope: string
  } {
    return {
      ...this.stats,
      batchObjects: this.mounted.size,
      instanceCount: this.countInstances(),
      generation: this.generation,
      deviceGeneration: this.deviceGeneration,
      scope: this.options.scope,
    }
  }

  /**
   * 资源计数对账（A19 主判据）。
   *
   * 覆盖**本呈现器显式登记**的资源：材质与几何各 acquire 一次、卸载时 release 一次。
   * M8 起设备丢失的份额由 `abandonAll` **单列**记账，守恒式见
   * `presentation/ownership#ledger`（acquire 的三去向：released + abandoned + live）。
   */
  ledger(): ReturnType<OwnershipRegistry['ledger']> {
    return this.ownership.ledger()
  }

  /**
   * **场景时间**（秒）。只写呈现参数（纹理的 repeat.y/offset.y），
   * **不改结构、不触发重编、不设 needsUpdate**。
   *
   * ## 为什么同值短路
   *
   * 播放时每帧都会调用它；时间没变（暂停、倍率 0、亚帧取整）时没有任何新样本要写。
   * 短路省掉每帧一遍映射遍历与一次采样对象分配 —— 而"暂停 500 ms 样本不漂"
   * 也因此是结构事实，不是靠"反正写进去也一样"。
   *
   * apply/rebind 走**私有** applySceneTime 强制落一次（新材质必须拿到初值，
   * 不能被"同值"吞掉）。
   */
  setSceneTime(seconds: number): void {
    const s = Number.isFinite(seconds) ? seconds : 0
    if (s === this.sceneSeconds) return
    this.sceneSeconds = s
    this.applySceneTime()
  }

  /**
   * 当前**纹理样本**（按 assetId 去重；冻结数组）。e2e/单测的观测面。
   *
   * 空数组 = 没有已登记的动画材质（**不是**"采样失败"：失败计入
   * textureSampleStats().errors）。
   */
  textureSamples(): readonly TextureSampleReport[] {
    return Object.freeze([...this.lastSamples.values()])
  }

  /** 采样诊断计数（错误 / 声明混合未混合 / 相位跳过）。 */
  textureSampleStats(): { errors: number; blended: number; phaseSkipped: number } {
    return Object.freeze({
      errors: this.sampleErrors,
      blended: this.blendedSamples,
      phaseSkipped: this.phaseAnimationSkipped,
    })
  }

  /**
   * 把当前 sceneSeconds 落到全部已登记动画材质上（**唯一**采样写点）。
   *
   * ## 竖条裁切为什么是 repeat.y/offset.y（而不是改 UV）
   *
   * 几何 UV 是**满 tile**（0..1），整张竖条平铺会把所有帧压进一个面。正确的呈现手段是
   * 纹理级变换：repeat.y = 1/N 把 V 压到一格，offset.y 选择哪一格。它**不碰
   * 顶点数据、不改几何身份、不改批次身份** ⇒ 播放期零重建（G1/A11 的前提）。
   *
   * ## 三条纪律
   *
   * 1. **不设 texture.needsUpdate**：那会让 GPU 每帧重传整张像素（legacy
   *    applyFrameOffset 的先例正是只写 uniform）；
   * 2. **按纹理去重**：offset 是纹理级属性，同一纹理的多个材质写同一个值；
   * 3. **失败显式计数**（sampleErrors），**不**回落 0 帧/1 帧冒充成功。
   *
   * ## flipY 分支（不是洁癖）
   *
   * 帧 0 = 竖条**最上一格**（与 legacy textureStripAnimation 的约定一致）。flipY=false
   * 时 V 向下增长 ⇒ offset.y = frame/N；flipY=true（纹理上下翻转）时帧序整体倒过来
   * ⇒ offset.y = (N-1-frame)/N。不分支会让"将来出现 flipY=true 的采样"上下颠倒。
   */
  private applySceneTime(): void {
    const seconds = this.sceneSeconds
    /** 本遍已写过的纹理（纹理级去重；见上）。 */
    const written = new Set<THREE.Texture>()
    const reports = new Map<string, TextureSampleReport>()
    for (const { texture, binding } of this.animatedMaterials.values()) {
      const animation = binding.animation
      if (animation === undefined || binding.map === undefined) continue
      const sampled = sampleBoundTexture(binding, animation.sequence, seconds)
      if (!sampled.ok) {
        // 显式失败：保持上一次偏移（不写 0 冒充第 0 帧），并计数。
        this.sampleErrors += 1
        continue
      }
      const stripFrameCount = animation.stripFrameCount
      const frame = Math.max(0, Math.min(stripFrameCount - 1, sampled.value.frame))
      const offsetY = binding.sampling.flipY
        ? (stripFrameCount - 1 - frame) / stripFrameCount
        : frame / stripFrameCount
      if (!written.has(texture)) {
        written.add(texture)
        texture.repeat.y = 1 / stripFrameCount
        texture.offset.y = offsetY
        // 只写 uniform：不设 texture.needsUpdate（见上）。
      }
      if (sampled.value.mix !== 0) {
        // 声明了 interpolate ⇒ 本应两帧混合；M5 只做阶跃。**显式**暴露缺口，
        // 不静默假装"已混合"（每个 assetId 只告警一次，避免每帧刷屏）。
        this.blendedSamples += 1
        const assetId = binding.map.id
        if (!this.blendReported.has(assetId)) {
          this.blendReported.add(assetId)
          console.warn(
            `[presenter] texture-blend-not-applied:${assetId} —— 该纹理声明了 interpolate，`
              + 'M5 只做离散阶跃（mix 不参与呈现）；要真混合需另立工作包',
          )
        }
      }
      const key = binding.map.id
      if (!reports.has(key)) {
        reports.set(
          key,
          Object.freeze({
            assetId: binding.map.id,
            contentVersion: binding.map.version,
            seconds,
            frame,
            nextFrame: sampled.value.nextFrame,
            mix: sampled.value.mix,
            stripFrameCount,
            offsetY: texture.offset.y,
            repeatY: texture.repeat.y,
          }),
        )
      }
    }
    // 只保留**当前登记**的样本：卸载掉的材质不得残留读数（否则读面会说谎）。
    this.lastSamples.clear()
    for (const [key, report] of reports) this.lastSamples.set(key, report)
  }
  /**
   * 应用一次编译结果（**GPU 上传阶段**）。
   *
   * 增量策略（G1 的关键）：
   *  - 几何按**内容身份**缓存并计数引用 ⇒ 两次编译间同一身份被复用时不新建 `BufferGeometry`
   *    （于是"变一个注解文字"不会重建方块几何）；
   *  - 批次对象按**成员身份键**复用 ⇒ 键相同则只更新实例矩阵，不重建对象；
   *  - 本次不再存在的批次被卸载并释放引用。
   */
  apply(scene: CompiledScene): void {
    this.stats.applies += 1
    this.generation = scene.generation
    this.lastScene = scene

    const nextKeys = new Set<string>()
    for (const payload of scene.payloads) {
      const key = batchKeyOf(payload)
      nextKeys.add(key)

      const existing = this.mounted.get(key)
      if (existing !== undefined && canReuse(existing, payload)) {
        this.stats.batchReuses += 1
        this.updateInstances(existing, payload)
        continue
      }
      if (existing !== undefined) this.unmount(existing)

      const mounted = this.mount(payload)
      this.mounted.set(key, mounted)
      this.group.add(mounted.object)
      this.stats.batchBuilds += 1
    }

    for (const mounted of [...this.mounted.values()]) {
      if (!nextKeys.has(mounted.key)) this.unmount(mounted)
    }
    // 新建/重挂的材质**立刻**拿到当前帧的偏移，不依赖下一次 tick（否则重编那一帧
    // 会显示上一个时间点的样本，而画面上没有任何报错）。
    this.applySceneTime()
  }

  /** 释放本呈现器持有的全部份额（+ 卸载全部批次对象）。 */
  dispose(): void {
    for (const mounted of [...this.mounted.values()]) this.unmount(mounted)
    for (const [key, cached] of [...this.geometryCache.entries()]) {
      cached.value.dispose()
      this.stats.disposals += 1
      this.geometryCache.delete(key)
      this.ownership.release(this.entryOf(geometryIdentityOf(key)))
    }
    for (const [key, cached] of [...this.materialCache.entries()]) {
      cached.value.dispose()
      this.stats.disposals += 1
      this.materialCache.delete(key)
      this.ownership.release(this.entryOf(materialIdentityOfKey(key)))
    }
    this.animatedMaterials.clear()
    this.lastSamples.clear()
    this.blendReported.clear()
    this.group.clear()
    this.generation = null
  }

  /**
   * WebGL 丢失处置：**放弃全部 GPU 句柄**，但**保留**可重建的 CPU 侧描述
   * （#249 §19.5「重建 GPU 设备资源…不改写文档或清空编辑上下文」）。
   *
   * 返回被放弃的句柄数（单列在 `OwnershipRegistry.abandoned` 上，使"正常回收"与
   * "设备丢失放弃"在账上可区分）。
   */
  handleContextLost(): number {
    // 清掉挂载表与两个缓存，使恢复时**必然**重建 —— 旧 GPU 句柄不复用（A30 明文）。
    for (const mounted of this.mounted.values()) this.group.remove(mounted.object)
    this.mounted.clear()
    this.geometryCache.clear()
    this.materialCache.clear()
    // 旧 GPU 纹理句柄已失效：动画登记与样本读数一并清空（恢复后按当前时间重新落一次）。
    this.animatedMaterials.clear()
    this.lastSamples.clear()
    const abandoned = this.ownership.abandonAll('webgl-context-lost')
    this.generation = null
    return abandoned
  }

  /**
   * WebGL 恢复：调用方随后用**当前有效版本**重新 `apply()` 一次
   * （A30「恢复后按当前有效版本重建」）。本方法把"需要重建"显式化并计数，
   * 避免"只 resize 而不重建归属资源"（A30 负对照）。
   */
  handleContextRestored(): void {
    this.restoreCount += 1
  }

  /**
   * 更新材质 → 纹理绑定（#299 P10e）。
   *
   * ## 为什么必须**卸载并重建**受影响的批次，而不是只改 `options`
   *
   * 材质缓存键**含纹理内容身份**（见 `materialIdentityOf`：`mapKey` 进 id）。
   * ⇒ 换一张贴图会改材质身份 ⇒ 旧批次缓存里的材质**不再是**正确的材质。
   * 若只替换 `options.textureBindings` 而不重建，那些批次会继续用旧材质渲染
   * —— 画面永远显示旧图，而那是 A28 负对照「按 URL 而不按内容版本缓存」的同族形态
   * （用户改完贴图看不到变化）。
   *
   * ## 为什么重建**不能**留给"下一次 `apply`"
   *
   * `apply` 的批次复用键含**成员身份 + 几何身份**而**不含材质身份**
   * （见 `batchKeyOf`/`canReuse`）—— 于是"换绑定后再 apply 同一个场景"
   * 会被判为可复用，旧材质照样留着。更糟的是：若调用方此后不再 apply
   * （内容确实没变，它没理由再 apply），画面会**停在卸载后的空状态**。
   *
   * ⇒ 本方法自己做完整的"卸载 → 按新绑定重建"，且只用**上一次 apply 的场景**
   * （不要求调用方重新给）。于是"换绑定"这件事自洽，不依赖调用方的调用时机。
   */
  setTextureBindings(bindings: ReadonlyMap<string, TextureBinding>): void {
    // ① 归零"曾经动画、现在不再动画"的纹理：offset/repeat 是纹理级属性，
    //    残留的旧偏移会把静态贴图裁成一格（画面上是"贴图突然只剩一条"）。
    const animatedMaps = new Set<string>()
    for (const b of bindings.values()) {
      if (b.animation !== undefined && b.map !== undefined) animatedMaps.add(identityKey(b.map))
    }
    const staleTextures = new Set<THREE.Texture>()
    for (const { texture, binding } of this.animatedMaterials.values()) {
      if (binding.map !== undefined && !animatedMaps.has(identityKey(binding.map))) staleTextures.add(texture)
    }
    for (const tex of staleTextures) {
      tex.repeat.set(1, 1)
      tex.offset.set(0, 0)
    }
    // ② 登记与读数随新绑定重建（旧键不再有意义）。
    this.animatedMaterials.clear()
    this.lastSamples.clear()
    this.options.textureBindings = bindings
    if (this.lastScene === null || this.generation === null) return
    // 卸载全部批次后按新绑定重建（几何/材质缓存仍按内容身份复用，
    // 故这里的重建只重建**批次对象**与新材质，不重算几何数值）。
    for (const mounted of [...this.mounted.values()]) this.unmount(mounted)
    this.remountLastScene()
    // 重挂后**立刻**重采样（新材质不得等下一次 tick 才拿到当前帧偏移）。
    this.applySceneTime()
  }

  /**
   * 按当前绑定重建上一次 apply 的场景（`setTextureBindings` 的重建半边）。
   *
   * `generation` 在重建后必须**保持不变** —— 它是"这批绘制数据"的身份，
   * 而换绑定改的是**材质**（呈现参数）而不是绘制数据的结构。
   * 世代变了会让下游（拾取映射）整体失效，表现为"换张贴图后点不中方块了"。
   */
  private remountLastScene(): void {
    const scene = this.lastScene
    const generation = this.generation
    if (scene === null) return
    // 走 apply 的挂载逻辑，但保住世代（apply 会重算 generationOf；对同一 scene
    // 它是同一值，故这里只需断言而不是修补）。
    this.apply(scene)
    if (this.generation !== generation) {
      // 同场景重放不该改世代。真出了这种情况说明 `generationOf` 不再纯 ——
      // 那是实现缺陷，**显式**暴露而不是静默接受（否则拾取会在换绑定后静默全失效）。
      console.error(
        `[presenter] setTextureBindings: 世代在重放同一场景时改变（${generation} → ${this.generation}）` +
          '—— generationOf 不再是纯函数，拾取映射会静默失效',
      )
    }
  }

  /**
   * 由一次真实 raycast 命中解出**批次内引用**（#299 P10e 交互面重建的桥）。
   *
   * ## 为什么这个桥必须在呈现器上（不能在外面自己走 `object.parent`）
   *
   * "命中的这个 `Object3D` 是哪个批次的第几个实例"是**呈现器自己**在挂载时建立的
   * 对应关系（`userData.presentationBatch`，见 {@link batchTagOf}）。外面若自己
   * 反查（例如按 `object.name` 解析或按父链位置猜），就会造出**第二份**批次映射 ——
   * 而两份映射漂移的表现是"点选偶尔点到隔壁实例"（静默错误）。
   *
   * ## 为什么返回 `BatchHitRef` 而不是 `PickResolution`
   *
   * 呈现器**不持有** `PickIndex`（那是编译产物的派生视图，属调用方）。
   * 它只回答它唯一有资格回答的问题："这次命中对应哪个批次/实例/三角形"。
   * 解回对象与格身份由调用方经 `PickIndex.resolve` 做 —— 于是
   * "批次序号不得当对象身份"这条纪律在**类型上**仍然成立（本方法的返回类型里
   * 根本没有 `objectId`）。
   *
   * ## 三种挂载形态都要覆盖（这是本方法唯一的复杂度来源）
   *
   * | 形态 | 命中对象 | 槽位来源 |
   * |---|---|---|
   * | 实例化（`InstancedMesh`） | 批次对象本身 | `intersection.instanceId` |
   * | 共享几何 + 独立变形（`Group` + N `Mesh`） | 子 `Mesh` | 子对象的 `userData.instanceSlot` |
   * | 非同质（`Group` + 逐成员 `Mesh`/几何） | 子 `Mesh` | 同上 |
   *
   * 实例化路径**必须**读 `instanceId`：它没有"第几个子对象"这回事
   * （只有一个网格 + N 个矩阵）。把两者混起来（例如一律读 `userData`）
   * 会让实例化路径恒解到槽位 0 —— 10,000 个对象里只能点中第一个。
   *
   * `generation` 由呈现器当前世代填：调用方拿它去 `PickIndex.resolve`，
   * 过期世代在那里被判 `null`（A12）。
   */
  batchHitOf(intersection: THREE.Intersection): BatchHitRef | null {
    if (this.generation === null) return null
    const obj = intersection.object
    const tag = (obj.userData as { presentationBatch?: ReturnType<typeof batchTagOf> }).presentationBatch
    if (tag === undefined) return null
    const batchIndex = tag.batchIndex
    if (typeof batchIndex !== 'number') return null

    // 实例化：槽位来自 raycaster 的 `instanceId`（**不是** `userData` —— 见上）。
    if (typeof intersection.instanceId === 'number') {
      return {
        generation: this.generation,
        batchIndex,
        instanceSlot: intersection.instanceId,
        primitiveIndex: intersection.faceIndex ?? undefined,
      }
    }
    // 非实例化：槽位写在子对象的标签里（挂载时逐个写入）。
    const slot = tag.instanceSlot
    if (typeof slot !== 'number') return null
    return {
      generation: this.generation,
      batchIndex,
      instanceSlot: slot,
      primitiveIndex: intersection.faceIndex ?? undefined,
    }
  }

  /**
   * 遍历本呈现器的全部可命中对象（供调用方交给 `Raycaster.intersectObjects`）。
   *
   * 为什么不由呈现器自己持有 raycaster：raycaster 需要**相机**，而相机属视口
   * （#249 §3.4：机位是视口事实）。呈现器只暴露"可命中的物体集合"，
   * 于是"用哪个相机、从哪个 NDC 发射"完全留在视口侧 —— 同一份呈现产物
   * 因此可以同时服务两个 Area 的拾取（A05）。
   */
  pickTargets(): readonly THREE.Object3D[] {
    return [...this.mounted.values()].map((m) => m.object)
  }

  // ── 挂载 / 更新 / 卸载 ──

  private mount(payload: BatchPayload): MountedBatch {
    const materialIdentity = materialIdentityOf(payload.material)
    const material = this.materialFor(payload.material, this.options.textureBindings?.get(payload.material.id))
    const geometryKey = geometryKeyOf(payload)
    const geometry = this.geometryFor(geometryKey, payload.attributes)
    /** 非同质批次里**与批次级不同**的成员材质键（卸载时逐份释放，见 `unmount`）。 */
    const memberMaterialKeys: string[] = []

    let object: THREE.Object3D
    if (payload.instanceable && payload.sharedGeometry) {
      const inst = new THREE.InstancedMesh(geometry, material, payload.instances.length)
      inst.name = `batch:${payload.batchIndex}`
      for (const instance of payload.instances) {
        inst.setMatrixAt(instance.instanceSlot, matrixOf(instance.transform))
      }
      inst.instanceMatrix.needsUpdate = true
      inst.userData.presentationBatch = batchTagOf(payload)
      object = inst
    } else if (payload.sharedGeometry) {
      const holder = new THREE.Group()
      holder.name = `batch:${payload.batchIndex}`
      for (const instance of payload.instances) {
        const mesh = new THREE.Mesh(geometry, material)
        mesh.applyMatrix4(matrixOf(instance.transform))
        mesh.userData.presentationBatch = batchTagOf(payload, instance.instanceSlot)
        holder.add(mesh)
      }
      object = holder
    } else {
      // 非同质批次：**逐成员**材质/几何（不得用代表值糊过去 —— 那会把 A 的纹理画到 B 上）
      const holder = new THREE.Group()
      holder.name = `batch:${payload.batchIndex}`
      for (const instance of payload.instances) {
        const attrs = instance.attributes
        const memberGeometryKey = instance.geometryId !== undefined
          ? `geo:${instance.geometryId}`
          : (attrs !== undefined ? `${geometryKey}#${instance.objectId}` : geometryKey)
        const g = attrs !== undefined
          ? this.geometryFor(memberGeometryKey, attrs)
          : geometry
        // 成员自己的材质（合并批次里批次级只是代表值）。绑定也必须按**成员**材质 id 取。
        const descriptor = instance.material ?? payload.material
        const binding = this.options.textureBindings?.get(descriptor.id)
        const m = this.materialFor(descriptor, binding)
        if (descriptor.id !== payload.material.id) {
          memberMaterialKeys.push(identityKey(materialIdentityOf(descriptor, binding)))
        }
        const mesh = new THREE.Mesh(g, m)
        mesh.applyMatrix4(matrixOf(instance.transform))
        mesh.userData.presentationBatch = batchTagOf(payload, instance.instanceSlot)
        holder.add(mesh)
      }
      object = holder
    }

    return {
      key: batchKeyOf(payload),
      object,
      materialIdentity,
      materialKey: identityKey(materialIdentity),
      geometryKey,
      /** 非同质批次会为每个成员各持一份几何引用 —— 卸载时逐份释放。 */
      memberGeometryKeys: payload.sharedGeometry
        ? []
        : payload.instances
            .filter((i) => i.attributes !== undefined)
            .map((i) => `${geometryKey}#${i.objectId}`),
      instanceCount: payload.instances.length,
      instanceable: payload.instanceable && payload.sharedGeometry,
      memberMaterialKeys,
    }
  }

  private updateInstances(mounted: MountedBatch, payload: BatchPayload): void {
    if (mounted.instanceable && mounted.object instanceof THREE.InstancedMesh) {
      const inst = mounted.object
      if (mounted.instanceCount !== payload.instances.length) {
        // 实例数变化 ⇒ 容量在构造期固定，必须重建
        this.unmount(mounted)
        const fresh = this.mount(payload)
        this.mounted.set(fresh.key, fresh)
        this.group.add(fresh.object)
        this.stats.batchBuilds += 1
        return
      }
      for (const instance of payload.instances) {
        inst.setMatrixAt(instance.instanceSlot, matrixOf(instance.transform))
      }
      inst.instanceMatrix.needsUpdate = true
      return
    }
    const children = mounted.object.children
    const reusable = children.length === payload.instances.length && mounted.memberGeometryKeys.length === 0
    if (!reusable) {
      this.unmount(mounted)
      const fresh = this.mount(payload)
      this.mounted.set(fresh.key, fresh)
      this.group.add(fresh.object)
      this.stats.batchBuilds += 1
      return
    }
    payload.instances.forEach((instance, i) => {
      const child = children[i]!
      child.matrixAutoUpdate = false
      child.matrix.copy(matrixOf(instance.transform))
      child.matrixWorldNeedsUpdate = true
    })
  }

  private unmount(mounted: MountedBatch): void {
    this.group.remove(mounted.object)
    this.stats.disposals += 1
    this.releaseMaterialRef(mounted.materialKey)
    for (const key of mounted.memberMaterialKeys) this.releaseMaterialRef(key)
    this.releaseGeometryRef(mounted.geometryKey)
    for (const key of mounted.memberGeometryKeys) this.releaseGeometryRef(key)
    this.mounted.delete(mounted.key)
  }

  // ── 几何缓存（G1 的落点）──

  private geometryFor(key: string, attrs: GeometryAttributes | undefined): THREE.BufferGeometry {
    const cached = this.geometryCache.get(key)
    if (cached !== undefined) {
      cached.refs += 1
      this.stats.geometryReuses += 1
      return cached.value
    }
    const geometry = attrs === undefined ? new THREE.BufferGeometry() : buildGeometry(attrs)
    if (attrs === undefined) {
      // 共享路径应总有属性；缺失时**显式标记**，不假装渲染成功（A36/G4）
      geometry.userData.presentationMissingAttributes = true
    }
    this.geometryCache.set(key, { value: geometry, refs: 1 })
    this.ownership.acquire(this.entryOf(geometryIdentityOf(key)), () => {})
    this.stats.geometryBuilds += 1
    return geometry
  }

  private releaseGeometryRef(key: string): void {
    const cached = this.geometryCache.get(key)
    if (cached === undefined) return
    cached.refs -= 1
    if (cached.refs > 0) return
    cached.value.dispose()
    this.stats.disposals += 1
    this.geometryCache.delete(key)
    this.ownership.release(this.entryOf(geometryIdentityOf(key)))
  }

  // ── 材质缓存 ──

  private materialFor(descriptor: MaterialDescriptor, binding: TextureBinding | undefined): THREE.Material {
    const identity = materialIdentityOf(descriptor, binding)
    const key = identityKey(identity)
    const cached = this.materialCache.get(key)
    if (cached !== undefined) {
      cached.refs += 1
      this.stats.materialReuses += 1
      return cached.value
    }
    const material = createMaterial(descriptor, binding, this.options.textures)
    this.materialCache.set(key, { value: material, refs: 1 })
    this.ownership.acquire(this.entryOf(identity), () => {})
    this.stats.materialBuilds += 1
    if (binding?.missingRequired === true) this.stats.missingRequiredTextures += 1
    this.registerAnimatedMaterial(key, binding)
    return material
  }

  private releaseMaterialRef(key: string): void {
    const cached = this.materialCache.get(key)
    if (cached === undefined) return
    cached.refs -= 1
    if (cached.refs > 0) return
    cached.value.dispose()
    this.stats.disposals += 1
    this.materialCache.delete(key)
    this.animatedMaterials.delete(key)
    this.ownership.release(this.entryOf(materialIdentityOfKey(key)))
  }


  /**
   * 登记一个**动画材质**（材质新建后调用；卸载时按同一把钥匙注销）。
   *
   * 三条跳过判据（都**不**静默）：
   *  1. 无绑定/无 animation/无 map ⇒ 静态贴图，不登记（缺席就是缺席）；
   *  2. 相位绑定 ⇒ **不登记**并计数：同一张纹理可能被多个相位共享，而 offset 是
   *     纹理级属性 ⇒ 两个相位会互相覆盖（"用第一个材质的相位糊过去"是更糟的静默错误）。
   *     生产相位数据当前恒缺席，故这只是显式的缺口登记；
   *  3. 纹理端口取不到纹理（未解码/缺失）⇒ 不登记（没有 GPU 贴图可写）。
   */
  private registerAnimatedMaterial(key: string, binding: TextureBinding | undefined): void {
    if (binding === undefined || binding.animation === undefined || binding.map === undefined) return
    if (binding.texturePhase !== undefined) {
      this.phaseAnimationSkipped += 1
      return
    }
    const texture = this.options.textures?.textureFor(binding.map)
    if (texture === null || texture === undefined) return
    this.animatedMaterials.set(key, { texture, binding })
  }

  /**
   * 归属条目身份：内容身份 × **设备作用域**。
   *
   * 作用域进键的理由：WebGL 句柄不跨 context 共用（#249 §11 明文）。同一份内容在两个
   * 渲染器里是两条独立条目 —— 于是"释放其一"与"释放全部"的计数语义天然正确，
   * 不需要调用方记住这一点（这正是 A19「一方关闭不破坏另一方」的实现基础）。
   */
  private entryOf(identity: ContentIdentity): OwnershipEntry {
    return { identity, deviceScope: this.options.scope, deviceGeneration: this.deviceGeneration }
  }

  private countInstances(): number {
    let n = 0
    for (const mounted of this.mounted.values()) n += mounted.instanceCount
    return n
  }
}

interface MountedBatch {
  key: string
  object: THREE.Object3D
  materialIdentity: ContentIdentity
  materialKey: string
  geometryKey: string
  memberGeometryKeys: string[]
  /** 非同质批次里逐成员的材质键（与 `memberGeometryKeys` 同族：卸载时逐份释放）。 */
  memberMaterialKeys: string[]
  instanceCount: number
  instanceable: boolean
}

interface CachedRef<T> {
  value: T
  refs: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 身份键（呈现层的内部约定；与 assetIdentity 的 `contentIdentityKey` 一致口径）
// ─────────────────────────────────────────────────────────────────────────────

/** 材质**实例**身份：id/version + 混合模式 + tint + 顶点色（不同 tint 必须不同材质）。 */
/**
 * 材质**内容身份**（#289 P10d：**含纹理内容身份**）。
 *
 * ## 为什么纹理必须进材质身份（A36 的"版本替换"判据）
 *
 * A36 要求「资源**版本替换**」可判定：同一 `materialId` 换了贴图内容 ⇒
 * 必须换材质身份，否则缓存命中、画面**永远显示旧图** —— 而那是 A28 负对照
 * 「按 URL 而不按内容版本缓存」的同族形态。
 *
 * 旧形态的身份只有 `(id, blend, tint, useVertexColor)`：它把"换贴图"表达不出来
 * （纹理根本不在呈现层）。补上 `map` 的**内容身份**后，"内容版本变了 ⇒ 身份变"
 * 自动成立，且判据与 `presentation/assetIdentity` 同一来源（`contentIdentityKey`）。
 *
 * ## 为什么用 `map` 而不是 locator
 *
 * §19.3：「资源引用包含稳定资源 ID 和内容版本/哈希，**URL 仅为获取位置**」。
 * 用 locator 会让"同一份贴图换了个镜像地址"变成两种材质（多余重建），
 * 而"同一 URL 覆盖上传"变成同一种材质（永不更新）—— 两个方向都错。
 */
export function materialIdentityOf(descriptor: MaterialDescriptor, binding?: TextureBinding): ContentIdentity {
  const mapKey = binding?.map === undefined ? '-' : contentIdentityKey(binding.map)
  // 相位进材质身份（#388 R2-①）：`-` = 无相位动画，`0/1` = 显式第 0 相位 ⇒ 两者是**两个**
  // 身份 ⇒ `materialCache` 不同条目（缺席相位不得复用第 0 相位的 GPU 材质）。
  // descriptor 是权威；`binding` 是它的派生（`bindTexture` 逐字复制），两处取 `??` 只为
  // "只给 binding 的调用方"仍能分开缓存 —— 不会把缺席归一成 `{0,1}`。
  const phaseKey = texturePhaseKeyOf(descriptor.texturePhase ?? binding?.texturePhase)
  return {
    id:
      `material:${descriptor.id}:${descriptor.blend}:${descriptor.tint}:${descriptor.useVertexColor ? 'vc' : 'plain'}` +
      `:${mapKey}:ph${phaseKey}`,
    version: descriptor.version,
  }
}

/**
 * 几何身份。
 *
 * `key` 就是 `${id}@${version}` 或（非共享路径下）`${id}@${version}#${objectId}`。
 * 后者的 `#objectId` 段是**局部**的：它只在同一个非共享批次内区分成员，不构成新的
 * 内容身份 —— 因为同一几何的成员属性**内容相同**时 key 相同、缓存自然合并。
 */
function geometryIdentityOf(key: string): ContentIdentity {
  const hash = key.lastIndexOf('@')
  if (hash < 0) return { id: `geometry:${key}`, version: '0' }
  return { id: `geometry:${key.slice(0, hash)}`, version: key.slice(hash + 1) }
}

function materialIdentityOfKey(key: string): ContentIdentity {
  const hash = key.lastIndexOf('@')
  if (hash < 0) return { id: `material:${key}`, version: '0' }
  return { id: key.slice(0, hash), version: key.slice(hash + 1) }
}

function identityKey(identity: ContentIdentity): string {
  return contentIdentityKey(identity)
}

// ─────────────────────────────────────────────────────────────────────────────
// 批次对象的稳定标识
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 批次对象的复用键：兼容性键 + **成员对象身份**。
 *
 * 为什么成员身份进 key：批次位置不得作为对象身份，但"这个批次由哪些对象组成"是
 * 批次本身的身份。成员变了（对象移出/加入）⇒ 必须重建该批次对象。
 */
function batchKeyOf(payload: BatchPayload): string {
  return `${payload.compatibilityKey}#${payload.instances.map((i) => i.objectId).join(',')}`
}

/**
 * 挂在批次对象上的诊断标签（e2e 观测面）。
 *
 * `objectIds` 是权威身份；`batchIndex` 只作诊断。这直接支撑"对象身份没有被批次序号
 * 取代"这一断言 —— 观测面里两者同时可见、且可断言前者稳定而后者可变。
 */
function batchTagOf(payload: BatchPayload, instanceSlot?: number): Record<string, unknown> {
  return {
    batchIndex: payload.batchIndex,
    compatibilityKey: payload.compatibilityKey,
    objectIds: payload.instances.map((i) => i.objectId),
    instanceSlot,
  }
}

function geometryKeyOf(payload: BatchPayload): string {
  return `${payload.geometry.id}@${payload.geometry.version}`
}

function canReuse(mounted: MountedBatch, payload: BatchPayload): boolean {
  return (
    mounted.geometryKey === geometryKeyOf(payload) &&
    mounted.instanceable === (payload.instanceable && payload.sharedGeometry) &&
    mounted.memberGeometryKeys.length === 0
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// three 对象构造（纯上传侧）
// ─────────────────────────────────────────────────────────────────────────────

function buildGeometry(attrs: GeometryAttributes): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(attrs.positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(attrs.uvs, 2))
  g.setAttribute('color', new THREE.BufferAttribute(attrs.colors, 3))
  g.computeVertexNormals()
  return g
}

/**
 * 材质 → three 材质的构造（**含纹理贴图**；#289 P10d 补）。
 *
 * ## 本函数替代什么（P10c 实测缺口）
 *
 * P10c（#286）实测原文：
 *
 * > `presentation/`（P5 交付、本应成为渲染输入的那一层）**完全不处理纹理**：
 * > `presenter.ts:524` 的 `createMaterial` 只设 `vertexColors`/`color`/`transparent`/
 * > `alphaTest` —— **没有 `map`**。全层零 `Texture` 使用。
 *
 * ⇒ 呈现通道下的方块没有贴图，而旧渲染链（`simpleMaterialLibrary`）有 ——
 * 切换即"画面变平"（能力回退）。本函数把 `map` 补上。
 *
 * ## 三条判据
 *
 * ### 1. 纹理按**内容身份**缓存，不按 URL
 *
 * `#289` 的硬约束是 `three ^0.174.0`；A28 的负对照是「按 URL 而不按内容版本缓存」。
 * 故 {@link PresenterOptions.textures} 是一个按 `contentIdentityKey` 索引的端口，
 * 而"同一 URL 换内容"在该索引下**必然**落进两个不同条目（见 `textureBinding.ts`）。
 *
 * ### 2. `map` 缺席 ⇒ **不设** `map`（不是设一张默认图）
 *
 * 顶点色/线框材质本就没有贴图。设默认图会让"这个材质没有贴图"与"贴图丢了"
 * 不可区分 —— 与 `textureBinding.ts` 的字段缺席口径一致。
 *
 * ### 3. 必需资源未就绪 ⇒ **显式不标成功**（G4/A36）
 *
 * `binding.missingRequired === true` 时**不**静默用占位顶上：本函数仍建材质
 * （否则整个批次消失，比缺贴图更糟），但走 `params.color` 的中性色并在
 * 呈现器的 `missingRequired` 计数里可见 —— 于是"渲染出了一个缺贴图的画面"
 * 是一个**可观测**的事实，而不是宣称完整。
 *
 * ## 采样设置
 *
 * `binding.sampling` 决定 `magFilter`/`minFilter`/`wrapS`/`wrapT`/`flipY`/mipmap ——
 * 它们是**呈现参数**（不进资源身份，见 `textureBinding.ts` 的说明）。
 * MC 体素风格默认 `nearest`（不插值），故 `filter: 'nearest'` 是默认。
 */
function createMaterial(
  descriptor: MaterialDescriptor,
  binding: TextureBinding | undefined,
  textures: TexturePort | undefined,
): THREE.MeshBasicMaterial {
  const params: THREE.MeshBasicMaterialParameters = {
    vertexColors: descriptor.useVertexColor,
    color: descriptor.useVertexColor ? 0xffffff : descriptor.tint,
  }
  if (descriptor.blend !== 'opaque') {
    params.transparent = true
    params.alphaTest = descriptor.blend === 'cutout' ? 0.5 : 0
    params.depthWrite = true
  }

  // ③ 纹理贴图（#289 P10d 补；缺席即不设 —— 见判据 2）。
  if (binding?.map !== undefined && textures !== undefined) {
    const tex = textures.textureFor(binding.map)
    if (tex !== null) {
      const s = binding.sampling
      tex.magFilter = s.filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter
      tex.minFilter = s.mipmaps
        ? s.filter === 'nearest'
          ? THREE.NearestMipmapNearestFilter
          : THREE.LinearMipmapLinearFilter
        : s.filter === 'nearest'
          ? THREE.NearestFilter
          : THREE.LinearFilter
      tex.wrapS = s.wrap === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
      tex.wrapT = s.wrap === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
      tex.flipY = s.flipY
      tex.anisotropy = s.anisotropy
      tex.needsUpdate = true
      params.map = tex
      // 贴图与顶点色**相乘**（体素路径的既有语义：几何带 UV + 顶点色，贴图提供纹素）。
      // `useVertexColor === false` 时 `color` 是整型 tint，同样与贴图相乘 ——
      // 这正是旧链 `simpleMaterialLibrary` 的口径。
    }
    // `tex === null`（还没解码 / 缺失）：按判据 3 走中性色，**不**设 map。
    // 计数由调用方经 `binding.missingRequired` 读（本函数不持有统计）。
  }
  return new THREE.MeshBasicMaterial(params)
}

/** 列主序 16 元 → `Matrix4`（`fromArray` 在 r174 支持数组 + 可选 offset）。 */
function matrixOf(values: readonly number[]): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray(values as number[])
}