<script setup lang="ts">
import { onMounted, onBeforeUnmount, provide, ref } from 'vue'

import WorkbenchShell from '@/workbench/layout/WorkbenchShell.vue'
import WorkbenchSettingsDrawer from '@/workbench/components/WorkbenchSettingsDrawer.vue'
import MenuBar from '@/workbench/components/MenuBar.vue'
import WorkspaceTabs from '@/workbench/components/WorkspaceTabs.vue'
import ViewportHost from '@/workbench/components/ViewportHost.vue'
import PropertiesPanel from '@/workbench/components/PropertiesPanel.vue'
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
import ToolShelf from '@/workbench/components/ToolShelf.vue'

// Old tools (will be removed in Phase 4)
import { selectTool } from '@/workbench/tools/selectTool'
import { moveTool } from '@/workbench/tools/moveTool'
import { deleteTool } from '@/workbench/tools/deleteTool'
import { replaceTool } from '@/workbench/tools/replaceTool'
import { fillTool } from '@/workbench/tools/fillTool'
import { mirrorTool } from '@/workbench/tools/mirrorTool'
import { generateTool } from '@/workbench/tools/generateTool'
import { annotationTool } from '@/workbench/tools/annotationTool'
import { labelTool } from '@/workbench/tools/labelTool'
import { eyedropperTool } from '@/workbench/tools/eyedropperTool'

// New operators
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
import { MoveGizmoOperator } from '@/workbench/operators/builtin/moveGizmoOperator'

import { installDebugApi, injectDebugRefs } from '@/workbench/debug/debugLog'

// Keymap
import { loadKeymap, matchBinding, type KeyBinding } from '@/workbench/keymap'

const scene = provideSceneContext()
const connection = provideConnectionContext(scene)
const selection = provideSelectionContext()
const editHistory = provideEditHistory(256)
const toolRegistry = provideToolRegistry()
const bctx: BContext = {
  scene,
  selection,
  editHistory,
  toolRegistry,
  connection,
  camera: null,
  contentGroup: null,
  domElement: null,
  controlsRef: null,
  definition: null,
  layerPreview: null,
}
provideBContext(bctx)
useNeiTheme()

// Register all tools
toolRegistry.register(selectTool)
toolRegistry.register(moveTool)
toolRegistry.register(deleteTool)
toolRegistry.register(replaceTool)
toolRegistry.register(fillTool)
toolRegistry.register(mirrorTool)
toolRegistry.register(generateTool)
toolRegistry.register(annotationTool)
toolRegistry.register(labelTool)
toolRegistry.register(eyedropperTool)
toolRegistry.activate('select')

// Register new operators (parallel to old tools)
globalOperators.register(SelectOperator)
globalOperators.register(MoveOperator)
globalOperators.register(DeleteOperator)
globalOperators.register(ReplaceOperator)
globalOperators.register(FillOperator)
globalOperators.register(EyedropperOperator)
globalOperators.register(MirrorOperator)
globalOperators.register(GenerateOperator)
globalOperators.register(AnnotationOperator)
globalOperators.register(LabelOperator)
globalOperators.register(MoveGizmoOperator)

// Keymap
let keymap: KeyBinding[] = []

function handleKeydown(event: KeyboardEvent): void {
  for (const binding of keymap) {
    if (!matchBinding(binding, event)) continue
    event.preventDefault()
    if (binding.toolId) {
      toolRegistry.activate(binding.toolId)
    } else if (binding.action) {
      switch (binding.action) {
        case 'undo': editHistory.undo(); break
        case 'redo': editHistory.redo(); break
        case 'toggle-tool': {
          const prev = toolRegistry.getPreviousEditToolId()
          if (prev) { toolRegistry.activate(prev) } else { toolRegistry.activate('select') }
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
  <!-- Preview Workspace: 3-column Blender layout -->
  <WorkbenchShell v-show="workspace === 'preview'">
    <template #menubar>
      <MenuBar @open-settings="openSettings" @reset-layout="resetLayout" />
    </template>
    <template #workspace-tabs>
      <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
    </template>
    <template #tool-shelf>
      <ToolShelf />
    </template>
    <template #viewport>
      <ViewportHost />
    </template>
    <template #properties>
      <PropertiesPanel />
    </template>
    <template #statusbar>
      <StatusBar />
    </template>
  </WorkbenchShell>

  <!-- Wiki Viewer Workspace -->
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

  <!-- Export Workspace -->
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
