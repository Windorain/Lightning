<script setup lang="ts">
/**
 * `WorkbenchViewport` —— 工作台 3D 视口的**薄包装**（M7-4 段 B）。
 *
 * ## 本文件现在只负责"工作台这一侧的呈现与策略"
 *
 * 视口粘合（通道取值、视口运行时、载入时机、相机纪律、dock tab、卸载顺序）
 * 已收敛到 `shared/viewport/EditorViewportHost.vue`（唯一实现）。这里提供的是
 * **工作台特有**的策略值：
 *
 * | 策略项 | 工作台取值 | 为什么属外壳 |
 * |---|---|---|
 * | 输入处理器 | 工具 gizmo + keymap + hover | 工具/gizmo 只在工作台装配里存在 |
 * | 描边 | 选择集 + 本区悬停描边 + move gizmo 逐帧 overlay | 工具上下文按 region 登记 |
 * | 拖放 | 拖入 .json ⇒ `OPERATOR_OPEN_SCENE` | 嵌入没有文件打开能力（装配无命令） |
 * | dock | 帧/层恒允许、空时仍渲染 | 与旧行为逐字相同 |
 * | 占位态 | `No scene loaded` 文案 | 工作台的用户引导（嵌入没有） |
 *
 * 组件内**没有** `isEmbed` 判断：差异全在策略值里（SPEC §4.1）。
 */
import { computed, ref } from 'vue'
import { useContext } from '@/runtime/context'
import { createToolGizmoHandler } from '@/handlers/toolGizmoHandler'
import { createKeymapHandler } from '@/handlers/keymapHandler'
import { createHoverHandler } from '@/handlers/hoverHandler'
import type { MoveGizmo } from '@/workbench/tools/gizmos'
import type { ToolContext } from '@/workbench/tools/tool'
import type { ToolHint } from '@/workbench/tools/tool'
import { pickVoxel, pickAll, getCurrentFrame, gridCenterWorld, getBlockGeometry, getPartMaskGeometry } from '@/context/queries'
import { createWorkbenchHoverBlockRef } from '@/runtime/hover/access'
import { REGION } from '@/runtime/regionIds'
import ToolHintsBar from '@/workbench/ux/ToolHintsBar.vue'
import EditorViewportHost from '@/shared/viewport/EditorViewportHost.vue'
import EditorViewportDock from '@/shared/viewport/EditorViewportDock.vue'
import type { EditorViewportHostApi, EditorViewportPolicy } from '@/shared/viewport/editorViewportHost'

const ctx = useContext()
const selection = ctx.getSelection()

const props = withDefaults(defineProps<{
  /**
   * **本视口的 region id**（#282 P10b Area 产品接线）。
   *
   * 缺省仍是 `REGION.WORKBENCH_VIEWPORT`：**单视口装配的行为逐字不变**
   * （既有 e2e 与 `__vm__` 观测面读的就是这个 region）。
   */
  regionId?: string
  /**
   * 本 Area 在 `viewport3d` 类型下**已保存的局部状态**（`Workspace.layout.localState`）。
   * 由 `AreaHost` 从布局树读出后下行（M7-2「localState 真接线」）；视口宿主在 setup 时读一次。
   */
  localState?: Record<string, unknown>
}>(), {
  regionId: REGION.WORKBENCH_VIEWPORT,
})
const VIEWPORT_REGION_ID = props.regionId

/**
 * **本视口自己的悬停描边目标**（M4-1 双区归属）。
 *
 * 旧写法是 `ctx.getHoveredBlock()`（写死根区）⇒ 每个视口的描边都画根区的悬停格。
 * region 是悬停状态的键（`handlers/hoverHandler` 按 region 写），读面必须同键。
 * 悬停的**非呈现**读面（底栏/检查器）仍走 `ctx.getHoveredBlock()` 的"最近悬停区"规则。
 */
const regionHoveredBlock = createWorkbenchHoverBlockRef(ctx, VIEWPORT_REGION_ID)

const toolHints = computed<ToolHint[]>(() => ctx.getToolRegistry().activeTool.value?.hints ?? [])

/** 工具上下文 / 逐帧 overlay 的句柄（`onAttached` 里拿到，帧回调里用）。 */
let toolCtx: ToolContext | null = null

