<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useBContext } from '@/workbench/context/bContext'
import { readSceneMetaField } from '@/render/data/compactSceneDocument'
import { useSceneContext } from '@/workbench/sceneContext'
import { t } from '@/workbench/i18n'

const ctx = useSceneContext()
const bctx = useBContext()

const hasScene = computed(() => ctx.scene.value != null)

const id = ref('')
const label = ref('')
const author = ref('')
const gtnhVersion = ref('')
const structureId = ref('')

// scene → 表单
watch(
  () => ctx.scene.value,
  (d) => {
    id.value = d ? readSceneMetaField(d, 'id') : ''
    label.value = d ? readSceneMetaField(d, 'label') : ''
    author.value = d ? readSceneMetaField(d, 'author') : ''
    gtnhVersion.value = d ? readSceneMetaField(d, 'gtnhVersion') : ''
    structureId.value = d ? readSceneMetaField(d, 'structureId') : ''
  },
  { immediate: true },
)

// 表单 → scene（300ms debounce，通过 operator 提交）
let debounceTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSync(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  const sceneSnapshot = ctx.scene.value
  debounceTimer = setTimeout(() => {
    if (ctx.scene.value !== sceneSnapshot) return
    const doc = ctx.scene.value
    if (!doc) return
    for (const [k, v] of Object.entries({
      id: id.value, label: label.value, author: author.value,
      gtnhVersion: gtnhVersion.value, structureId: structureId.value,
    })) {
      bctx.operators.exec('OPERATOR_SCENE_META_EDIT', { field: k, value: v || null })
    }
    void ctx.syncPreview()
  }, 300)
}

watch([id, label, author, gtnhVersion, structureId], () => scheduleSync())
</script>

<template>
  <div class="pe-panel">
    <div class="pe-title">{{ t('sceneInfo') }}</div>
    <p v-if="!hasScene" class="pe-muted">{{ t('noScene') }}</p>
    <template v-else>
      <div class="se-grid">
        <label class="se-field"><span>label</span><input v-model="label" placeholder="标签" type="text" autocomplete="off" /></label>
        <label class="se-field"><span>id</span><input v-model="id" placeholder="ID" type="text" autocomplete="off" /></label>
        <label class="se-field"><span>author</span><input v-model="author" placeholder="作者" type="text" autocomplete="off" /></label>
        <label class="se-field"><span>gtnhVersion</span><input v-model="gtnhVersion" placeholder="版本号" type="text" autocomplete="off" /></label>
        <label class="se-field"><span>structureId</span><input v-model="structureId" placeholder="注册名" type="text" autocomplete="off" /></label>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pe-panel { padding: 10px; font-size: 12px; }
.pe-title { font-size: 13px; font-weight: 600; color: var(--nei-text); text-shadow: var(--nei-label-shadow); margin-bottom: 8px; }
.pe-muted { font-size: 11px; color: var(--nei-muted); }
.se-grid { display: flex; flex-direction: column; gap: 6px; }
.se-field { display: flex; flex-direction: column; gap: 3px; }
.se-field span { font-size: 10px; color: var(--nei-label); }
.se-field input, .se-field select {
  padding: 4px 6px; border-radius: 4px; border: var(--nei-bevel-w) solid;
  border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow);
  background: var(--nei-inset-bg); color: var(--nei-text); font-size: 11px;
}
.se-field input::placeholder { color: var(--nei-muted); }
</style>
