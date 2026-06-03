<script setup lang="ts">
import { computed } from 'vue'

import { useContext } from '@/runtime/context'
const ctx = useContext()

const isSde = computed(() => ctx.workspaceMode.value === 'sde')
const apiBaseStr = computed(() => ctx.connection.apiBase)
const exportFilesList = computed(() => ctx.connection.exports)
const exportsLoading = computed(() => ctx.connection.exportsLoading)
const selectedName = computed(() => ctx.connection.selectedExportName)

async function onPick(name: string): Promise<void> {
  try {
    await ctx.operators.exec('OPERATOR_SDE_LOAD', { name })
    ctx.log.setStatus(`已加载 ${name}`)
  } catch (e) {
    ctx.log.setStatus(String(e instanceof Error ? e.message : e))
  }
}
</script>

<template>
  <section v-if="isSde && apiBaseStr" class="wm-panel">
    <h2 class="wm-panel__title">structure_exports</h2>
    <div v-if="exportsLoading" class="wm-muted">加载列表…</div>
    <ul v-else class="wm-list">
      <li v-for="f in exportFilesList" :key="f.name" class="wm-list__item">
        <button
          type="button"
          class="wm-link"
          :class="{ 'wm-link--active': selectedName === f.name }"
          @click="onPick(f.name)"
        >
          {{ f.name }}
        </button>
        <span class="wm-size">{{ f.size }} B</span>
      </li>
    </ul>
    <p v-if="!exportsLoading && exportFilesList.length === 0" class="wm-muted">目录下暂无 .json</p>
  </section>
</template>

<style scoped>
.wm-panel {
  padding: 12px;
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  background: var(--wb-bg-deepest);
  margin-bottom: 12px;
}
.wm-panel__title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
}
.wm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 200px;
  overflow: auto;
}
.wm-list__item {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--wb-border);
  font-size: 12px;
}
.wm-link {
  background: none;
  border: none;
  color: var(--wb-accent-muted);
  cursor: pointer;
  text-align: left;
  padding: 0;
  flex: 1;
}
.wm-link:hover {
  text-decoration: underline;
}
.wm-link--active {
  color: var(--wb-warn);
}
.wm-size {
  color: var(--wb-text-dim);
  flex-shrink: 0;
}
.wm-muted {
  font-size: 12px;
  color: var(--wb-text-dim);
}
</style>
