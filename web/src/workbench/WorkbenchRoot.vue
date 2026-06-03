<script setup lang="ts">
import { onMounted, onBeforeUnmount, provide, ref, computed, watch } from 'vue'

import WorkbenchShell from '@/workbench/layout/WorkbenchShell.vue'
import WorkbenchSettingsDrawer from '@/workbench/components/WorkbenchSettingsDrawer.vue'
import WorkspaceTabs from '@/workbench/components/WorkspaceTabs.vue'
import WorkbenchViewport from '@/workbench/components/WorkbenchViewport.vue'
import StatusBar from '@/workbench/components/StatusBar.vue'
import ExportWorkspace from '@/workbench/components/ExportWorkspace.vue'
import MaterialGallery from '@/workbench/ux/panels/MaterialGallery.vue'
import { EmbedPreview } from '@/shared/viewport/embedPreview'
import { defaultEmbedUi } from '@/preview/previewConfig'
import type { EmbedSettings } from '@/preview/previewConfig'
import { useNeiTheme } from '@/workbench/composables/useNeiTheme'
import { createSelectionContext } from '@/context/selection'
import { provideEditHistory } from '@/context/editHistory'
import { provideToolRegistry } from '@/workbench/tools/registry'
import { provideContext } from '@/runtime/context'
import { hostKey } from '@/runtime/host'
import type { ContextSettings } from '@/runtime/types'
import { currentLang } from '@/config/i18n'
import { theme } from '@/workbench/composables/useNeiTheme'

function createContextSettings(overrides?: {
  theme?: 'dark' | 'light'
  language?: 'zh' | 'en'
  confirmDirty?: (msg: string) => boolean
}): ContextSettings {
  const replaceBrush = ref<string | null>(null)
  const fillBrush = ref<string | null>(null)
  const generateType = ref<string | null>(null)
  const snapEnabled = ref<boolean>(false)

  return {
    get replaceBrush(): string | null { return replaceBrush.value },
    set replaceBrush(v: string | null) { replaceBrush.value = v },
    get fillBrush(): string | null { return fillBrush.value },
    set fillBrush(v: string | null) { fillBrush.value = v },
    get generateType(): string | null { return generateType.value },
    set generateType(v: string | null) { generateType.value = v },
    dragSensitivity: 0.05,
    get snapEnabled(): boolean { return snapEnabled.value },
    set snapEnabled(v: boolean) { snapEnabled.value = v },
    confirmDirty: overrides?.confirmDirty ?? ((msg: string) => window.confirm(msg)),
    get theme(): 'dark' | 'light' {
      if (overrides?.theme) return overrides.theme
      return theme.value
    },
    get language(): 'zh' | 'en' {
      if (overrides?.language) return overrides.language
      return currentLang.value
    },
  }
}

// Operators — registered via shared VM assembly
import { createWorkbenchHost } from '@/workbench/context/workbenchContext'

import { bindChromeDom, CHROME_REGION } from '@/runtime/chromeBinder'
import { createChromeKeymapHandler } from '@/handlers/chromeKeymapHandler'
import UIRenderer from '@/workbench/ux/UIRenderer.vue'
import PanelTabs from '@/workbench/ux/PanelTabs.vue'

import { createContextMenu, showContextMenu, hideContextMenu, type ContextMenuItem } from '@/workbench/ux/contextMenu'
import { usePanelQueries } from '@/workbench/context/usePanelQueries'

const selection = createSelectionContext()
const editHistory = provideEditHistory(256)
const toolRegistry = provideToolRegistry()

// 共享 VM 组装
const settings = createContextSettings()
const { host, ctx, screen: defaultScreen } = createWorkbenchHost({
  selection, editHistory, toolRegistry, settings,
})

provideContext(ctx)
provide(hostKey, host)
useNeiTheme()


const { activeToolshelfPanels, activePropertiesPanels, activeHeaderPanels } = usePanelQueries(ctx, defaultScreen)

// Wiki embed settings
const wikiConfig = ctx.wikiConfig as Record<string, any>
function parseHex6(s: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim())
  if (!m) return 0x5a5a5a
  return parseInt(m[1], 16)
}
const embedSettings = computed<EmbedSettings>(() => ({
  features: {
    ...defaultEmbedUi.features,
    ...(wikiConfig.features ?? {}),
  },
  blockIconCacheOptions: defaultEmbedUi.blockIconCacheOptions,
  initialLayerWorldY: defaultEmbedUi.initialLayerWorldY,
  initialCamera: {
    yawDeg: wikiConfig.cameraYaw,
    elevationDeg: wikiConfig.cameraElevation,
    zoom: wikiConfig.cameraZoom,
  },
  sceneBackground: parseHex6(wikiConfig.sceneBackgroundHex ?? '#5a5a5a'),
  loadingMessage: defaultEmbedUi.loadingMessage,
  okMessage: defaultEmbedUi.okMessage,
  debug: wikiConfig.features?.debugStatusBar ?? false,
}))

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
    ctx.operators.invoke(item.opId, item.props ?? {})
  }
}

