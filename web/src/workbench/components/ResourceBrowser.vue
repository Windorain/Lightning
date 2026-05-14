<script setup lang="ts">
import { computed, ref } from 'vue'
import { useBContext } from '@/workbench/context/bContext'
import { usePanelState } from '@/workbench/panelState'
import { useSelectionContext } from '@/workbench/selectionContext'
import type { V2AnnotationBox, V2Label } from '@/render/data/sceneDocumentV2'

const bctx = useBContext()
const { highlightType, clearHighlight, pinType } = usePanelState()
const selection = useSelectionContext()

const searchQuery = ref('')
const selectedTab = ref<'blocks' | 'annotations' | 'labels' | 'frames'>('blocks')

interface TreeNode {
  id: string
  label: string
  count?: number
}

const tree = computed<TreeNode[]>(() => {
  const doc = bctx.scene.scene.value
  if (!doc) return []
  const q = searchQuery.value.toLowerCase()

  switch (selectedTab.value) {
    case 'annotations': {
      const annos = (doc as any).annotations as V2AnnotationBox[] | undefined
      return (annos ?? []).filter(a => !q || a.title.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
        .map(a => ({ id: a.id, label: a.title || a.id, count: undefined }))
    }
    case 'labels': {
      const lbs = (doc as any).labels as V2Label[] | undefined
      return (lbs ?? []).filter(l => !q || l.text.toLowerCase().includes(q))
        .map(l => ({ id: l.id, label: l.text || l.id, count: undefined }))
    }
    case 'frames': {
      const frames = (doc as any).frames ?? []
      return (frames as Array<any>).map((f: any, i: number) => ({ id: String(i), label: f.label || `Frame ${i}`, count: f.blocks?.length ?? 0 }))
    }
    case 'blocks':
    default: {
      const currentFrame = (doc as any).frames?.[selection.frameIndex.value ?? 0]
      const blocks = (currentFrame?.blocks ?? []) as Array<{ block_state_id: string }>
      const counts = new Map<string, number>()
      for (const b of blocks) counts.set(b.block_state_id, (counts.get(b.block_state_id) ?? 0) + 1)
      return [...counts.entries()]
        .filter(([id]) => !q || id.toLowerCase().includes(q))
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => ({ id, label: id, count: n }))
    }
  }
})

function onMouseEnter(id: string): void { highlightType(id) }
function onMouseLeave(): void { clearHighlight() }
function onClick(id: string): void { pinType(id) }
</script>

<template>
  <div class="resource-browser">
    <input v-model="searchQuery" class="rb-search" placeholder="Filter..." />
    <div class="rb-tabs">
      <button v-for="t in (['blocks','annotations','labels','frames'] as const)" :key="t"
        class="rb-tab" :class="{ 'rb-tab--active': selectedTab === t }" @click="selectedTab = t">
        {{ t }}
      </button>
    </div>
    <div class="rb-tree">
      <div v-for="node in tree" :key="node.id" class="rb-node"
        @mouseenter="onMouseEnter(node.id)" @mouseleave="onMouseLeave" @click="onClick(node.id)">
        <span class="rb-node__label">{{ node.label }}</span>
        <span v-if="node.count !== undefined" class="rb-node__count">{{ node.count }}</span>
      </div>
      <div v-if="tree.length === 0" class="rb-node rb-node--empty">No items</div>
    </div>
  </div>
</template>

<style scoped>
.resource-browser { padding: 8px; font-size: 12px; color: var(--nei-text-dark); display: flex; flex-direction: column; height: 100%; }
.rb-search { width: 100%; padding: 4px 8px; border: 1px solid var(--nei-border); border-radius: 4px;
  background: var(--nei-bg); color: var(--nei-text-dark); font-size: 12px; margin-bottom: 4px; flex-shrink: 0; }
.rb-tabs { display: flex; gap: 2px; margin-bottom: 4px; flex-shrink: 0; }
.rb-tab { padding: 2px 8px; border: none; background: transparent; color: var(--nei-muted);
  font-size: 11px; cursor: pointer; border-radius: 3px; text-transform: capitalize; }
.rb-tab--active { background: var(--nei-dropdown-hover); color: #fff; }
.rb-tab:hover { background: var(--nei-panel-hover); }
.rb-tree { flex: 1; overflow-y: auto; }
.rb-node { display: flex; justify-content: space-between; padding: 2px 6px; border-radius: 3px; cursor: pointer; }
.rb-node:hover { background: var(--nei-panel-hover); }
.rb-node--empty { cursor: default; color: var(--nei-muted); justify-content: center; }
.rb-node--empty:hover { background: transparent; }
.rb-node__label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rb-node__count { font-variant-numeric: tabular-nums; color: var(--nei-muted); margin-left: 8px; }
</style>
