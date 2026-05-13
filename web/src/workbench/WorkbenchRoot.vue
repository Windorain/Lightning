<script setup lang="ts">
import { onMounted, onBeforeUnmount, provide, ref, computed } from 'vue'

import WorkbenchShell from '@/workbench/layout/WorkbenchShell.vue'
import WorkbenchSettingsDrawer from '@/workbench/components/WorkbenchSettingsDrawer.vue'
import MenuBar from '@/workbench/components/MenuBar.vue'
import WorkspaceTabs from '@/workbench/components/WorkspaceTabs.vue'
import ViewportHost from '@/workbench/components/ViewportHost.vue'
import StatusBar from '@/workbench/components/StatusBar.vue'
import ExportWorkspace from '@/workbench/components/ExportWorkspace.vue'
import WikiViewerWorkspace from '@/workbench/components/WikiViewerWorkspace.vue'
import { useNeiTheme } from '@/workbench/composables/useNeiTheme'
import { provideSceneContext } from '@/workbench/sceneContext'
import { provideConnectionContext } from '@/workbench/connectionContext'
import { provideSelectionContext } from '@/workbench/selectionContext'
import { provideEditHistory } from '@/workbench/editHistoryContext'
import { provideToolRegistry } from '@/workbench/toolRegistry'
import { provideBContext, type BContext } from '@/workbench/context/bContext'
import { createProductionQueries } from '@/workbench/context/sceneQueries'
import { createBContextSettings } from '@/workbench/context/toolSettings'

// Operators
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { SelectOperator } from '@/workbench/operators/builtin/selectOperator'
import { MoveOperator } from '@/workbench/operators/builtin/moveOperator'
import { DeleteOperator } from '@/workbench/operators/builtin/deleteOperator'
import { ReplaceOperator } from '@/workbench/operators/builtin/replaceOperator'
import { FillOperator } from '@/workbench/operators/builtin/fillOperator'
import { EyedropperOperator } from '@/workbench/operators/builtin/eyedropperOperator'
import { MirrorOperator } from '@/workbench/operators/builtin/mirrorOperator'
import { GenerateOperator } from '@/workbench/operators/builtin/generateOperator'
import { AnnotationOperator } from '@/workbench/operators/builtin/annotationOperator'
import { LabelOperator } from '@/workbench/operators/builtin/labelOperator'
import { UndoOperator, RedoOperator } from '@/workbench/operators/builtin/undoOperator'
import { ViewRotateOperator, ViewPanOperator, ViewZoomOperator } from '@/workbench/operators/builtin/viewOperators'
import { ToolSetOperator } from '@/workbench/operators/builtin/toolOperator'
import { SceneMetaEditOperator, TooltipEditOperator } from '@/workbench/operators/builtin/sceneEditOperators'

import { installDebugApi, injectDebugRefs } from '@/workbench/debug/debugLog'
import { installLogCenter } from '@/workbench/logging/LogCenter'
import { installTestRunner } from '@/workbench/testing/testRunner'
import { eventDispatcher } from '@/workbench/eventDispatcher'
import { logCenter } from '@/workbench/logging/LogCenter'
import { wikiConfig } from '@/workbench/wikiConfig'
import { useStatusMessage } from '@/workbench/composables/useStatusMessage'
import { SpaceType, RegionType, type bScreen } from '@/workbench/ux/types/screen'
import { createRNARegistry, blockRNA, toolSettingsRNA, sceneMetaRNA, wikiConfigRNA } from '@/workbench/ux/rna'
import { computeLayout, boundsOf, regionAt, relayout } from '@/workbench/ux/layout'
import UIRenderer from '@/workbench/ux/UIRenderer.vue'
import {
  blockInspectorPanel, toolShelfPanel, generatePanel,
  transformPanel, batchEditPanel, annotationPanel, labelPanel, sceneInfoPanel,
} from '@/workbench/ux/panels'

// Keymap
import { loadKeymap, matchBinding, type KeyBinding } from '@/workbench/keymap'

