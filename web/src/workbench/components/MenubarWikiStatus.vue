<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useContext } from '@/runtime/context'
import { useShell } from '@/composition/shell'
import { CAPABILITY } from '@/composition/modules'
import { isWikiApiAvailable } from '@/wiki/mwApiAdapter'

const ctx = useContext()
/** 本实例的翻译（消费本实例语言，无模块级全局读源）。 */
const t = ctx.t
const shell = useShell()
/**
 * 旧实现是模板里直接调 `isWikiHostProfile()`（**组件询问宿主名**
 * 是禁止的形态）。现在模板只看这个**能力派生**的布尔：
 * 问的是"本外壳有没有 Wiki 上传面"，不是"宿主叫什么"。
 */
const showWikiStatus = shell.has(CAPABILITY.WIKI_UPLOAD)
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
  <span v-if="showWikiStatus" class="wb-menubar-wiki-status" :class="{ 'wb-menubar-wiki-status--ok': ready }">
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
