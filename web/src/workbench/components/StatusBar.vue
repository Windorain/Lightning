<script setup lang="ts">
/**
 * 底栏状态条：模型信息 + 帧信息 + 渲染状态
 */
import { computed, inject } from 'vue'
import { bContextKey } from '@/workbench/context/bContext'
import { logCenter, LOG_LEVEL } from '@/workbench/logging/LogCenter'

const bctx = inject(bContextKey)

const frameCount = computed(() => bctx?.doc.value?.frameCount ?? 0)
const hasWorldMultiFrame = computed(() => frameCount.value > 1)

function logClass(level: number): string {
  if (level & LOG_LEVEL.ERROR) return 'sb-item sb-item--error'
  if (level & LOG_LEVEL.WARN) return 'sb-item sb-item--warn'
  return 'sb-item'
}
</script>

<template>
  <div class="sb-root">
    <span v-if="logCenter.lastDisplayable.value" :class="logClass(logCenter.lastDisplayable.value.level)">
      {{ logCenter.lastDisplayable.value.message }}
    </span>
    <span v-if="logCenter.statusMessage && !logCenter.lastDisplayable.value" class="sb-item">{{ logCenter.statusMessage }}</span>
    <span class="sb-spacer" />
    <span v-if="hasWorldMultiFrame" class="sb-item">
      Frame {{ (bctx?.currentWorldFrameIndex.value ?? 0) + 1 }} / {{ frameCount }}
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