// RNA — 加载属性描述符
import '@/workbench/rna/plainSceneRna'

// Document format handlers — 注册到分发中心
import { formatDispatcher } from '@/workbench/context/documentHandler'
import { V2PlainHandler } from '@/workbench/context/handlers/v2PlainHandler'
import { WorldHandler } from '@/workbench/context/handlers/worldHandler'
import { StructureDataHandler } from '@/workbench/context/handlers/structureDataHandler'
formatDispatcher.register(V2PlainHandler)
formatDispatcher.register(WorldHandler)
formatDispatcher.register(StructureDataHandler)

const scene = provideSceneContext()
const connection = provideConnectionContext(scene)
const selection = provideSelectionContext()
const editHistory = provideEditHistory(256)
const toolRegistry = provideToolRegistry()
const statusMessage = useStatusMessage().statusMessage
const bctx = {
  scene,
  selection,
  editHistory,
  toolRegistry,
  connection,
  operators: {
    exec: (id: string, props?: Record<string, unknown>) => globalOperators.exec(bctx, id, props),
    invoke: (id: string, props?: Record<string, unknown>, event?: Event) => globalOperators.invoke(bctx, id, props, event as any),
    find: (id: string) => globalOperators.find(id),
    all: () => globalOperators.all(),
    register: (op: any) => globalOperators.register(op),
  },
  eventDispatcher: eventDispatcher as any,
  log: logCenter as any,
  wikiConfig: wikiConfig as any,
  statusMessage: statusMessage as any,
  camera: null,
  contentGroup: null,
  domElement: null,
  controlsRef: null,
  definition: null,
  layerPreview: null,
  settings: createBContextSettings(),
} as BContext
bctx.queries = createProductionQueries(bctx)

// Build RNA registry
const rna = createRNARegistry()
rna.register(blockRNA)
rna.register(toolSettingsRNA)
rna.register(sceneMetaRNA)
rna.register(wikiConfigRNA)

