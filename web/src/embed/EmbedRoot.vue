<script setup lang="ts">
/**
 * EmbedRoot — 嵌入场景的 ctx Owner。
 */
import { onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import type { EmbedBootstrapOptions } from '@/embed/embedContract'
import { formatUnknownError } from '@/util/formatUnknownError'
import { createEmbedHost } from '@/runtime/host/embedHost'
import { useKernelFrameLoop } from '@/composition/useKernelFrameLoop'
import HostProvider from '@/runtime/HostProvider.vue'
import EmbedViewport from '@/shared/viewport/EmbedViewport.vue'
import { buildEmbedSettingsFromBootstrap } from '@/viewer/viewerConfig'
import { createEmbedShellRuntime, shellKey } from '@/composition/shell'
import { createEmbedAssemblyProbe, registerEmbedAssemblyProbe } from '@/embed/embedAssemblyProbe'
import { REGION } from '@/runtime/regionIds'

const props = defineProps<{
  bootstrap: EmbedBootstrapOptions
  /**
   * **本嵌入实例身份**（M7-6）：由装配层 `embed/mount` 分配。
   *
   * 它是本实例持久化键与日志观测面的唯一键。缺省 `'embed'` 只为
   * 宿主直接 `createApp(EmbedRoot, { bootstrap })` 的旧用法保留一个可解释的形态；
   * 走 `mount()` 的生产路径恒传一个逐实例不同的 id。
   */
  instanceId?: string
}>()

const settings = buildEmbedSettingsFromBootstrap({
  ui: props.bootstrap.ui,
  features: props.bootstrap.features,
})

/**
 * **本实例的外壳运行实例**（M7-4 段 A / D1）：由 `EMBED_PROFILE` 解析而来。
 *
 * ## 这里修的是什么
 *
 * 旧实现调 `createEmbedHost(settings, …, undefined)`（第三个参数缺省）⇒ 宿主落在
 * `EMPTY_SHELL`（能力空集）—— 于是 `EMBED_PROFILE` 的装配结果（以及它的
 * `pruned` / `prunedLandings`）在生产里**零消费者**：A14/A15 只活在
 * `assembly.test.ts` 里。现在装配结果是真的输入：
 *   - `provide(shellKey, shell)` ⇒ 组件问能力（`useShell()`）能拿到本实例的装配；
 *   - `createEmbedHost(…, shell)` ⇒ 内核会话的能力集合 = 装配结果（A15 的运行时落点）。
 *
 * ## 为什么是"写死 EMBED_PROFILE"而不是读构建期变量
 *
 * 见 `composition/shell#createEmbedShellRuntime`：嵌入库只有一个装配形态，
 * 它的 profile 是产品代码的事实，不是构建配置的事实。
 */
const shell = createEmbedShellRuntime()
provide(shellKey, shell)

const { host, ctx } = createEmbedHost(settings, {
  structureBase: props.bootstrap.structureBase,
  workbenchEdit: props.bootstrap.workbenchEdit,
  handlers: props.bootstrap.handlers,
}, shell, props.instanceId ?? 'embed')

/**
 * **装配只读面**（M7-4 段 A）：把**本实例真实的** `shell.assembly` 登记进按实例的
 * 探针表（`window.__lk_embed__.probes()`）。
 *
 * 登记发生在 `onMounted`、注销发生在 `onBeforeUnmount`：探针的寿命与实例一致
 * （同页两个 `mount()` ⇒ 两条记录，不互相覆盖）。它只读装配结果，不产生第二套能力真源。
 */
let unregisterAssemblyProbe: (() => void) | null = null
onMounted(() => {
  unregisterAssemblyProbe = registerEmbedAssemblyProbe(createEmbedAssemblyProbe({
    profileId: shell.profileId,
    regionId: REGION.EMBED,
    assembly: shell.assembly,
    ctx,
  }))
})
onBeforeUnmount(() => {
  unregisterAssemblyProbe?.()
  unregisterAssemblyProbe = null
})

// **内核帧循环**（P10 #261 / R-WK-03）：嵌入外壳同样由宿主按帧注入时间。
// 与工作台各自独立（时间属共享 EditContext ⇒ 同页两实例各播各的互不影响）。
useKernelFrameLoop(ctx)

const loadError = ref('')

async function load() {
  loadError.value = ''
  try {
    await ctx.getOperators().exec('OPERATOR_LOAD_EMBED_DOCUMENT', {
      document: props.bootstrap.data.document,
    })
  } catch (e) {
    loadError.value = formatUnknownError(e)
  }
}

watch(
  () => props.bootstrap,
  () => { void load() },
  { deep: true, immediate: true },
)
</script>

<template>
  <HostProvider :host="host" :ctx="ctx">
    <div v-if="loadError" class="embed-boot embed-boot--err">
      {{ loadError }}
    </div>
    <EmbedViewport v-else-if="ctx.hasLoadedDocument()" :settings="settings" />
    <div v-else class="embed-boot embed-boot--loading">
      <div class="embed-boot-spinner"></div>
      <span>加载中…</span>
    </div>
  </HostProvider>
</template>

<style scoped>
.embed-boot {
  padding: 16px;
  font-family: system-ui, sans-serif;
  color: var(--wb-text);
  background: var(--wb-viewport-bg);
  min-height: 40vh;
}
.embed-boot--loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 120px;
}
.embed-boot-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--nei-border-panel);
  border-top-color: var(--nei-accent);
  border-radius: 50%;
  animation: embed-spin 0.6s linear infinite;
}
@keyframes embed-spin {
  to { transform: rotate(360deg); }
}
.embed-boot--err {
  color: #fecaca;
  white-space: pre-wrap;
}
</style>