<script setup lang="ts">
/**
 * 工作台入口：聚合根全量子组件 + 子树错误边界。
 */
import { onErrorCaptured, ref } from 'vue'

import WorkbenchRoot from '@/workbench/WorkbenchRoot.vue'
import { formatUnknownError } from '@/util/formatUnknownError'

const bootError = ref<string | null>(null)

onErrorCaptured((err) => {
  bootError.value = formatUnknownError(err)
  console.error('[StructureRenderer] WorkbenchRoot', err)
  return false
})
</script>

<template>
  <div v-if="bootError" class="wm-boot wm-boot--err">
    {{ bootError }}
  </div>
  <WorkbenchRoot v-else />
</template>

<style scoped>
.wm-boot {
  padding: 16px;
  font-family: system-ui, sans-serif;
  color: var(--wb-text);
  background: var(--wb-viewport-bg);
  min-height: 40vh;
}
.wm-boot--err {
  color: #fecaca;
  white-space: pre-wrap;
}
</style>
