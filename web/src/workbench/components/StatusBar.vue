<script setup lang="ts">
/**
 * 底栏状态条：模型信息 + 帧信息 + 渲染状态 + Wiki 绑定
 */
import { computed } from 'vue'
import { LOG_LEVEL } from '@/logging/LogCenter'
import { useContext } from '@/runtime/context'
import { useShell } from '@/composition/shell'
import { CAPABILITY } from '@/composition/modules'
import { buildWikiDataPageUrl, displayNameFromLocator } from '@/wiki/wikiUrls'
import { buildWikiEditSummaryDraft, hasWikiAuditableChanges } from '@/wiki/wikiEditSummary'

const ctx = useContext()
const shell = useShell()
const log = ctx.log
/** 本实例的翻译（#259 A33：消费本实例语言，无模块级全局读源）。 */
const t = ctx.t

const frameCount = computed(() => ctx.getDoc().value?.frameCount ?? 0)
const hasWorldMultiFrame = computed(() => frameCount.value > 1)

// B5 #7：旧实现是 `isWikiHostProfile()`（组件在问宿主名 —— #249 §10 明文禁止）。
// 现在问**能力**：只有装配了 Wiki 上传的外壳才显示 Wiki 绑定行。
const wikiHost = computed(() => shell.has(CAPABILITY.WIKI_UPLOAD))
const binding = computed(() => ctx.getDocumentBinding().value)
const wikiName = computed(() =>
  binding.value.sourceId === 'wiki-data' && binding.value.locator
    ? displayNameFromLocator(binding.value.locator)
    : null,
)
const wikiDirty = computed(() => {
  if (binding.value.sourceId !== 'wiki-data') return false
  const draft = buildWikiEditSummaryDraft(binding.value.saveBaseline, ctx.getDoc().value)
  return hasWikiAuditableChanges(draft) || ctx.getEditHistory().canUndo.value
})

function logClass(level: number): string {
  if (level & LOG_LEVEL.ERROR) return 'sb-item sb-item--error'
  if (level & LOG_LEVEL.WARN) return 'sb-item sb-item--warn'
  return 'sb-item'
}

function openWikiDataPage() {
  if (!binding.value.locator) return
  window.open(buildWikiDataPageUrl(binding.value.locator), '_blank', 'noopener')
}
</script>

<template>
  <div class="sb-root">
    <span v-if="log.lastDisplayable.value" :class="logClass(log.lastDisplayable.value.level)">
      {{ log.lastDisplayable.value.message }}
    </span>
    <span v-if="log.statusMessage && !log.lastDisplayable.value" class="sb-item">{{ log.statusMessage }}</span>
    <span v-if="wikiHost && wikiName" class="sb-item sb-item--link" @click="openWikiDataPage">
      {{ t('wikiStructure') }}: {{ wikiName }}
      <span v-if="wikiDirty" class="sb-unsaved"> · {{ t('unsaved') }}</span>
    </span>
    <span class="sb-spacer" />
    <span v-if="hasWorldMultiFrame" class="sb-item">
      Frame {{ (ctx.getFrameIndex()) + 1 }} / {{ frameCount }}
    </span>
  </div>
</template>

<style scoped>
.sb-root {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 14px;
  color: var(--wb-text-muted);
}
.sb-item { white-space: nowrap; font-size: 10px; }
.sb-item--link { cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.sb-item--link:hover { color: var(--wb-text); }
.sb-unsaved { color: var(--wb-warn); }
.sb-item--error { color: var(--wb-danger); }
.sb-item--warn { color: var(--wb-warn); }
.sb-spacer { flex: 1; }
</style>
