<script setup lang="ts">
/**
 * `EditorViewportHost` —— **单一视口宿主**。
 *
 * ## 本组件替代的分叉
 *
 * 合成前同一段"视口粘合"写了两遍（`WorkbenchViewport` 496 行 / `EmbedViewport` 603 行，
 * §2 #6、D7），差异不是业务差异而是**两份实现漂移**：
 *
 * | 粘合 | 旧工作台 | 旧嵌入 | 现在 |
 * |---|---|---|---|
 * | 通道 + 视口运行时 | `useViewportRuntime`/`useKernelChannels` | 同一对 | 本组件（一份） |
 * | 载入时机 | onMounted + 文档 false→true 重装 | **只有** onMounted | 本组件（两份语义取并：重装是必要的，见下） |
 * | 相机纪律 | `attachViewport` 的按 region 台账 | **另写一份** `didInitCamera` | 本组件（只保留台账那一份） |
 * | 卸载顺序 | detach → 注销 region → dispose → **归零槽位** | 同前三步，**漏归零**（D6） | 本组件（一条顺序，含归零） |
 * | dock 默认 tab | 用户选择 / 文档形态分离 | setup 时求值一次 | 本组件（前者的语义） |
 *
 * ## 差异怎么表达（不写 `if (宿主)`）
 *
 * 全部经 `EditorViewportPolicy`（`shared/viewport/editorViewportHost.ts`）：
 * 渲染配置、dock 允许项、输入处理器、描边绑定、装载后钩子、局部状态、拖放能力。
 * 本组件**没有** `宿主身份判断` / profile / 宿主名字段 —— SPEC §4.1：外壳与宿主不是领域
 * 规则的另一个实现；"嵌入故意没有"的能力必须在**装配**（`ShellRuntime`）或**策略值**里，
 * 不能变成合壳组件内部的分支（那是把分叉搬进组件）。
 *
 * ## 卸载顺序为什么仍逐条写在这里
 *
 * 顺序本身就是语义：
 *  1. `host.detachViewport(region)` —— 移除 DOM 监听、解开 overlay；**不**归零槽位
 *     （重挂前的 detach 也会走这里，归零会抹掉 DRW 拥有的 `definition`/`outlinePass`）；
 *  2. `_alive = false` —— 迟到的帧回调不再碰 overlay；
 *  3. 摘逐帧钩子；
 *  4. `drw.dispose()` —— 释放 GPU/DOM 资源（此时 DOM 仍有效，故必须在这之前）；
 *  5. 注销 region（模态栈回基线）+ **归零并移除视口槽位** —— 归零后
 *     `ctx.viewports.get(region)` 为 `undefined`，经 `__vm__` 的读面不再把已 dispose 的句柄读成"还在"。
 *
 * 第 5 步的归零修掉的是：嵌入侧原先只做前三步 + dispose，于是离开 Wiki 工作区后
 * `r-wiki-preview` 仍报 `slotLive: true`（读到的是已 dispose 的相机/DOM）。
 * 现在两个宿主走**同一条**卸载路径 ⇒ 该缺口没有第二条形态。
 *
 * ⚠️ **释放权威仍在 `AreaLayoutHost`**（region **节点**的登记/释放台账）。
 * 本组件释放的是**视口槽位**（`ctx.viewports`）与 WM 输入域注册 —— 另一条轴、另一份所有权。
 * 嵌入侧不挂 `AreaLayoutHost`（装配无 `layout.edit`），故这一句就是嵌入的实际释放点，
 * 与工作台的槽位轴同源、不重叠（单点论证）。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RenderEngineHost from '@/shared/viewport/RenderEngineHost.vue'
import type { RenderEngineReadyPayload } from '@/runtime/renderEngine'
import { useContext } from '@/runtime/context'
import { hostKey } from '@/runtime/host'
import type { Host } from '@/runtime/host'
import { useViewportRuntime } from '@/shared/viewport/useViewportRuntime'
import { useKernelChannels } from '@/shared/viewport/useKernelChannels'
import { availableDockTabs, defaultDockTab, resolveDockTab, type ViewportDockTab } from '@/shared/viewport/dockTabs'
import type { EditorViewportHostApi, EditorViewportPolicy } from '@/shared/viewport/editorViewportHost'

const props = defineProps<{
  /** 本视口的 region id（输入域/相机/槽位/机位的键）。 */
  regionId: string
  /** 宿主策略（呈现输入 + 输入处理器 + 描边 + 装载后钩子）。 */
  policy: EditorViewportPolicy
}>()

