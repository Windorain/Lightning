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
  background: var(--nei-drawer-backdrop);
  pointer-events: auto;
}
.drawer-panel {
  position: relative;
  width: min(420px, 100vw);
  height: 100%;
  background: var(--nei-bg);
  border-left: 1px solid var(--nei-border);
  box-shadow: var(--nei-drawer-shadow);
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  animation: drawer-in 0.18s ease-out;
}
@keyframes drawer-in {
  from { transform: translateX(100%); opacity: 0.9; }
  to { transform: translateX(0); opacity: 1; }
}
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--nei-border);
  flex-shrink: 0;
}
.drawer-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--nei-text);
}
.drawer-close {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: var(--nei-bg-deep);
  color: var(--nei-muted);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.drawer-close:hover {
  background: var(--nei-panel-hover);
  color: var(--nei-text);
}
.drawer-body {
  flex: 1;
  overflow: auto;
  padding: 16px 18px 28px;
}
.drawer-section {
  margin-bottom: 20px;
}
.drawer-h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--nei-label);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.drawer-lead {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--nei-muted);
}
.seg {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.seg__btn {
  flex: 1;
  min-width: 100px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--nei-seg-off-border);
  background: var(--nei-seg-off-bg);
  color: var(--nei-seg-off-text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.seg__btn:hover {
  border-color: var(--nei-border);
}
.seg__btn--on {
  border-color: var(--nei-seg-on-border);
  background: var(--nei-seg-on-bg);
  color: var(--nei-seg-on-text);
}
.drawer-stack {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.drawer-stack :deep(.dash-card) {
  margin-bottom: 12px;
}
.drawer-stack :deep(.dash-card:last-child) {
  margin-bottom: 0;
}
</style>
