<script setup lang="ts">
import { provide } from 'vue'
import { provideContext } from '@/runtime/context'
import type { Context } from '@/runtime/context'
import { hostKey, type Host } from '@/runtime/host'
import { contentIssueReporterKey } from '@/editors/contentBoundary'
import { createContentBoundaryDiagnostics } from '@/runtime/contentDiagnostics'

const props = defineProps<{
  host: Host
  ctx: Context
}>()

provideContext(props.ctx)
provide(hostKey, props.host)

/**
 * 内容边界 → 诊断通道。
 *
 * 依赖方向是 runtime → editors：这里把"报告函数"注入下去，呈现组件
 * （`ContentText.vue`）只声明它需要一个接收拒绝事实的回调，**不**知道
 * 诊断记录器的存在。`editors/` 因此不反向依赖 `runtime/` 的实现。
 */
provide(
  contentIssueReporterKey,
  createContentBoundaryDiagnostics(props.ctx.wm.diagnostics),
)
</script>

<template>
  <slot />
</template>
