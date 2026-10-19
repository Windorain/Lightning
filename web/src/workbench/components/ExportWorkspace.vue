<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { sceneStableStringIdFromDocument } from '@/render/data/compactSceneDocument'
import { copyTextToClipboard, downloadBlob } from '@/util/browser'
import { EXPORT_PIXEL_SIZE, blobOf, dataUrlOf, exportErrorText, runIsoExport } from '@/workbench/export/isoExportJob'
import { createDomTextureDecoder } from '@/adapters/textureDecode'
import { formatUnknownError } from '@/util/formatUnknownError'
import { useContext } from '@/runtime/context'
import type { ExportAssetManifest, ExportCaptureFacts } from '@/application/exportPlan'
import ExportManifestPanel from './ExportManifestPanel.vue'

/** 一次成功导出的面板数据（A 块来自冻结清单，B 块来自捕获明细）。 */
interface ExportPanelData {
  readonly manifest: ExportAssetManifest
  readonly facts: ExportCaptureFacts | null
}

const ctx = useContext()
/** 本实例的翻译（语言来自本实例设置，不是模块级全局读源；#259 A33）。 */
const t = ctx.t
// #301 P10f D2：产物改由**内核投影**给出（`plainForSave` 是唯一分流点；
// 未装配时自动回落旧文档 —— 能力不回退）。
const doc = computed(() => ctx.plainForSave().plain ?? null)
const baseName = computed(() => doc.value ? sceneStableStringIdFromDocument(doc.value) : 'scene')
const showSdeSave = computed(() => ctx.getWorkspaceMode().value === 'sde' && ctx.getConnection().apiBase.length > 0)
const feedback = ref('')

function msg(s: string): void { feedback.value = s }

function downloadPlain(): void {
  try { ctx.getOperators().exec('OPERATOR_EXPORT_PLAIN'); msg('已下载 Plain JSON') } catch (e) { msg(formatUnknownError(e)) }
}
function downloadEnvelope(): void {
  try { ctx.getOperators().exec('OPERATOR_EXPORT_ENVELOPE'); msg('已下载 Envelope JSON') } catch (e) { msg(formatUnknownError(e)) }
}
async function copyRawJson(): Promise<void> {
  if (!doc.value) return
  try { const raw = doc.value; await copyTextToClipboard(JSON.stringify(raw, null, 2)); msg('已复制到剪贴板') } catch (e) { msg(formatUnknownError(e)) }
}
async function downloadObjBlock(): Promise<void> {
  try { await ctx.getOperators().exec('OPERATOR_EXPORT_OBJ', { connected: false }); msg('已导出 OBJ (block)') } catch (e) { msg(formatUnknownError(e)) }
}
async function downloadObjConnected(): Promise<void> {
  try { await ctx.getOperators().exec('OPERATOR_EXPORT_OBJ', { connected: true }); msg('已导出 OBJ (connected)') } catch (e) { msg(formatUnknownError(e)) }
}
async function downloadObjLayered(): Promise<void> {
  try { await ctx.getOperators().exec('OPERATOR_EXPORT_OBJ', { mode: 'layered' }); msg('已导出 OBJ (layered)') } catch (e) { msg(formatUnknownError(e)) }
}

const isoDir = ref(0)
/**
 * 导出时间（场景秒数）。默认 = 当前预览时间。
 *
 * 读面只用 `ctx.getSceneSeconds()`（`domain/animation#sceneClockOf` 的唯一投影）：
 * 面板/视口/导出必须同一个时间值，否则同一时刻会得到不同样本（A27）。
 */
/**
 * 时间输入是**文本**框（`type="text" inputmode="decimal"`），不是 `type="number"`。
 *
 * ## 为什么不是 number（M5-4 / P4 手测实测，2026-10-18）
 *
 * `type="number"` 的浏览器行为是**吞掉**非法键盘输入（键入 `abc` 后 `value` 恒为空串），
 * 于是"非法时间 ⇒ 红字"这条 UI 事实在真人操作下**几乎不可达**（只有清空输入框才碰得到）
 * —— 一条只有程序化可达的错误位等于没有。改为文本输入后：
 *  · 键入即校验（`@input`）⇒ 红字随输入出现/消失；
 *  · 归一仍由 `normalizeIsoSeconds`（唯一入口）在烘焙/下载时拒绝非法值 ⇒ 不静默当 0。
 */
