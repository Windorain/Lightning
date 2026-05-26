<script setup lang="ts">
import { ref } from 'vue'
import type { Tool } from '@/workbench/tools/tool'
import { useToolRegistry } from '@/workbench/toolRegistry'
import { toolIcon, type ToolIconId } from '@/workbench/icons/toolIcons'

const iconMap: Record<string, ToolIconId> = {
  select: 'select',
  move: 'move',
  'annotation-box': 'box',
  'annotation-box-full': 'box',
  'annotation-point': 'point',
  'annotation-line': 'line',
  'annotation-text': 'text',
}

const props = defineProps<{
  members: Tool[]
}>()

const registry = useToolRegistry()
const flyoutOpen = ref(false)
let holdTimer: ReturnType<typeof setTimeout> | null = null
let heldOpen = false

const activeToolId = registry.activeTool.value?.id ?? ''
const activeMember = props.members.find(t => t.id === activeToolId) ?? props.members[0]
const hasMultiple = props.members.length > 1

function activateTool(id: string): void {
  flyoutOpen.value = false
  registry.activate(id)
}

function onPointerDown(): void {
  if (!hasMultiple) return
  heldOpen = false
  holdTimer = setTimeout(() => {
    flyoutOpen.value = true
    heldOpen = true
  }, 200)
}

function onPointerUp(): void {
  if (holdTimer) {
    clearTimeout(holdTimer)
    holdTimer = null
  }
}

function isCornerClick(e: MouseEvent): boolean {
  const btn = e.currentTarget as HTMLElement
  const rect = btn.getBoundingClientRect()
  const dx = rect.right - e.clientX
  const dy = rect.bottom - e.clientY
  return dx <= 12 && dy <= 12
}

function onMainClick(e: MouseEvent): void {
  if (!hasMultiple) {
    registry.activate(activeMember!.id)
    return
  }
  if (flyoutOpen.value) {
    flyoutOpen.value = false
    return
  }
  // Click on corner triangle → open flyout immediately
  if (isCornerClick(e)) {
    flyoutOpen.value = true
    return
  }
  if (!heldOpen) {
    registry.activate(activeMember!.id)
  }
}

function onFlyoutLeave(): void {
  if (holdTimer) {
    clearTimeout(holdTimer)
    holdTimer = null
  }
  flyoutOpen.value = false
}
</script>

<template>
  <div
    class="tg-btn"
    :class="{
      'tg-btn--active': !!activeMember && registry.activeTool.value?.id === activeMember.id,
      'tg-btn--has-variants': hasMultiple,
    }"
    @click="onMainClick"
  >
    <button
      class="tg-main"
      :title="activeMember?.label ?? members[0]?.label"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointerleave="onPointerUp"
    >
      <span class="tg-icon" v-html="toolIcon(iconMap[activeMember?.id ?? members[0]?.id] ?? 'select', 'active')" />
    </button>
    <div v-if="hasMultiple && flyoutOpen" class="tg-flyout" @mouseleave="onFlyoutLeave">
      <div class="tg-flyout-header">{{ activeMember?.label ?? members[0]?.label }}</div>
      <button
        v-for="t in members"
        :key="t.id"
        class="tg-flyout-item"
        :class="{ 'tg-flyout-item--active': registry.activeTool.value?.id === t.id }"
        @click="activateTool(t.id)"
      >
        <span class="tg-flyout-icon" v-html="toolIcon(iconMap[t.id] ?? 'select', registry.activeTool.value?.id === t.id ? 'active' : 'inactive')" />
        <span class="tg-flyout-label">{{ t.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tg-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
}

/* -- trigger button -- */
.tg-main {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--wb-radius-md, 4px);
  background: transparent;
  cursor: pointer;
  color: var(--wb-text-muted, #889eb8);
  transition:
    background 150ms ease,
    border-color 150ms ease,
    color 150ms ease;
}

.tg-btn--active .tg-main {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.12);
  color: var(--wb-text, #c5d8e8);
}

.tg-main:hover {
  background: rgba(255, 255, 255, 0.06);
}

.tg-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}

/* Blender-style corner-fold triangle (ROUNDBOX_TRIA_HOLD_ACTION_ARROW).
   Size: triasize 0.75 × shader scale 0.4 ≈ 30% of 36px = ~10px.
   Color: Blender wcol->item = rgba(255,255,255,0.7). */
.tg-btn--has-variants::after {
  content: '';
  position: absolute;
  bottom: 0;
  right: 0;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 0 0 10px 10px;
  border-color: transparent transparent rgba(255, 255, 255, 0.7) transparent;
  border-radius: 0 0 var(--wb-radius-md, 4px) 0;
  pointer-events: none;
  transition: border-color 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.tg-btn--has-variants:hover::after {
  border-color: transparent transparent var(--wb-accent, #4dabf7) transparent;
}

/* -- flyout panel: opens to the right (Photoshop/Figma/Blender convention) -- */
.tg-flyout {
  position: absolute;
  top: 0;
  left: calc(100% + 6px);
  z-index: 500;
  min-width: 168px;
  padding: 6px;
  background: rgba(26, 38, 51, 0.96);
  backdrop-filter: blur(16px) saturate(120%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--wb-radius-lg, 6px);
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.3),
    0 8px 24px rgba(0, 0, 0, 0.5),
    0 2px 6px rgba(0, 0, 0, 0.3);
}

/* -- flyout group header -- */
.tg-flyout-header {
  font-family: var(--wb-font-mono, 'JetBrains Mono', monospace);
  font-size: 10px;
  color: var(--wb-text-dim, #6a7e96);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 4px 10px 2px;
  user-select: none;
}

/* -- flyout items -- */
.tg-flyout-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: none;
  border-radius: var(--wb-radius-sm, 3px);
  background: transparent;
  color: var(--wb-text-muted, #889eb8);
  cursor: pointer;
  font-size: 12px;
  font-family: system-ui, 'Segoe UI', sans-serif;
  text-align: left;
  position: relative;
  transition:
    background 150ms ease,
    color 150ms ease,
    padding-left 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

/* Active indicator: left accent bar — only on the selected item, never on hover.
   No second blue bar to avoid visual symbol collision. */
.tg-flyout-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--wb-accent, #4dabf7);
  opacity: 0;
  transform: scaleY(0.6);
  transition:
    opacity 200ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

/* Active: blue bar + subtle blue-tinted background */
.tg-flyout-item--active {
  background: rgba(77, 171, 247, 0.1);
  color: #fff;
}

.tg-flyout-item--active::before {
  opacity: 1;
  transform: scaleY(1);
}

/* Hover: background lift + text push-right only — no blue bar */
.tg-flyout-item:hover {
  background: var(--wb-bg-hover, #253442);
  color: var(--wb-text, #c5d8e8);
  padding-left: 14px;
}

.tg-flyout-item--active:hover {
  background: rgba(77, 171, 247, 0.16);
}

.tg-flyout-icon {
  display: flex;
  align-items: center;
  width: 18px;
  height: 18px;
}

.tg-flyout-label {
  font-weight: 500;
  white-space: nowrap;
}
</style>
