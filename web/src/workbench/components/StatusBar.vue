<script setup lang="ts">
/**
 * 底栏状态条：模型信息 + 帧信息 + 渲染状态
 */
import { inject } from 'vue'
import { bContextKey } from '@/workbench/context/bContext'
import { logCenter, LOG_LEVEL } from '@/workbench/logging/LogCenter'

const bctx = inject(bContextKey)

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
    <span v-if="bctx?.hasWorldMultiFrame.value" class="sb-item">
      Frame {{ bctx.worldFrameIndex.value + 1 }} / {{ bctx.worldFrameCount.value }}
    </span>
  </div>
</template>

<style scoped>
.sb-root {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 16px;
  color: var(--nei-muted);
}
.sb-item { white-space: nowrap; }
.sb-item--error { color: #ff5555; }
.sb-item--warn { color: #ffaa33; }
.sb-spacer { flex: 1; }
</style>
