/**
 * `shared/viewport/useKernelChannels` —— **通道取值的视口读面**。
 *
 * ## 本模块替代的旧机制（`per-viewport-staging` + `manual-refresh-chain`）
 *
 * 旧 `shared/viewport/useMultiblockChannels.ts` 让**每个视口自持一份**
 * `{totalTier, values, runstate}` + 一个 `revision` 计数器，并在取值变化时经
 * `bindMultiblockMeshSync` **手动链式**调 `loadStructureAndResources()` +
 * `rebuildContentMesh()`。两条后果：
 *
 * | 后果 | 为什么是缺陷 |
 * |---|---|
 * | 每个视口只能读到**自己那份**取值 | 契约要求取值属**编辑上下文**（同一上下文的所有 Area 读到同一份，"两视口有效坐标相同"） |
 * | 取值变化要靠调用方**手动**推重建 | 失效应由依赖图自动传播；手动链一旦漏挂就得到"滑杆动了画面不动" |
 *
 * ## 现在的形态（两条都换掉了）
 *
 * | 面 | 旧 | 新 |
 * |---|---|---|
 * | 取值权威 | 每视口 `state`（`ref`） | `EditContext.channelValues`（内核值，`kernelSession.channelValues()`） |
 * | 写入 | 每视口 `setTier`/`setChannelValue`/`setRunstate` 改本地 `ref` | `kernelSession.setChannelValue()`（经**唯一写通路** `setChannelValue` 命令） |
 * | 失效传播 | `revision` + `bindMultiblockMeshSync` 手动链 | 渲染侧按**内容身份**自行判定（`presentation/contentIdentity` + `contentRefreshTick`） |
 *
 * ## 这个模块为什么还在 `shared/viewport/`
 *
 * 它**不是**新的"每视口暂存"：它不持有任何取值状态，只把内核读面**投影**成视口
 * 需要的形状（面板模型 + 渲染视图文档）。状态归内核，本模块是纯投影 ——
 * 这正是 `retirementRegistry` 对 `per-viewport-staging` 的退出条件
 * （"删除 `useMultiblockChannels.ts`，其每视口 `state`/`revision`/`bindMultiblockMeshSync`
 * 一并消失，取值改经 `EditContext.channelValues`"）。
 *
 * ## 渲染视图文档仍需要（如实说明，不掩盖）
 *
 * 多方块文档的 `frame.grid` 恒为 `null`（网格是装配产物），而 DRW 只吃
 * `RuntimeDocument.serialize()`。故 `renderDoc` 仍构造一份**视图文档** ——
 * 但它的输入已从"每视口本地取值"改为"**内核**取值 + 内核装配产物"。
 *
 * ## 面板与画面吃**同一次**求值（断点②）
 *
 * 本模块不再自己调 `assembleMultiblockKernelFace`（那会让"面板尺寸"与"画面网格"
 * 各算一次）：面板的 `dims`/`variantKey` 与画面的定义面/几何都来自
 * `Context#kernelMultiblockEvaluation()` 的**同一份**派生场景。取值写入仍只经
 * `setChannelValue` 命令；本模块只负责"写后请求一次内容重读"（`contentRefreshTick`），
 * 失效判定仍由渲染侧按内容身份自行算。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'
import { kernelRenderViewFromFace, type KernelRenderView } from '@/composition/kernelRenderView'
import type { Context } from '@/runtime/context'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { multiblockDeclarationViewOf } from '@/domain/multiblockDocument'
import {
  clampChannelValue,
  projectMultiblockSelection,
  snapTierToSample,
  tierSampleValues,
  type MultiblockSelectionState,
} from '@/domain/multiblockSelection'
import {
  channelPanelModelOf,
  type MultiblockChannelPanelModel,
} from './multiblockChannelUi'

export interface KernelChannelControls {
  /** 当前文档是否为「多方块为主」形态（通道 tab 的唯一显隐条件） */
  isMultiblock: ComputedRef<boolean>
  /** 给 DRW 的渲染视图文档（帧为主文档 = 原文档本身） */
  renderDoc: ComputedRef<RuntimeDocument | null>
  /** 面板模型（非多方块文档为 null） */
  panel: ComputedRef<MultiblockChannelPanelModel | null>
  /**
   * 取值快照（**派生自内核**，不是本地状态）。
   *
   * 保留这个名字（旧 `revision` 的语义是"取值变了"）会让读者以为它仍是
   * 手动刷新信号 —— 故改名并说明：它是**内核取值的只读投影**，
   * 由 `context` 观察规格投递（`kernelSession.channelValues()`）。
   */
  readonly values: ComputedRef<MultiblockSelectionState>
  setTier(value: number): void
  setChannelValue(key: string, value: number): void
  setRunstate(id: string): void
}

  // 选择投影（含保留键 `$totalTier`/`$runstate` 与"以声明初值为底"的规则）