ctx.wm.chrome.contextMenuOpen = contextMenu.open
ctx.wm.chrome.contextMenuPosition = contextMenu.position
ctx.wm.chrome.contextMenuItems = ADD_MENU_ITEMS
ctx.wm.chrome.lastMousePosition = lastMousePosition
ctx.wm.chrome.showContextMenu = (pos, items) => showContextMenu(contextMenu, pos, items)
ctx.wm.chrome.hideContextMenu = () => hideContextMenu(contextMenu)

let unbindChrome: (() => void) | null = null

const workspace = ref<'preview' | 'wiki' | 'export' | 'materials'>('preview')
watch(workspace, (v) => {
  void ctx.operators.exec('OPERATOR_APPLY_SETTINGS', { uiWorkspace: v })
}, { immediate: true })
const settingsOpen = ref(false)
provide('workbenchSettingsOpen', settingsOpen)


onMounted(async () => {
  unbindChrome = bindChromeDom(ctx, createChromeKeymapHandler(CHROME_REGION, () => ctx))
  await host.start()
})

onBeforeUnmount(() => {
  unbindChrome?.()
  unbindChrome = null
})


// VM 句柄：测试层通过 window.__vm__ 访问公开观测面
;(window as any).__vm__ = ctx
;(window as any).__vm_ready__ = true


ctx.log.injectStateRefs({
  scene: () => ctx.doc.value?.serialize() as any,
  selection: () => [...selection.items.value].filter(e => e.kind === 'block').map(e => e.ref),
  toolRegistry: () => ({
    activeToolId: toolRegistry.activeTool.value?.id ?? 'none',
    canUndo: editHistory.canUndo.value,
    canRedo: editHistory.canRedo.value,
    undoLabel: editHistory.undoLabel.value,
    redoLabel: editHistory.redoLabel.value,
  }),
})
</script>

<template>
  <WorkbenchShell v-show="workspace === 'preview' || workspace === 'wiki'">
    <template #menubar>
      <div class="wb-menubar-inner">
        <span class="wb-brand"><svg class="wb-brand-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>LIGHTNING</span>
        <UIRenderer
          v-for="panel in activeHeaderPanels"
          :key="panel.id"
          :layout="panel.layout"
          :rna="ctx.rna"
          :owner="panel.owner"
        />
      </div>
    </template>
    <template #workspace-tabs>
      <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
    </template>
    <template v-if="workspace !== 'wiki'" #tool-shelf>
      <div class="wb-toolshelf">
        <template v-for="panel in activeToolshelfPanels" :key="panel.id">
          <component v-if="panel.component" :is="panel.component" />
          <UIRenderer v-else :layout="panel.layout" :rna="ctx.rna" :owner="panel.owner" />
        </template>
      </div>
    </template>
    <template #viewport>
      <WorkbenchViewport v-if="workspace === 'preview' && ctx.doc.value" />
      <div v-else-if="workspace === 'wiki' && ctx.doc.value" class="wb-wiki-embed">
        <EmbedPreview :settings="embedSettings" :style="{ width: `${wikiConfig.viewWidth ?? 800}px`, height: `${wikiConfig.viewHeight ?? 600}px` }" />
      </div>
    </template>
    <template #properties>
      <PanelTabs :panels="activePropertiesPanels" :rna="ctx.rna" :ctx="ctx" />
    </template>
    <template #statusbar>
      <StatusBar />
    </template>
  </WorkbenchShell>

  <WorkbenchShell v-if="workspace === 'export'">
    <template #menubar>
      <div class="wb-menubar-inner">
        <span class="wb-brand"><svg class="wb-brand-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>LIGHTNING</span>
        <UIRenderer
          v-for="panel in activeHeaderPanels"
          :key="panel.id"
          :layout="panel.layout"
          :rna="ctx.rna"
          :owner="panel.owner"
        />
      </div>
    </template>
    <template #workspace-tabs>
      <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
    </template>
    <template #viewport>
      <ExportWorkspace />
    </template>
    <template #statusbar>
      <StatusBar />
    </template>
  </WorkbenchShell>

  <WorkbenchShell v-if="workspace === 'materials'">
    <template #menubar>
      <div class="wb-menubar-inner">
        <span class="wb-brand"><svg class="wb-brand-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>LIGHTNING</span>
        <UIRenderer
          v-for="panel in activeHeaderPanels"
          :key="panel.id"
          :layout="panel.layout"
          :rna="ctx.rna"
          :owner="panel.owner"
        />
      </div>
    </template>
    <template #workspace-tabs>
      <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
    </template>
    <template #viewport>
      <MaterialGallery />
    </template>
    <template #statusbar>
      <StatusBar />
    </template>
  </WorkbenchShell>

  <WorkbenchSettingsDrawer />

  <!-- ContextMenu floating overlay -->
  <Teleport to="body">
    <Transition name="menu-pop">
      <div
        v-if="ctx.wm.chrome.contextMenuOpen?.value ?? false"
        class="context-menu-overlay"
        @click="hideContextMenu(contextMenu)"
        @contextmenu.prevent
      >
        <div
          class="context-menu-popup"
          :style="{ left: (ctx.wm.chrome.contextMenuPosition?.value.x ?? 0) + 'px', top: (ctx.wm.chrome.contextMenuPosition?.value.y ?? 0) + 'px' }"
          @click.stop
        >
          <template v-for="(item, i) in ((ctx.wm.chrome.contextMenuItems ?? []) as ContextMenuItem[])" :key="i">
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
    </Transition>
  </Teleport>
