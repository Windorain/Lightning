<script setup lang="ts">
import { onMounted, provide, ref } from 'vue'

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

const scene = provideSceneContext()
const connection = provideConnectionContext(scene)
provideSelectionContext()
provideEditHistory(256)
provideToolRegistry()
useNeiTheme()

const workspace = ref<'preview' | 'wiki' | 'export'>('preview')
const settingsOpen = ref(false)
provide('workbenchSettingsOpen', settingsOpen)

function openSettings(): void { settingsOpen.value = true }
function resetLayout(): void {
  try { localStorage.removeItem('wsr-wb-left-w'); localStorage.removeItem('wsr-wb-right-w') } catch { /* */ }
  location.reload()
}

onMounted(async () => {
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
