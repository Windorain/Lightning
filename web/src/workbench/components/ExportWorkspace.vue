<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { sceneStableStringIdFromDocument } from '@/render/data/compactSceneDocument'
import { copyTextToClipboard } from '@/util/browser'
import { bakeIsometricStructurePngDataUrl } from '@/workbench/exportIsometricImage'
import { formatUnknownError } from '@/util/formatUnknownError'
import { useBContext } from '@/workbench/context/bContext'
import { t } from '@/workbench/i18n'

const bctx = useBContext()
const doc = computed(() => bctx.doc.value?.toRaw() ?? null)
const baseName = computed(() => doc.value ? sceneStableStringIdFromDocument(doc.value) : 'scene')
const showSdeSave = computed(() => bctx.workspaceMode.value === 'sde' && bctx.connectionApiBase.value.length > 0)
const feedback = ref('')

function msg(s: string): void { feedback.value = s }

function downloadPlain(): void {
  try { bctx.operators.exec('OPERATOR_EXPORT_PLAIN'); msg('已下载 Plain JSON') } catch (e) { msg(formatUnknownError(e)) }
}
function downloadEnvelope(): void {
  try { bctx.operators.exec('OPERATOR_EXPORT_ENVELOPE'); msg('已下载 Envelope JSON') } catch (e) { msg(formatUnknownError(e)) }
}
async function copyRawJson(): Promise<void> {
  if (!doc.value) return
  try { const raw = doc.value; await copyTextToClipboard(JSON.stringify(raw, null, 2)); msg('已复制到剪贴板') } catch (e) { msg(formatUnknownError(e)) }
}
function downloadObjBlock(): void {
  try { bctx.operators.exec('OPERATOR_EXPORT_OBJ', { connected: false }); msg('已导出 OBJ (block)') } catch (e) { msg(formatUnknownError(e)) }
}
function downloadObjConnected(): void {
  try { bctx.operators.exec('OPERATOR_EXPORT_OBJ', { connected: true }); msg('已导出 OBJ (connected)') } catch (e) { msg(formatUnknownError(e)) }
}

const isoDir = ref(0)
const isoUrl = ref<string | null>(null)
const isoBusy = ref(false)
const isoErr = ref<string | null>(null)
let isoSeq = 0
function cycleIso(): void { isoDir.value = (isoDir.value + 1) % 4 }
async function bakeIso(): Promise<void> {
  const d = doc.value; if (!d) { isoUrl.value = null; isoErr.value = null; isoBusy.value = false; return }
  const seq = ++isoSeq; isoBusy.value = true; isoErr.value = null
  try { const url = await bakeIsometricStructurePngDataUrl(d, isoDir.value); if (seq !== isoSeq) return; isoUrl.value = url }
  catch (e) { if (seq !== isoSeq) return; isoUrl.value = null; isoErr.value = formatUnknownError(e) }
  finally { if (seq === isoSeq) isoBusy.value = false }
}
watch(() => [doc.value, isoDir.value] as const, () => { void bakeIso() }, { immediate: true })
function downloadIso(): void {
  try { bctx.operators.exec('OPERATOR_EXPORT_ISO_PNG', { direction: isoDir.value }); msg(`已下载等轴视角 PNG ${isoDir.value + 1}/4`) } catch (e) { msg(formatUnknownError(e)) }
}
function pushToServer(): void {
  try { bctx.operators.exec('OPERATOR_SDE_PUSH'); msg('已同步到 SDE') } catch (e) { msg(formatUnknownError(e)) }
}
</script>

