<script setup lang="ts">
/**
 * 底栏状态条：模型信息 + 帧信息 + 渲染状态 + Wiki 绑定
 */
import { computed } from 'vue'
import { LOG_LEVEL } from '@/logging/LogCenter'
import { useContext } from '@/runtime/context'
import { isWikiHostProfile } from '@/runtime/hostProfile'
import { buildWikiDataPageUrl, displayNameFromLocator } from '@/wiki/wikiUrls'
import { buildWikiEditSummaryDraft, hasWikiAuditableChanges } from '@/wiki/wikiEditSummary'
import { t } from '@/config/i18n'

const ctx = useContext()
const log = ctx.log

const frameCount = computed(() => ctx.getDoc().value?.frameCount ?? 0)
const hasWorldMultiFrame = computed(() => frameCount.value > 1)

const wikiHost = computed(() => isWikiHostProfile())
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
      Frame {{ (ctx.getCurrentFrameIndex().value ?? 0) + 1 }} / {{ frameCount }}
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
