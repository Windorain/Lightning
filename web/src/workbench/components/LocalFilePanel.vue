<script setup lang="ts">
import { ref } from 'vue'

import { useSceneContext } from '@/workbench/sceneContext'
import { logCenter } from '@/workbench/logging/LogCenter'

const ctx = useSceneContext()
const fileInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const lastErr = ref('')

function triggerPick(): void {
  lastErr.value = ''
  fileInput.value?.click()
}

/** 支持 File System Access 时用手柄打开，便于之后「保存到文件」写回原路径 */
async function pickFile(): Promise<void> {
  lastErr.value = ''
  if (
    typeof window !== 'undefined' &&
    'showOpenFilePicker' in window &&
    typeof window.showOpenFilePicker === 'function'
  ) {
    busy.value = true
    try {
      const handles = await window.showOpenFilePicker({
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        multiple: false,
      })
      const handle = handles[0]
      const file = await handle.getFile()
      await ctx.loadSceneFromFile(file, { saveHandle: handle })
      logCenter.setStatus(`已打开 ${file.name}`)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      lastErr.value = err instanceof Error ? err.message : String(err)
    } finally {
      busy.value = false
    }
    return
  }
  triggerPick()
}

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  lastErr.value = ''
  try {
    await ctx.loadSceneFromFile(file)
    logCenter.setStatus(`已打开 ${file.name}`)
  } catch (err) {
    lastErr.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function onDrop(ev: DragEvent): Promise<void> {
  ev.preventDefault()
  const file = ev.dataTransfer?.files?.[0]
  if (!file || !file.name.toLowerCase().endsWith('.json')) {
    lastErr.value = '请拖入 .json 文件'
    return
  }
  busy.value = true
  lastErr.value = ''
  try {
    await ctx.loadSceneFromFile(file)
    logCenter.setStatus(`已打开 ${file.name}`)
  } catch (err) {
    lastErr.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="dash-card">
    <h2 class="dash-card__title">打开本地 JSON</h2>
    <p class="dash-card__desc">从磁盘选择 StructureData / World 打包 JSON，数据仅在浏览器内存中处理。</p>

    <input ref="fileInput" type="file" accept=".json,application/json" class="dash-hidden" @change="onFile" />

    <div
      class="dash-drop"
      :class="{ 'dash-drop--busy': busy }"
      @dragover.prevent
      @drop="onDrop"
    >
      <p class="dash-drop__hint">拖放 .json 到此处，或</p>
      <button type="button" class="dash-btn dash-btn--primary" :disabled="busy" @click="pickFile">
        {{ busy ? '读取中…' : '选择文件' }}
      </button>
    </div>

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
.dash-hidden {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}
.dash-drop {
  border: 1px dashed var(--nei-panel-hover);
  border-radius: 10px;
  padding: 20px;
  text-align: center;
  background: var(--nei-bg);
}
.dash-drop--busy {
  opacity: 0.7;
}
.dash-drop__hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--nei-muted);
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
  opacity: 0.7;
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
