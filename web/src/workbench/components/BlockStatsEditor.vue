<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/workbench/i18n'
import { useSceneContext } from '@/workbench/sceneContext'
import { loadStructureOrWorld, isWorldDocument } from '@/render/data/bundleResolve'
import { buildBlockStatsEntries } from '@/render/interaction/blockStats'

const ctx = useSceneContext()

const entries = computed(() => {
  const doc = ctx.scene.value
  if (!doc) return []
  try {
    let def
    if (isWorldDocument(doc) && doc.frames.length > 0) {
      const st = (doc.frames[0] as Record<string, unknown>)?.structure
      def = st ? loadStructureOrWorld(st, undefined) : null
    } else {
      def = loadStructureOrWorld(doc, undefined)
    }
    if (!def) return []
    return buildBlockStatsEntries(def, 'all')
  } catch {
    return []
  }
})

defineEmits<{
  (e: 'hover-block', payload: { blockId: string; clientX: number; clientY: number } | null): void
}>()
</script>

<template>
  <div class="pe-panel">
    <div class="pe-title">{{ t('blockInspector') }}</div>
    <p v-if="entries.length === 0" class="pe-muted">无方块数据</p>
    <div v-else class="bs-list">
      <div
        v-for="row in entries" :key="row.blockId"
        class="bs-row"
      >
        <span class="bs-id">{{ row.blockId }}</span>
        <span class="bs-count">{{ row.count }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pe-panel { padding: 10px; font-size: 12px; }
.pe-title { font-size: 13px; font-weight: 600; color: var(--nei-text); text-shadow: var(--nei-label-shadow); margin-bottom: 8px; }
.pe-muted { font-size: 11px; color: var(--nei-muted); }
.bs-list { display: flex; flex-direction: column; gap: 2px; max-height: 360px; overflow-y: auto; }
.bs-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 6px; border-radius: 3px; background: var(--nei-bg); border: 1px solid var(--nei-border); }
.bs-id { font-family: ui-monospace, monospace; font-size: 11px; color: var(--nei-text-dark); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bs-count { font-family: ui-monospace, monospace; font-size: 11px; color: var(--nei-muted); margin-left: 8px; flex-shrink: 0; }
</style>