<template>
  <div class="ew-root">
    <div class="ew-header">
      <h2 class="ew-title">{{ t("export") }}</h2>
      <span class="ew-sub">{{ baseName }}</span>
    </div>

    <div class="ew-grid">
      <section class="ew-card">
        <h3>{{ t("json") }}</h3>
        <p class="ew-desc">{{ t("plainDesc") }}</p>
        <div class="ew-row"><button class="ew-btn" @click="void downloadPlain()">{{ t("downloadPlain") }}</button><button class="ew-btn" @click="void downloadEnvelope()">{{ t("downloadEnvelope") }}</button><button class="ew-btn" @click="void copyRawJson()">{{ t("copyToClipboard") }}</button></div>
      </section>

      <section class="ew-card">
        <h3>{{ t("obj") }}</h3>
        <p class="ew-desc">{{ t("objDesc") }}</p>
        <div class="ew-row"><button class="ew-btn" @click="void downloadObjBlock()">{{ t("objBlock") }}</button><button class="ew-btn" @click="void downloadObjConnected()">{{ t("objConnected") }}</button></div>
      </section>

      <section class="ew-card">
        <h3>{{ t("isoPng") }}</h3>
        <p class="ew-desc">{{ t("isoDesc") }}</p>
        <div class="ew-row">
          <button class="ew-btn ew-btn--sm" @click="cycleIso" :disabled="isoBusy">{{ t("isoDir") }} {{ isoDir + 1 }}/4</button>
          <button v-if="isoUrl" class="ew-btn ew-btn--primary" @click="void downloadIso()">{{ t("downloadPng") }}</button>
        </div>
        <div v-if="isoBusy" class="ew-fb">{{ t('rendering') }}</div>
        <img v-else-if="isoUrl" :src="isoUrl" class="ew-iso" alt="Iso preview" />
        <div v-if="isoErr" class="ew-fb ew-fb--err">{{ isoErr }}</div>
      </section>

      <section v-if="showSdeSave" class="ew-card">
        <h3>{{ t("sdeSync") }}</h3>
        <button class="ew-btn ew-btn--primary" @click="pushToServer()">{{ t("putToSde") }}</button>
      </section>
    </div>

    <div v-if="feedback" class="ew-fb-bar">{{ feedback }}</div>
  </div>
</template>

<style scoped>
.ew-root { padding: 24px 32px; box-sizing: border-box; height: 100%; overflow-y: auto; }
.ew-header { margin-bottom: 24px; }
.ew-title { font-size: 20px; font-weight: 700; color: var(--wb-text); margin: 0; }
.ew-sub { font-size: 13px; color: var(--wb-text-dim); }
.ew-grid { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
.ew-card {
  padding: 20px;
  border-radius: var(--wb-radius-lg);
  background: var(--wb-bg-surface);
  border: 1px solid var(--wb-border);
}
.ew-card h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; color: var(--wb-text); }
.ew-desc { margin: 0 0 12px; font-size: 13px; color: var(--wb-text-dim); line-height: 1.5; }
.ew-row { display: flex; flex-wrap: wrap; gap: 8px; }
.ew-btn {
  padding: 8px 16px;
  border-radius: var(--wb-radius-md);
  border: 1px solid var(--wb-border);
  background: var(--wb-bg-elevated);
  color: var(--wb-accent-muted);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.ew-btn:hover { background: var(--wb-bg-hover); border-color: var(--wb-accent); color: var(--wb-text); }
.ew-btn--primary { border-color: var(--wb-accent); background: var(--wb-bg-hover); color: var(--wb-accent); font-weight: 500; }
.ew-btn--primary:hover { background: var(--wb-accent); color: #fff; }
.ew-btn--sm { font-size: 12px; padding: 6px 12px; }
.ew-iso { max-width: 340px; border-radius: var(--wb-radius-md); border: 1px solid var(--wb-border); margin-top: 10px; }
.ew-fb { font-size: 12px; color: var(--wb-text-dim); margin-top: 8px; }
.ew-fb--err { color: var(--wb-danger); }
.ew-fb-bar {
  margin-top: 20px; padding: 10px 14px;
  border-radius: var(--wb-radius-md);
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  font-size: 13px; color: var(--wb-text-dim);
}
</style>
