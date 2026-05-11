<script setup lang="ts">
/**
 * Workbench 主布局壳：Blender 风格 3 列。
 * 通过 named slots 让父组件控制各区域的内容与 props。
 */
import { provide } from 'vue'
import { usePanelResize } from './panelResize'

const { rightWidth, startRightDrag, dragging } = usePanelResize()

provide('wb-right-width', rightWidth)
provide('wb-dragging', dragging)
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
        class="wb-divider wb-divider--right"
        @pointerdown="startRightDrag"
        role="separator"
        aria-orientation="vertical"
        tabindex="-1"
      />

      <aside class="wb-properties" :style="{ width: `${rightWidth}px` }">
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
  background: var(--nei-bg);
  color: var(--nei-text-dark);
}
.wb-shell--dragging * { cursor: col-resize !important; }

.wb-menubar {
  flex-shrink: 0;
  height: 28px;
  background: var(--nei-bg-deep);
  border-bottom: 1px solid var(--nei-border);
}

.wb-workspace-tabs {
  flex-shrink: 0;
  height: 32px;
  background: var(--nei-bg-deep);
  border-bottom: 1px solid var(--nei-border);
}

.wb-main {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.wb-divider {
  flex-shrink: 0;
  width: 4px;
  cursor: col-resize;
  background: var(--nei-divider-bg);
  transition: background 0.15s;
  z-index: 10;
}
.wb-divider:hover,
.wb-divider:active {
  background: var(--nei-divider-hover);
}

.wb-viewport {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  background: var(--nei-viewport-bg);
}

.wb-properties {
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--nei-bg-deep);
  border-left: 1px solid var(--nei-border);
}

.wb-statusbar {
  flex-shrink: 0;
  height: 24px;
  background: var(--nei-bg-deep);
  border-top: 1px solid var(--nei-border);
  font-size: 11px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  color: var(--nei-muted);
}
</style>
