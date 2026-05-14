<script setup lang="ts">
/**
 * PS 风格菜单栏：File / Edit / View / Help
 */
import { ref } from 'vue'
import { useBContext } from '@/workbench/context/bContext'
import { t, setLang, currentLang } from '@/workbench/i18n'
import { useNeiTheme } from '@/workbench/composables/useNeiTheme'

const { theme, toggleTheme } = useNeiTheme()

const bctx = useBContext()

defineProps<{ editMode?: boolean }>()

const emit = defineEmits<{
  (e: 'open-settings'): void
  (e: 'reset-layout'): void
}>()

const openMenu = ref<string | null>(null)
const lang = currentLang
const fileInput = ref<HTMLInputElement | null>(null)

function switchLang(v: 'zh' | 'en'): void {
  setLang(v)
  closeMenu()
}

function toggleMenu(menu: string): void {
  openMenu.value = openMenu.value === menu ? null : menu
}
function closeMenu(): void { openMenu.value = null }

async function openSceneFile(): Promise<void> {
  closeMenu()
  if (bctx.scene.dirty.value) {
    const ok = window.confirm('当前场景有未保存的修改，是否保存？')
    if (ok) {
      await bctx.operators.exec('OPERATOR_SAVE_FILE')
    }
  }
  fileInput.value?.click()
}

async function newSceneFile(): Promise<void> {
  closeMenu()
  if (bctx.scene.dirty.value) {
    const ok = window.confirm('当前场景有未保存的修改，是否保存？')
    if (ok) await bctx.operators.exec('OPERATOR_SAVE_FILE')
  }
  await bctx.operators.exec('OPERATOR_NEW_SCENE')
}

async function onSceneFileSelected(): Promise<void> {
  const file = fileInput.value?.files?.[0]
  if (!file) return
  await bctx.operators.exec('OPERATOR_OPEN_SCENE', { file })
  if (fileInput.value) fileInput.value.value = ''
}

function onMenuAction(action: string): void {
  closeMenu()
  switch (action) {
    case 'save-file': void bctx.operators.exec('OPERATOR_SAVE_FILE'); break
    case 'reset-layout': emit('reset-layout'); break
  }
}
</script>

<template>
  <div class="mb-root" @mouseleave="closeMenu">
    <div class="mb-left">
      <div class="mb-item" @mouseenter="toggleMenu('file')">
        <span class="mb-label">{{ t('file') }}</span>
        <div v-if="openMenu === 'file'" class="mb-dropdown">
          <button class="mb-dd-item" @click="newSceneFile">{{ t('newFile') }}</button>
          <button class="mb-dd-item" @click="openSceneFile">{{ t('openScene') }}</button>
          <button class="mb-dd-item" @click="onMenuAction('save-file')">{{ t('saveToFile') }}</button>
        </div>
      </div>
      <div class="mb-item" @mouseenter="toggleMenu('edit')">
        <span class="mb-label">{{ t('edit') }}</span>
        <div v-if="openMenu === 'edit'" class="mb-dropdown">
          <div class="mb-dd-section">{{ t('language') }}</div>
          <button class="mb-dd-item" :class="{ 'mb-dd-item--checked': lang === 'zh' }" @click="switchLang('zh')">
            <span class="mb-check">{{ lang === 'zh' ? '✓' : '' }}</span>{{ t('chinese') }}
          </button>
          <button class="mb-dd-item" :class="{ 'mb-dd-item--checked': lang === 'en' }" @click="switchLang('en')">
            <span class="mb-check">{{ lang === 'en' ? '✓' : '' }}</span>{{ t('english') }}
          </button>
        </div>
      </div>
      <div class="mb-item" @mouseenter="toggleMenu('view')">
        <span class="mb-label">{{ t('view') }}</span>
        <div v-if="openMenu === 'view'" class="mb-dropdown">
          <button class="mb-dd-item" @click="onMenuAction('reset-layout')">{{ t('resetLayout') }}</button>
        </div>
      </div>
      <span class="mb-label mb-disabled">{{ t('help') }}</span>
    </div>
    <div class="mb-right">
      <button class="mb-theme-btn" :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'" @click="toggleTheme">
        {{ theme === 'dark' ? '☀' : '☾' }}
      </button>
      <span class="mb-status-dot" :class="bctx.connection.connected.value ? 'mb-online' : 'mb-offline'" />
      <span class="mb-status-label">{{ bctx.connection.connected.value ? t('connected') : t('offline') }}</span>
    </div>
    <input ref="fileInput" type="file" accept=".json" class="mb-file-input" @change="onSceneFileSelected" />
  </div>
</template>

<style scoped>
.mb-root {
  display: flex; align-items: center; justify-content: space-between;
  height: 100%; padding: 0 6px; font-size: 12px;
}
.mb-left, .mb-right { display: flex; align-items: center; gap: 0; }
.mb-item { position: relative; }
.mb-label {
  padding: 3px 10px; border-radius: 4px; cursor: pointer;
  user-select: none; color: var(--nei-label); display: inline-block;
}
.mb-label:hover { background: var(--nei-panel-hover); }
.mb-disabled { color: var(--nei-muted); cursor: default; }
.mb-disabled:hover { background: transparent; }
.mb-dropdown {
  position: absolute; top: 100%; left: 0; z-index: 1000;
  min-width: 180px; padding: 4px;
  background: var(--nei-dropdown-bg); border: 1px solid var(--nei-border); border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.mb-dd-section {
  padding: 4px 10px 2px; font-size: 10px; text-transform: uppercase;
  color: var(--nei-muted); letter-spacing: 0.5px;
}
.mb-dd-item {
  display: flex; align-items: center; gap: 4px;
  width: 100%; padding: 5px 10px; border: none;
  background: transparent; color: var(--nei-text-dark); font-size: 12px;
  text-align: left; cursor: pointer; border-radius: 3px;
}
.mb-dd-item:hover { background: var(--nei-dropdown-hover); color: #fff; }
.mb-check { width: 14px; font-size: 10px; color: var(--nei-check); }
.mb-status-dot { width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; }
.mb-online { background: var(--nei-online); box-shadow: 0 0 4px var(--nei-online); }
.mb-offline { background: var(--nei-offline); }
.mb-status-label { font-size: 11px; color: var(--nei-muted); }
.mb-theme-btn {
  width: 22px; height: 22px; border: var(--nei-bevel-w) solid;
  border-color: var(--nei-highlight) var(--nei-shadow) var(--nei-shadow) var(--nei-highlight);
  background: var(--nei-bg); color: var(--nei-text-dark); font-size: 12px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  border-radius: 2px; margin-right: 8px; padding: 0; line-height: 1;
}
.mb-theme-btn:hover { background: var(--nei-panel-hover); }
.mb-file-input { display: none; }
</style>
