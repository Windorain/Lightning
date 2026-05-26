<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { renderTooltipHtml } from '@/workbench/components/renderTooltipHtml'

const props = defineProps<{
  text: string
  clientX: number
  clientY: number
  offset?: number
}>()

const root = ref<HTMLElement | null>(null)
const boxStyle = ref<Record<string, string>>({ left: '0px', top: '0px' })

const html = computed(() => renderTooltipHtml(props.text))

const pad = computed(() => props.offset ?? 12)

function clampTooltipPosition(): void {
  const el = root.value
  if (!el) return
  const vw = window.innerWidth
  const vh = window.innerHeight
  const r = el.getBoundingClientRect()
  let left = props.clientX + pad.value
  let top = props.clientY + pad.value
  if (left + r.width > vw - 8) {
    left = props.clientX - r.width - pad.value
  }
  if (left < 8) left = 8
  if (top + r.height > vh - 8) {
    top = vh - r.height - 8
  }
  if (top < 8) top = 8
  boxStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
  }
}

watch(
  () => [props.clientX, props.clientY, props.text, props.offset] as const,
  async () => {
    boxStyle.value = {
      left: `${props.clientX + pad.value}px`,
      top: `${props.clientY + pad.value}px`,
    }
    await nextTick()
    clampTooltipPosition()
    requestAnimationFrame(() => clampTooltipPosition())
  },
  { flush: 'post', immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <div ref="root" class="wm-tooltip-box wm-tooltip-surface" role="tooltip" :style="boxStyle">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="wm-tooltip-body" v-html="html" />
    </div>
  </Teleport>
</template>

<!-- 样式见 @/styles/nei-tokens.css（Teleport 到 body，需全局类） -->