const isoText = ref(String(ctx.getSceneSeconds()))
/** 正在编辑的**原文**（`@input` 即时更新；只用于"红字"提示，不进烘焙）。 */
const isoDraft = ref(isoText.value)
const isoUrl = ref<string | null>(null)
const isoBusy = ref(false)
const isoErr = ref<string | null>(null)
/** 本次成功导出的清单面板（Q8：只有成功结局才有面板；失败必须清空）。 */
const isoPanel = ref<ExportPanelData | null>(null)
/** 下载失败（可见）；与 `isoErr`（预览失败）分开 —— 两者的触发条件不同。 */
const dlErr = ref<string | null>(null)
let isoSeq = 0
function cycleIso(): void { isoDir.value = (isoDir.value + 1) % 4 }
/**
 * 文本 → 秒（**只做解析**，不做归一）：空串/非有限数 ⇒ `null`。
 *
 * 归一（含负数取模语义、缺省 0）仍归 `normalizeIsoSeconds` —— 本函数不复制那条政策，
 * 只回答"这串文本能不能当成一个有限秒数"。
 */
function parseIsoText(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}
/** 「取当前预览时间」：把场景时间权威的当前值搬进输入框（不提交任何命令）。 */
function takeCurrentTime(): void {
  isoText.value = String(ctx.getSceneSeconds())
  isoDraft.value = isoText.value
}
/** 输入即时校验：编辑中就看得出非法（不必等失焦/提交）。 */
const isoTimeInvalid = computed(() => parseIsoText(isoDraft.value) === null)
/** 已提交的文本 → 秒（`null` = 非法：本卡**不**烘焙，避免把错误当 t=0 画出来）。 */
const isoSeconds = computed<number | null>(() => parseIsoText(isoText.value))
/** 输入事件：原文进 `isoDraft`（红字即时），提交仍由 `v-model.lazy` 的 change 负责。 */
function onIsoInput(e: Event): void {
  isoDraft.value = (e.target as HTMLInputElement).value
}
async function bakeIso(): Promise<void> {
  const d = doc.value
  if (!d) { isoUrl.value = null; isoErr.value = null; isoBusy.value = false; isoPanel.value = null; return }
  const seconds = isoSeconds.value
  // 非法输入**不烘焙**：把 'abc' 当 t=0 画出来就是"静默当 0"（本卡的红字说的正是它非法）。
  if (seconds === null) { isoUrl.value = null; isoErr.value = null; isoBusy.value = false; isoPanel.value = null; return }
  const seq = ++isoSeq; isoBusy.value = true; isoErr.value = null
  try {
    /**
     * 预览与下载**同一条链、同一组参数**（M6-3）：预览不再走第二套烘焙，
     * 于是"卡片上看到的图就是下载得到的图"由结构保证（既有判据 C2 逐字节断言）。
     *
     * 边长 480 = 旧烘焙的缺省（`openIsometricStage` 的 `pixelSize ?? 480`）；
     * M6-5 起它是**唯一来源** `EXPORT_PIXEL_SIZE`（场景 GIF 同批统一），两张卡片的
     * 预览/下载都不再各自写死一个数。
     */
    const r = await runIsoExport(ctx, {
      kind: 'image',
      directionIndex: isoDir.value,
      pixelSize: EXPORT_PIXEL_SIZE,
      seconds,
      decoder: createDomTextureDecoder(),
      now: Date.now(),
    })
    if (!r.ok) throw new Error(exportErrorText(r.error))
    if (seq !== isoSeq) return
    isoUrl.value = dataUrlOf(r.value)
    // Q8：A/B 两块都来自**这一次**作业的结局（不是再算一份清单）。
    isoPanel.value = { manifest: r.value.outcome.assetManifest, facts: r.value.outcome.captureFacts ?? null }
  } catch (e) {
    if (seq !== isoSeq) return
    isoUrl.value = null
    isoErr.value = formatUnknownError(e)
    // 失败必须**没有**面板：一张残留的清单会让"这次没导成"看起来像"导成了"。
    isoPanel.value = null
  }
  finally { if (seq === isoSeq) isoBusy.value = false }
}
// `.lazy` 只在 change（失焦/回车）提交 ⇒ 一次编辑一次重烘焙，不需要计时器。
watch(() => [doc.value, isoDir.value, isoSeconds.value] as const, () => { void bakeIso() }, { immediate: true })