</template>

<style scoped>
.wb-toolshelf {
  position: absolute; top: 4px; left: 4px; z-index: 100;
  display: flex; flex-direction: column; gap: 2px;
  padding: 4px;
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.wb-toolshelf :deep(.ux-operator-btn) {
  width: 34px; height: 34px; padding: 0;
  font-size: 16px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  border-color: transparent;
  background: transparent;
  color: var(--wb-text-muted);
  border-radius: var(--wb-radius-md);
}
.wb-toolshelf :deep(.ux-operator-btn:hover) {
  background: var(--wb-bg-hover);
  border-color: var(--wb-border);
}
.wb-toolshelf :deep(.ux-operator-btn--active) {
  background: var(--wb-bg-hover);
  border-color: var(--wb-accent);
  box-shadow: 0 0 10px rgba(77, 171, 247, 0.2);
}
.wb-toolshelf :deep(.ux-operator-btn--active:hover) {
  background: var(--wb-bg-hover);
  border-color: var(--wb-accent);
}
.wb-menubar-inner {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 10px;
}
.wb-brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--wb-text);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.3px;
  margin-right: 24px;
  user-select: none;
  flex-shrink: 0;
}
.wb-brand-icon {
  color: var(--wb-accent);
}
.wb-menubar-inner :deep(.ux-menu-btn) {
  border: none;
  background: transparent;
  padding: 5px 10px;
  font-size: 13px;
  color: var(--wb-accent-muted);
  cursor: pointer;
}
.wb-menubar-inner :deep(.ux-menu-btn:hover) {
  background: var(--wb-bg-hover);
  border-radius: var(--wb-radius-sm);
  color: var(--wb-text);
}
.wb-menubar-inner :deep(.ux-arrow) { display: none; }
.wb-menubar-inner :deep(.ux-operator-btn) {
  border: none;
  background: transparent;
  padding: 5px 10px;
  font-size: 13px;
  color: var(--wb-accent-muted);
  width: auto;
  cursor: pointer;
}
.wb-menubar-inner :deep(.ux-operator-btn:hover) {
  background: var(--wb-bg-hover);
  border-radius: var(--wb-radius-sm);
  color: var(--wb-text);
}
.wb-menubar-inner :deep(.ux-label) {
  font-size: 13px;
  color: var(--wb-text-dim);
  padding: 0 4px;
}

/* ---- Wiki embed ---- */
.wb-wiki-embed {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  overflow: auto;
  background: var(--wb-viewport-bg);
  background-image:
    linear-gradient(var(--wb-grid-color) 1px, transparent 1px),
    linear-gradient(90deg, var(--wb-grid-color) 1px, transparent 1px);
  background-size: 32px 32px;
}
.wb-wiki-placeholder {
  color: var(--wb-text-dim);
  font-size: 15px;
}
</style>

<style>
.context-menu-overlay {
  position: fixed; inset: 0; z-index: 9999;
}
.context-menu-popup {
  position: absolute;
  min-width: 160px;
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  padding: 4px 0;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.cm-item {
  display: block; width: 100%; padding: 4px 12px;
  border: none; background: transparent; color: var(--wb-text);
  font-size: 13px; text-align: left; cursor: pointer;
}
.cm-item:hover { background: var(--wb-bg-hover); }
.cm-label {
  display: block; padding: 2px 12px; font-size: 11px; color: var(--wb-text-dim);
}
.cm-sep { margin: 4px 8px; border: none; border-top: 1px solid var(--wb-border); }
.cm-icon { margin-right: 6px; }

.menu-pop-enter-active {
  transition: opacity 0.1s ease, transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.menu-pop-leave-active {
  transition: opacity 0.08s ease;
}
.menu-pop-enter-from {
  opacity: 0;
  transform: scale(0.95) translateY(-4px);
}
.menu-pop-leave-to {
  opacity: 0;
}

</style>
