<script setup lang="ts">
/**
 * 底栏状态条：模型信息 + 帧信息 + 渲染状态
 */
import { computed } from 'vue'
import { LOG_LEVEL } from '@/logging/LogCenter'
import { useContext } from '@/runtime/context'

const ctx = useContext()
const log = ctx.log

const frameCount = computed(() => ctx?.doc.value?.frameCount ?? 0)
const hasWorldMultiFrame = computed(() => frameCount.value > 1)

function logClass(level: number): string {
  if (level & LOG_LEVEL.ERROR) return 'sb-item sb-item--error'
  if (level & LOG_LEVEL.WARN) return 'sb-item sb-item--warn'
  return 'sb-item'
}
</script>

<template>
  <div class="sb-root">
    <span v-if="log.lastDisplayable.value" :class="logClass(log.lastDisplayable.value.level)">
      {{ log.lastDisplayable.value.message }}
    </span>
    <span v-if="log.statusMessage && !log.lastDisplayable.value" class="sb-item">{{ log.statusMessage }}</span>
    <span class="sb-spacer" />
    <span v-if="hasWorldMultiFrame" class="sb-item">
      Frame {{ (ctx?.currentFrameIndex.value ?? 0) + 1 }} / {{ frameCount }}
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
.sb-item--warn { color: var(--wb-warn); }
.sb-spacer { flex: 1; }
</style>
