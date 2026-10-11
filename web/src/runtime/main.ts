import { ref } from 'vue'
import type { Ref } from 'vue'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import {
  createMainCameraStore,
  type CameraMainKey,
  type EmbedPublishSettings,
  type MainCameraStore,
} from '@/runtime/mainCameras'
import type { ViewportCameraState } from '@/runtime/viewportCamera'
import type { EmbedWorkbenchEditHandlers } from '@/embed/embedContract'
import type { OperatorRegistry } from '@/operators/operatorRegistry'
import { wrapOperatorRegistry } from '@/operators/operatorRegistry'
import type { Context } from '@/runtime/context'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { ParserRegistryImpl } from '@/context/parserRegistry'
import { createParserRegistry } from '@/context/parserRegistry'

export interface MainRegistries {
  operators: OperatorRegistry
  operatorsFacade: {
    exec(id: string, props?: Record<string, unknown>): void | Promise<void>
    invoke(id: string, props?: Record<string, unknown>, event?: Event, regionId?: string): string
    find(id: string): { id: string; label: string } | undefined
    all(): { id: string; label: string }[]
    register(op: import('@/operators/operatorType').OperatorType): void
  }
  tools: ToolRegistry | null
  /**
   * **已删除**（#253 P2，退役 #3）：旧的 `rna: RNARegistry | null` 曾在 Main 上挂一份
   * 自带 `get`/`set` 闭包的属性描述。属性描述现在是数据（`@/application/properties`），
   * 由 `@/editors/workbench-rna` 按需构造，不挂在 Main 上。
   */
  parsers: ParserRegistryImpl
}

export class Main {
  readonly doc: Ref<RuntimeDocument | null> = ref(null)
  /**
   * **已删除**（P10 #261，退役 B5 #8 `frame-sequence-as-animation`）：
   * `currentFrameIndex` 与 `framesPlaybackIsPlaying` 两个 Vue Ref。
   *
   * ## 它们被什么替代（R-WK-03：播放状态归 `EditContext`）
   *
   * | 旧字段 | 新归属 |
   * |---|---|
   * | `currentFrameIndex: Ref<number>` | **派生值**：`KernelSession.frameIndex()` —— 由 `EditContext.time` 经离散阶跃采样（`domain/materials#sampleStripFrameAt`）算出，**不是**独立权威 |
   * | `framesPlaybackIsPlaying: Ref<boolean>` | `EditContext.playing`（经 `setPlaying` 命令写） |
   *
   * ## 为什么两个字段必须一起删（而不是留一个过渡）
   *
   * 旧形态下"帧下标"与"时间"是**两个独立权威**：帧下标由
   * `OPERATOR_SET_FRAME_INDEX` 直接写，与时间无关，于是"播放到第 5 帧"
   * 与"时间是第几帧"可以互相矛盾；而播放开关是驱动一个 `setTimeout` 自续链的
   * **唯一**输入（`drwMeshPipeline` 的 `scheduleNextWorldFrameStep`）。
   * 留任一个都会让"时间是不是唯一权威"变成一个含糊的问题 ——
   * 而它必须是明确的（A09「同时间同结果」/ A05「两视口读同一份」都依赖它）。
   *
   * 消费面全部迁到 `Context.requireKernelSession()`；见
   * `retirementRegistry` 的 `world-frame-playback` 组（相位 `executed`）。
   */

  /**
   * **内容重读请求**（#249 §15 第 5 条的替代物；原 `structEpoch` 的位置）。
   *
   * ## 它与被删除的 `structEpoch` 的本质差别
   *
   * | | `structEpoch`（已删） | 本字段 |
   * |---|---|---|
   * | 语义 | "我认为该重建了" | "内容可能变了，请**你自己读**" |
   * | 携带信息 | 无（只有次数） | 无 —— 但它**不是判据**，只是触发器 |
   * | 谁做判定 | 调用方（推版本） | 呈现层（比较内容身份） |
   * | 能否伪造"没变" | 能（`bumpStructEpoch: false`） | **不能**（没有设值入口） |
   *
   * 关键点：这个计数的**唯一**作用是让呈现层去重读内容。它不参与任何"该不该重建"的判定 ——
   * 判定全部由 `presentation/contentIdentity` 从数据算出。因此"非内容版本冒充内容变化"
   * （§15 第 5 条的删除判据）在结构上不再可能：无论本计数怎么变，内容没变就**不会**重建。
   *
   * ## 为什么还需要它（而不是只 watch 文档引用）
   *
   * 因为 legacy 的编辑路径**原地修改**网格（`Grid.moveBlock` 等），文档对象引用不变，
   * 单纯的 `watch(docRef)` 察觉不到。这个显式请求覆盖该情形；它是过渡设施，
   * 由 P1（#252）的受控提交收口为"提交即产生新版本"（届时本字段随之删除）。
   */
  readonly contentRefreshTick = ref(0)

