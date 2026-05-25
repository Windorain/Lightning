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
      host.appendChild(canvas)
    }
  },
  { flush: 'post' },
)
</script>

<template>
  <div class="nei-slot-preview" role="listitem">
    <div
      ref="iconHost"
      class="nei-slot-preview-icon"
      aria-hidden="true"
    />
    <span
      v-if="count > 1"
      class="nei-slot-preview-count"
      aria-label="数量"
    >{{ count }}</span>
  </div>
</template>

<style scoped>
/* 40x40 NEI slot */
.nei-slot-preview {
  position: relative;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border: 2px solid var(--nei-border-slot);
  background: var(--nei-bg-input);
  box-sizing: border-box;
}
.nei-slot-preview-icon {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.nei-slot-preview-icon :deep(canvas) {
  width: 36px;
  height: 36px;
  image-rendering: pixelated;
  display: block;
}
.nei-slot-preview-count {
  position: absolute;
  right: 1px;
  bottom: 0;
  font-size: 10px;
  line-height: 1;
  font-weight: 700;
  font-family: ui-monospace, monospace;
  color: #ffffff;
  text-shadow: 1px 1px 0 #000;
  pointer-events: none;
  user-select: none;
}
</style>
