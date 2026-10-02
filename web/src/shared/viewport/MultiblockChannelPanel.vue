<script setup lang="ts">
/**
 * MultiblockChannelPanel — 「通道」面板（计划 T2.4）。
 *
 * 纯叶子：只有 props / emits，不读 ctx、不做装配（装配在 `useMultiblockChannels` + T2.2 装配器）。
 * 内容**完全来自文件声明**：Tier 滑杆（范围 1..最大总等级）+ 每通道一条滑杆（范围 0..取值域上界，
 * 0 显示 `Not set`）+ 运行态切换（呈现名来自文件）+ 只提示不拒绝的提示列表。
 * 不重复造 Layer 滑杆（分层预览 tab 已有）。
 *
 * 无头断言用的稳定观测选择器（T2.6）：
 *   `[data-mb-panel="channels"]`       面板根（带 `data-mb-variant` / `data-mb-dims` / `data-mb-tier` / `data-mb-runstate`）
 *   `[data-dock-tab="channels"]`       tab 按钮（在 Dock 上）
 *   `input[data-mb-tier]`              Tier 滑杆（min/max/step + `[data-mb-tier-value]` 值文本）
 *   `input[data-mb-channel="<key>"]`   通道滑杆（`-name` / `-kind` / `-hi` / `-eff-min` / `-eff-max`）
 *   `[data-mb-channel-value="<key>"]`  通道值文本（0 → `Not set`）
 *   `select[data-mb-runstate-select]`  运行态切换（option 带 `data-mb-runstate-id`）
 *   `[data-mb-notices] [data-mb-notice]` 提示列表（软约束 / 回落 / 夹取）
 */
import { formatChannelValue, type MultiblockChannelPanelModel } from './multiblockChannelUi'

const props = defineProps<{ model: MultiblockChannelPanelModel }>()

const emit = defineEmits<{
  'update:tier': [value: number]
  'update:value': [payload: { key: string; value: number }]
  'update:runstate': [id: string]
}>()

function readInt(e: Event): number {
  const el = e.target as HTMLInputElement
  const n = Math.trunc(Number(el.value))
  return Number.isFinite(n) ? n : 0
}

function onTierInput(e: Event): void {
  emit('update:tier', readInt(e))
}

function onChannelInput(key: string, e: Event): void {
  emit('update:value', { key, value: readInt(e) })
}

function onRunstateChange(e: Event): void {
  emit('update:runstate', (e.target as HTMLSelectElement).value)
}

function valueOf(key: string): number {
  return props.model.values[key] ?? 0
}
</script>

<template>
  <div
    class="vp-mb"
    data-mb-panel="channels"
    :data-mb-display-name="model.displayName"
    :data-mb-variant="model.variantKey"
    :data-mb-dims="model.dims"
    :data-mb-tier="String(model.tier)"
    :data-mb-tier-min="String(model.tierMin)"
    :data-mb-tier-max="String(model.tierMax)"
    :data-mb-tier-samples="model.tierSamples.join(',')"
    :data-mb-runstate="model.runstate"
  >
    <div class="vp-mb__col vp-mb__col--sliders">
      <div class="vp-mb__row">
        <label class="vp-mb__label" for="mb-tier">Tier</label>
        <input
          id="mb-tier"
          class="vp-mb__range"
          type="range"
          :min="model.tierMin"
          :max="model.tierMax"
          step="1"
          :value="model.tier"
          list="mb-tier-samples"
          data-mb-tier
          @input="onTierInput"
        >
        <datalist id="mb-tier-samples">
          <option v-for="t in model.tierSamples" :key="t" :value="t" />
        </datalist>
        <span class="vp-mb__value" data-mb-tier-value>{{ model.tier }}</span>
      </div>

      <div v-for="ch in model.channels" :key="ch.key" class="vp-mb__row">
        <label
          class="vp-mb__label"
          :for="`mb-ch-${ch.key}`"
          :data-mb-channel-label="ch.key"
          :title="ch.kind"
        >{{ ch.name }}</label>
        <input
          :id="`mb-ch-${ch.key}`"
          class="vp-mb__range"
          type="range"
          min="0"
          :max="ch.hi"
          step="1"
          :value="valueOf(ch.key)"
          :data-mb-channel="ch.key"
          :data-mb-channel-name="ch.name"
          :data-mb-channel-kind="ch.kind"
          :data-mb-channel-hi="String(ch.hi)"
          :data-mb-channel-eff-min="String(ch.min)"
          :data-mb-channel-eff-max="String(ch.max)"
          @input="onChannelInput(ch.key, $event)"
        >
        <span class="vp-mb__value" :data-mb-channel-value="ch.key">
          {{ formatChannelValue(valueOf(ch.key)) }}
        </span>
      </div>
    </div>

    <div class="vp-mb__col vp-mb__col--side">
      <div class="vp-mb__row vp-mb__row--runstate">
        <label class="vp-mb__label" for="mb-runstate">运行态</label>
        <select
          id="mb-runstate"
          class="vp-mb__select"
          :value="model.runstate"
          data-mb-runstate-select
          @change="onRunstateChange"
        >
          <option
            v-for="rs in model.runstates"
            :key="rs.id"
            :value="rs.id"
            :data-mb-runstate-id="rs.id"
          >{{ rs.name }}</option>
        </select>
      </div>

      <ul v-if="model.notices.length > 0" class="vp-mb__notices" data-mb-notices>
        <li v-for="(n, i) in model.notices" :key="i" class="vp-mb__notice" data-mb-notice>{{ n }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.vp-mb {
  flex: 1; min-width: 0; min-height: 0;
  display: flex; align-items: flex-start; gap: 16px;
  font: inherit; color: inherit;
}
.vp-mb__col { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.vp-mb__col--sliders { flex: 1 1 auto; }
.vp-mb__col--side { flex: 0 1 260px; min-width: 200px; }
.vp-mb__row {
  display: grid; grid-template-columns: minmax(56px, max-content) minmax(90px, 1fr) 56px;
  align-items: center; gap: 8px; min-width: 0;
}
.vp-mb__row--runstate { grid-template-columns: minmax(56px, max-content) minmax(90px, 1fr); }
.vp-mb__label { font-size: 11px; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vp-mb__range { width: 100%; min-width: 0; height: 14px; cursor: pointer; }
.vp-mb__value { font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.vp-mb__select {
  width: 100%; min-width: 0; font: inherit; font-size: 11px;
  padding: 1px 2px; background: transparent; color: inherit;
  border: 1px solid currentColor; border-radius: 0; opacity: 0.9;
}
.vp-mb__notices {
  margin: 2px 0 0; padding: 0 0 0 14px; list-style: disc;
  max-height: 42px; overflow-y: auto;
  font-size: 10px; line-height: 1.35; opacity: 0.72;
}
.vp-mb__notice { white-space: normal; word-break: break-word; }
</style>