  readonly registries: MainRegistries
  /**
   * 逻辑相机存储（**按键动态分配**；#282 P10b）。
   *
   * 从"固定两键 `{embed, workbench}`"改为按 **region id** 分配 —— 于是 Area 分割出
   * 的每个 3D 视口各有自己的机位（A05「保持独立观察视角」/§3.4「观察视角…各实例独立」）。
   * 详见 `mainCameras` 的文件头。
   */
  readonly cameras: Record<CameraMainKey, Ref<ViewportCameraState | null>>
  /** 相机存储本体（`cameras` 是它的按键视图；新增键请经 `ensure`）。 */
  private readonly cameraStore: MainCameraStore
  /** 文档 `meta.embed_initial_view` 的运行时镜像（加载/同步后写入） */
  readonly embedInitialView: Ref<ViewportCameraState | null>
  readonly embedPublish: Ref<EmbedPublishSettings>
  /** Wiki `data-wsr-structure` 对应 base 名（Embed 编辑跳转用） */
  readonly embedStructureBase = ref<string | null>(null)
  /** Entry `pollWorkbenchEdit` 结果（标题栏编辑钮灰显与 tooltip） */
  readonly embedWorkbenchEdit = ref<{ enabled: boolean; reason: string }>({
    enabled: false,
    reason: '',
  })
  embedWorkbenchHandlers: EmbedWorkbenchEditHandlers | null = null

  constructor(registries: Omit<MainRegistries, 'parsers' | 'operatorsFacade'> & {
    parsers?: ParserRegistryImpl
    operatorsFacade?: MainRegistries['operatorsFacade']
  }) {
    const { parsers, operatorsFacade, ...rest } = registries
    this.registries = {
      ...rest,
      operatorsFacade: operatorsFacade ?? stubOperatorFacade(rest.operators),
      parsers: parsers ?? createParserRegistry(),
    }
    const store = createMainCameraStore()
    this.cameraStore = store
    this.cameras = store.cameras
    this.embedInitialView = store.embedInitialView
    this.embedPublish = store.embedPublish
  }

  /**
   * 取（必要时创建）某相机键的 `Ref`。
   *
   * 为什么需要它：`cameras` 是**开放**键空间（按 region 分配），故消费者不能假设
   * 键已存在。旧形态下 `cameras[key]` 对两个固定键恒有值，新形态下"新视口的键"
   * 要经此创建 —— 否则第二个 3D Area 的机位会写到 `undefined`（静默丢弃）。
   */
  ensureCamera(key: CameraMainKey): Ref<ViewportCameraState | null> {
    return this.cameraStore.ensure(key)
  }

  /** 已分配的相机键（稳定排序；供诊断与 A13 资源对账）。 */
  cameraKeys(): readonly CameraMainKey[] {
    return this.cameraStore.keys()
  }

  /** 在 Context 创建后绑定 operator 门面（避免重复 wrap） */
  bindOperatorFacade(getCtx: () => Context, sanitize = false): void {
    this.registries.operatorsFacade = wrapOperatorRegistry(
      this.registries.operators,
      getCtx,
      sanitize,
    )
  }

  /**
   * 替换文档。
   *
   * 与旧实现的差别：
   *  - **没有** `bumpStructEpoch` 选项（判断"要不要重建"不是调用方的职权 ——
   *    呈现层会从文档内容算出身份并自行决定，`presentation/contentIdentity`）；
   *  - **没有** `resetFrameIndex` 选项（P10 #261）：帧下标不再是本对象的字段，
   *    而是由 `EditContext.time` 派生的值 ⇒ 换文档时"重置帧"就是
   *    "把时间定位到 0"，那是 `setTime` 命令的职责，不是文档替换的副作用。
   *    调用方若需要重置，显式发 `setTime`（见 `pipeline.ts` 的加载路径）。
   */
  replaceDoc(doc: RuntimeDocument | null): void {
    this.doc.value = doc
    // 文档引用变了，呈现层需重读内容（这是"内容可能变了"的请求，不是判定）
    this.contentRefreshTick.value += 1
  }

  /**
   * 请求呈现层**重读内容**（原 `bumpEpoch()` 的位置）。
   *
   * 用于原地修改文档/网格后（legacy 编辑路径）通知呈现层。与 `bumpEpoch()` 的区别：
   *  - 没有"重建"这一含义 —— 它只请求重读；
   *  - 调用方无法表达"这次不用重建"（旧 `bumpStructEpoch: false` 正是这种补丁）；
   *  - 内容没变时呈现层**什么也不做**（旧机制必然全量重建）。
   */
  requestContentRefresh(): void {
    this.contentRefreshTick.value += 1
  }
}

function stubOperatorFacade(registry: OperatorRegistry): MainRegistries['operatorsFacade'] {
  const notReady = (): never => { throw new Error('Context not bound; call bindOperatorFacade first') }
  return {
    exec: notReady,
    invoke: notReady,
    find: (id) => registry.find(id),
    all: () => registry.all(),
    register: (op) => registry.register(op),
  }
}
