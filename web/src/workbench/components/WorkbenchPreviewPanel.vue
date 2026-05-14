<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import EmbedViewer from '@/embed/EmbedViewer.vue'
import { useBContext } from '@/workbench/context/bContext'

const PREVIEW_H_STORAGE = 'wmsr-workbench-preview-h'
const PREVIEW_H_DEFAULT = 520
const PREVIEW_H_MIN = 260

const bctx = useBContext()

const scene = computed(() => bctx.scene.scene.value)
const previewBusy = computed(() => bctx.scene.previewBusy.value)
const previewErrorText = computed(() => bctx.scene.previewError.value)
const previewCfg = computed(() => bctx.scene.previewConfig.value)
const previewKey = computed(() => bctx.scene.previewEpoch.value)

function clampPreviewHeight(h: number): number {
  const max =
    typeof window !== 'undefined' ? Math.min(2400, Math.max(PREVIEW_H_MIN + 80, window.innerHeight - 40)) : 2400
  return Math.min(max, Math.max(PREVIEW_H_MIN, Math.round(h)))
}

function readStoredPreviewHeight(): number {
  if (typeof window === 'undefined') return PREVIEW_H_DEFAULT
  const raw = localStorage.getItem(PREVIEW_H_STORAGE)
  const n = raw ? parseInt(raw, 10) : NaN
  return clampPreviewHeight(Number.isFinite(n) ? n : PREVIEW_H_DEFAULT)
}

const previewHeightPx = ref(PREVIEW_H_DEFAULT)

onMounted(() => {
  previewHeightPx.value = readStoredPreviewHeight()
})

async function onRetrySync(): Promise<void> {
  await bctx.operators.exec('OPERATOR_SYNC_PREVIEW')
}

function persistPreviewHeight(): void {
  try {
    localStorage.setItem(PREVIEW_H_STORAGE, String(previewHeightPx.value))
  } catch {
    /* ignore */
  }
}

function onResizeHandlePointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  e.preventDefault()
  const startY = e.clientY
  const startH = previewHeightPx.value
  const move = (ev: PointerEvent): void => {
    previewHeightPx.value = clampPreviewHeight(startH + (ev.clientY - startY))
  }
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    persistPreviewHeight()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function onResizeHandleDblClick(): void {
  previewHeightPx.value = clampPreviewHeight(PREVIEW_H_DEFAULT)
  persistPreviewHeight()
}
</script>

<template>
  <section class="wm-preview">
    <p
      v-if="scene && previewErrorText && previewCfg"
      class="wm-preview-banner"
      role="status"
    >
      {{ previewErrorText }}
      <button type="button" class="wm-btn-inline" @click="onRetrySync">重试同步</button>
    </p>

    <div v-if="!scene" class="wm-boot wm-boot--muted wm-boot--tall">
      请先在右上角「设置」中加载场景（本机 / SDE / 示例）；须含 textureBlobs 与 baked 几何以预览。
    </div>

    <div v-else-if="!previewCfg && previewErrorText" class="wm-boot wm-boot--err wm-boot--tall">
      <p>{{ previewErrorText }}</p>
      <button type="button" class="wm-btn" @click="onRetrySync">重试</button>
    </div>

    <div v-else-if="!previewCfg" class="wm-boot wm-boot--tall">正在从内存中的场景数据构建三维预览…</div>

    <template v-else>
      <div class="wm-preview-resize-root" :style="{ height: `${previewHeightPx}px` }">
        <div class="wm-preview-embed" :class="{ 'wm-preview-embed--busy': previewBusy }">
          <EmbedViewer :key="`pv-${previewKey}`" :merged-config="previewCfg" />
          <div v-if="previewBusy" class="wm-preview-veil" aria-hidden="true" />
        </div>
        <div
          class="wm-preview-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整预览区域高度，双击恢复默认"
          title="拖动调整高度 · 双击恢复默认"
          @pointerdown="onResizeHandlePointerDown"
          @dblclick="onResizeHandleDblClick"
        />
      </div>
    </template>
  </section>
</template>

<style scoped>
.wm-preview {
  background: var(--nei-bg);
  border-radius: 8px;
  border: 1px solid var(--nei-border);
  overflow: hidden;
  position: relative;
}
.wm-preview-banner {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--nei-error-text);
  background: var(--nei-error-bg);
  border-bottom: 1px solid var(--nei-error-border);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.wm-btn-inline {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--nei-muted);
  background: var(--nei-border);
  color: var(--nei-text);
  cursor: pointer;
}
.wm-preview-resize-root {
  display: flex;
  flex-direction: column;
  min-height: 260px;
  box-sizing: border-box;
}
.wm-preview-embed {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* AppShell 根与主舞台填满剩余高度，Three 视口随容器 ResizeObserver 更新 */
.wm-preview-embed :deep(.wm-root) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.wm-preview-embed :deep(.wm-main-stage) {
  flex: 1;
  min-height: 0;
}
.wm-preview-embed :deep(.wm-viewport-column) {
  flex: 1;
  min-height: 0;
}
/* 视口在列 flex+min-h-0 链上不能再用 min-h:0，否则常把 canvas 压到 0 高；亦勿用 !important 盖掉子组件的 min-height */
.wm-preview-embed :deep(.wm-viewport) {
  flex: 1 1 0;
  min-height: 240px;
  min-width: 0;
  position: relative;
  height: auto;
}
.wm-preview-resize-handle {
  flex-shrink: 0;
  height: 10px;
  cursor: ns-resize;
  background: linear-gradient(180deg, var(--nei-bg-deep) 0%, var(--nei-border) 45%, var(--nei-panel-hover) 100%);
  border-top: 1px solid var(--nei-muted);
  touch-action: none;
  user-select: none;
}
.wm-preview-resize-handle:hover {
  filter: brightness(1.08);
}
.wm-preview-resize-handle:active {
  filter: brightness(1.15);
}
.wm-preview-embed--busy {
  pointer-events: none;
  opacity: 0.65;
  transition: opacity 0.12s;
}
.wm-preview-veil {
  position: absolute;
  inset: 0;
  background: var(--nei-bg);
  z-index: 2;
  pointer-events: none;
}
.wm-boot {
  padding: 16px;
  font-family: system-ui, sans-serif;
  color: var(--nei-text-dark);
}
.wm-boot--tall {
  min-height: 50vh;
}
.wm-boot--err {
  color: var(--nei-error-text);
  white-space: pre-wrap;
}
.wm-boot--muted {
  color: var(--nei-label);
}
.wm-btn {
  margin-top: 8px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--nei-muted);
  background: var(--nei-border);
  color: var(--nei-text);
  cursor: pointer;
  font-size: 12px;
}
</style>
