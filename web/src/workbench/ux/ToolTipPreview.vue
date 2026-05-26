<script setup lang="ts">
import { computed } from 'vue'
import { renderTooltipHtml } from '@/workbench/components/renderTooltipHtml'

const props = defineProps<{
  lines: string[]
}>()

const html = computed(() => props.lines.map(line => renderTooltipHtml(line)).join('\n'))
</script>

<template>
  <div class="tip-preview">
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="tip-preview-body" v-html="html" />
  </div>
</template>

<style>
/* Matches real MC/NEI rendering from CodeChickenLib GuiDraw.java */
.tip-preview {
  box-sizing: border-box;
  padding: 6px 8px;
  font-size: 14px;
  line-height: 1.5;
  font-family: system-ui, 'Segoe UI', sans-serif;
  color: #aaaaaa;
  background: rgba(16, 0, 16, 0.94);
  border: 1px solid;
  border-color: rgba(80, 0, 255, 0.25) rgba(80, 0, 255, 0.2) rgba(40, 0, 127, 0.3) rgba(80, 0, 255, 0.2);
  border-radius: 0;
  box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.4);
  width: 100%;
}

.tip-preview-body {
  margin: 0;
  white-space: pre-line;
  overflow-wrap: break-word;
  word-break: normal;
  text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.5);
}

.tip-preview-body::first-line {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.6;
  color: #ffffff;
}

.tip-preview-body strong {
  font-weight: 700;
  text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.6);
}

.tip-preview-body em { font-style: italic; }

.tip-preview-body code {
  font-family: 'JetBrains Mono', ui-monospace, 'Cascadia Code', monospace;
  background: rgba(0, 0, 0, 0.2);
  padding: 0 3px;
  border-radius: 0;
  text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.5);
}

.tip-preview-body a {
  color: #60a5fa;
  text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.5);
}

.tip-preview-body span {
  text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.4);
}
</style>
