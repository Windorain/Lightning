<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RenderEngineHost from '@/shared/viewport/RenderEngineHost.vue'
import type { RenderEngineReadyPayload } from '@/runtime/renderEngine'
import ViewportFrameLayerDock from '@/shared/viewport/ViewportFrameLayerDock.vue'
import { useContext } from '@/runtime/context'
import { hostKey } from '@/runtime/host'
import type { WorkbenchHost } from '@/runtime/host/workbenchHost'
import { useViewportRuntime } from '@/shared/viewport/useViewportRuntime'
import { useKernelChannels } from '@/shared/viewport/useKernelChannels'
import { availableDockTabs, defaultDockTab, resolveDockTab, type ViewportDockTab } from '@/shared/viewport/dockTabs'
import { REGION } from '@/runtime/regionIds'
import { createToolGizmoHandler } from '@/handlers/toolGizmoHandler'
import type { MoveGizmo } from '@/workbench/tools/gizmos'
import { createKeymapHandler } from '@/handlers/keymapHandler'
import { createHoverHandler } from '@/handlers/hoverHandler'
import type { ToolContext } from '@/workbench/tools/tool'
import { pickVoxel, pickAll, getCurrentFrame, gridCenterWorld, getBlockGeometry, getPartMaskGeometry } from '@/context/queries'
import ToolHintsBar from '@/workbench/ux/ToolHintsBar.vue'
import type { ToolHint } from '@/workbench/tools/tool'
import { createWorkbenchHoverBlockRef } from '@/runtime/hover/access'

const ctx = useContext()
const host = inject(hostKey)! as WorkbenchHost
const selection = ctx.getSelection()

/**
 * **本视口的 region id**（#282 P10b Area 产品接线）。
 *
 * ## 为什么它是 prop 而不是常量
 *
 * 旧实现写死 `REGION.WORKBENCH_VIEWPORT` —— 于是"工作台只能有一个 3D 视口"
 * 成为**组件层**的事实。Area 分割要挂第二个 3D Area，就必须让本组件知道自己
 * 是**哪一个**视口（region 是"输入域/相机/槽位/机位"的键，见 `mainCameras`）。
 *
 * 缺省仍是 `REGION.WORKBENCH_VIEWPORT`：**单视口装配的行为逐字不变**
 * （既有 e2e 与 `__vm__` 观测面读的就是这个 region）。
 */
const props = withDefaults(defineProps<{
  regionId?: string
  /**
   * 本 Area 在 `viewport3d` 类型下**已保存的局部状态**（`Workspace.layout.localState`）。
   *
   * 由 `AreaHost` 从布局树读出后下行（M7-2「localState 真接线」）。本组件只在
   * **setup 时读一次**：首帧即恢复形态（SPEC §7.3-b③「逻辑状态应在首次呈现前
   * 正确恢复」），不做"先默认再改回"的双跳。
   */
  localState?: Record<string, unknown>
}>(), {
  regionId: REGION.WORKBENCH_VIEWPORT,
})
const VIEWPORT_REGION_ID = props.regionId
const prefs = ctx.requireRegion(VIEWPORT_REGION_ID).state.viewer
if (!prefs) throw new Error(`viewer preferences missing on ${VIEWPORT_REGION_ID}`)

/**
 * 多方块通道取值（**归内核编辑上下文**；#282 P10b）。
 *
 * 必须先于 DRW 创建，`renderDoc` 即 DRW 的文档来源（T2.5 接线）。
 * 与旧 `useMultiblockChannels` 的差别：本 composable **不持有**取值状态
 * （旧形态每视口自持 `state` + `revision`），取值权威是
 * `EditContext.channelValues`，写入经 `setChannelValue` 命令 ⇒
 * "同一上下文的所有 Area 读到同一份取值"（#249 §3.3、A05）。
 */
const mb = useKernelChannels(ctx)
const {
  isMultiblock, renderDoc,
  panel: channelPanel,
  setTier: setChannelTier, setChannelValue, setRunstate: setChannelRunstate,
} = mb

