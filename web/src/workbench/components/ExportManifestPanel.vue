<script setup lang="ts">
/**
 * **导出资源清单面板（UI 展示，不产生第二个下载文件）**。
 *
 * ## 两块来源不同、身份也不同（设计 §10.4）
 *
 * | 块 | 内容 | 来源 | 进 digest |
 * |---|---|---|---|
 * | **A** | `canonical` 逐行文本 + `digest` | `outcome.assetManifest`（请求里那份冻结清单） | **是**（它就是摘要的输入） |
 * | **B** | 纹理身份 / 采样参数 / 序列规格 | `outcome.captureFacts`（捕获期只读面） | **否**（塞进 `ExportAssetNeed` 会改 digest） |
 *
 * 面板**不下载**任何东西：一次导出只有产物本身（`delivery: 'panel'`）。
 * A 块是等宽可选中文本，作为"没有机器可读清单文件"的最小补偿。
 */
import type { ExportAssetManifest, ExportCaptureFacts } from '@/application/exportPlan'

const props = defineProps<{
  /** 产物格式（同页两个卡片各自一块面板；e2e 据此区分）。 */
  readonly format: 'iso-png' | 'scene-gif'
  /**
   * A 块来源（`null` = 本次导出没有成功结局 ⇒ **不渲染面板**）。
   *
   * 用 `null` 而不是"空字符串清单"：失败/未导出时不能显示一张看起来
   * "零资源"的表（那会把"没有清单"读成"无需资源"）。
   */
  readonly manifest: ExportAssetManifest | null
  /** B 块来源；`null` = 捕获面没有提供明细（显示"无纹理资源"，不伪造空表）。 */
  readonly facts: ExportCaptureFacts | null
}>()

function samplingText(s: { filter: string; wrap: string; flipY: boolean; mipmaps: boolean; anisotropy: number }): string {
  return `filter=${s.filter};wrap=${s.wrap};flipY=${String(s.flipY)};mipmaps=${String(s.mipmaps)};anisotropy=${s.anisotropy}`
}

function sequenceText(s: { frameCount: number; durationsMs: readonly number[] } | null): string {
  return s === null ? 'static' : `frames=${s.frameCount};durationsMs=${s.durationsMs.join(',')}`
}
</script>

<template>
  <div
    v-if="props.manifest"
    class="ew-manifest"
    data-export-manifest-panel
    :data-manifest-format="props.format"
  >
    <div class="ew-manifest-head">
      <h4>资源清单</h4>
      <span class="ew-manifest-delivery" data-manifest-delivery="panel">面板交付（不下载清单文件）</span>
    </div>

    <!-- A 块：对账权威（canonical + digest；digest 的输入就是它） -->
    <div class="ew-manifest-label">A 清单（进 digest，对账权威）</div>
    <pre class="ew-manifest-canonical" data-manifest-canonical>{{ props.manifest.canonical }}</pre>
    <div v-if="props.manifest.canonical === ''" class="ew-manifest-empty">无资源条目</div>
    <div class="ew-manifest-digest">digest <span data-manifest-digest>{{ props.manifest.digest }}</span></div>

    <!-- B 块：人读明细（不进 digest） -->
    <div class="ew-manifest-label">B 资源明细（不进 digest）</div>
    <div data-manifest-facts class="ew-manifest-facts">
      <div v-if="props.facts === null || props.facts.textures.length === 0" class="ew-manifest-empty">
        无纹理资源
      </div>
      <table v-else class="ew-manifest-table">
        <thead>
          <tr>
            <th>材质</th>
            <th>纹理</th>
            <th>采样</th>
            <th>序列</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(t, i) in props.facts.textures" :key="i" data-manifest-fact>
            <td data-manifest-field="material">{{ t.materialId }}@{{ t.materialVersion }}</td>
            <td data-manifest-field="texture">{{ t.textureId }}@{{ t.textureVersion }}</td>
            <td data-manifest-field="sampling">{{ samplingText(t.sampling) }}</td>
            <td data-manifest-field="sequence">{{ sequenceText(t.sequence) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.ew-manifest {
  margin-top: 12px;
  padding: 12px;
  border-radius: var(--wb-radius-md);
  border: 1px dashed var(--wb-border);
  background: var(--wb-bg-base, var(--wb-bg-surface));
}
.ew-manifest-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ew-manifest h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--wb-text); }
.ew-manifest-delivery { font-size: 11px; color: var(--wb-text-dim); }
.ew-manifest-label { margin-top: 8px; font-size: 11px; color: var(--wb-text-dim); }
.ew-manifest-canonical {
  margin: 4px 0 0;
  padding: 8px;
  max-height: 140px;
  overflow: auto;
  border-radius: var(--wb-radius-sm, 4px);
  background: var(--wb-bg-elevated);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-text);
  white-space: pre;
  user-select: text;
}
.ew-manifest-digest { margin-top: 4px; font-size: 11px; color: var(--wb-text-dim); }
.ew-manifest-digest span { font-family: 'JetBrains Mono', ui-monospace, monospace; color: var(--wb-text); }
.ew-manifest-facts { margin-top: 4px; }
.ew-manifest-empty { font-size: 12px; color: var(--wb-text-dim); }
.ew-manifest-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.ew-manifest-table th, .ew-manifest-table td {
  text-align: left;
  padding: 3px 6px;
  border-bottom: 1px solid var(--wb-border);
  color: var(--wb-text);
  vertical-align: top;
}
.ew-manifest-table th { color: var(--wb-text-dim); font-weight: 500; }
</style>
