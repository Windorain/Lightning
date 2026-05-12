<script setup lang="ts">
import { useSelectionContext } from '@/workbench/selectionContext'

const selection = useSelectionContext()
void selection // Referenced by WorkbenchViewport via imperative Three.js rendering
</script>

<template>
  <!-- Rendered imperatively by WorkbenchViewport via Three.js LineSegments -->
</template>