const {
  drw, vpSlot, loadStatus, meshBusy, structureDefinition, mainMeshGroup,
  worldFrameIndex, layerWorldY, isPlaying,
  computed: drwComputed,
} = useViewportRuntime({
  ctx,
  regionId: VIEWPORT_REGION_ID,
  viewerPrefs: prefs,
  renderDocRef: renderDoc,
  /** **R1-A C10**：呈现会话包由装配边构造后下行（同上）。 */
  createPresenter: (rid) => host.createViewportPresenter(rid),
})

const {
  layerPreviewMode, layerPreviewLabel, gridHeight,
  hasWorldMultiFrame, worldFrameCount,
} = drwComputed

/**
 * **本视口自己的悬停描边目标**（M4-1 双区归属）。
 *
 * 旧写法是 `ctx.getHoveredBlock()`，而该读面当时写死根区 ⇒ 每个视口的描边都画
 * 根区的悬停格（B 区悬停时 A 的格子亮、A 区悬停时两区同时亮）。region 是悬停状态
 * 的键（`handlers/hoverHandler` 按 region 写），读面必须同键。
 *
 * 悬停的**非呈现**读面（底栏/检查器）走的是 `ctx.getHoveredBlock()` 的
 * "最近悬停区"规则 —— 两者分工是"本区描边"与"全域读数"，不是同一件事。
 */
const regionHoveredBlock = createWorkbenchHoverBlockRef(ctx, VIEWPORT_REGION_ID)

// ---- Hover（region.state.hover + 统一 HOVER handler）----
//
// ## M3-shell B1：编辑器视口**不再渲染悬浮 ToolTipBox**（用户裁决：编辑器视口无悬浮框）
//
// 旧接线（#398）把 `shared/viewport` 的解析链与 `ToolTipBox` 挂在本视口上。
// B1 撤掉它，悬停信息的呈现改到**固定位**：
//   - 右栏「方块检查器」在无选中时回落悬停方块（`workbench-rna#resolveRefs`，零改动）；
//   - `StatusBar` 的悬停格读数（见该组件）。
// 嵌入预览器（`EmbedViewport` + region `r-wiki-preview`）仍走原链路 ——
// `useEmbedTooltip`/`ToolTipBox` 原样保留，那是渲染器视口专属的呈现。
// 拾取本身（`handlers/hoverHandler` 写 `viewportBlock`）不受影响。

/**
 * 下方栏 tab：可用性与默认项走两端共用的纯逻辑（`dockTabs`），
 * Workbench 侧帧控制/分层预览恒被允许（是否显示帧 tab 仍由多帧与否决定）。
 *
 * ## ⚠️ "用户选择" 与 "默认" 必须分开（#282 P10b 实测修正）
 *
 * 旧实现是 `const _preferredTab = ref(defaultDockTab(availability))` —— 默认值在
 * **setup 时求值一次**。那在"本组件只在文档已存在时挂载"（旧 `v-if` 守卫）的前提下
 * 恰好正确：挂载时 `hasWorldMultiFrame` 已是真值。
 *
 * Area 产品接线后本组件由 `AreaHost` 挂载（**文档之前**就存在），于是：
 *
 *  1. setup 时 `hasWorldMultiFrame === false` ⇒ 可用列表 `['layer']` ⇒ 默认落 `'layer'`；
 *  2. 文档到达后可用列表变 `['frame','layer']`，但 `resolveDockTab('layer', …)`
 *     因 `'layer'` 仍在列表里而**保留它** ⇒ 帧控制 tab 永不成为默认。
 *
 * 实测症状：`multiblock-frame-regression.spec.ts` 的
 * `FRAME_SLIDER = 'input[aria-label^="当前帧"]'` 找不到元素（该 spec 在
 * 相机键提交上通过、在 Area 接线提交上失败）—— 这正是"跨批回归"的形态。
 *
 * 修法：`_userTab` 只记**用户显式选择**（`null` = 没选过）。没选过时 active 直接
 * 取 `defaultDockTab(可用列表)` —— 那正是 `dockTabs.ts` 对"默认 tab"的定义
 * （"可用列表中优先级最高者"），于是"文档形态决定默认 tab"与**挂载时机**解耦。
 * 选过之后仍走 `resolveDockTab`（首选不可用时回落到最高优先级，不残留空 panel）。
 */