// Build default screen layout (single VIEW_3D area + PROPERTIES area)
const defaultScreen: bScreen = {
  id: 'workbench',
  areas: [
    {
      id: 'viewport-area',
      spaceType: SpaceType.VIEW_3D,
      splitDir: 'none',
      parentArea: null,
      regions: [
        { id: 'r-header', type: RegionType.HEADER, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
        { id: 'r-toolshelf', type: RegionType.TOOLSHELF, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
        { id: 'r-viewport', type: RegionType.MAIN, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
      ],
    },
    {
      id: 'properties-area',
      spaceType: SpaceType.PROPERTIES,
      splitDir: 'none',
      parentArea: null,
      regions: [
        { id: 'r-props-main', type: RegionType.MAIN, panels: [], visible: true, collapsed: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, handlers: [] },
      ],
    },
  ],
  popupRegions: [],
  bounds: { width: 1400, height: 800 },
}

// Register panels into screen regions
const viewportArea = defaultScreen.areas.find(a => a.spaceType === SpaceType.VIEW_3D)!
viewportArea.regions.find(r => r.type === RegionType.TOOLSHELF)!.panels.push(toolShelfPanel)
const propertiesArea = defaultScreen.areas.find(a => a.spaceType === SpaceType.PROPERTIES)!
propertiesArea.regions.find(r => r.type === RegionType.MAIN)!.panels.push(
  blockInspectorPanel, generatePanel, transformPanel,
  batchEditPanel, annotationPanel, labelPanel, sceneInfoPanel,
)

// Reactive panel queries — poll() and layout() are tracked by Vue reactivity
const activeToolshelfPanels = computed(() =>
  viewportArea.regions.find(r => r.type === RegionType.TOOLSHELF)!.panels
    .filter(p => p.poll(bctx))
    .map(p => ({ id: p.id, layout: p.layout(bctx) }))
)

const activePropertiesPanels = computed(() =>
  propertiesArea.regions.find(r => r.type === RegionType.MAIN)!.panels
    .filter(p => p.poll(bctx))
    .map(p => ({ id: p.id, layout: p.layout(bctx) }))
)

// Compute initial layout
computeLayout(bctx, defaultScreen)

// Wire into bctx
;(bctx as any).wm = { windows: [], activeWindow: null }
;(bctx as any).screen = defaultScreen
;(bctx as any).area = null
;(bctx as any).region = null
;(bctx as any).rna = rna
;(bctx as any).ui = {
  computeLayout: (s: bScreen) => computeLayout(bctx, s),
  boundsOf: (id: string) => boundsOf(bctx, id),
  regionAt: (x: number, y: number) => regionAt(defaultScreen, x, y),
  relayout: () => relayout(bctx),
}

provideBContext(bctx)
useNeiTheme()

// Register all operators
bctx.operators.register(SelectOperator)
bctx.operators.register(MoveOperator)
bctx.operators.register(DeleteOperator)
bctx.operators.register(ReplaceOperator)
bctx.operators.register(FillOperator)
bctx.operators.register(EyedropperOperator)
bctx.operators.register(MirrorOperator)
bctx.operators.register(GenerateOperator)
bctx.operators.register(AnnotationOperator)
bctx.operators.register(LabelOperator)
bctx.operators.register(UndoOperator)
bctx.operators.register(RedoOperator)
bctx.operators.register(ViewRotateOperator)
bctx.operators.register(ViewPanOperator)
bctx.operators.register(ViewZoomOperator)
bctx.operators.register(ToolSetOperator)
bctx.operators.register(SceneMetaEditOperator)
bctx.operators.register(TooltipEditOperator)

// Rebuild tool list after all operators registered, then activate default
toolRegistry.rebuildTools()
toolRegistry.activate('OPERATOR_SELECT')

// Keymap — maps to operator IDs
const OPERATOR_KEY_MAP: Record<string, string> = {
  select: 'OPERATOR_SELECT',
  move: 'OPERATOR_MOVE',
  delete: 'OPERATOR_DELETE',
  replace: 'OPERATOR_REPLACE',
  fill: 'OPERATOR_FILL',
  eyedropper: 'OPERATOR_EYEDROPPER',
  mirror: 'OPERATOR_MIRROR',
  generate: 'OPERATOR_GENERATE',
  annotation: 'OPERATOR_ANNOTATION',
  label: 'OPERATOR_LABEL',
}

let keymap: KeyBinding[] = []

function handleKeydown(event: KeyboardEvent): void {
  for (const binding of keymap) {
    if (!matchBinding(binding, event)) continue
    event.preventDefault()
    if (binding.toolId) {
      const opId = OPERATOR_KEY_MAP[binding.toolId] ?? `OPERATOR_${binding.toolId.toUpperCase()}`
      bctx.operators.exec('OPERATOR_TOOL_SET', { toolId: opId })
    } else if (binding.action) {
      switch (binding.action) {
        case 'undo': bctx.operators.exec('OPERATOR_UNDO'); break
        case 'redo': bctx.operators.exec('OPERATOR_REDO'); break
        case 'toggle-tool': {
          const prev = toolRegistry.getPreviousEditToolId()
          if (prev) { toolRegistry.activate(prev, bctx) } else { toolRegistry.activate('OPERATOR_SELECT', bctx) }
          break
        }
        case 'toggle-toolshelf': break
        case 'toggle-properties': break
        case 'invert': break
      }
    }
    return
  }
}

const workspace = ref<'preview' | 'wiki' | 'export'>('preview')
const settingsOpen = ref(false)
provide('workbenchSettingsOpen', settingsOpen)

function openSettings(): void { settingsOpen.value = true }
function resetLayout(): void {
  try { localStorage.removeItem('wsr-wb-left-w'); localStorage.removeItem('wsr-wb-right-w') } catch { /* */ }
  location.reload()
}

onMounted(async () => {
  keymap = loadKeymap()
  window.addEventListener('keydown', handleKeydown)

  if (connection.apiBase.value) {
    await connection.testConnection()
    if (connection.connected.value) {
      await connection.refreshExportList()
      await connection.pullFromServer()
    }
  } else if (import.meta.env.DEV) {
    const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
    const sceneId = q?.get('sceneId')
    if (sceneId) {
      try { await scene.loadBuiltinScene(sceneId) } catch { /* ignore */ }
    }
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
})

installLogCenter()
installTestRunner(bctx)

if (import.meta.env.DEV) {
  injectDebugRefs({
    scene: () => scene.scene.value as any,
    selection: () => [...selection.items.value],
    toolRegistry: () => ({
      activeToolId: toolRegistry.activeTool.value?.id ?? 'none',
      canUndo: editHistory.canUndo.value,
      canRedo: editHistory.canRedo.value,
      undoLabel: editHistory.undoLabel.value,
      redoLabel: editHistory.redoLabel.value,
    }),
  })
  installDebugApi()
}
</script>

<template>
  <WorkbenchShell v-show="workspace === 'preview'">
    <template #menubar>
      <MenuBar @open-settings="openSettings" @reset-layout="resetLayout" />
    </template>
    <template #workspace-tabs>
      <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
    </template>
    <template #tool-shelf>
      <div class="wb-toolshelf">
        <UIRenderer
          v-for="panel in activeToolshelfPanels"
          :key="panel.id"
          :layout="panel.layout"
          :rna="bctx.rna"
        />
      </div>
    </template>
    <template #viewport>
      <ViewportHost />
    </template>
    <template #properties>
      <UIRenderer
        v-for="panel in activePropertiesPanels"
        :key="panel.id"
        :layout="panel.layout"
        :rna="bctx.rna"
      />
    </template>
    <template #statusbar>
      <StatusBar />
    </template>
  </WorkbenchShell>

  <div v-show="workspace === 'wiki'" class="wb-standalone">
    <header class="wb-standalone-menubar">
      <MenuBar @open-settings="openSettings" @reset-layout="resetLayout" />
    </header>
    <header class="wb-standalone-top">
      <div class="wb-standalone-tabs">
        <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
      </div>
    </header>
    <main class="wb-standalone-body">
      <WikiViewerWorkspace />
    </main>
  </div>

  <div v-show="workspace === 'export'" class="wb-standalone">
    <header class="wb-standalone-menubar">
      <MenuBar @open-settings="openSettings" @reset-layout="resetLayout" />
    </header>
    <header class="wb-standalone-top">
      <div class="wb-standalone-tabs">
        <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
      </div>
    </header>
    <main class="wb-standalone-body">
      <ExportWorkspace />
    </main>
  </div>

  <WorkbenchSettingsDrawer />
</template>

<style scoped>
.wb-toolshelf {
  position: absolute; top: 4px; left: 4px; z-index: 100;
  display: flex; flex-direction: column; gap: 2px;
  padding: 4px;
  background: var(--nei-dropdown-bg);
  border: 1px solid var(--nei-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.wb-toolshelf :deep(.ux-operator-btn) {
  width: 32px; height: 32px; padding: 0;
  font-size: 16px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  border-color: transparent;
  background: transparent;
  color: var(--nei-label);
}
.wb-toolshelf :deep(.ux-operator-btn:hover) {
  background: var(--nei-panel-hover);
}
</style>

<style>
.wb-standalone {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--nei-bg);
  color: var(--nei-text-dark);
}
.wb-standalone-menubar {
  flex-shrink: 0;
  height: 28px;
  background: var(--nei-bg-deep);
  border-bottom: 1px solid var(--nei-border);
}
.wb-standalone-top {
  flex-shrink: 0;
  height: 32px;
  background: var(--nei-bg-deep);
  border-bottom: 1px solid var(--nei-border);
  display: flex;
  align-items: center;
}
.wb-standalone-tabs {
  display: flex;
  align-items: stretch;
  height: 100%;
}
.wb-standalone-body {
  flex: 1;
  overflow-y: auto;
}
</style>
