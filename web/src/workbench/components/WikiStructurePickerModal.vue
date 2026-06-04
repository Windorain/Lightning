<script setup lang="ts">
import { ref, watch } from 'vue'
import { searchStructureDataPages } from '@/wiki/mwApiAdapter'
import { getRecentStructures } from '@/wiki/wikiRecentStructures'
import { buildWikiUploadPageUrl } from '@/wiki/wikiUrls'
import type { Context } from '@/runtime/context'

const props = defineProps<{
  ctx: Context
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  selected: [title: string]
}>()

const query = ref('')
const hits = ref<Array<{ title: string; displayName: string }>>([])
const recent = ref<string[]>([])
const loading = ref(false)

watch(
  () => props.open,
  open => {
    if (!open) return
    query.value = ''
    recent.value = getRecentStructures()
    hits.value = []
    void runSearch('')
  },
)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(query, q => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => void runSearch(q), 300)
})

async function runSearch(q: string) {
  loading.value = true
  try {
    if (!q.trim()) {
      const rec = recent.value
      hits.value = rec.map(base => ({
        title: `Data:Structures/${base}.json`,
        displayName: base,
      }))
    } else {
      hits.value = await searchStructureDataPages(q)
    }
  } catch (e) {
    props.ctx.log.error('Wiki 搜索', String(e))
    hits.value = []
  } finally {
    loading.value = false
  }
}

function pick(title: string) {
  emit('selected', title)
  emit('close')
}

function pickRecent(base: string) {
  pick(`Data:Structures/${base}.json`)
}
</script>

<template>
  <div
    v-if="open"
    class="wiki-modal-backdrop"
    @mousedown.self="emit('close')"
    @keydown.stop
    @keydown.esc="emit('close')"
  >
    <div class="wiki-modal" role="dialog" aria-modal="true">
      <h3 class="wiki-modal__title">从 Wiki 加载结构</h3>
      <input
        v-model="query"
        class="wiki-modal__input"
        type="search"
        placeholder="按结构名称搜索…"
        autofocus
      />
      <p v-if="loading" class="wiki-modal__hint">搜索中…</p>
      <ul v-else class="wiki-modal__list">
        <li v-for="h in hits" :key="h.title">
          <button type="button" class="wiki-modal__item" @dblclick="pick(h.title)" @click="pick(h.title)">
            {{ h.displayName }}
          </button>
        </li>
        <li v-if="!hits.length && query.trim()" class="wiki-modal__empty">
          未找到匹配结构。
          <a :href="buildWikiUploadPageUrl()" target="_blank" rel="noopener">前往上传页</a>
        </li>
        <li v-if="!hits.length && !query.trim() && !recent.length" class="wiki-modal__empty">
          暂无最近打开记录。
          <a :href="buildWikiUploadPageUrl()" target="_blank" rel="noopener">上传新结构</a>
        </li>
      </ul>
      <div v-if="!query.trim() && recent.length" class="wiki-modal__section">最近打开</div>
      <ul v-if="!query.trim() && recent.length" class="wiki-modal__list">
        <li v-for="r in recent" :key="r">
          <button type="button" class="wiki-modal__item" @click="pickRecent(r)">{{ r }}</button>
        </li>
      </ul>
      <div class="wiki-modal__actions">
        <button type="button" @click="emit('close')">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wiki-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50000;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
}
.wiki-modal {
  width: min(420px, 92vw);
  max-height: 70vh;
  overflow: auto;
  background: var(--wb-panel-bg, #1e1e1e);
  color: var(--wb-text, #eee);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.wiki-modal__title { margin: 0 0 12px; font-size: 15px; }
.wiki-modal__input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  margin-bottom: 10px;
}
.wiki-modal__list { list-style: none; margin: 0; padding: 0; }
.wiki-modal__item {
  width: 100%;
  text-align: left;
  padding: 8px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.wiki-modal__item:hover { background: rgba(255, 255, 255, 0.08); }
.wiki-modal__empty { padding: 8px; font-size: 12px; color: var(--wb-text-muted, #999); }
.wiki-modal__section { font-size: 11px; color: var(--wb-text-muted); margin-top: 8px; }
.wiki-modal__actions { margin-top: 12px; text-align: right; }
.wiki-modal__hint { font-size: 12px; color: var(--wb-text-muted); }
</style>