const dockTabAvailability = computed(() => ({
  showFrameTab: true,
  hasWorldMultiFrame: hasWorldMultiFrame.value,
  showLayerTab: true,
  showChannelsTab: isMultiblock.value,
}))
const dockTabs = computed(() => availableDockTabs(dockTabAvailability.value))
/**
 * 读回本实例的局部状态（M7-2 接线）。
 *
 * ## 为什么 `viewport3d` 的局部状态**只有这一项**
 *
 * | 状态 | 归属 | 为什么不在 `localState` 里 |
 * |---|---|---|
 * | 观察机位 | 实例私有（§7.3-b） | 已由 `Main.cameras[region]` 承载，且**跨组件**存活（`runtime/mainCameras.ts`）；再存一份就是第二份权威（§7.3-b 的反例） |
 * | 活动工具 / 选择 / 历史 | 文档与内核会话 | 归 `EditContext`/`Document`，换 Area 不结束它们 |
 * | 层高 / 帧 / 通道取值 | 文档呈现输入 | 归内核（`setLayerY`/`setFrameIndex` 等算子写内核） |
 * | **下方栏 tab（本行）** | **本视口实例的局部显示** | 没有任何其它机制承载 ⇒ 换承载就丢（工作区往返、切类型回切都回到默认） |
 *
 * 所以这里只保存"用户显式选过的 dock tab"。`null` = 没选过 ⇒ 跟随文档形态默认
 * （`dockTabs#defaultDockTab`）—— 这个区分本身是语义，别把它压成"存当前生效值"。
 */
const _userTab = ref<ViewportDockTab | null>(readSavedDockTab(props.localState))

function readSavedDockTab(state: Record<string, unknown> | undefined): ViewportDockTab | null {
  const saved = state?.dockTab
  return saved === 'frame' || saved === 'layer' || saved === 'channels' ? saved : null
}

/**
 * 交回本实例的局部状态（由 `AreaHost` 在关闭前调用；见 `editors/AreaHost.vue`）。
 *
 * 返回的是**用户显式选择**（`null` 也照实返回：那是"没选过"这一事实，
 * 与"选了第一个"不同）。
 */
function captureLocalState(): Record<string, unknown> {
  return { dockTab: _userTab.value }
}
defineExpose({ captureLocalState })
const activeTab = computed<ViewportDockTab>({
  get: () =>
    _userTab.value === null
      ? defaultDockTab(dockTabAvailability.value)
      : resolveDockTab(_userTab.value, dockTabs.value),
  set: (v: ViewportDockTab) => { _userTab.value = v },
})

// ---- 多方块接线：取值变化 → 装配产物 → DRW 按**内容身份**自行重建 ----
//
// 旧形态：`bindMultiblockMeshSync(revision, drw)` 在每视口的 `revision` 计数器变化时
// **手动链式**调 `loadStructureAndResources()` + `rebuildContentMesh()`（B5 #5
// `manual-refresh-chain`）。那是"调用方手动刷新"，漏挂一处就得到"滑杆动了画面不动"。
//
// 现在：取值归内核 ⇒ `renderDoc`（下面的 `docOverride`）随之变化，且取值写入时
// bump `contentRefreshTick` ⇒ DRW 的观察者按 `presentation/contentIdentity`
// **从数据算出**身份，再按 `RebuildPlan` 分范围执行（见 `drwMeshPipeline` 文件头）。
// 失效由数据决定，不需要任何调用方声明重建范围。
/** 渲染定义随装配刷新：让 `vpSlot.definition` 始终等于"当前渲染的网格"（公开观测点） */
watch(structureDefinition, (d) => { vpSlot.definition.value = d ?? null }, { flush: 'post' })

