<script setup lang="ts">
/**
 * `EditorViewportDock` —— 视口下方栏的**唯一**接线。
 *
 * ## 为什么它单独一个组件
 *
 * dock 的**位置**是外壳的布局决定（工作台在视口条带下、嵌入在整个 stage 之下、
 * 跨过侧栏），而它的**状态与动作**属于视口宿主。把两者分开：
 *  - 状态/动作只有一份（`EditorViewportHostApi#dock` + `set*`）；
 *  - 外壳只决定"放在哪"（本组件在各自模板里的位置）。
 *
 * 旧实现里这段 props/emit 映射在两个壳里各写一遍（工作台 9 个 prop、嵌入 11 个），
 * 差异是"嵌入多传 show-frame-tab/show-layer-tab"——现在两者都从 dock 策略取，
 * 工作台的策略值恒为 true（与旧缺省逐字相同）。
 */
import ViewportFrameLayerDock from '@/shared/viewport/ViewportFrameLayerDock.vue'
import type { EditorViewportHostApi } from '@/shared/viewport/editorViewportHost'

const props = defineProps<{
  api: EditorViewportHostApi
}>()
</script>

<template>
  <ViewportFrameLayerDock
    v-if="props.api.dock.show"
    :active-tab="props.api.dock.activeTab"
    :theme="props.api.dock.theme"
    :show-frame-tab="props.api.dock.showFrameTab"
    :show-layer-tab="props.api.dock.showLayerTab"
    :has-world-multi-frame="props.api.dock.hasWorldMultiFrame"
    :world-frame-index="props.api.dock.worldFrameIndex"
    :world-frame-count="props.api.dock.worldFrameCount"
    :is-playing="props.api.dock.isPlaying"
    :mesh-busy="props.api.dock.meshBusy"
    :grid-height="props.api.dock.gridHeight"
    :layer-world-y="props.api.dock.layerWorldY"
    :layer-preview-label="props.api.dock.layerPreviewLabel"
    :channel-panel="props.api.dock.channelPanel"
    @update:active-tab="props.api.setActiveTab"
    @set-frame="props.api.setFrameIndex"
    @toggle-playback="props.api.togglePlayback"
    @set-tier="props.api.setChannelTier"
    @set-channel-value="props.api.setChannelValue"
    @set-runstate="props.api.setChannelRunstate"
    @update:layer-y="props.api.setLayerY"
  />
</template>
