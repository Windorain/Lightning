<script setup lang="ts">
import { onMounted, onBeforeUnmount, provide, ref, computed } from 'vue'

import WorkbenchShell from '@/workbench/layout/WorkbenchShell.vue'
import WorkbenchSettingsDrawer from '@/workbench/components/WorkbenchSettingsDrawer.vue'
import WorkspaceTabs from '@/workbench/components/WorkspaceTabs.vue'
import ViewportHost from '@/workbench/components/ViewportHost.vue'
import StatusBar from '@/workbench/components/StatusBar.vue'
import ExportWorkspace from '@/workbench/components/ExportWorkspace.vue'
import WikiViewerWorkspace from '@/workbench/components/WikiViewerWorkspace.vue'
import MaterialGallery from '@/workbench/ux/panels/MaterialGallery.vue'
import { useNeiTheme } from '@/workbench/composables/useNeiTheme'
import { provideSceneContext } from '@/workbench/sceneContext'
import { provideConnectionContext } from '@/workbench/connectionContext'
import { provideSelectionContext } from '@/workbench/selectionContext'
import { provideEditHistory } from '@/workbench/editHistoryContext'
import { provideToolRegistry } from '@/workbench/toolRegistry'
import { provideBContext } from '@/workbench/context/bContext'
import { createBContextSettings } from '@/workbench/context/toolSettings'

// Operators — registered via shared VM assembly
import { createWorkbenchContext } from '@/workbench/context/workbenchContext'

import { installUnifiedLogApi } from '@/workbench/logging/LogCenter'
import { logCenter } from '@/workbench/logging/LogCenter'
import { useStatusMessage } from '@/workbench/composables/useStatusMessage'
import { SpaceType, RegionType } from '@/workbench/ux/types/screen'
import UIRenderer from '@/workbench/ux/UIRenderer.vue'
import PanelTabs from '@/workbench/ux/PanelTabs.vue'

import { createContextMenu, showContextMenu, hideContextMenu, type ContextMenuItem } from '@/workbench/ux/contextMenu'

// Document format parsers — 注册到解析分发中心
import { parserRegistry } from '@/workbench/context/parserRegistry'
import { V2PlainParser } from '@/workbench/context/parsers/v2PlainParser'
import { StructureDataParser } from '@/workbench/context/parsers/structureDataParser'
import { WorldParser } from '@/workbench/context/parsers/worldParser'
import { EnvelopeParser } from '@/workbench/context/parsers/envelopeParser'
parserRegistry.register(V2PlainParser)
parserRegistry.register(EnvelopeParser)
parserRegistry.register(WorldParser)
parserRegistry.register(StructureDataParser)

const scene = provideSceneContext()
const connection = provideConnectionContext(scene)
const selection = provideSelectionContext()
const editHistory = provideEditHistory(256)
const toolRegistry = provideToolRegistry()
const statusMessage = useStatusMessage().statusMessage

// 共享 VM 组装
const settings = createBContextSettings()
const { bctx, screen: defaultScreen } = createWorkbenchContext({
  scene, connection, selection, editHistory, toolRegistry, settings,
  statusMessage,
})

provideBContext(bctx)
useNeiTheme()


// Reactive panel queries
const viewportArea = defaultScreen.areas.find(a => a.spaceType === SpaceType.VIEW_3D)!
const propertiesArea = defaultScreen.areas.find(a => a.spaceType === SpaceType.PROPERTIES)!

const activeToolshelfPanels = computed(() =>
  viewportArea.regions.find(r => r.type === RegionType.TOOLSHELF)!.panels
    .filter(p => p.poll(bctx))
    .map(p => ({ id: p.id, layout: p.layout(bctx), owner: p.owner?.(bctx) }))
)

const activePropertiesPanels = computed(() =>
  propertiesArea.regions.find(r => r.type === RegionType.MAIN)!.panels
    .filter(p => p.poll(bctx))
    .map(p => ({ id: p.id, label: p.label, icon: p.icon, layout: p.layout(bctx), owner: p.owner?.(bctx), component: p.component }))
)

