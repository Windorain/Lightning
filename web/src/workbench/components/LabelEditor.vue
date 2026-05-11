<script setup lang="ts">
import { ref } from 'vue'

const labelText = ref('')
const labelColor = ref('#ffffff')
const labelFontSize = ref(14)
</script>

<template>
  <div class="label-editor">
    <h4 class="le-heading">Label Editor</h4>
    <div class="le-field">
      <label class="le-label">Text</label>
      <input v-model="labelText" class="le-input" placeholder="Enter label text..." />
    </div>
    <div class="le-field">
      <label class="le-label">Color</label>
      <input v-model="labelColor" type="color" class="le-color" />
    </div>
    <div class="le-field">
      <label class="le-label">Size</label>
      <input v-model.number="labelFontSize" type="range" min="8" max="48" class="le-range" />
      <span class="le-size-val">{{ labelFontSize }}</span>
    </div>
  </div>
</template>

<style scoped>
.label-editor { padding: 12px; color: var(--nei-text-dark); font-size: 12px; }
.le-heading { margin: 0 0 8px; font-size: 12px; font-weight: 600; }
.le-field { margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
.le-label { min-width: 36px; font-size: 11px; color: var(--nei-muted); }
.le-input { flex: 1; padding: 3px 6px; border: 1px solid var(--nei-border); border-radius: 3px;
  background: var(--nei-bg); color: var(--nei-text-dark); font-size: 12px; }
.le-color { width: 28px; height: 22px; border: 1px solid var(--nei-border); border-radius: 3px;
  background: var(--nei-bg); cursor: pointer; padding: 1px; }
.le-range { flex: 1; }
.le-size-val { min-width: 20px; font-variant-numeric: tabular-nums; color: var(--nei-muted); }
</style>
