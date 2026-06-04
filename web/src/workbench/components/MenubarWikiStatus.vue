<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useContext } from '@/runtime/context'
import { isWikiHostProfile } from '@/runtime/hostProfile'
import { isWikiApiAvailable } from '@/wiki/mwApiAdapter'
import { t } from '@/config/i18n'

const ctx = useContext()
const ready = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

function sync(): void {
  const next = isWikiApiAvailable()
  ready.value = next
  const ui = ctx.wm.chrome.wikiUi
  if (ui) ui.mwReady.value = next
}

onMounted(() => {
  sync()
  timer = setInterval(sync, 400)
  window.setTimeout(sync, 0)
  window.setTimeout(sync, 800)
})

onBeforeUnmount(() => {
  if (timer != null) clearInterval(timer)
})
</script>

<template>
  <span v-if="isWikiHostProfile()" class="wb-menubar-wiki-status" :class="{ 'wb-menubar-wiki-status--ok': ready }">
    {{ ready ? t('wikiReady') : t('wikiLoginRequired') }}
  </span>
</template>

<style scoped>
.wb-menubar-wiki-status {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--wb-text-dim);
  padding: 0 8px;
  user-select: none;
}
.wb-menubar-wiki-status--ok {
  color: var(--wb-accent-muted, #7dd3fc);
}
</style>
