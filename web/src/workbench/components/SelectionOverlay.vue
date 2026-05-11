<script setup lang="ts">
import { useSelectionContext } from '@/workbench/selectionContext'

const selection = useSelectionContext()
void selection
</script>

<template>
  <!-- Selection wireframe overlay rendered by WorkbenchViewport using SelectionContext items -->
</template>
