<script setup lang="ts">
/**
 * 右侧属性面板：Blender 风格的编辑器容器。
 * 顶部下拉切换编辑器类型；KeepAlive 缓存各编辑器状态。
 * 可通过 editors prop 自定义可用编辑器列表。
 */
import { computed, ref, type Component } from 'vue'
import { t } from '@/workbench/i18n'
import BlockInspector from './BlockInspector.vue'
import TooltipEditor from './TooltipEditor.vue'
import BlockStatsEditor from './BlockStatsEditor.vue'
import SceneInfoEditor from './SceneInfoEditor.vue'
import WikiConfigEditor from './WikiConfigEditor.vue'

interface EditorEntry {
  id: string
  comp: Component
  i18nKey: string
}

const props = defineProps<{
  editors?: 'editor' | 'wiki'
}>()

const ALL_EDITORS: Record<string, EditorEntry[]> = {
  editor: [
    { id: 'inspector', comp: BlockInspector, i18nKey: 'blockInspector' },
    { id: 'tooltip', comp: TooltipEditor, i18nKey: 'tooltipEditor' },
    { id: 'stats', comp: BlockStatsEditor, i18nKey: 'blockStats' },
  ],
  wiki: [
    { id: 'scene', comp: SceneInfoEditor, i18nKey: 'sceneInfo' },
    { id: 'config', comp: WikiConfigEditor, i18nKey: 'wikiConfig' },
    { id: 'stats', comp: BlockStatsEditor, i18nKey: 'blockStats' },
  ],
}

const editors = computed(() => ALL_EDITORS[props.editors ?? 'editor'] ?? ALL_EDITORS.editor)
const activeEditorId = ref(editors.value[0]?.id ?? '')
const activeEditor = computed<Component>(() => editors.value.find(e => e.id === activeEditorId.value)?.comp ?? editors.value[0]!.comp)
</script>

<template>
  <div class="pp-root">
    <div class="pp-header">
      <select v-model="activeEditorId" class="pp-editor-select">
        <option v-for="ed in editors" :key="ed.id" :value="ed.id">{{ t(ed.i18nKey) }}</option>
      </select>
    </div>
    <div class="pp-body">
      <KeepAlive>
        <component :is="activeEditor" />
      </KeepAlive>
    </div>
  </div>
</template>

<style scoped>
.pp-root { display: flex; flex-direction: column; height: 100%; }
.pp-header { flex-shrink: 0; padding: 6px 8px; border-bottom: 1px solid var(--nei-border); }
.pp-editor-select { width: 100%; padding: 4px 6px; border-radius: 4px; border: var(--nei-bevel-w) solid; border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow); background: var(--nei-inset-bg); color: var(--nei-text); font-size: 12px; }
.pp-body { flex: 1; overflow-y: auto; }
</style>
