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
import { MoveGizmoOperator } from '@/workbench/operators/builtin/moveGizmoOperator'

import { installDebugApi, injectDebugRefs } from '@/workbench/debug/debugLog'

// Keymap
import { loadKeymap, matchBinding, type KeyBinding } from '@/workbench/keymap'

// RNA — 加载属性描述符
import '@/workbench/rna/plainSceneRna'

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

// Register all operators
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
      toolRegistry.activate(opId, bctx)
    } else if (binding.action) {
      switch (binding.action) {
        case 'undo': editHistory.undo(); break
        case 'redo': editHistory.redo(); break
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
