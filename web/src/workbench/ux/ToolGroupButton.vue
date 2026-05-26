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

const activeToolId = registry.activeTool.value?.id ?? ''
const activeMember = props.members.find(t => t.id === activeToolId) ?? props.members[0]
const hasMultiple = props.members.length > 1

function activateDefault(): void {
  flyoutOpen.value = false
  registry.activate(activeMember!.id)
}

function activateTool(id: string): void {
  flyoutOpen.value = false
  registry.activate(id)
}

function toggleFlyout(): void {
  flyoutOpen.value = !flyoutOpen.value
}

function onFlyoutLeave(): void {
  flyoutOpen.value = false
}
</script>

<template>
  <div class="tg-btn" :class="{ 'tg-btn--active': !!activeMember && registry.activeTool.value?.id === activeMember.id }">
    <button
      class="tg-main"
      :title="activeMember?.label ?? members[0]?.label"
      @click="activateDefault"
    >
      <span class="tg-icon" v-html="toolIcon(iconMap[activeMember?.id ?? members[0]?.id] ?? 'select', 'active')" />
      <span v-if="hasMultiple" class="tg-arrow" @click.stop="toggleFlyout">▾</span>
    </button>
    <div v-if="hasMultiple && flyoutOpen" class="tg-flyout" @mouseleave="onFlyoutLeave">
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

.tg-main {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  color: var(--nei-text-secondary, #8890a0);
}

.tg-btn--active .tg-main {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.12);
  color: var(--nei-text-primary, #d0d8e0);
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

.tg-arrow {
  position: absolute;
  bottom: 0;
  right: 0;
  font-size: 8px;
  line-height: 1;
  color: rgba(255, 255, 255, 0.5);
  width: 10px;
  height: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tg-arrow:hover {
  color: rgba(255, 255, 255, 0.9);
}

.tg-flyout {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 300;
  background: rgba(20, 24, 28, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 140px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.tg-flyout-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--nei-text-secondary, #8890a0);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}

.tg-flyout-item:hover,
.tg-flyout-item--active {
  background: rgba(255, 255, 255, 0.08);
  color: var(--nei-text-primary, #d0d8e0);
}

.tg-flyout-icon {
  display: flex;
  align-items: center;
  width: 18px;
  height: 18px;
}

.tg-flyout-label {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
}
</style>
