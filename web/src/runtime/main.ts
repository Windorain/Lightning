import { ref } from 'vue'
import type { Ref } from 'vue'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import {
  createMainCameraStore,
  type CameraMainKey,
  type EmbedPublishSettings,
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
  readonly currentFrameIndex = ref(0)
  readonly framesPlaybackIsPlaying = ref(false)

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
  readonly cameras: Record<CameraMainKey, Ref<ViewportCameraState | null>>
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
    this.cameras = store.cameras
    this.embedInitialView = store.embedInitialView
    this.embedPublish = store.embedPublish
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
   * 与旧实现的差别：**没有** `bumpStructEpoch` 选项。判断"要不要重建"不是调用方的职权 ——
   * 呈现层会从文档内容算出身份并自行决定（`presentation/contentIdentity`）。
   * `resetFrameIndex` 保留：帧索引是**视图状态**，不属于内容判定。
   */
  replaceDoc(doc: RuntimeDocument | null, options?: { resetFrameIndex?: boolean }): void {
    const prev = this.doc.value
    this.doc.value = doc
    const newDocument = prev === null || (doc !== null && prev?.id !== doc.id)
    const resetFrame = options?.resetFrameIndex ?? newDocument
    if (doc && resetFrame) {
      this.currentFrameIndex.value = 0
    }
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