const policy: EditorViewportPolicy = {
  sceneBackground: 0x5a5a5a,
  showAxesGizmo: true,
  dock: { showFrameTab: true, showLayerTab: true, hideWhenEmpty: false, theme: 'workbench' },
  localState: props.localState,
  input: ({ regionId }) => ({
    hover: createHoverHandler(regionId, () => ctx),
    gizmo: createToolGizmoHandler(regionId, () => ctx),
    keymap: createKeymapHandler(regionId, () => ctx),
  }),
  selection: ({ prefs, outlinePlans }) => ({
    selectionItems: selection.items,
    hoveredBlock: regionHoveredBlock,
    highlightOnHover: computed(() => prefs.highlightOnHover),
    getBlockGeometry: (pos) => getBlockGeometry(ctx, pos),
    gridCenterWorld: (pos) => gridCenterWorld(ctx, pos),
    // B-1：格 + 部件定位 → 该部件 mask（hover 描边；B-5 点选高亮共用同一入口）
    getPartMaskGeometry: (ref) => getPartMaskGeometry(ctx, ref),
    /** **R1-A C9**：描边几何由装配根注入的规划端口产出（旧层不向上 import 装配根）。 */
    outlinePlans,
  }),
  /**
   * 装载完成后的工作台接线（原 `WorkbenchViewport#onViewportReady` 的后半段）：
   * 工具上下文按 region 登记、move gizmo 挂到本区的 overlay 组、逐帧 overlay 钩子。
   */
  onAttached: ({ regionId, vpSlot, addFrameHook, isAlive }) => {
    toolCtx = {
      selection,
      viewport: vpSlot,
      pickVoxel: (e) => pickVoxel(ctx, e, regionId),
      pickAll: (e) => pickAll(ctx, e, regionId),
      getCurrentFrame: () => getCurrentFrame(ctx),
      gridCenterWorld: (pos) => gridCenterWorld(ctx, pos),
      getBlockGeometry: (pos) => getBlockGeometry(ctx, pos),
      invokeOperator: (id, props, event, rid) => ctx.getOperators().invoke(id, props ?? {}, event, rid),
      activeTool: ctx.getToolRegistry().activeTool,
      modalDepth: (rid: string) => ctx.wm.events.modalDepth(rid),
    }
    // M4-1：工具上下文**按 region** 登记（旧实现是注册表上的一个单例，
    // "最后 ready 的视口赢" ⇒ 第二区的 gizmo 用的是第一区的相机/选中集）。
    ctx.getToolRegistry().setToolContext(regionId, toolCtx)

    /**
     * **本区的 move gizmo**（M4-1 双区归属）。
     * 实例由工具注册表**按 region** 提供（注册的是工厂），缓存在本区槽位的 `gizmo` 字段。
     * 挂载点是本区的 `toolsOverlayGroup`，故两个 3D Area 各有自己的 gizmo 节点与相机投影。
     */
    const toolsRoot = vpSlot.toolsOverlayGroup.value
    const regionGizmo = ctx.getToolRegistry().gizmoOf('move', regionId)
    vpSlot.gizmo.value = regionGizmo as MoveGizmo | null
    if (regionGizmo && toolsRoot) {
      toolsRoot.add((regionGizmo as MoveGizmo).root)
    }

    const onFrame = (): void => {
      if (!isAlive()) return
      try { updateOverlay(regionId, vpSlot) } catch (e) { console.error('[Workbench] updateOverlay', e) }
    }
    addFrameHook(onFrame)
    onFrame()
  },
  /** 该区的工具上下文随视口退场（否则注册表继续指向已拆的视口）。 */
  onBeforeDetach: ({ regionId }) => {
    ctx.getToolRegistry().clearToolContext(regionId)
    toolCtx = null
  },
  /** 拖放：工作台有文件打开命令（嵌入没有 ⇒ 不提供该策略，与"没有能力"一致）。 */
  onDropFile: (file) => { void ctx.getOperators().exec('OPERATOR_OPEN_SCENE', { file }) },
}

function updateOverlay(regionId: string, vpSlot: EditorViewportHostApi['vpSlot']): void {
  // 本区的那一只（不是"全局最后 ready 的视口"那一只）
  const gizmo = ctx.getToolRegistry().gizmoFor(regionId)
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

const hostRef = ref<InstanceType<typeof EditorViewportHost> | null>(null)
/**
 * dock 需要宿主的 api，而它渲染在**宿主之外**（外壳布局决定位置）。
 * 用模板 ref + computed 拿：`api` 是普通对象、其 getter 在模板渲染副作用里被读，
 * 故状态变化照常触发重渲（不依赖"把 api 变成响应式对象"）。
 */
const vpApi = computed<EditorViewportHostApi | null>(() => hostRef.value?.api ?? null)

/** 本实例的局部状态（由 `AreaHost` 在关闭前问；转发给宿主）。 */
function captureLocalState(): Record<string, unknown> {
  return hostRef.value?.captureLocalState() ?? { dockTab: null }
}
defineExpose({ captureLocalState })
</script>

<template>
  <div class="wv-root">
    <EditorViewportHost ref="hostRef" :region-id="VIEWPORT_REGION_ID" :policy="policy">
      <template #above-canvas>
        <ToolHintsBar :hints="toolHints" />
      </template>
      <template #placeholder>
        <div class="wv-placeholder">
          <svg class="wv-placeholder-icon" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>
          <span class="wv-placeholder-title">No scene loaded</span>
          <span class="wv-placeholder-hint">Open a scene from the File menu or drop a .json file</span>
        </div>
      </template>
      <template #below-canvas>
        <div v-if="vpApi?.dragOver" class="wv-drag-overlay">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <span>释放以加载场景</span>
        </div>
      </template>
    </EditorViewportHost>

    <EditorViewportDock v-if="vpApi" :api="vpApi" />
  </div>
</template>

<style scoped>
.wv-root { width: 100%; height: 100%; position: relative; display: flex; flex-direction: column; }
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