// 已下沉到 `domain/multiblockSelection#projectMultiblockSelection` —— 面板、装载装配、
// 画面求值**同一实现**。下面保留的是它为什么必须"以声明初值为底"的历史说明；
// 判据由 `context/__tests__/multiblockChannelRender.test.ts` 与 e2e 遍历把守。

/**
 * 取值投影的历史说明（实现见 `domain/multiblockSelection#projectMultiblockSelection`）。
 *
 * ## 为什么需要这层投影（而不是让内核直接存 `MultiblockSelectionState`）
 *
 * 内核的取值面是 `Record<string, number>`（契约 §5：通道取值是数值域）。
 * 而多方块的"选择"含一个**离散**运行态（`runstate` 是 id 字符串）。
 * 投影把"数值域 ↔ 离散选择"的换算收在**一处**：
 *  - 总档位 ↔ `$totalTier`（数值，直通）；
 *  - 运行态 ↔ `$runstate`（**下标**，因为数值域只能表达序数）；
 *  - 逐通道 ↔ 同名键（直通）。
 *
 * ## ⚠️ 必须以**声明初值**为底再叠加内核取值（实测修正）
 *
 * 契约 §5.1 明文：「变体声明值**每个通道都有**（未设置写 0）」——
 * 即 `values` 必须是**完整**表，不是"只有用户碰过的键"。
 *
 * 初版直接返回内核里的键 ⇒ 用户只设了 `coil` 时 `values = {coil: 2}`，
 * 缺 `height`/`glass` 等 ⇒ `multiblockVariantKey` 算出**不同的键**，
 * 面板 `data-mb-variant` 与期望不符、渲染收敛到错误的变体。
 * 实测由 `multiblock-channel-traversal.spec.ts`（全 552 组合）判红。
 *
 * 正解：先取 `initialMultiblockSelection(decl)`（它按契约填满所有通道，
 * 总档位取 `domain.default ?? max` 并吸附抽样、运行态取声明首项），
 * 再用内核取值**覆盖** —— 于是"没设过"与"设过 0"仍可区分（内核里没有的键
 * 保持声明初值，而不是被强制成 0）。
 */
