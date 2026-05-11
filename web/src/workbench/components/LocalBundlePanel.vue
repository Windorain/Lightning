<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listDevSceneIds } from '@/dev/devScenes'
import { DEFAULT_PREVIEW_SCENE_ID } from '@/preview/previewSession'
import { useSceneContext } from '@/workbench/sceneContext'
import { useStatusMessage } from '@/workbench/composables/useStatusMessage'

const ctx = useSceneContext()
const { setStatusMessage } = useStatusMessage()

const ids = computed(() => listDevSceneIds())
const selectedId = ref(DEFAULT_PREVIEW_SCENE_ID)
const busy = ref(false)
const lastErr = ref('')

onMounted(() => {
  const list = listDevSceneIds()
  if (list.length > 0 && !list.includes(selectedId.value)) {
    selectedId.value = list[0]!
  }
})

async function load(): Promise<void> {
  busy.value = true
  lastErr.value = ''
  try {
    await ctx.loadBuiltinScene(selectedId.value)
    setStatusMessage(`已加载示例 ${selectedId.value}`)
  } catch (e) {
    lastErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="dash-card">
    <h2 class="dash-card__title">内置示例场景</h2>
    <p class="dash-card__desc">来自仓库 <code class="dash-code">data/scenes/*.json</code>，仅供开发与对照。</p>

    <label class="dash-field">
      <span class="dash-field__label">场景 ID</span>
      <select v-model="selectedId" class="dash-select">
        <option v-for="id in ids" :key="id" :value="id">{{ id }}</option>
      </select>
    </label>

    <button type="button" class="dash-btn dash-btn--primary" :disabled="busy || ids.length === 0" @click="load">
      {{ busy ? '加载中…' : '加载到工作台' }}
    </button>

    <p v-if="lastErr" class="dash-err">{{ lastErr }}</p>
  </section>
</template>

<style scoped>
.dash-card {
  padding: 16px;
  border: 1px solid var(--nei-border);
  border-radius: 10px;
  background: var(--nei-bg-deep);
  margin-bottom: 14px;
}
.dash-card__title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--nei-text);
}
.dash-card__desc {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--nei-label);
}
.dash-code {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--nei-bg);
  color: var(--nei-text-dark);
}
.dash-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.dash-field__label {
  font-size: 11px;
  color: var(--nei-label);
}
.dash-select {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--nei-panel-hover);
  background: var(--nei-bg);
  color: var(--nei-text-dark);
  font-size: 13px;
}
.dash-btn {
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--nei-muted);
  background: var(--nei-border);
  color: var(--nei-text);
  cursor: pointer;
  font-size: 13px;
}
.dash-btn:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}
.dash-btn--primary {
  background: var(--nei-accent);
  border-color: var(--nei-accent);
}
.dash-err {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--nei-error-text);
}
</style>
