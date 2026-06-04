<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Context } from '@/runtime/context'
import { WIKI_DEFAULT_EDIT_SUMMARY } from '@/wiki/wikiEditSummary'
import { bindWikiModalEscape, setWikiModalOpen } from '@/wiki/wikiInputShield'
import WikiStructurePickerModal from './WikiStructurePickerModal.vue'

const props = defineProps<{ ctx: Context }>()

const wikiUi = props.ctx.wm.chrome.wikiUi!

const modal = computed(() => wikiUi.modal.value)
const saveConfirm = computed(() => wikiUi.saveConfirm.value)
const summaryDraft = ref('')

watch(saveConfirm, v => {
  if (v) summaryDraft.value = v.defaultSummary
})

watch(modal, m => {
  if (m === 'save-as') summaryDraft.value = WIKI_DEFAULT_EDIT_SUMMARY
})

function closeModal() {
  wikiUi.modal.value = null
  wikiUi.saveConfirm.value = null
  wikiUi.savePreviewMessage.value = null
}

watch(
  modal,
  m => {
    setWikiModalOpen(m != null)
  },
  { immediate: true },
)

let unbindModalEscape: (() => void) | null = null
onMounted(() => {
  unbindModalEscape = bindWikiModalEscape(closeModal)
})
onBeforeUnmount(() => {
  unbindModalEscape?.()
  unbindModalEscape = null
  setWikiModalOpen(false)
})

async function onPick(title: string) {
  closeModal()
  await props.ctx.getOperators().exec('OPERATOR_DOCUMENT_LOAD', {
    sourceId: 'wiki-data',
    title,
  })
}

async function confirmSave() {
  const ref = props.ctx.getDocumentBinding()
  ref.value = { ...ref.value, pendingSaveSummary: summaryDraft.value }
  closeModal()
  try {
    await props.ctx.getOperators().exec('OPERATOR_DOCUMENT_SAVE', {
      summary: summaryDraft.value,
    })
    props.ctx.log.info('Wiki 保存', '完成')
  } catch (err) {
    const e = err as Error & { code?: string }
    if (e.code === 'wiki-editconflict' || wikiUi.conflictMessage.value) {
      const ok = window.confirm(
        `${wikiUi.conflictMessage.value ?? e.message}\n\n是否重新载入最新版本？`,
      )
      if (ok) {
        await props.ctx.getOperators().exec('OPERATOR_WIKI_RELOAD')
      }
    }
  }
}

async function runSaveAs() {
  const name = saveAsName.value.trim()
  if (!name) return
  closeModal()
  await props.ctx.getOperators().exec('OPERATOR_WIKI_SAVE_AS', {
    baseName: name,
    summary: summaryDraft.value || WIKI_DEFAULT_EDIT_SUMMARY,
  })
}

const saveAsName = ref('')
</script>

<template>
  <WikiStructurePickerModal
    :ctx="ctx"
    :open="modal === 'picker'"
    @close="closeModal"
    @selected="onPick"
  />

  <div
    v-if="modal === 'save-confirm' && saveConfirm"
    class="wiki-modal-backdrop"
    @mousedown.self="closeModal"
    @keydown.stop
    @keydown.esc="closeModal"
  >
    <div class="wiki-modal" role="dialog">
      <h3 class="wiki-modal__title">保存到 Wiki</h3>
      <p class="wiki-modal__hint">
        {{
          saveConfirm.planMode === 'single'
            ? '将写入 1 页'
            : `将写入索引 + ${saveConfirm.planPartCount} 个分片`
        }}
      </p>
      <label class="wiki-modal__label">编辑摘要</label>
      <textarea v-model="summaryDraft" class="wiki-modal__textarea" rows="3" maxlength="500" />
      <div class="wiki-modal__actions">
        <button type="button" @click="closeModal">取消</button>
        <button type="button" class="wiki-modal__primary" @click="confirmSave">确认保存</button>
      </div>
    </div>
  </div>

  <div
    v-if="modal === 'save-preview'"
    class="wiki-modal-backdrop"
    @mousedown.self="closeModal"
    @keydown.stop
    @keydown.esc="closeModal"
  >
    <div class="wiki-modal" role="dialog">
      <h3 class="wiki-modal__title">分片预检</h3>
      <p>{{ wikiUi.savePreviewMessage }}</p>
      <div class="wiki-modal__actions">
        <button type="button" @click="closeModal">关闭</button>
      </div>
    </div>
  </div>

  <div
    v-if="modal === 'save-as'"
    class="wiki-modal-backdrop"
    @mousedown.self="closeModal"
    @keydown.stop
    @keydown.esc="closeModal"
  >
    <div class="wiki-modal" role="dialog">
      <h3 class="wiki-modal__title">另存为新结构</h3>
      <input v-model="saveAsName" class="wiki-modal__input" placeholder="结构名称" />
      <textarea v-model="summaryDraft" class="wiki-modal__textarea" rows="2" placeholder="编辑摘要（可选）" />
      <div class="wiki-modal__actions">
        <button type="button" @click="closeModal">取消</button>
        <button type="button" class="wiki-modal__primary" :disabled="!saveAsName.trim()" @click="runSaveAs">
          保存
        </button>
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
  width: min(400px, 92vw);
  background: var(--wb-panel-bg, #1e1e1e);
  color: var(--wb-text, #eee);
  border-radius: 8px;
  padding: 16px;
}
.wiki-modal__title { margin: 0 0 8px; font-size: 15px; }
.wiki-modal__hint { font-size: 12px; color: var(--wb-text-muted); margin: 0 0 10px; }
.wiki-modal__label { display: block; font-size: 11px; margin-bottom: 4px; }
.wiki-modal__input,
.wiki-modal__textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  margin-bottom: 10px;
}
.wiki-modal__actions { display: flex; gap: 8px; justify-content: flex-end; }
.wiki-modal__primary { font-weight: 600; }
</style>
