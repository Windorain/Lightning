<script setup lang="ts">
import { provide } from 'vue'
import { provideContext } from '@/runtime/context'
import type { Context } from '@/runtime/context'
import { hostKey, type Host } from '@/runtime/host'

const props = defineProps<{
  host: Host
  ctx: Context
}>()

provideContext(props.ctx)
provide(hostKey, props.host)
</script>

<template>
  <slot />
</template>
