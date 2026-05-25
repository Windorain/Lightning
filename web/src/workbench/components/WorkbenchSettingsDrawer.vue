<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, type Ref } from 'vue'

import ExportsListPanel from '@/workbench/components/ExportsListPanel.vue'
import LocalBundlePanel from '@/workbench/components/LocalBundlePanel.vue'
import LocalFilePanel from '@/workbench/components/LocalFilePanel.vue'
import SdeConnectionPanel from '@/workbench/components/SdeConnectionPanel.vue'
import { listDevSceneIds } from '@/dev/devScenes'
import type { WorkbenchWorkspaceMode } from '@/workbench/context/bContext'
import { useBContext } from '@/workbench/context/bContext'

const bctx = useBContext()
const settingsOpen = inject<Ref<boolean>>('workbenchSettingsOpen')!

const open = computed(() => settingsOpen.value)
const mode = computed(() => bctx.workspaceMode.value)
const builtinSceneCount = computed(() => listDevSceneIds().length)
const showBuiltin = computed(() => builtinSceneCount.value > 0)

function close(): void {
  settingsOpen.value = false
}

function pickMode(m: WorkbenchWorkspaceMode): void {
  bctx.operators.exec('OPERATOR_SET_WORKSPACE_MODE', { mode: m })
  bctx.connectionConnected.value = null
  bctx.connectionExports.value = []
  bctx.connectionExportsLoading.value = false
  bctx.connectionSelectedExportName.value = null
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="open" class="drawer-root">
        <div class="drawer-backdrop" aria-hidden="true" @click="close" />
        <aside class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
          <header class="drawer-head">
            <h2 id="drawer-title" class="drawer-title">设置</h2>
            <button type="button" class="drawer-close" aria-label="关闭" @click="close">×</button>
          </header>

          <div class="drawer-body">
            <section class="drawer-section">
              <h3 class="drawer-h3">数据源</h3>
              <p class="drawer-lead">选择文档来源；切换会清空当前文档与连接状态。</p>
              <div class="seg" role="group" aria-label="数据源类型">
                <button
                  type="button"
                  class="seg__btn"
                  :class="{ 'seg__btn--on': mode === 'sde' }"
                  @click="pickMode('sde')"
                >
                  SDE 远程
                </button>
                <button
                  type="button"
                  class="seg__btn"
                  :class="{ 'seg__btn--on': mode === 'local-file' }"
                  @click="pickMode('local-file')"
                >
                  本地文件
                </button>
                <button
                  v-if="showBuiltin"
                  type="button"
                  class="seg__btn"
                  :class="{ 'seg__btn--on': mode === 'local-bundle' }"
                  @click="pickMode('local-bundle')"
                >
                  内置示例
                </button>
              </div>
            </section>

            <div v-if="mode === 'sde'" class="drawer-stack">
              <SdeConnectionPanel />
              <ExportsListPanel />
            </div>
            <div v-else-if="mode === 'local-file'" class="drawer-stack">
              <LocalFilePanel />
            </div>
            <div v-else class="drawer-stack">
              <LocalBundlePanel />
            </div>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.drawer-root {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  justify-content: flex-end;
  pointer-events: none;
}
.drawer-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(2, 6, 23, 0.55);
  pointer-events: auto;
}
.drawer-panel {
  position: relative;
  width: min(420px, 100vw);
  height: 100%;
  background: var(--wb-bg-elevated);
  border-left: 1px solid var(--wb-border);
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

.drawer-enter-active,
.drawer-leave-active {
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease;
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--wb-border);
  flex-shrink: 0;
}
.drawer-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
}
.drawer-close {
  width: 28px; height: 28px;
  border: 1px solid var(--wb-border); border-radius: var(--wb-radius-md);
  background: var(--wb-bg-surface);
  color: var(--wb-text-muted); font-size: 16px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.drawer-close:hover { background: var(--wb-bg-hover); color: var(--wb-text); box-shadow: 0 0 12px rgba(77, 171, 247, 0.15); }
.drawer-body {
  flex: 1; overflow: auto; padding: 14px 16px 24px;
}
.drawer-section { margin-bottom: 16px; }
.drawer-h3 {
  margin: 0 0 8px; font-size: 9px; font-weight: 600; color: var(--wb-text-dim);
  text-transform: uppercase; letter-spacing: 0.8px;
}
.drawer-lead {
  margin: 0 0 10px; font-size: 11px; line-height: 1.5; color: var(--wb-text-muted);
}
.seg { display: flex; flex-wrap: wrap; gap: 6px; }
.seg__btn {
  flex: 1; min-width: 100px; padding: 8px 12px; border-radius: var(--wb-radius-md);
  border: 1px solid var(--wb-border); background: var(--wb-bg-surface);
  color: var(--wb-text-muted); font-size: 11px; font-weight: 500; cursor: pointer;
}
.seg__btn:hover { border-color: var(--wb-accent); }
.seg__btn--on {
  border-color: var(--wb-accent); background: var(--wb-bg-hover); color: var(--wb-accent);
}
.drawer-stack { display: flex; flex-direction: column; gap: 0; }
.drawer-stack :deep(.dash-card) { margin-bottom: 12px; }
.drawer-stack :deep(.dash-card:last-child) { margin-bottom: 0; }
</style>