// ── 场景 GIF（M5-4）────────────────────────────────────────────────────────
// 与等轴 PNG 同一个方向/相机；时间来自"纹理序列一个循环"的冻结计划（不是墙钟）。
const gifUrl = ref<string | null>(null)
const gifBusy = ref(false)
const gifErr = ref<string | null>(null)
const gifPanel = ref<ExportPanelData | null>(null)
/** 例："12 帧 / 1.500 s" —— e2e 的 `[data-gif-plan]` 读它，与下载字节解码结果对账。 */
const gifInfo = ref<string | null>(null)
async function makeGif(): Promise<void> {
  const d = doc.value
  if (!d) return
  gifBusy.value = true
  gifErr.value = null
  gifPanel.value = null
  try {
    /**
     * 预览与下载**同尺寸来源**（M6-5 / Q1）：两处都引用 `EXPORT_PIXEL_SIZE`，
     * 不再出现"预览 480 / 下载 320"。夹取仍在命令侧一处（`ExportSceneGifOperator`）。
     */
    const r = await runIsoExport(ctx, {
      kind: 'animation',
      directionIndex: isoDir.value,
      pixelSize: EXPORT_PIXEL_SIZE,
      decoder: createDomTextureDecoder(),
      now: Date.now(),
    })
    if (!r.ok) throw new Error(exportErrorText(r.error))
    if (gifUrl.value) URL.revokeObjectURL(gifUrl.value)
    gifUrl.value = URL.createObjectURL(blobOf(r.value))
    // 帧数与总时长来自**捕获期的时间计划**（不是回读产物、不是再算一遍声明）。
    const loop = r.value.capture.loop
    gifInfo.value = loop === null ? null : `${loop.frameCount} 帧 / ${(loop.totalMs / 1000).toFixed(3)} s`
    gifPanel.value = { manifest: r.value.outcome.assetManifest, facts: r.value.outcome.captureFacts ?? null }
  } catch (e) {
    gifUrl.value = null
    gifInfo.value = null
    gifPanel.value = null
    gifErr.value = formatUnknownError(e)
  } finally {
    gifBusy.value = false
  }
}
async function downloadGif(): Promise<void> {
  gifErr.value = null
  gifPanel.value = null
  try {
    /**
     * Q8：卡片下载走**同一条** `runIsoExport`（不是第二套烘焙），于是：
     *  - 面板 A/B 两块拿到的是**这一次下载**的 `outcome`；
     *  - 下载只落产物本身（清单交付 = 面板，不产生第二个文件）。
     *
     * 与预览**同一个常量**（`EXPORT_PIXEL_SIZE`）：这次下载的字节与卡片上
     * 显示的预览是同一尺寸，e2e 对两者直接对账。
     */
    const r = await runIsoExport(ctx, {
      kind: 'animation',
      directionIndex: isoDir.value,
      pixelSize: EXPORT_PIXEL_SIZE,
      decoder: createDomTextureDecoder(),
      now: Date.now(),
    })
    if (!r.ok) throw new Error(exportErrorText(r.error))
    downloadBlob(r.value.fileName, blobOf(r.value))
    gifPanel.value = { manifest: r.value.outcome.assetManifest, facts: r.value.outcome.captureFacts ?? null }
    msg(`已下载动画 GIF ${isoDir.value + 1}/4`)
  } catch (e) {
    gifPanel.value = null
    gifErr.value = formatUnknownError(e)
  }
}
async function downloadIso(): Promise<void> {
  dlErr.value = null
  isoPanel.value = null
  // 非法输入**不下载**（不在卡片里换成 0；错误位必须可见）。
  const seconds = isoSeconds.value
  if (seconds === null) {
    dlErr.value = t('isoTimeInvalid')
    msg(dlErr.value)
    return
  }
  try {
    /**
     * Q8：与预览**同一条链、同一组参数**（边长/方向/秒数），只是多落一次盘。
     * `outcome` 直接喂面板 ⇒ "卡片上的清单就是这次下载的清单"由结构保证。
     */
    const r = await runIsoExport(ctx, {
      kind: 'image',
      directionIndex: isoDir.value,
      pixelSize: EXPORT_PIXEL_SIZE,
      seconds,
      decoder: createDomTextureDecoder(),
      now: Date.now(),
    })
    if (!r.ok) throw new Error(exportErrorText(r.error))
    downloadBlob(r.value.fileName, blobOf(r.value))
    isoPanel.value = { manifest: r.value.outcome.assetManifest, facts: r.value.outcome.captureFacts ?? null }
    msg(`已下载等轴视角 PNG ${isoDir.value + 1}/4`)
  } catch (e) {
    // 失败必须有可见错误位；且不得留下上次成功的面板（"没导成"不能看起来像导成了）。
    isoPanel.value = null
    dlErr.value = formatUnknownError(e)
    msg(formatUnknownError(e))
  }
}
function pushToServer(): void {
  try { ctx.getOperators().exec('OPERATOR_SDE_PUSH'); msg('已同步到 SDE') } catch (e) { msg(formatUnknownError(e)) }
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
        <div class="ew-row"><button class="ew-btn" @click="downloadObjBlock()">{{ t("objBlock") }}</button><button class="ew-btn" @click="downloadObjConnected()">{{ t("objConnected") }}</button><button class="ew-btn" @click="downloadObjLayered()">{{ t("objLayered") }}</button></div>
      </section>

      <section class="ew-card">
        <h3>{{ t("isoPng") }}</h3>
        <p class="ew-desc">{{ t("isoDesc") }}</p>
        <div class="ew-row">
          <button class="ew-btn ew-btn--sm" @click="cycleIso" :disabled="isoBusy">{{ t("isoDir") }} {{ isoDir + 1 }}/4</button>
          <label class="ew-time">
            {{ t("isoTime") }}
            <!--
              `type="text"` + `inputmode="decimal"`：见 `isoText` 的说明（number 会吞掉非法
              键盘输入 ⇒ 红字不可达）。`v-model.lazy` 保持"一次编辑一次重烘焙"；
              `@input` 只更新提示用的原文。
            -->
            <input
              class="ew-num"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
              v-model.lazy="isoText"
              :disabled="isoBusy"
              data-iso-seconds
              @input="onIsoInput"
            />
            <span class="ew-unit">s</span>
          </label>
          <button class="ew-btn ew-btn--sm" @click="takeCurrentTime" :disabled="isoBusy">{{ t("takeCurrentTime") }}</button>
          <!--
            M5-4：下载按钮不再以"预览成功"为前提（原 `v-if="isoUrl"`）。
            理由：下载失败的错误位（`dlErr`）必须有**可达**的触发路径 —— 若按钮只在预览成功时
            出现，而预览与下载又走同一条烘焙链，那个错误位在 UI 上几乎不可达（形同死代码）。
            现在：预览失败也能点下载，失败即显示红色错误位（不产生任何下载）。
          -->
          <button v-if="doc" class="ew-btn ew-btn--primary" @click="downloadIso()" data-download-iso>{{ t("downloadPng") }}</button>
        </div>
        <div v-if="isoTimeInvalid" class="ew-fb ew-fb--err" data-iso-time-invalid>{{ t("isoTimeInvalid") }}</div>
        <div v-if="isoBusy" class="ew-fb">{{ t('rendering') }}</div>
        <img v-else-if="isoUrl" :src="isoUrl" class="ew-iso" alt="Iso preview" />
        <div v-if="isoErr" class="ew-fb ew-fb--err">{{ isoErr }}</div>
        <div v-if="dlErr" class="ew-fb ew-fb--err" data-iso-dl-err>{{ dlErr }}</div>
        <!-- Q8：一次下载只有产物本身；A/B 清单在卡片内的面板里（不产生第二个文件）。 -->
        <ExportManifestPanel format="iso-png" :manifest="isoPanel?.manifest ?? null" :facts="isoPanel?.facts ?? null" />
      </section>

      <section class="ew-card">
        <h3>{{ t("animGif") }}</h3>
        <p class="ew-desc">{{ t("animGifDesc") }}</p>
        <div class="ew-row">
          <button class="ew-btn ew-btn--sm" @click="cycleIso" :disabled="gifBusy">{{ t("isoDir") }} {{ isoDir + 1 }}/4</button>
          <button class="ew-btn" @click="void makeGif()" :disabled="gifBusy" data-make-gif>{{ t("generateGif") }}</button>
          <button v-if="gifUrl" class="ew-btn ew-btn--primary" @click="void downloadGif()" data-download-gif>{{ t("downloadGif") }}</button>
        </div>
        <div v-if="gifBusy" class="ew-fb">{{ t("rendering") }}</div>
        <div v-else-if="gifInfo" class="ew-fb" data-gif-plan>{{ gifInfo }}</div>
        <img v-if="gifUrl" :src="gifUrl" class="ew-iso" alt="GIF preview" data-gif-preview />
        <div v-if="gifErr" class="ew-fb ew-fb--err" data-gif-err>{{ gifErr }}</div>
        <ExportManifestPanel format="scene-gif" :manifest="gifPanel?.manifest ?? null" :facts="gifPanel?.facts ?? null" />
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
.ew-btn--primary:hover { background: var(--wb-accent); color: #ffffff; }
.ew-btn--sm { font-size: 12px; padding: 6px 12px; }
.ew-iso { max-width: 340px; border-radius: var(--wb-radius-md); border: 1px solid var(--wb-border); margin-top: 10px; }
.ew-time { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--wb-text-dim); }
.ew-num { width: 72px; padding: 4px 6px; border-radius: var(--wb-radius-sm, 4px); border: 1px solid var(--wb-border); background: var(--wb-bg-elevated); color: var(--wb-text); font-size: 12px; }
.ew-unit { font-size: 12px; color: var(--wb-text-dim); }
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
