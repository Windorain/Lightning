<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import ContentText from '@/editors/ContentText.vue'

const props = defineProps<{
  text: string
  clientX: number
  clientY: number
  offset?: number
  /**
   * 本实例的主题（#259 A33）。
   *
   * 为什么需要它：本组件 `Teleport` 到 `body`，**脱离**实例根的 DOM 继承链，
   * 因此读不到实例根上的 `data-lk-theme`。旧实现把这个信息放在
   * `document.documentElement`（全局），于是同页两实例无法各持主题；
   * 新形态由调用方把本实例主题显式传下来。
   */
  theme?: 'dark' | 'light'
}>()

const root = ref<HTMLElement | null>(null)
const boxStyle = ref<Record<string, string>>({ left: '0px', top: '0px' })

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
    <div
      ref="root"
      class="wm-tooltip-box wm-tooltip-surface"
      role="tooltip"
      :data-lk-theme="theme ?? 'dark'"
      :style="boxStyle"
    >
      <!--
        外部文本经**受控呈现边界**（ContentText → domain/textContent）。
        这里没有 `v-html`：节点由允许列表产出，组件只按 `type` 分派元素。
        （#259 A32 退役项：本文件原为 6 条 `v-html` 直通路径之一。）
      -->
      <ContentText class="wm-tooltip-body" :text="text" mode="mc" />
    </div>
  </Teleport>
</template>

<!-- 样式见 @/styles/nei-tokens.css（Teleport 到 body，需全局类） -->
