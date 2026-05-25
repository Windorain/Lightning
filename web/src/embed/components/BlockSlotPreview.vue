<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { BlockIconCache } from '@/render/interaction/blockIconCache'

const props = defineProps<{
  blockId: string
  count: number
  cache: BlockIconCache
}>()

/** 仅订阅本槽位 blockId，避免全局 notify 导致侧栏每一行都 flush */
const bump = ref(0)

watch(
  () => [props.blockId, props.cache] as const,
  ([id, cache], _prev, onCleanup) => {
    const unsub = cache.subscribe(id, () => {
      bump.value++
    })
    onCleanup(() => unsub())
  },
  { immediate: true },
)

const entry = computed(() => {
  void bump.value
  return props.cache.get(props.blockId)
})

const iconHost = ref<HTMLDivElement | null>(null)

watch(
  [entry, iconHost],
  () => {
    const host = iconHost.value
    const canvas = entry.value.canvas
    if (!host) return
    host.replaceChildren()
    if (entry.value.status === 'ready' && canvas) {
      canvas.classList.add('wm-slot-canvas')
      host.appendChild(canvas)
    }
  },
  { flush: 'post' },
)
</script>

<template>
  <div class="wm-slot" role="listitem">
    <div
      ref="iconHost"
      class="wm-slot-icon"
      aria-hidden="true"
    />
    <div
      v-if="entry.status === 'pending' || entry.status === 'idle'"
      class="wm-slot-skeleton"
    />
    <div
      v-if="entry.status === 'error'"
      class="wm-slot-fallback"
      :title="entry.error?.message ?? '预览失败'"
    />
    <span
      v-if="count > 1"
      class="wm-slot-count"
      aria-label="数量"
    >{{ count }}</span>
  </div>
</template>

<style scoped>
/* 2x slot, blueprint style */
.wm-slot {
  position: relative;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  box-sizing: border-box;
}
.wm-slot-icon {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 0;
}
.wm-slot-icon :deep(.wm-slot-canvas) {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  display: block;
}
.wm-slot-skeleton {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: 0;
  background: linear-gradient(
    90deg,
    rgba(80, 80, 80, 0.5) 0%,
    rgba(120, 120, 120, 0.7) 50%,
    rgba(80, 80, 80, 0.5) 100%
  );
  background-size: 200% 100%;
  animation: wm-shimmer 1.1s ease-in-out infinite;
  pointer-events: none;
}
@keyframes wm-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}
.wm-slot-fallback {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: 0;
  background: repeating-linear-gradient(
    45deg,
    #6b6b6b,
    #6b6b6b 4px,
    #4a4a4a 4px,
    #4a4a4a 8px
  );
  pointer-events: none;
}
.wm-slot-count {
  position: absolute;
  right: 1px;
  bottom: 0;
  font-size: 9px;
  line-height: 1;
  font-weight: 600;
  font-family: ui-monospace, 'Cascadia Code', monospace;
  color: var(--wb-text);
  text-shadow:
    1px 1px 0 #2f2f2f,
    -1px -1px 0 #2f2f2f,
    1px -1px 0 #2f2f2f,
    -1px 1px 0 #2f2f2f;
  pointer-events: none;
  user-select: none;
}
</style>
