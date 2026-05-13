<!-- web/src/workbench/components/ToolShelf.vue -->
<script setup lang="ts">
import { useToolRegistry } from '@/workbench/toolRegistry'
import { useBContext } from '@/workbench/context/bContext'
import { useSnapping } from '@/workbench/composables/useSnapping'
import { globalOperators } from '@/workbench/operators/operatorRegistry'

const registry = useToolRegistry()
const { tools, activeTool } = registry
const bctx = useBContext()
const { snapEnabled, toggleSnap } = useSnapping()
</script>

<template>
  <div class="toolshelf">
    <button
      v-for="[_id, tool] in tools"
      :key="tool.id"
      :data-testid="`tool-${tool.id}`"
      class="toolshelf__btn"
      :class="{ 'toolshelf__btn--active': activeTool?.id === tool.id }"
      :title="tool.label + (tool.defaultKey ? ` (${tool.defaultKey})` : '')"
      @click="globalOperators.exec(bctx, 'OPERATOR_TOOL_SET', { toolId: tool.id })"
    >
      <span class="toolshelf__icon">{{ tool.icon }}</span>
    </button>
    <div class="toolshelf__sep" />
    <button class="toolshelf__btn" :class="{ 'toolshelf__btn--active': snapEnabled }"
      title="吸附 / Snap" @click="toggleSnap()">
      <span class="toolshelf__icon">{{ snapEnabled ? '⊞' : '⊟' }}</span>
    </button>
  </div>
</template>

<style scoped>
.toolshelf {
  position: absolute; top: 4px; left: 4px; z-index: 100;
  display: flex; flex-direction: column; gap: 2px;
  padding: 4px; background: var(--nei-dropdown-bg); border: 1px solid var(--nei-border);
  border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.toolshelf__btn {
  width: 32px; height: 32px; border: 1px solid transparent;
  background: transparent; color: var(--nei-label); font-size: 16px;
  cursor: pointer; border-radius: 4px; display: flex; align-items: center; justify-content: center;
}
.toolshelf__btn:hover { background: var(--nei-panel-hover); }
.toolshelf__btn--active { background: var(--nei-dropdown-hover); color: #fff; border-color: var(--nei-border); }
.toolshelf__sep { height: 1px; background: var(--nei-border); margin: 2px 0; }
.toolshelf__icon { line-height: 1; }
</style>
