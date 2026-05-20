<script setup lang="ts">
/**
 * 底栏状态条：模型信息 + 帧信息 + 渲染状态
 */
import { inject } from 'vue'
import { View3DContextKey } from '@/preview/sceneStore'
import { logCenter, LOG_LEVEL } from '@/workbench/logging/LogCenter'

const store = inject(View3DContextKey)

function logClass(level: number): string {
  if (level & LOG_LEVEL.ERROR) return 'sb-item sb-item--error'
  if (level & LOG_LEVEL.WARN) return 'sb-item sb-item--warn'
  return 'sb-item'
}

function logLevelLabel(level: number): string {
  return (LOG_LEVEL_LABEL as Record<number, string>)[level] ?? ''
}
</script>

<template>
  <div class="sb-root">
    <span v-if="logCenter.lastDisplayable.value" :class="logClass(logCenter.lastDisplayable.value.level)">
      {{ logCenter.lastDisplayable.value.message }}
    </span>
    <span v-if="logCenter.statusMessage && !logCenter.lastDisplayable.value" class="sb-item">{{ logCenter.statusMessage }}</span>
    <span class="sb-spacer" />
    <span v-if="store?.hasWorldMultiFrame.value" class="sb-item">
      Frame {{ store.worldFrameIndex.value + 1 }} / {{ store.worldFrameCount.value }}
    </span>
  </div>
</template>

<style scoped>
.sb-root {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 14px;
  color: var(--wb-text-muted);
}
.sb-item { white-space: nowrap; font-size: 10px; }
.sb-item--error { color: var(--wb-danger); }
.sb-item--warn { color: #f59e0b; }
.sb-spacer { flex: 1; }
</style>
