<script setup lang="ts">
import { ref } from 'vue'
import { useSceneContext } from '@/workbench/sceneContext'
import { useBContext } from '@/workbench/context/bContext'
import { FLOOR_TEMPLATES } from '@/workbench/context/toolSettings'

const scene = useSceneContext()
const bctx = useBContext()

const activeTab = ref<'palette' | 'floor'>('palette')

const paletteEntries = ref<string[]>([])
function refreshPalette(): void {
  const doc = scene.scene.value as any
  if (!doc?.block_palette) { paletteEntries.value = []; return }
  paletteEntries.value = Object.keys(doc.block_palette)
}
refreshPalette()

function selectType(id: string): void {
  bctx.settings.generateType = id
  bctx.settings.replaceBrush = id
}

function selectFloor(templateId: string): void {
  bctx.settings.generateType = templateId
}
</script>

<template>
  <div class="generate-panel">
    <h4 class="gp-heading">Generate</h4>
    <div class="gp-tabs">
      <button class="gp-tab" :class="{ 'gp-tab--active': activeTab === 'palette' }" @click="activeTab = 'palette'">Palette</button>
      <button class="gp-tab" :class="{ 'gp-tab--active': activeTab === 'floor' }" @click="activeTab = 'floor'">Floor</button>
    </div>

    <div v-if="activeTab === 'palette'" class="gp-list">
      <button
        v-for="id in paletteEntries" :key="id"
        class="gp-item"
        :class="{ 'gp-item--active': bctx.settings.generateType === id || bctx.settings.replaceBrush === id }"
        @click="selectType(id)"
      >
        {{ id }}
      </button>
      <div v-if="paletteEntries.length === 0" class="gp-empty">No blocks in palette</div>
    </div>

    <div v-if="activeTab === 'floor'" class="gp-list">
      <button
        v-for="tmpl in FLOOR_TEMPLATES" :key="tmpl.id"
        class="gp-item"
        :class="{ 'gp-item--active': bctx.settings.generateType === tmpl.id }"
        @click="selectFloor(tmpl.id)"
      >
        <span class="gp-swatch" :style="{ background: tmpl.color.includes('/') ? 'repeating-conic-gradient(#fff 0% 25%, #000 0% 50%) 0 / 12px 12px' : tmpl.color }" />
        {{ tmpl.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.generate-panel { padding: 8px; font-size: 12px; color: var(--nei-text-dark); display: flex; flex-direction: column; height: 100%; }
.gp-heading { margin: 0 0 4px; font-size: 12px; font-weight: 600; flex-shrink: 0; }
.gp-tabs { display: flex; gap: 2px; margin-bottom: 4px; flex-shrink: 0; }
.gp-tab { padding: 2px 8px; border: none; background: transparent; color: var(--nei-muted);
  font-size: 11px; cursor: pointer; border-radius: 3px; }
.gp-tab--active { background: var(--nei-dropdown-hover); color: #fff; }
.gp-list { flex: 1; overflow-y: auto; }
.gp-item {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 3px 8px; border: none; background: transparent;
  color: var(--nei-text-dark); font-size: 11px; text-align: left;
  cursor: pointer; border-radius: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gp-item:hover { background: var(--nei-panel-hover); }
.gp-item--active { background: var(--nei-dropdown-hover); color: #fff; }
.gp-empty { padding: 8px; color: var(--nei-muted); text-align: center; }
.gp-swatch { width: 14px; height: 14px; border-radius: 2px; border: 1px solid var(--nei-border); flex-shrink: 0; }
</style>