function onChannelValue(payload: { key: string; value: number }): void {
  setChannelValue(payload.key, payload.value)
}

function createToolContext(): ToolContext {
  return {
    selection,
    viewport: vpSlot,
    pickVoxel: (e) => pickVoxel(ctx, e, VIEWPORT_REGION_ID),
    pickAll: (e) => pickAll(ctx, e, VIEWPORT_REGION_ID),
    getCurrentFrame: () => getCurrentFrame(ctx),
    gridCenterWorld: (pos) => gridCenterWorld(ctx, pos),
    getBlockGeometry: (pos) => getBlockGeometry(ctx, pos),
    invokeOperator: (id, props, event, rid) => ctx.getOperators().invoke(id, props ?? {}, event, rid),
    activeTool: ctx.getToolRegistry().activeTool,
    modalDepth: (rid: string) => ctx.wm.events.modalDepth(rid),
  }
}

let _alive = true
let toolCtx: ToolContext | null = null
let unframeHook: (() => void) | null = null
const engineHostRef = ref<InstanceType<typeof RenderEngineHost> | null>(null)

async function onViewportReady(payload: RenderEngineReadyPayload): Promise<void> {
  toolCtx = createToolContext()
  // M4-1：工具上下文**按 region** 登记（旧实现是注册表上的一个单例，
  // "最后 ready 的视口赢" ⇒ 第二区的 gizmo 用的是第一区的相机/选中集）。
  ctx.getToolRegistry().setToolContext(VIEWPORT_REGION_ID, toolCtx)

  await host.attachViewport(VIEWPORT_REGION_ID, {
    drw,
    payload,
    layerPreviewMode: layerPreviewMode.value,
    structureDefinition,
    mainMeshGroup,
    handlers: {
      hover: createHoverHandler(VIEWPORT_REGION_ID, () => ctx),
      gizmo: createToolGizmoHandler(VIEWPORT_REGION_ID, () => ctx),
      keymap: createKeymapHandler(VIEWPORT_REGION_ID, () => ctx),
    },
    selectionOutline: {
      selectionItems: selection.items,
      hoveredBlock: regionHoveredBlock,
      highlightOnHover: computed(() => prefs!.highlightOnHover),
      getBlockGeometry: (pos) => getBlockGeometry(ctx, pos),
      gridCenterWorld: (pos) => gridCenterWorld(ctx, pos),
      // B-1：格 + 部件定位 → 该部件 mask（hover 描边；B-5 点选高亮共用同一入口）
      getPartMaskGeometry: (ref) => getPartMaskGeometry(ctx, ref),
      /** **R1-A C9**：描边几何由装配根注入的规划端口产出（旧层不向上 import 装配根）。 */
      outlinePlans: host.createViewportOutlinePlanner(VIEWPORT_REGION_ID),
    },
  })

  /**
   * **本区的 move gizmo**（M4-1 双区归属）。
   *
   * 实例由工具注册表**按 region** 提供（注册的是工厂，见 `registerWorkbenchTools`），
   * 并缓存在本区槽位的 `gizmo` 字段（`ViewportSlot#gizmo` 的既有含义不变：
   * "本视口挂着的 move gizmo"）。挂载点是本区的 `toolsOverlayGroup`，
   * 故两个 3D Area 各有自己的 gizmo 节点与自己的相机投影。
   */
  const toolsRoot = vpSlot.toolsOverlayGroup.value
  const regionGizmo = ctx.getToolRegistry().gizmoOf('move', VIEWPORT_REGION_ID)
  vpSlot.gizmo.value = regionGizmo as MoveGizmo | null
  if (regionGizmo && toolsRoot) {
    toolsRoot.add((regionGizmo as MoveGizmo).root)
  }

  const onFrame = (): void => {
    if (!_alive) return
    try { updateOverlay() } catch (e) { console.error('[Workbench] updateOverlay', e) }
  }
  unframeHook = engineHostRef.value?.addFrameHook(onFrame) ?? null
  onFrame()
}

