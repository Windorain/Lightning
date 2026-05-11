<script setup lang="ts">
const props = defineProps<{ annotationId?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <div class="annot-editor">
    <h4 class="ae-heading">Annotation Editor</h4>
    <p class="ae-hint" v-if="!annotationId">Create an annotation box by dragging in the viewport</p>
    <p class="ae-hint" v-else>Editing annotation {{ annotationId }}</p>
  </div>
</template>

<style scoped>
.annot-editor { padding: 12px; color: var(--nei-text-dark); font-size: 12px; }
.ae-heading { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
.ae-hint { margin: 0; color: var(--nei-muted); }
</style>
