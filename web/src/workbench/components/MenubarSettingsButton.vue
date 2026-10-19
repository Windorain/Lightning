<script setup lang="ts">
/**
 * 顶栏「设置」入口（打开 `WorkbenchSettingsDrawer`）。
 *
 * ## 为什么需要它（M5-5）
 *
 * 设置抽屉是**内置示例 / 数据源**的唯一产品入口，但在此之前全树没有任何代码把
 * `workbenchSettingsOpen` 置为 `true` ⇒ 抽屉与 `LocalBundlePanel` 在产品里**不可达**
 * （M5-S0-A 的 G8：「通道预览的唯一入口没有产品样本」——样本进了目录也点不到）。
 * 本组件只做一件事：把抽屉的既有开关接到一个真实按钮上，不新增任何设置语义。
 *
 * 开关本体仍由 `WorkbenchRoot` 拥有（`provide('workbenchSettingsOpen')`）——
 * 这里不复制状态，避免出现第二份"抽屉开没开"。
 */
import { inject, type Ref } from 'vue'

const settingsOpen = inject<Ref<boolean>>('workbenchSettingsOpen')!
</script>

<template>
  <button
    type="button"
    class="wb-menubar-settings-btn"
    title="设置"
    aria-label="设置"
    @click="settingsOpen = true"
  >
    设置
  </button>
</template>

<style scoped>
.wb-menubar-settings-btn {
  flex-shrink: 0;
  margin-left: 8px;
  border: 1px solid var(--wb-border);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  padding: 4px 10px;
  font-size: 12px;
  border-radius: var(--wb-radius-sm, 4px);
  cursor: pointer;
}
.wb-menubar-settings-btn:hover {
  background: var(--wb-bg-hover);
  border-color: var(--wb-accent);
  color: var(--wb-accent-muted, var(--wb-text));
}
</style>
