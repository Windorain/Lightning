<script lang="ts">
export type { ViewportDockTab } from './dockTabs'
</script>

<script setup lang="ts">
import { computed } from 'vue'
import LayerPreviewBar from '@/shared/viewport/LayerPreviewBar.vue'
import WorldFramePlayerControls from '@/shared/viewport/WorldFramePlayerControls.vue'
import WorldFrameScrubber from '@/shared/viewport/WorldFrameScrubber.vue'
import MultiblockChannelPanel from '@/shared/viewport/MultiblockChannelPanel.vue'
import type { MultiblockChannelPanelModel } from '@/shared/viewport/multiblockChannelUi'
import type { ViewportDockTab } from '@/shared/viewport/dockTabs'

const props = withDefaults(defineProps<{
  theme?: 'embed' | 'workbench'
  showFrameTab?: boolean
  showLayerTab?: boolean
  hasWorldMultiFrame: boolean
  worldFrameIndex: number
  worldFrameCount: number
  /**
   * 时间是否在前进（**呈现输入**）。
   *
   * ## 为什么这个 prop 不叫 `framesPlaybackIsPlaying`（P10 #261 改名）
   *
   * 旧名字与**被删除的权威字段**（`Main.framesPlaybackIsPlaying`）逐字同名。
   * 那不只是"名字撞了"——它让退役审计的判据（按标识符扫描）无法区分
   * "旧权威还在"与"某组件恰好用了同一个词描述自己的显示状态"。
   * 一个**呈现**输入不该借用**领域权威**的名字：本组件只关心
   * "要不要把播放按钮画成按下态"，它不拥有、也不判定"时间在不在走"。
   *
   * 改名后判据可以干净地归零，而本组件的行为一字未变。
   */
  isPlaying: boolean
  meshBusy: boolean
  gridHeight: number
  layerWorldY: number
  layerPreviewLabel: string
  /**
   * 「通道」面板模型（`null`/缺省 = 非多方块文档 ⇒ 通道 tab 不出现）。
   * 由 `useMultiblockChannels` 组装，本组件只负责呈现与转发事件（叶子组件约定）。
   */
  channelPanel?: MultiblockChannelPanelModel | null
}>(), {
  theme: 'workbench',
  showFrameTab: true,
  showLayerTab: true,
  channelPanel: null,
})

const activeTab = defineModel<ViewportDockTab>('activeTab', { required: true })

const showFramePanel = computed(
  () => props.showFrameTab && props.hasWorldMultiFrame && activeTab.value === 'frame',
)
const showLayerPanel = computed(
  () => props.showLayerTab && activeTab.value === 'layer',
)
const showChannelsTab = computed(() => props.channelPanel !== null && props.channelPanel !== undefined)
const channelsModel = computed(() => (activeTab.value === 'channels' && showChannelsTab.value
  ? props.channelPanel as MultiblockChannelPanelModel
  : null))
/** 状态区一行摘要：通道条数 · Tier · 运行态呈现名（呈现名来自文件声明） */
const channelStatus = computed(() => {
  const m = props.channelPanel
  if (!m) return null
  const runstateName = m.runstates.find(r => r.id === m.runstate)?.name ?? m.runstate
  return { count: m.channels.length, tier: m.tier, runstateName }
})

const emit = defineEmits<{
  setFrame: [index: number]
  togglePlayback: []
  'update:layerY': [y: number]
  setTier: [value: number]
  setChannelValue: [payload: { key: string; value: number }]
  setRunstate: [id: string]
}>()
</script>

<template>
  <div class="vp-dock" :class="`vp-dock--${theme}`">
    <div class="vp-dock__tab-row">
      <button
        v-if="showChannelsTab"
        type="button"
        class="vp-dock__tab"
        :class="{ 'vp-dock__tab--active': activeTab === 'channels' }"
        data-dock-tab="channels"
        @click="activeTab = 'channels'"
      >通道</button>
      <button
        v-if="showFrameTab && hasWorldMultiFrame"
        type="button"
        class="vp-dock__tab"
        :class="{ 'vp-dock__tab--active': activeTab === 'frame' }"
        data-dock-tab="frame"
        @click="activeTab = 'frame'"
      >帧控制</button>
      <button
        v-if="showLayerTab"
        type="button"
        class="vp-dock__tab"
        :class="{ 'vp-dock__tab--active': activeTab === 'layer' }"
        data-dock-tab="layer"
        @click="activeTab = 'layer'"
      >分层预览</button>
      <div class="vp-dock__tab-status">
        <!-- 既有状态在前：`[data-mb-status]` 是新增观测点，但**不得**改变既有
             `.vp-dock__stat` 的文档顺序（`.first()` 仍应是「帧」/「层」，T2.6 harness 依赖） -->
        <span v-if="showFrameTab && hasWorldMultiFrame" class="vp-dock__stat">
          帧 <strong>{{ worldFrameIndex + 1 }}/{{ worldFrameCount }}</strong>
        </span>
        <span v-if="showLayerTab" class="vp-dock__stat">
          层 <strong>{{ layerPreviewLabel }}</strong>
        </span>
        <span v-if="channelStatus" class="vp-dock__stat" data-mb-status>
          通道 <strong>{{ channelStatus.count }}</strong>
          · Tier <strong>{{ channelStatus.tier }}</strong>
          · <strong>{{ channelStatus.runstateName }}</strong>
        </span>
      </div>
    </div>
    <div v-if="channelsModel" class="vp-dock__panel vp-dock__panel--channels" data-dock-panel="channels">
      <MultiblockChannelPanel
        :model="channelsModel"
        @update:tier="emit('setTier', $event)"
        @update:value="emit('setChannelValue', $event)"
        @update:runstate="emit('setRunstate', $event)"
      />
    </div>
    <div v-if="showFramePanel" class="vp-dock__panel vp-dock__panel--active">
      <WorldFramePlayerControls
        :has-world-multi-frame="hasWorldMultiFrame"
        :is-playing="isPlaying"
        @toggle="emit('togglePlayback')"
      />
      <WorldFrameScrubber
        :has-world-multi-frame="hasWorldMultiFrame"
        :frame-count="worldFrameCount"
        :is-playing="isPlaying"
        :mesh-busy="meshBusy"
        :world-frame-index="worldFrameIndex"
        @toggle-playback="emit('togglePlayback')"
        @set-frame="emit('setFrame', $event)"
      />
    </div>
    <div v-if="showLayerPanel" class="vp-dock__panel vp-dock__panel--active">
      <LayerPreviewBar
        :grid-height="gridHeight"
        :mesh-busy="meshBusy"
        :layer-world-y="layerWorldY"
        :layer-preview-label="layerPreviewLabel"
        @update:layer-y="emit('update:layerY', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.vp-dock { flex-shrink: 0; width: 100%; display: flex; flex-direction: column; }
