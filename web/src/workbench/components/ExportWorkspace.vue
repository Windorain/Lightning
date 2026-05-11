<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { loadStructureOrWorld } from '@/render/data/bundleResolve'
import { sceneStableStringIdFromDocument } from '@/render/data/compactSceneDocument'
import { buildEnvelopePackage } from '@/render/data/sceneExport'
import { copyTextToClipboard, downloadBlob, downloadJson } from '@/util/browser'
import { buildStructureBundleZip } from '@/workbench/structureBundleExport'
import { bakeIsometricStructurePngDataUrl, dataUrlToPngBlob } from '@/workbench/exportIsometricImage'
import { formatUnknownError } from '@/util/formatUnknownError'
import { useSceneContext } from '@/workbench/sceneContext'
import { useConnectionContext } from '@/workbench/connectionContext'
import { t } from '@/workbench/i18n'

const scene = useSceneContext()
const conn = useConnectionContext()
const doc = computed(() => scene.scene.value)
const baseName = computed(() => doc.value ? sceneStableStringIdFromDocument(doc.value) : 'scene')
const showSdeSave = computed(() => scene.workspaceMode.value === 'sde' && conn.apiBase.value.length > 0)
const feedback = ref('')

function msg(s: string): void { feedback.value = s }

async function downloadPlain(): Promise<void> {
  if (!doc.value) return
  try { const raw = doc.value as Record<string, unknown>; downloadJson(`${baseName.value}-plain`, raw, true); msg('已下载 Plain JSON') } catch (e) { msg(formatUnknownError(e)) }
}
async function downloadEnvelope(): Promise<void> {
  if (!doc.value) return
  try { const raw = doc.value as Record<string, unknown>; downloadJson(`${baseName.value}-envelope`, buildEnvelopePackage(raw), true); msg('已下载 Envelope JSON') } catch (e) { msg(formatUnknownError(e)) }
}
async function copyRawJson(): Promise<void> {
  if (!doc.value) return
  try { const raw = doc.value; await copyTextToClipboard(JSON.stringify(raw, null, 2)); msg('已复制到剪贴板') } catch (e) { msg(formatUnknownError(e)) }
}
async function downloadObjBlock(): Promise<void> {
  if (!doc.value) return
  try { const n = doc.value as Record<string, unknown>; const def = loadStructureOrWorld(n, undefined); const zip = await buildStructureBundleZip(def, n, { mode: 'block' }); downloadBlob(`${baseName.value}-block.zip`, zip); msg('已导出 OBJ (block)') } catch (e) { msg(formatUnknownError(e)) }
}
async function downloadObjConnected(): Promise<void> {
  if (!doc.value) return
  try { const n = doc.value as Record<string, unknown>; const def = loadStructureOrWorld(n, undefined); const zip = await buildStructureBundleZip(def, n, { mode: 'connected' }); downloadBlob(`${baseName.value}-connected.zip`, zip); msg('已导出 OBJ (connected)') } catch (e) { msg(formatUnknownError(e)) }
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
async function downloadIso(): Promise<void> {
  if (!doc.value || !isoUrl.value) return
  try { downloadBlob(`${baseName.value}-iso-${isoDir.value}.png`, dataUrlToPngBlob(isoUrl.value)); msg(`已下载等轴视角 PNG ${isoDir.value + 1}/4`) } catch (e) { msg(formatUnknownError(e)) }
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
        <button class="ew-btn ew-btn--primary" @click="void conn.pushToServer().then(() => msg('已同步到 SDE')).catch(e => msg(String(e)))">{{ t("putToSde") }}</button>
      </section>
    </div>

    <div v-if="feedback" class="ew-fb-bar">{{ feedback }}</div>
  </div>
</template>

<style scoped>
.ew-root { padding: 24px 32px; box-sizing: border-box; }
.ew-header { margin-bottom: 20px; }
.ew-title { font-size: 18px; font-weight: 600; color: var(--nei-text); text-shadow: var(--nei-label-shadow); margin: 0; }
.ew-sub { font-size: 12px; color: var(--nei-muted); }
.ew-grid { display: flex; flex-direction: column; gap: 14px; max-width: 720px; }
.ew-card { padding: 16px; border-radius: 8px; background: var(--nei-bg-deep); border: 1px solid var(--nei-border); }
.ew-card h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--nei-text); text-shadow: var(--nei-label-shadow); }
.ew-desc { margin: 0 0 10px; font-size: 12px; color: var(--nei-muted); }
.ew-row { display: flex; flex-wrap: wrap; gap: 8px; }
.ew-btn { padding: 6px 14px; border-radius: 6px; border: var(--nei-bevel-w) solid; border-color: var(--nei-highlight) var(--nei-shadow) var(--nei-shadow) var(--nei-highlight); background: var(--nei-btn-bg); color: var(--nei-btn-text); font-size: 12px; cursor: pointer; }
.ew-btn:hover { background: var(--nei-panel-hover); }
.ew-btn--primary { background: var(--nei-accent); border-color: var(--nei-accent-shadow); color: var(--nei-accent-text); text-shadow: var(--nei-accent-shadow); }
.ew-btn--sm { font-size: 11px; padding: 4px 10px; }
.ew-iso { max-width: 320px; border-radius: 4px; border: 1px solid var(--nei-border); margin-top: 8px; }
.ew-fb { font-size: 11px; color: var(--nei-muted); margin-top: 6px; }
.ew-fb--err { color: var(--nei-status-err); }
.ew-fb-bar { margin-top: 16px; padding: 8px 12px; border-radius: 6px; background: var(--nei-bg); border: 1px solid var(--nei-border); font-size: 12px; color: var(--nei-muted); }
</style>
