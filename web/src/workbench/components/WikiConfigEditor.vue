<script setup lang="ts">
import { wikiConfig } from '@/workbench/wikiConfig'
</script>

<template>
  <div class="pe-panel">
    <div class="pe-title">Wiki 配置</div>

    <h3>组件开关</h3>
    <div class="wc-grid">
      <label v-for="(_, key) in wikiConfig.features" :key="key" class="wc-check">
        <input type="checkbox" v-model="wikiConfig.features[key]" />
        <span>{{ key }}</span>
      </label>
    </div>

    <h3>视口尺寸</h3>
    <div class="wc-grid">
      <label class="wc-field"><span>宽</span><input v-model.number="wikiConfig.viewWidth" type="number" min="200" max="2000" step="10" /></label>
      <label class="wc-field"><span>高</span><input v-model.number="wikiConfig.viewHeight" type="number" min="150" max="1500" step="10" /></label>
    </div>

    <h3>初始摄像头</h3>
    <div class="wc-grid">
      <label class="wc-field"><span>偏航角 yaw (°)</span><input v-model.number="wikiConfig.cameraYaw" type="number" min="0" max="360" step="5" /></label>
      <label class="wc-field"><span>俯仰角 elevation (°)</span><input v-model.number="wikiConfig.cameraElevation" type="number" min="5" max="85" step="5" /></label>
      <label class="wc-field"><span>缩放（与滚轮相同，1=默认）</span><input v-model.number="wikiConfig.cameraZoom" type="number" min="0.05" max="50" step="0.1" /></label>
    </div>
  </div>
</template>

<style scoped>
.pe-panel { padding: 10px; font-size: 12px; }
.pe-title { font-size: 13px; font-weight: 600; color: var(--nei-text); text-shadow: var(--nei-label-shadow); margin-bottom: 8px; }
h3 { font-size: 11px; font-weight: 600; color: var(--nei-label); margin: 10px 0 4px; text-transform: uppercase; letter-spacing: 0.3px; }
.wc-grid { display: flex; flex-direction: column; gap: 4px; }
.wc-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--nei-text-dark); cursor: pointer; }
.wc-check input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--nei-accent); }
.wc-field { display: flex; flex-direction: column; gap: 2px; }
.wc-field span { font-size: 10px; color: var(--nei-label); }
.wc-field input, .wc-field select {
  padding: 4px 6px; border-radius: 4px; border: var(--nei-bevel-w) solid;
  border-color: var(--nei-shadow) var(--nei-highlight) var(--nei-highlight) var(--nei-shadow);
  background: var(--nei-inset-bg); color: var(--nei-text); font-size: 11px;
}
</style>
