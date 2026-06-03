<script setup lang="ts">
/**
 * EmbedSettingsPanel — 视口设置浮层面板
 *
 * 从 EmbedViewport.vue 提取，职责单一：
 * - 展示偏好设置选项（高亮、提示框、偏移量、注解）
 * - 通过 prefs prop 直接双向绑定
 */

import type { ViewerPreferences } from '@/viewer/preferences'

defineProps<{
  show: boolean
  prefs: ViewerPreferences
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <Transition name="fade">
    <div v-if="show" class="wm-settings-overlay" @click.self="emit('close')">
      <div class="wm-settings-panel">
        <div class="wm-settings-head">
          <span>视口设置</span>
          <button class="wm-settings-close" @click="emit('close')">✕</button>
        </div>
        <div class="wm-settings-body">
          <label class="wm-settings-row">
            <span class="wm-settings-label">鼠标悬浮高亮方块</span>
            <input type="checkbox" v-model="prefs.highlightOnHover" />
          </label>
          <label class="wm-settings-row">
            <span class="wm-settings-label">鼠标悬浮显示物品名称</span>
            <input type="checkbox" v-model="prefs.showHoverTooltip" />
          </label>
          <label class="wm-settings-row">
            <span class="wm-settings-label">提示框距光标偏移 {{ prefs.tooltipOffset }}px</span>
            <input type="range" min="4" max="48" v-model.number="prefs.tooltipOffset" />
          </label>
          <label class="wm-settings-row">
            <span class="wm-settings-label">显示注解层</span>
            <input type="checkbox" v-model="prefs.showAnnotations" />
          </label>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }

.wm-settings-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
}
.wm-settings-panel {
  background: var(--nei-bg-deep);
  border: var(--nei-bevel-w) solid;
  border-color: var(--nei-bevel-light) var(--nei-bevel-dark) var(--nei-bevel-dark) var(--nei-bevel-light);
  min-width: 280px; max-width: 400px;
  font-family: var(--nei-font-mono); font-size: 12px; color: var(--nei-text);
}
.wm-settings-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  background: var(--nei-bg-panel);
  border-bottom: 1px solid var(--nei-shadow);
  box-shadow: 0 1px 0 var(--nei-highlight);
}
.wm-settings-close {
  border: none; background: none; color: var(--nei-icon-color); cursor: pointer;
  font-size: 14px; line-height: 1; padding: 2px 6px;
}
.wm-settings-close:hover { color: var(--nei-text); }
.wm-settings-body { padding: 16px; }
.wm-settings-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 0; cursor: pointer; user-select: none;
}
.wm-settings-row + .wm-settings-row { border-top: 1px solid var(--nei-border-subtle); }
.wm-settings-label { font-size: 13px; color: var(--nei-text); }
.wm-settings-row input[type="checkbox"] {
  width: 16px; height: 16px; cursor: pointer; accent-color: var(--nei-accent);
}
.wm-settings-hint { margin: 0; color: var(--nei-text-dim); }
</style>