.vp-dock--embed {
  border: var(--nei-bevel-w) solid;
  border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow);
  border-top: none;
  background: var(--nei-inset-bg);
}
.vp-dock--workbench {
  background: var(--wb-bg-elevated);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.12);
}
.vp-dock__tab-row {
  display: flex; align-items: center; padding: 0 4px;
}
.vp-dock--embed .vp-dock__tab-row {
  background: var(--nei-bg-deep);
  border-bottom: 1px solid var(--nei-shadow);
  box-shadow: 0 1px 0 var(--nei-highlight);
}
.vp-dock--workbench .vp-dock__tab-row {
  background: var(--wb-bg-surface);
  border-bottom: 1px solid var(--wb-border);
}
.vp-dock__tab {
  padding: 6px 14px 5px; font-weight: 600;
  background: none; border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer; user-select: none; white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
}
.vp-dock--embed .vp-dock__tab {
  font-size: 11px; font-family: var(--nei-font-mono);
  color: var(--nei-text-muted);
}
.vp-dock--embed .vp-dock__tab:hover { color: var(--nei-text); }
.vp-dock--embed .vp-dock__tab--active {
  color: var(--nei-text);
  border-bottom-color: var(--nei-accent);
}
.vp-dock--workbench .vp-dock__tab {
  font-size: 12px; font-family: system-ui, sans-serif;
  color: var(--wb-text-muted);
}
.vp-dock--workbench .vp-dock__tab:hover { color: var(--wb-text); }
.vp-dock--workbench .vp-dock__tab--active {
  color: var(--wb-text);
  border-bottom-color: var(--wb-accent);
}
.vp-dock__tab-status {
  margin-left: auto; display: flex; align-items: center; gap: 14px;
  padding: 0 10px; flex-shrink: 0;
}
.vp-dock--embed .vp-dock__tab-status {
  font-size: 11px; font-family: var(--nei-font-mono);
  color: var(--nei-text-muted);
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
}
.vp-dock--workbench .vp-dock__tab-status {
  font-size: 12px; font-family: system-ui, sans-serif;
  color: var(--wb-text-muted);
}
.vp-dock__stat strong { font-weight: 600; }
.vp-dock--embed .vp-dock__stat strong { color: var(--nei-text); }
.vp-dock--workbench .vp-dock__stat strong { color: var(--wb-text); }
.vp-dock__panel {
  display: flex; width: 100%; box-sizing: border-box;
  padding: 6px 10px; align-items: center; gap: 10px;
}
.vp-dock--embed .vp-dock__panel { height: 48px; background: var(--nei-inset-bg); }
.vp-dock--workbench .vp-dock__panel { height: 40px; background: var(--wb-bg-elevated); }
/* 通道面板：内容高度随声明条数增长（视口下方栏按需变高，超过上限内部滚动） */
.vp-dock__panel--channels {
  height: auto; min-height: 40px; max-height: 152px;
  align-items: stretch; overflow-y: auto;
}
.vp-dock--embed .vp-dock__panel--channels { min-height: 48px; }
.vp-dock__panel :deep(.wm-wfs),
.vp-dock__panel :deep(.wm-wfp-controls),
.vp-dock__panel :deep(.wm-layer-bar) {
  flex: 1; min-width: 0; background: transparent; border: none; padding: 0;
}
[data-nei-theme="light"] .vp-dock--embed .vp-dock__panel :deep(.wm-layer-label),
[data-nei-theme="light"] .vp-dock--embed .vp-dock__panel :deep(.wm-wfs__label) {
  color: #e0e0e0;
}
</style>