export function useKernelChannels(ctx: Context): KernelChannelControls {
  const kernel = ctx.kernel

  /**
   * 内核取值快照的**反应式镜像**。
   *
   * `channelValues()` 是普通方法（内核值不是 Vue Ref）。故本模块用一个本地 `ref`
   * 做镜像，并在**内核投递后**刷新 —— 这是"投影"而不是"第二份状态"：
   * 它没有独立写入者（唯一写入者是内核投递与下面的 `syncFromKernel`），
   * 也没有独立语义（就是内核的值）。
   *
   * ## 为什么用轮询式 `watch` 而不是给内核加 Vue 依赖
   *
   * `runtime/kernelSession` 刻意**不** import Vue（内核是纯执行协议，见其文件头）。
   * 故镜像在**视口层**做：视口本来就在 Vue 里。
   *
   * 刷新源是**两个既有的**信号，都不需要新机制：
   *  1. `contentRefreshTick`（内容确实变了的唯一信号，与渲染侧同一信号）——
   *     取值改动由本模块自己 bump 它（见 `requestContentReread`），故"改了就同步"；
   *  2. 帧时钟的 `onFrame`（每帧推进）—— 覆盖"别处改了取值"（如快捷键/命令）的情形。
   */
  const mirror = ref<Readonly<Record<string, number>>>(kernel?.channelValues() ?? Object.freeze({}))

  function syncFromKernel(): void {
    if (kernel === undefined || kernel === null) return
    const next = kernel.channelValues()
    const prev = mirror.value
    // 值比较后再赋值：避免每次投递都触发下游重算（通道面板与渲染视图都是 computed）。
    if (next === prev) return
    let same = true
    const pk = Object.keys(prev)
    const nk = Object.keys(next)
    if (pk.length !== nk.length) same = false
    else {
      for (const k of nk) {
        if (prev[k] !== next[k]) { same = false; break }
      }
    }
    if (!same) mirror.value = next
  }

  // 内容信号（渲染侧同一信号）：换文档/取值改动后立刻同步。
  watch(ctx.getContentRefreshTick(), () => syncFromKernel(), { flush: 'sync' })

  /**
   * 帧时钟订阅（`onFrame` 是注册式回调，不是可 watch 的 Ref）。
   *
   * 用 `onMounted`/`onBeforeUnmount` 对齐寿命：时钟在父级 `onMounted` 启动
   * （子组件先挂载），故这里订阅时时钟可能还没设 —— 用 `watch` 等它出现。
   */
  let unframe: (() => void) | null = null
  function subscribeClock(): void {
    unframe?.()
    unframe = null
    const clock = ctx.getFrameClock()
    if (clock === null) return
    unframe = clock.onFrame(() => syncFromKernel())
  }
  watch(() => ctx.getFrameClock(), () => subscribeClock())
  onMounted(() => subscribeClock())
  onBeforeUnmount(() => {
    unframe?.()
    unframe = null
  })

    // ── 声明路径：吃**内核内容载体** `content.multiblock` + 域层索引视图 ──
  //
  // 切换前这里取 `ctx.legacyRenderSource()`（旧文档）再读 `doc.multiblock.decl` ——
  // 那是接缝 `legacy-render-source-document` 的**最后一个**生产消费点。现在：
  //  · 声明事实 ← `Context#kernelMultiblockDeclaration()`（= `DocumentContent.multiblock`；
  //    与装配面的声明投影是**同一个对象**，见 `composition/kernelAssembly.ts:622`）；
  //  · O(1) 查表 ← `domain/multiblockDocument#multiblockDeclarationViewOf`（**唯一**索引
  //    实现，与解析器共用 ⇒ 键面恒为四张表、不含 `raw`）。
  const declaredView = computed(() => {
    const decl = ctx.kernelMultiblockDeclaration()
    return decl === null ? null : multiblockDeclarationViewOf(decl)
  })
  /**
   * 通道 tab 的**唯一**显隐条件。
   *
   * ## 未装配 ⇒ `false`，这是**语义正确**而不是静默丢信息
   *
   * 判据是"内核是否保管了这份文档的多方块声明"（`Context#kernelMultiblockDeclaration()`
   * 在 `!hasAdoptedContent()` 时返回 `null`）。未装配成功 ⇒ 内核没有这份文档的**任何**
   * 声明事实 ⇒ 通道面板两个方向都没有对象：
   *  - 读（当前取值）：没有权威来源（取值属 `EditContext.channelValues`，而内核没承载它）；
   *  - 写（`setTier`/`setChannelValue`/`setRunstate`）：没有接收方（三个 setter 都以
   *    `declaredView` 为门，`null` 时**什么都不做**）。
   *
   * ⇒ 此时不出现通道 tab 是**正确**呈现，而不是"把可用的东西藏起来"。而"文档未被承载"
   * 这一事实本身由换帧路径上的**既有诊断通道**显式说出（`runtime/drwMeshPipeline` 的
   * `onFrameChangeUnavailable` 接线 ⇒ `ctx.wm.diagnostics`），不靠"tab 不见了"去暗示。
   */
  const isMultiblock = computed(() => declaredView.value !== null)

  const selection = computed<MultiblockSelectionState>(() => {
    const view = declaredView.value
    if (view === null) return { totalTier: 1, values: {}, runstate: '' }
    // **总是**投影：`projectSelection` 以声明初值为底再叠加内核取值 ——
    // 故"内核里一个键都没有"时它自然返回声明初值（不需要单独分支）。
    // 单独分支会让"用户设过 0"与"没设过"在两条不同代码路径上处理（易漂移）。
    return projectMultiblockSelection(view, mirror.value)
  })

  /**
   * **按当前取值的再装配**（面板与画面**同一份**装配产物）。
   *
   * 切换前本模块自己调 `assembleMultiblockKernelFace` 只为面板取尺寸 —— 而画面读的是
   * 装载期场景 ⇒ 两处对"当前取值"各有一个答案（断点②）。现在唯一求值点是
   * `Context#kernelMultiblockEvaluation()`（内部同样调 `assembleMultiblockKernelFace`），
   * 面板的尺寸/变体键与画面的网格来自**同一次**求值。
   *
   * ⚠️ `cellContent`（逐格说明叠加层）今天**没有内核承运的来源**：内核按设计不带
   * `tooltipPalette`/`cellTooltipGrid`（它们属解析侧的外部格式事实）⇒ 求值点不传（不伪造）。
   */
  const evaluation = computed(() => ctx.kernelMultiblockEvaluation())
  const kernelFace = computed(() => {
    const e = evaluation.value
    return e === null || e.assembly === null ? null : e.assembly
  })

  /**
   * **给 DRW 的渲染视图文档** —— 走**内核面求值**（`kernelRenderViewFromFace`）。
   *
   * ## 与切换前的差别
   *
   * | | 切换前（`kernelRenderViewOf`） | 现在（`kernelRenderViewFromFace`） |
   * |---|---|---|
   * | 输入 | 旧格式 `RuntimeDocument`（`ctx.legacyRenderSource()`） | body 承运 + 会话的 `scene`/`content`/`frameObjects`/声明投影（`ctx.kernelRenderViewInputs()`） |
   * | 装配 | `assembleKernelDocument({ doc })`：**整份文档**按新取值重装配 | `assembleMultiblockKernelFace({ body })`：**只**重装配多方块网格 |
   * | 元数据 | 靠 `kernelSourceRoot()` 传无损源（不传即有损降级） | **不需要**：`content` 本身就是装配期的内核内容（无损） |
   * | 身份 | `e:<hash>`（内容派生，不含机位） | 同左（`evaluationIdentityOf`，同一实现） |
   *
   * 实测两条内核路径**逐三角形一致**（`tier-only` 12 / `ebf-2ch` 12 / `lsc-overlap` 40）。
   *
   * ## `null` 的情形（与切换前同一处置：调用方保留上一次可渲染结果）
   *
   * 无会话 / 未装配成功（`kernelRenderViewInputs()` 为 `null`）、再装配失败、
   * 投影读不回 —— 三者都如实给 `doc: null`，**不**伪造一份"看起来能渲染"的文档。
   */
  const renderView = computed<KernelRenderView>(() => {
    const inputs = ctx.kernelRenderViewInputs()
    if (inputs === null) return { doc: null, identity: '', diagnostics: [] }
    return kernelRenderViewFromFace({
      scene: inputs.scene,
      content: inputs.content,
      frameObjects: inputs.frameObjects,
      multiblockDeclaration: inputs.multiblockDeclaration,
      identity: inputs.identity,
      frameIndex: ctx.getFrameIndex(),
    })
  })

  const renderDoc = computed<RuntimeDocument | null>(() => renderView.value.doc)

  const panel = computed<MultiblockChannelPanelModel | null>(() => {
    const view = declaredView.value
    // ⚠️ 与切换前**同一口径**：装配失败**不**让面板消失 —— 求值失败时
    // `kernelFace` 为 `null`，面板照样渲染（`dims: ''` + 提示）。若这里因
    // `kernelFace === null` 就 `return null`，面板会在"非法组合"下整块消失
      // （实测：`data-mb-variant` 找不到 ⇒ 遍历判据判红）。
    if (view === null) return null
    return channelPanelModelOf(
      view,
      selection.value,
        // 场景数（变体配置集合；不是时间轴帧数）—— 与内核声明 scenes 同源。
      ctx.kernelMultiblockDeclaration()?.scenes.length ?? 0,
      kernelFace.value,
    )
  })

  function setTier(value: number): void {
    const d = declaredView.value
    if (!d) return
    const next = snapTierToSample(tierSampleValues(d), value)
    if (next === selection.value.totalTier) return
    kernel?.setTotalTier(next)
    syncFromKernel()
  }

  function setChannelValue(key: string, value: number): void {
    const d = declaredView.value
    if (!d) return
    const next = clampChannelValue(d, key, value)
    if (next === null) return
    if ((selection.value.values[key] ?? 0) === next) return
    kernel?.setChannelValue(key, next)
    syncFromKernel()
  }

  function setRunstate(id: string): void {
    const d = declaredView.value
    if (!d) return
    const index = d.runstates.findIndex((r) => r.id === id)
    if (index < 0) return
    if (selection.value.runstate === id) return
    kernel?.setRunstateIndex(index)
    syncFromKernel()
  }

  /**
   * 取值变化 ⇒ 请求渲染侧重读（**唯一的"手动"动作，且它只表达"内容可能变了"**）。
   *
   * ## 为什么需要它（而它不是"手动刷新链"）
   *
   * 渲染侧的失效判定是**从数据算出的内容身份**
   * （`presentation/contentIdentity` 的 `contentIdentityOf` + `planContentRebuild`），
   * 由 `contentRefreshTick` 观察者驱动。而 `contentRefreshTick` 目前只在
   * `Main.replaceDoc`（换文档）时自增 —— 通道取值变化**不换文档引用**
   * （取值在内核 `EditContext` 里），故必须显式请求一次重读。
   *
   * 与旧 `bindMultiblockMeshSync` 的**关键差别**（这是它算不算"手动刷新链"的判据）：
   *
   * | | 旧 `bindMultiblockMeshSync` | 本函数 |
   * |---|---|---|
   * | 调用方声明 | 重建**范围**（`loadStructureAndResources` + `rebuildContentMesh`） | 只声明"内容**可能**变了" |
   * | 范围从哪来 | 调用方写死 | `planContentRebuild(contentIdentityOf(...))` **从数据算** |
   * | 内容未变时 | 仍全量重建（浪费） | `applyContentRefresh` 返回 `null`，**什么都不做** |
   *
   * ⇒ 本函数是依赖图传播所要求的形态（"失效由依赖图自动传播"在渲染侧的落点就是
   * 内容身份判定），不是被退役的那条链。旧链的**链式排队 + 写死范围**已消失。
   */
  function requestContentReread(): void {
    ctx.getContentRefreshTick().value += 1
  }

  function commit(action: () => void): void {
    action()
    requestContentReread()
  }

  return {
    isMultiblock,
    renderDoc,
    panel,
    values: selection,
    setTier: (v) => commit(() => setTier(v)),
    setChannelValue: (k, v) => commit(() => setChannelValue(k, v)),
    setRunstate: (id) => commit(() => setRunstate(id)),
  }
}
