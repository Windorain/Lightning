<script setup lang="ts">
import { computed } from 'vue'
import { useContext } from '@/runtime/context'
import ToolGroupButton from './ToolGroupButton.vue'
import type { Tool } from '@/workbench/tools/tool'

const ctx = useContext()
const tools = computed(() => [...ctx.toolRegistry.tools.values()])

// Group tools: tools with the same `group` field, plus ungrouped tools as singleton groups
const groups = computed(() => {
  const map = new Map<string, Tool[]>()
  for (const t of tools.value) {
    const key = t.group ?? `__single__${t.id}`
    const arr = map.get(key)
    if (arr) arr.push(t)
    else map.set(key, [t])
  }
  return [...map.values()]
})
</script>

<template>
  <ToolGroupButton
    v-for="g in groups"
    :key="g[0]!.id"
    :members="g"
  />
</template>
