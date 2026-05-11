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
import ToolShelf from '@/workbench/components/ToolShelf.vue'

// Tools
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

// Keymap
import { loadKeymap, matchBinding, type KeyBinding } from '@/workbench/keymap'

const scene = provideSceneContext()
const connection = provideConnectionContext(scene)
provideSelectionContext()
const editHistory = provideEditHistory(256)
const toolRegistry = provideToolRegistry()
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