const ctx = useContext()
const host = inject(hostKey)! as Host

const VIEWPORT_REGION_ID = props.regionId
const maybePrefs = ctx.requireRegion(VIEWPORT_REGION_ID).state.viewer
if (!maybePrefs) throw new Error(`viewer preferences missing on ${VIEWPORT_REGION_ID}`)
const prefs = maybePrefs

/**
 * 多方块通道取值（归内核编辑上下文）。
 *
 * 必须先于 DRW 创建：`renderDoc` 是 DRW 的文档来源（定义面）。取值权威是
 * `EditContext.channelValues`（不是每视口自持），故同一上下文的所有 Area 读到同一份。
 */
const mb = useKernelChannels(ctx)
const {
  isMultiblock, renderDoc,
  panel: channelPanel,
  setTier: setChannelTier, setChannelValue, setRunstate: setChannelRunstate,
} = mb

const {
  drw, vpSlot, loadStatus, meshBusy, blockIconCache, tooltipPalette,
  structureDefinition, mainMeshGroup, worldFrameIndex, layerWorldY, isPlaying,
  computed: drwComputed,
} = useViewportRuntime({
  ctx,
  regionId: VIEWPORT_REGION_ID,
  viewerPrefs: prefs,
  ...(props.policy.blockIconCacheOptions === undefined ? {} : { blockIconCacheOptions: props.policy.blockIconCacheOptions }),
  ...(props.policy.initialWorldFrameIndex === undefined ? {} : { initialWorldFrameIndex: props.policy.initialWorldFrameIndex }),
  renderDocRef: renderDoc,
  /** 呈现会话包由装配边构造后下行（视口不向上 import 装配根）。 */
  createPresenter: (rid) => host.createViewportPresenter(rid),
})

const {
  layerPreviewMode, layerPreviewLabel, gridHeight,
  hasWorldMultiFrame, worldFrameCount, blockStatsEntries,
} = drwComputed

/** 渲染定义随装配刷新：让 `vpSlot.definition` 始终等于"当前渲染的网格"（公开观测点）。 */
watch(structureDefinition, (d) => { vpSlot.definition.value = d ?? null }, { flush: 'post' })

/**
 * 下方栏 tab：可用性与默认项走两端共用的纯逻辑（`dockTabs`）。
 *
 * "用户显式选择"与"默认"必须分开（实测修正）：默认值若在 setup 时求值一次，
 * 那么"文档晚于组件到达"的宿主（嵌入/Area）会永远停在 setup 那一刻的默认 tab。
 * ⇒ `_userTab = null` 表示没选过，active 直接取 `defaultDockTab(可用列表)`。
 */
const dockTabAvailability = computed(() => ({
  showFrameTab: props.policy.dock.showFrameTab,
  hasWorldMultiFrame: hasWorldMultiFrame.value,
  showLayerTab: props.policy.dock.showLayerTab,
  showChannelsTab: isMultiblock.value,
}))
const dockTabs = computed(() => availableDockTabs(dockTabAvailability.value))

function readSavedDockTab(state: Record<string, unknown> | undefined): ViewportDockTab | null {
  const saved = state?.dockTab
  return saved === 'frame' || saved === 'layer' || saved === 'channels' ? saved : null
}

/**
 * 局部状态：**只有这一项**。
 *
 * | 状态 | 归属 | 为什么不在 `localState` 里 |
 * |---|---|---|
 * | 观察机位 | 实例私有（§7.3-b） | 已由 `Main.cameras[region]` 承载且跨组件存活；再存一份就是第二份权威 |
 * | 活动工具 / 选择 / 历史 | 文档与内核会话 | 换 Area 不结束它们 |
 * | 层高 / 帧 / 通道取值 | 文档呈现输入 | 归内核（算子写内核） |
 * | **下方栏 tab** | **本视口实例的局部显示** | 没有其它机制承载 ⇒ 换承载就丢 |
 */