const activeHeaderPanels = computed(() =>
  viewportArea.regions.find(r => r.type === RegionType.HEADER)!.panels
    .filter(p => p.poll(bctx))
    .map(p => ({ id: p.id, label: p.label, icon: p.icon, layout: p.layout(bctx), owner: p.owner?.(bctx) }))
)

// Context menu
const contextMenu = createContextMenu()
const lastMousePosition = ref<{ x: number; y: number } | null>(null)

const ADD_MENU_ITEMS: ContextMenuItem[] = [
  { kind: 'label', label: '生成', icon: '＋' },
  { kind: 'separator', label: '' },
  { kind: 'operator', label: '撤销 (Ctrl+Z)', opId: 'OPERATOR_UNDO' },
  { kind: 'operator', label: '重做 (Ctrl+Shift+Z)', opId: 'OPERATOR_REDO' },
]

function invokeContextMenuItem(item: ContextMenuItem) {
  if (item.opId) {
    bctx.operators.invoke(item.opId, item.props ?? {})
  }
}

function onMouseMove(e: MouseEvent) {
  lastMousePosition.value = { x: e.clientX, y: e.clientY }
}

// Wire context menu + show/hide into wm (不在 createWorkbenchContext 内，因为依赖 showContextMenu 闭包)
  bctx.wm.contextMenu = contextMenu
  bctx.wm.showContextMenu = showContextMenu
  bctx.wm.hideContextMenu = hideContextMenu
  bctx.wm.contextMenuItems = ADD_MENU_ITEMS

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'a' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    const pos = lastMousePosition.value ?? { x: 400, y: 300 }
    showContextMenu(contextMenu, pos, ADD_MENU_ITEMS)
  }
  if (contextMenu.open.value) {
    hideContextMenu(contextMenu)
  }
}

const workspace = ref<'preview' | 'wiki' | 'export' | 'materials'>('preview')
const settingsOpen = ref(false)
provide('workbenchSettingsOpen', settingsOpen)


onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('mousemove', onMouseMove)

  if (connection.apiBase.value) {
    await connection.testConnection()
    if (connection.connected.value) {
      await connection.refreshExportList()
      const data = await connection.fetchWorkspaceData()
      if (data) {
        await scene.loadFromData(data)
      }
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
  window.removeEventListener('mousemove', onMouseMove)
})


// VM 句柄：测试层通过 window.__vm__ 访问公开观测面
;(window as any).__vm__ = bctx
;(window as any).__vm_ready__ = true


logCenter.injectStateRefs({
  scene: () => scene.scene.value?.toRaw() as any,
  selection: () => [...selection.items.value],
  toolRegistry: () => ({
    activeToolId: toolRegistry.activeTool.value?.id ?? 'none',
    canUndo: editHistory.canUndo.value,
    canRedo: editHistory.canRedo.value,
    undoLabel: editHistory.undoLabel.value,
    redoLabel: editHistory.redoLabel.value,
  }),
})

onMounted(() => {
  installUnifiedLogApi(bctx)
})
</script>