const toolHints = computed<ToolHint[]>(() => ctx.getToolRegistry().activeTool.value?.hints ?? [])

function updateOverlay(): void {
  // 本区的那一只（不是"全局最后 ready 的视口"那一只）
  const gizmo = ctx.getToolRegistry().gizmoFor(VIEWPORT_REGION_ID)
  if (gizmo && toolCtx) gizmo.render(toolCtx)

  const moveGizmo = vpSlot.gizmo.value
  if (moveGizmo && ctx.getToolRegistry().activeTool.value?.id === 'move') {
    const gp = moveGizmo.root.position
    ctx.log.updateGizmoState({ x: gp.x, y: gp.y, z: gp.z })
  } else {
    ctx.log.updateGizmoState(null)
  }
  const cam = vpSlot.camera.value
  const orbit = vpSlot.orbitTarget.value
  if (cam) {
    ctx.log.updateCameraState({
      position: [cam.position.x, cam.position.y, cam.position.z],
      target: orbit ? [orbit.x, orbit.y, orbit.z] : [0, 0, 0],
    })
  }
}

function togglePlayback(): void {
  void ctx.getOperators().exec('OPERATOR_TOGGLE_FRAME_PLAYBACK')
}

function setFrameIndex(i: number): void {
  void ctx.getOperators().exec('OPERATOR_SET_FRAME_INDEX', { index: i })
}

function setLayerY(v: number): void {
  void ctx.getOperators().exec('OPERATOR_SET_LAYER_Y', { y: v })
}

const dragOver = ref(false)
let dragEnterCount = 0

function onDragEnter(e: DragEvent) {
  e.preventDefault()
  dragEnterCount++
  if (e.dataTransfer?.types.includes('Files')) dragOver.value = true
}
function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(_e: DragEvent) {
  dragEnterCount--
  if (dragEnterCount <= 0) {
    dragEnterCount = 0
    dragOver.value = false
  }
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  dragEnterCount = 0
  const file = e.dataTransfer?.files[0]
  if (!file) return
  ctx.getOperators().exec('OPERATOR_OPEN_SCENE', { file })
}

/**
 * 挂载即尝试装载；**文档后到时重新装载**（#282 P10b 实测修正）。
 *
 * ## 为什么必须 watch 文档（而不是只在 `onMounted` 装载一次）
 *
 * 旧形态下本组件由父级 `v-if="ctx.getDoc().value"` 守卫（`WorkbenchRoot`），
 * 于是它**只在文档已存在时**才挂载 ⇒ 挂载时的 `loadStructureAndResources()`
 * 必然能拿到文档。
 *
 * Area 产品接线后，本组件由 `AreaHost` 挂载 —— 它在**文档之前**就存在
 * （Area 是布局的投影，与文档无关）。此时 `loadStructureAndResources()` 拿到
 * `doc === null`，按 `drwMeshPipeline` 的逻辑置 `loadStatus = 'error'`，
 * 而**没有任何东西会再重试** ⇒ 视口永久停在占位态。
 *
 * 实测症状：注入场景后 `doc: true` 但 `.vc-viewport` 计数为 0、`wv-placeholder` 为 1。
 *
 * ⇒ 文档从"无"变"有"时必须重装。`loadStructureAndResources` 自身是幂等且
 * 保留视口状态的（`preserveViewport = loadStatus === 'ok'`），故重复调用安全。
 */
onMounted(() => {
  void drw.loadStructureAndResources()
})