const _userTab = ref<ViewportDockTab | null>(readSavedDockTab(props.policy.localState))
const activeTab = computed<ViewportDockTab>({
  get: () =>
    _userTab.value === null
      ? defaultDockTab(dockTabAvailability.value)
      : resolveDockTab(_userTab.value, dockTabs.value),
  set: (v: ViewportDockTab) => { _userTab.value = v },
})

let _alive = true
let unframeHook: (() => void) | null = null
const engineHostRef = ref<InstanceType<typeof RenderEngineHost> | null>(null)

const isCanvasReady = computed(() => loadStatus.value === 'ok' && structureDefinition.value !== null)

/** 拖放（**只有提供了 `onDropFile` 的宿主才有拖放**；嵌入没有，于是不注册任何 drag 处理器）。 */
const dragOver = ref(false)
let dragEnterCount = 0
const hasDrop = computed(() => typeof props.policy.onDropFile === 'function')

function onDragEnter(e: DragEvent): void {
  e.preventDefault()
  dragEnterCount++
  if (e.dataTransfer?.types.includes('Files')) dragOver.value = true
}
function onDragOver(e: DragEvent): void {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(): void {
  dragEnterCount--
  if (dragEnterCount <= 0) {
    dragEnterCount = 0
    dragOver.value = false
  }
}
function onDrop(e: DragEvent): void {
  e.preventDefault()
  dragOver.value = false
  dragEnterCount = 0
  const file = e.dataTransfer?.files[0]
  if (!file) return
  props.policy.onDropFile?.(file)
}
const dragHandlers = computed(() =>
  hasDrop.value ? { dragenter: onDragEnter, dragover: onDragOver, dragleave: onDragLeave, drop: onDrop } : {},
)

async function onViewportReady(payload: RenderEngineReadyPayload): Promise<void> {
  await host.attachViewport(VIEWPORT_REGION_ID, {
    drw,
    payload,
    layerPreviewMode: layerPreviewMode.value,
    structureDefinition,
    mainMeshGroup,
    handlers: props.policy.input({ ctx, regionId: VIEWPORT_REGION_ID }),
    selectionOutline: props.policy.selection({
      ctx,
      regionId: VIEWPORT_REGION_ID,
      prefs,
      outlinePlans: host.createViewportOutlinePlanner(VIEWPORT_REGION_ID),
    }),
    ...(props.policy.documentKeydown === undefined ? {} : { documentKeydown: props.policy.documentKeydown }),
  })
  props.policy.onAttached?.({
    ctx,
    regionId: VIEWPORT_REGION_ID,
    drw,
    vpSlot,
    payload,
    addFrameHook: (fn) => {
      unframeHook = engineHostRef.value?.addFrameHook(fn) ?? null
    },
    isAlive: () => _alive,
  })
}

/**
 * 挂载即尝试装载；**文档后到时重新装载**（实测修正）。
 *
 * Area 产品接线后本宿主由 `AreaHost` 在**文档之前**挂载（Area 是布局的投影，与文档无关），
 * 此时 `loadStructureAndResources()` 拿到 `doc === null` ⇒ `loadStatus = 'error'`，
 * 而没有东西会再重试 ⇒ 视口永久停在占位态。故文档 false→true 必须重装
 * （`loadStructureAndResources` 自身幂等且 `preserveViewport` 保留视口状态）。
 *
 * 嵌入侧此前只有 `onMounted`（它的文档在挂载前就已由 `LoadEmbedDocument` 装载好），
 * 合壳后这条 watch 对它是**无害增强**：同一条规则适用于两个宿主（SPEC §10.10）。
 */
onMounted(() => {
  void drw.loadStructureAndResources()
})

watch(
  () => ctx.hasLoadedDocument(),
  (now, prev) => {
    // 只在"从无到有"时重装：文档**替换**（有→有）由 DRW 自己的文档订阅处理，
    // 在这里再装一次会与它竞争（两条装载路径同时改 loadStatus）。
    if (now && !prev) void drw.loadStructureAndResources()
  },
)

onBeforeUnmount(() => {
  host.detachViewport(VIEWPORT_REGION_ID)
  props.policy.onBeforeDetach?.({ ctx, regionId: VIEWPORT_REGION_ID })
  _alive = false
  unframeHook?.()
  unframeHook = null
  ctx.wm.events.unregisterRegion(VIEWPORT_REGION_ID)
  drw.dispose()
  /**
   * **D6 的修复点**：归零并移除槽位。旧 `EmbedViewport` 缺的就是这一句
   * （`WorkbenchViewport` 已有），于是离开 Wiki 工作区后 `r-wiki-preview`
   * 仍报 `slotLive: true`。现在两个宿主同一条路径。
   */
  ctx.viewports.unregister(VIEWPORT_REGION_ID)
})

const dockShow = computed(() =>
  loadStatus.value === 'ok'
  && (!props.policy.dock.hideWhenEmpty || dockTabs.value.length > 0),
)

const api: EditorViewportHostApi = {
  drw,
  vpSlot,
  get loadStatus() { return loadStatus.value },
  get meshBusy() { return meshBusy.value },
  get blockIconCache() { return blockIconCache.value },
  get tooltipPalette() { return tooltipPalette.value },
  get structureDefinition() { return structureDefinition.value },
  get mainMeshGroup() { return mainMeshGroup.value },
  get worldFrameIndex() { return worldFrameIndex.value },
  get layerWorldY() { return layerWorldY.value },
  get isPlaying() { return isPlaying.value },
  get layerPreviewMode() { return layerPreviewMode.value },
  get layerPreviewLabel() { return layerPreviewLabel.value },
  get gridHeight() { return gridHeight.value },
  get hasWorldMultiFrame() { return hasWorldMultiFrame.value },
  get worldFrameCount() { return worldFrameCount.value },
  get blockStatsEntries() { return blockStatsEntries.value },
  get channelPanel() { return channelPanel.value },
  get dock() {
    return {
      show: dockShow.value,
      theme: props.policy.dock.theme,
      showFrameTab: props.policy.dock.showFrameTab,
      showLayerTab: props.policy.dock.showLayerTab,
      hasWorldMultiFrame: hasWorldMultiFrame.value,
      worldFrameIndex: worldFrameIndex.value,
      worldFrameCount: worldFrameCount.value,
      isPlaying: isPlaying.value,
      meshBusy: meshBusy.value,
      gridHeight: gridHeight.value,
      layerWorldY: layerWorldY.value,
      layerPreviewLabel: layerPreviewLabel.value,
      channelPanel: channelPanel.value,
      activeTab: activeTab.value,
    }
  },
  get dragOver() { return dragOver.value },
  setActiveTab: (tab) => { activeTab.value = tab },
  setFrameIndex: (i) => { void ctx.getOperators().exec('OPERATOR_SET_FRAME_INDEX', { index: i }) },
  togglePlayback: () => { void ctx.getOperators().exec('OPERATOR_TOGGLE_FRAME_PLAYBACK') },
  setLayerY: (y) => { void ctx.getOperators().exec('OPERATOR_SET_LAYER_Y', { y }) },
  setChannelTier: (v) => { setChannelTier(v) },
  setChannelValue: (payload) => { setChannelValue(payload.key, payload.value) },
  setChannelRunstate: (id) => { setChannelRunstate(id) },
  captureLocalState: () => ({ dockTab: _userTab.value }),
  screenshot: () => { engineHostRef.value?.screenshot() },
}

defineExpose({ api, captureLocalState: api.captureLocalState })
</script>

<template>
  <div class="evh-root">
    <div class="evh-canvas" v-on="dragHandlers">
      <slot name="above-canvas" :api="api" />
      <!--
        宿主挂载条件 = **"有一份已解析的场景"**，**不含资源瞬时态**（SPEC §7.3、§7.4、§8）：
        材质库/贴图在资源重建期会瞬时为空，而它不是本宿主的输入（贴图绑定归呈现会话）。
        两个宿主共用同一条规则（SPEC §10.10）。
      -->
      <RenderEngineHost
        v-if="isCanvasReady"
        ref="engineHostRef"
        :definition="structureDefinition!"
        :content-group="mainMeshGroup"
        :layer-preview-mode="layerPreviewMode"
        :scene-background="policy.sceneBackground ?? 0x5a5a5a"
        :show-axes-gizmo="policy.showAxesGizmo ?? true"
        @ready="onViewportReady"
      />
      <slot v-else name="placeholder" :api="api" />
      <slot name="below-canvas" :api="api" />
    </div>
  </div>
</template>

<style scoped>
.evh-root {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.evh-canvas {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
</style>