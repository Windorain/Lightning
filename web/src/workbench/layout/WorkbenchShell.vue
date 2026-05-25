<script setup lang="ts">
/**
 * Workbench 主布局壳：Blender 风格 3 列。
 * 通过 named slots 让父组件控制各区域的内容与 props。
 */
import { useSlots } from 'vue'
import { usePanelResize } from './panelResize'

const { rightWidth, startRightDrag, dragging } = usePanelResize()
const slots = useSlots()
const hasProperties = () => !!slots.properties
</script>

<template>
  <div class="wb-shell" :class="{ 'wb-shell--dragging': dragging }">
    <header class="wb-menubar">
      <slot name="menubar" />
    </header>

    <nav class="wb-workspace-tabs">
      <slot name="workspace-tabs" />
    </nav>

    <div class="wb-main">
      <main class="wb-viewport">
        <slot name="tool-shelf" />
        <slot name="viewport" />
      </main>

      <div
        v-if="hasProperties()"
        class="wb-divider wb-divider--right"
        @pointerdown="startRightDrag"
        role="separator"
        aria-orientation="vertical"
        tabindex="-1"
      />

      <aside v-if="hasProperties()" class="wb-properties" :style="{ width: `${rightWidth}px` }">
        <slot name="properties" />
      </aside>
    </div>

    <footer class="wb-statusbar">
      <slot name="statusbar" />
    </footer>
  </div>
</template>

<style>
.wb-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--wb-bg-deepest);
  color: var(--wb-text);
  font-family: system-ui, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
  font-size: 13px;
}
.wb-shell--dragging * { cursor: col-resize !important; }

.wb-menubar {
  flex-shrink: 0;
  height: 36px;
  background: var(--wb-bg-elevated);
  border-bottom: 1px solid var(--wb-border);
}

.wb-workspace-tabs {
  flex-shrink: 0;
  height: 38px;
  background: var(--wb-bg-deepest);
  border-bottom: 1px solid var(--wb-border);
}

.wb-main {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.wb-divider {
  flex-shrink: 0;
  width: 1px;
  cursor: col-resize;
  background: var(--wb-border);
  transition: background 0.15s;
  z-index: 10;
}
.wb-divider:hover,
.wb-divider:active {
  background: var(--wb-accent);
}

.wb-viewport {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  background: var(--wb-viewport-bg);
  background-image:
    linear-gradient(var(--wb-grid-color) 1px, transparent 1px),
    linear-gradient(90deg, var(--wb-grid-color) 1px, transparent 1px);
  background-size: 32px 32px;
}

.wb-properties {
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--wb-bg-elevated);
  border-left: 1px solid var(--wb-border);
}

.wb-statusbar {
  flex-shrink: 0;
  height: 26px;
  background: var(--wb-bg-deepest);
  border-top: 1px solid var(--wb-border);
  font-size: 10px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  color: var(--wb-text-muted);
}
</style>