watch(
  // #301 P10f C′1（N9）：这里要的是**跃变**信号（无文档 → 有文档），
  // 由 GF-15 读面 `hasLoadedDocument()` 的 `false→true` 表达。
  //
  // ## 为什么单调计数器（tick / revision）**表达不出**它
  //
  // R-WK-08 的裁决原文把本处列为"单调计数器表达不出跃变"的实例：
  // tick/revision 只告诉你"变过"，无从区分"无→有"与"有→有"/"有→无"。
  // ⇒ 只有**布尔读面**能给出 (prev=false, now=true) 这一对。
  //
  // ⚠️ 因此 `prev` 语义必须保留（不能简写成 `if (now)`）—— 那会把"有→有"
  // （文档**替换**）也当成"无→有"，而下方注释说明那会与 DRW 自己的文档订阅
  // **竞争**（两条装载路径同时改 `loadStatus`）。
  () => ctx.hasLoadedDocument(),
  (now, prev) => {
    // 只在"从无到有"时重装：文档**替换**（有→有）由 DRW 自己的文档订阅处理，
    // 在这里再装一次会与它竞争（两条装载路径同时改 `loadStatus`）。
    if (now && !prev) void drw.loadStructureAndResources()
  },
)
/**
 * 卸载：**顺序是语义的一部分**（B5 #10；A13「关闭后实例/监听/作业回基线」）。
 *
 *  1. `host.detachViewport(region)` —— 走 `host` 的登记表调 `attachViewport` 的 unbind
 *     （移除 DOM 监听、解开 overlay）。**不**负责归零槽位：那个 unbind 也会在
 *     "重挂前的 detach"里被调用（`HostBase.attachViewport` → `detachViewport`
 *     → `attachViewport` 的既有行为），在那儿归零会抹掉 `definition`/`outlinePass`
 *     这类 **DRW 拥有**的状态，而重挂不会重建它们 —— P6 实测由
 *     `multiblock-channel-traversal.spec.ts` 的"尺寸变化方向"判红
 *     （`tier-only tt=1 渲染收敛` 20s 超时；基线同 spec 通过）。
 *  2. `_alive = false` —— 让迟到的 rAF 回调不再碰 overlay；
 *  3. `unframeHook()` —— 摘掉逐帧钩子；
 *  4. `drw.dispose()` —— 释放 GPU/DOM 资源（此时 DOM 仍有效，故必须在这之前）；
 *  5. **真正的拆解点**：注销 region 系统（模态栈回基线）+ 归零并移除视口槽位。
 *     归零后 `ctx.viewports.get(region)` 为 `undefined`，于是经 `__vm__` 观测面的
 *     读取（`readContentMesh` / `waitForRenderedGrid` / `readDefinitionRootFields` /
 *     `readCameraDirectionForCell`）不再把**已 dispose 的句柄**读成"还在"。
 *
 * 第 1 步必须在第 4 步之前（dispose 需要 DOM 仍有效）；第 5 步在最后
 * （它依赖前几步已停掉所有还会写槽位的活动源）。
 */
onBeforeUnmount(() => {
  host.detachViewport(VIEWPORT_REGION_ID)
  // 该区的工具上下文/gizmo 实例随视口退场（否则注册表继续指向已拆的视口）
  ctx.getToolRegistry().clearToolContext(VIEWPORT_REGION_ID)
  _alive = false
  unframeHook?.()
  unframeHook = null
  ctx.wm.events.unregisterRegion(VIEWPORT_REGION_ID)
  drw.dispose()
  // 归零并移除槽位（`EmbedViewport` 侧由 `unregisterRegion` + `drw.dispose()` 承担；
  // 槽位归零是 P6 追加的，用于消除经 `__vm__` 观测面的**陈旧成功**读取）
  ctx.viewports.unregister(VIEWPORT_REGION_ID)
})
</script>

