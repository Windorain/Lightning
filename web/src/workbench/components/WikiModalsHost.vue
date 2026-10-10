<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Context } from '@/runtime/context'
import { WIKI_DEFAULT_EDIT_SUMMARY } from '@/wiki/wikiEditSummary'
import WikiStructurePickerModal from './WikiStructurePickerModal.vue'

const props = defineProps<{ ctx: Context }>()

const wikiUi = props.ctx.wm.chrome.wikiUi!

const modal = computed(() => wikiUi.modal.value)
const saveConfirm = computed(() => wikiUi.saveConfirm.value)
const summaryDraft = ref('')

/**
 * 弹窗作用域 id（**显式**）。
 *
 * ## B5 退役矩阵 #12（输入面）的删除记录 —— P7（#258）
 *
 * 删除前这里走的是 `@/wiki/wikiInputShield` 的两个全局副作用：
 *
 * ```ts
 * import { bindWikiModalEscape, setWikiModalOpen } from '@/wiki/wikiInputShield'
 * watch(modal, (m) => { setWikiModalOpen(m != null) }, { immediate: true })  // ← 模块级 let 布尔
 * onMounted(() => { unbindModalEscape = bindWikiModalEscape(closeModal) })   // ← window capture keydown
 * ```
 *
 * 三处问题：
 *  1. `setWikiModalOpen` 写的是**模块级变量** —— 同页多实例（工作台 + 嵌入预览）
 *     互相覆盖，后挂的弹窗决定先挂弹窗的按键归属；
 *  2. `bindWikiModalEscape` 是**第三条** window 级 capture keydown
 *     （另两条在 `chromeBinder`/`viewportBinder`），Escape 会被多处各消费一次；
 *  3. 它只处理 Escape，其余键靠`shouldSkipWorkbenchDocumentKeydown` 的
 *     "弹窗开着就全跳过"粗糙兜底 —— 于是弹窗里的文本框也收不到任何键。
 *
 * 取代它的是 `ModalScopeState`（`domain/input`）：
 *  - 作用域按 **id** 登记（不共享全局布尔）；
 *  - 层级优先级由纯路由判定（Escape → `modal.close`；弹窗**内部**的文本控件
 *    仍走 `text` 层，不被"模态优先"吃掉）；
 *  - 不再需要第三条监听。
 *
 * 本组件现在只**声明事实**：哪个作用域开着、是否阻断背景、哪些是它自己的文本控件。
 */
const SCOPE_ID = 'wiki-modal'

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

function currentScopeId(): string | null {
  const m = modal.value
  if (m === null) return null
  return `${SCOPE_ID}:${m}`
}

let unbindScope: (() => void) | null = null

watch(
  modal,
  (m) => {
    unbindScope?.()
    unbindScope = null
    if (m === null) return
    unbindScope = props.ctx.wm.requireInputPort().openModalScope({
      scopeId: `${SCOPE_ID}:${m}`,
      blocksBackground: true,
      confirmOnEnter: false,
      // 弹窗**自己**的文本控件：它们在弹窗内仍接收输入（#249 §19.1 的层级示例）
      textControlIds: ['wiki-edit-summary', 'wiki-save-as-name'],
      onEscape: closeModal,
    })
  },
  { immediate: true },
)

onMounted(() => {
  // 只读诊断：把当前作用域暴露给 e2e 探针（不参与业务）
  void currentScopeId()
})
onBeforeUnmount(() => {
  unbindScope?.()
  unbindScope = null
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
