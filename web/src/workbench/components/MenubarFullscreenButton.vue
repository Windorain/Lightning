<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '@/config/i18n'

const isFullscreen = ref(false)
const supported = ref(false)

function fullscreenTarget(): HTMLElement | null {
  const app = document.getElementById('wsr-workbench-app')
  if (!app) return null
  const layer = app.closest('.wsw-overlay-layer')
  if (layer instanceof HTMLElement) return layer
  const shell = app.closest('.wb-shell')
  if (shell instanceof HTMLElement) return shell
  return app
}

function syncFullscreenState(): void {
  isFullscreen.value = !!document.fullscreenElement
}

async function toggleFullscreen(): Promise<void> {
  const el = fullscreenTarget()
  if (!el) return
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else if (el.requestFullscreen) {
      await el.requestFullscreen()
    }
  } catch {
    /* 用户取消或浏览器策略拒绝 */
  }
}

onMounted(() => {
  supported.value = typeof document.documentElement.requestFullscreen === 'function'
  syncFullscreenState()
  document.addEventListener('fullscreenchange', syncFullscreenState)
})

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFullscreenState)
})
</script>

<template>
  <button
    v-if="supported"
    type="button"
    class="wb-menubar-fullscreen-btn"
    :title="isFullscreen ? t('exitFullscreen') : t('fullscreen')"
    :aria-pressed="isFullscreen"
    @click="toggleFullscreen"
  >
    {{ isFullscreen ? t('exitFullscreen') : t('fullscreen') }}
  </button>
</template>

<style scoped>
.wb-menubar-fullscreen-btn {
  margin-left: auto;
  flex-shrink: 0;
  border: 1px solid var(--wb-border);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  padding: 4px 10px;
  font-size: 12px;
  border-radius: var(--wb-radius-sm, 4px);
  cursor: pointer;
}
.wb-menubar-fullscreen-btn:hover {
  background: var(--wb-bg-hover);
  border-color: var(--wb-accent);
  color: var(--wb-accent-muted, var(--wb-text));
}
</style>