<template>
  <WorkbenchShell v-show="workspace === 'preview'">
    <template #menubar>
      <div class="wb-menubar-inner">
        <UIRenderer
          v-for="panel in activeHeaderPanels"
          :key="panel.id"
          :layout="panel.layout"
          :rna="bctx.rna"
          :owner="panel.owner"
        />
      </div>
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
          :owner="panel.owner"
        />
      </div>
    </template>
    <template #viewport>
      <ViewportHost />
    </template>
    <template #properties>
      <PanelTabs :panels="activePropertiesPanels" :rna="bctx.rna" :bctx="bctx" />
    </template>
    <template #statusbar>
      <StatusBar />
    </template>
  </WorkbenchShell>

  <div v-if="workspace === 'wiki'" class="wb-standalone">
    <header class="wb-standalone-menubar">
      <div class="wb-menubar-inner">
        <UIRenderer
          v-for="panel in activeHeaderPanels"
          :key="panel.id"
          :layout="panel.layout"
          :rna="bctx.rna"
          :owner="panel.owner"
        />
      </div>
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

  <div v-if="workspace === 'export'" class="wb-standalone">
    <header class="wb-standalone-menubar">
      <div class="wb-menubar-inner">
        <UIRenderer
          v-for="panel in activeHeaderPanels"
          :key="panel.id"
          :layout="panel.layout"
          :rna="bctx.rna"
          :owner="panel.owner"
        />
      </div>
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

  <div v-if="workspace === 'materials'" class="wb-standalone">
    <header class="wb-standalone-menubar">
      <div class="wb-menubar-inner">
        <UIRenderer
          v-for="panel in activeHeaderPanels"
          :key="panel.id"
          :layout="panel.layout"
          :rna="bctx.rna"
          :owner="panel.owner"
        />
      </div>
    </header>
    <header class="wb-standalone-top">
      <div class="wb-standalone-tabs">
        <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
      </div>
    </header>
    <main class="wb-standalone-body">
      <MaterialGallery :bctx="bctx" />
    </main>
  </div>

  <WorkbenchSettingsDrawer />

  <!-- ContextMenu floating overlay -->
  <Teleport to="body">
    <div
      v-if="contextMenu.open.value"
      class="context-menu-overlay"
      @click="hideContextMenu(contextMenu)"
      @contextmenu.prevent
    >
      <div
        class="context-menu-popup"
        :style="{ left: contextMenu.position.value.x + 'px', top: contextMenu.position.value.y + 'px' }"
        @click.stop
      >
        <template v-for="(item, i) in contextMenu.items.value" :key="i">
          <hr v-if="item.kind === 'separator'" class="cm-sep" />
          <span v-else-if="item.kind === 'label'" class="cm-label">{{ item.label }}</span>
          <button
            v-else-if="item.kind === 'operator'"
            class="cm-item"
            @click="invokeContextMenuItem(item); hideContextMenu(contextMenu)"
          >
            <span v-if="item.icon" class="cm-icon">{{ item.icon }}</span>
            {{ item.label }}
          </button>
        </template>
      </div>
    </div>
  </Teleport>
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
.wb-menubar-inner {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 4px;
}
.wb-menubar-inner :deep(.ux-menu-btn) {
  border: none;
  background: transparent;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--nei-label);
  cursor: pointer;
}
.wb-menubar-inner :deep(.ux-menu-btn:hover) {
  background: var(--nei-panel-hover);
  border-radius: 4px;
}
.wb-menubar-inner :deep(.ux-arrow) { display: none; }
.wb-menubar-inner :deep(.ux-operator-btn) {
  border: none;
  background: transparent;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--nei-label);
  width: auto;
  cursor: pointer;
}
.wb-menubar-inner :deep(.ux-operator-btn:hover) {
  background: var(--nei-panel-hover);
  border-radius: 4px;
}
.wb-menubar-inner :deep(.ux-label) {
  font-size: 11px;
  color: var(--nei-muted);
  padding: 0 4px;
}
</style>

<style>
.context-menu-overlay {
  position: fixed; inset: 0; z-index: 9999;
}
.context-menu-popup {
  position: absolute;
  min-width: 160px;
  background: #2a2a2a;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 4px 0;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}
.cm-item {
  display: block; width: 100%; padding: 4px 12px;
  border: none; background: transparent; color: #ccc;
  font-size: 13px; text-align: left; cursor: pointer;
}
.cm-item:hover { background: #4a4a4a; }
.cm-label {
  display: block; padding: 2px 12px; font-size: 11px; color: #999;
}
.cm-sep { margin: 4px 8px; border: none; border-top: 1px solid #555; }
.cm-icon { margin-right: 6px; }

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