<template>
  <div class="wv-root">
    <div
      class="wv-viewport-wrap"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <ToolHintsBar :hints="toolHints" />
    <!--
      宿主挂载条件 = **"有一份已解析的场景"**，**不**含任何资源瞬时态。

      ## #397（M2-1）：为什么这里曾经有 `&& materialLibrary`

      旧条件写的是 `loadStatus === 'ok' && structureDefinition && materialLibrary`，
      其中 `materialLibrary` 是 `drw.textureCache`（材质库）。它在**资源重建**时被
      置空再重建（`runtime/drwMeshPipeline#applyContentRefresh` 的
      `plan.reloadResources` 分支：`textureCache.value = null`），于是：

        第一次内容投影 ⇒ contentRefreshTick ⇒ 内容身份首次 `republish`（无基线 ⇒
        `documentChanged`）⇒ `reloadResources` ⇒ textureCache 瞬时为 null ⇒
        本 `v-if` 变假 ⇒ `RenderEngineHost` **卸载重挂** ⇒ canvas DOM 节点被换掉
        （#397 实测：2 帧「.vc-viewport 与 canvas 同时缺席」、空窗 512 ms）。

      ## 为什么删掉它是对的（不是"放宽条件"）

      `RenderEngineHost`/`RenderEngine` **不消费**材质库：贴图绑定由呈现会话
      （`PresenterSession.bindTextures` + 纹理端口）负责，材质库只服务**方块图标缓存**
      （侧栏缩略图）。也就是说旧条件是在用"一个与画布无关的资源"决定画布的寿命 ——
      SPEC §7.3「普通内容编辑、撤销/重做、资源加载状态改变**不得销毁**正常视口宿主」、
      §7.4「部分资源未就绪时，可以按显示策略**保留已有画面**或显示占位」、§8
      「资源到达/失败不得隐式改变正常视口寿命」。

      ⇒ 判据只剩"有场景可画"：`loadStatus === 'ok'`（一次成功装载；后续内容刷新
      `preserveViewport` 保持 'ok'）+ 已解析的 `structureDefinition`。
      资源在编辑期间即便瞬时重建，宿主与画布也**继续存在**、继续呈现既有画面。
    -->
    <RenderEngineHost
      ref="engineHostRef"
      v-if="loadStatus === 'ok' && structureDefinition"
      :definition="structureDefinition"
      :content-group="mainMeshGroup"
      :layer-preview-mode="layerPreviewMode"
      :scene-background="0x5a5a5a"
      :show-axes-gizmo="true"
      @ready="onViewportReady"
    />
    <div v-else class="wv-placeholder">
          <svg class="wv-placeholder-icon" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>
          <span class="wv-placeholder-title">No scene loaded</span>
          <span class="wv-placeholder-hint">Open a scene from the File menu or drop a .json file</span>
        </div>
      <div v-if="dragOver" class="wv-drag-overlay">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span>释放以加载场景</span>
      </div>
    </div>

    <ViewportFrameLayerDock
      v-if="loadStatus === 'ok'"
      v-model:active-tab="activeTab"
      theme="workbench"
      :has-world-multi-frame="hasWorldMultiFrame"
      :world-frame-index="worldFrameIndex"
      :world-frame-count="worldFrameCount"
      :is-playing="isPlaying"
      :mesh-busy="meshBusy"
      :grid-height="gridHeight"
      :layer-world-y="layerWorldY"
      :layer-preview-label="layerPreviewLabel"
      :channel-panel="channelPanel"
      @set-frame="setFrameIndex"
      @toggle-playback="togglePlayback"
      @set-tier="setChannelTier"
      @set-channel-value="onChannelValue"
      @set-runstate="setChannelRunstate"
      @update:layer-y="setLayerY"
    />

  </div>
</template>

<style scoped>
.wv-root { width: 100%; height: 100%; position: relative; display: flex; flex-direction: column; }
.wv-viewport-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.wv-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--wb-text-muted);
}
.wv-placeholder-icon { opacity: 0.25; color: var(--wb-text-dim); }
.wv-placeholder-title { font-size: 15px; font-weight: 500; color: var(--wb-text-dim); }
.wv-placeholder-hint { font-size: 11px; color: var(--wb-text-muted); }

.wv-drag-overlay {
  position: absolute;
  inset: 0;
  z-index: 500;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(77, 171, 247, 0.12);
  border: 3px dashed var(--wb-accent);
  pointer-events: none;
  color: var(--wb-accent);
  font-size: 15px;
  font-weight: 600;
  backdrop-filter: blur(2px);
}

</style>