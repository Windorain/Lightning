<script setup lang="ts">
/**
 * 底栏状态条：模型信息 + 帧信息 + 渲染状态
 */
import { inject } from 'vue'
import { PreviewSceneContextKey } from '@/preview/sceneStore'
import { LOG_LEVEL_LABEL, LOG_LEVEL } from '@/workbench/logging/LogCenter'
import { useBContext } from '@/workbench/context/bContext'

const store = inject(PreviewSceneContextKey)
const bctx = useBContext()
const statusMessage = bctx.statusMessage

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
    <span v-if="bctx.log.lastDisplayable.value" :class="logClass(bctx.log.lastDisplayable.value.level)" :title="logLevelLabel(bctx.log.lastDisplayable.value.level)">
      {{ bctx.log.lastDisplayable.value.message }}
    </span>
    <span v-if="statusMessage && !bctx.log.lastDisplayable.value" class="sb-item">{{ statusMessage }}</span>
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
  gap: 16px;
  color: var(--nei-muted);
}
.sb-item { white-space: nowrap; }
.sb-item--error { color: #ff5555; }
.sb-item--warn { color: #ffaa33; }
.sb-spacer { flex: 1; }
</style>
