<script setup lang="ts">
/**
 * `AreaNodeView` —— **`AreaLayout` 的递归渲染单元**（#282 P10b Area 产品接线）。
 *
 * ## 为什么单独一个文件（而不是在同文件里自引用）
 *
 * 递归组件必须能引用自己。`<script setup>` 的自引用要求组件名可推导，而
 * "同文件两个 `<script>` 块 + 自引用"在本仓的 `@vitejs/plugin-vue` 版本上
 * 不可靠。**跨文件递归**是 Vue 官方支持的稳定形态（组件名由文件名推导），
 * 故拆成两个文件：本文件递归引用自己。
 *
 * ## 两种节点、两种语义（这是"分割"能成立的全部）
 *
 * | 节点 | 渲染 |
 * |---|---|
 * | `area` 叶子 | 一个 `AreaHost`（显式生命周期宿主） |
 * | `split` 内部节点 | 一个 flex 容器，`direction` 定方向、`ratio` 定份额，内含**两个**本组件 |
 *
 * 用真递归而不是"扁平化 + 绝对定位"：`ratio` 是**嵌套**语义（每次分割只切
 * 当前节点），扁平化会丢掉"哪次分割切的是哪一块"这一事实。
 *
 * ## 依赖注入而非层层传参
 *
 * 渲染一个叶子需要"该 Area 的实例 id / region / 组件 / 资源清单 / 账本"，
 * 而这些都是**外壳**（`AreaLayoutHost`）的知识。经 `provide`/`inject` 传递，
 * 递归的每一层不必知道它们 —— 否则每次加深一层都要多转一手 props。
 */
import { computed, inject } from 'vue'
import type { Component } from 'vue'
import AreaHost from '@/editors/AreaHost.vue'
import type { AreaLayoutNode } from '@/domain/workspace'
import { AREA_VIEW_CONTEXT, type AreaViewContext } from './areaViewContext'

const props = defineProps<{
  readonly node: AreaLayoutNode
}>()

const ctx = inject(AREA_VIEW_CONTEXT) as AreaViewContext
if (ctx === undefined) {
  // 缺注入是**装配错误**（本组件只应由 `AreaLayoutHost` 渲染）—— 响亮失败，
  // 不静默渲染一个空壳（#249 §13「不允许空接口/假成功」）。
  throw new Error('AreaNodeView 必须在 AreaLayoutHost 子树内使用（缺 AREA_VIEW_CONTEXT）')
}

const area = computed(() => (props.node?.kind === 'area' ? props.node : null))
const split = computed(() => (props.node?.kind === 'split' ? props.node : null))

/** 分割容器的方向与份额（`ratio` 是 `first` 的份额，0..1）。 */
const splitStyle = computed(() => {
  const s = split.value
  if (s === null) return {}
  const firstPct = `${Math.round(s.ratio * 100)}%`
  return s.direction === 'horizontal'
    ? { flexDirection: 'row' as const, '--first-size': firstPct }
    : { flexDirection: 'column' as const, '--first-size': firstPct }
})

function componentFor(editorType: string): Component | null {
  return ctx.componentFor(editorType)
}
</script>

<template>
  <!--
    ── 叶子：一个 Area ⇒ 一个显式生命周期宿主 ──

    `@pointerdown.capture`（M4-1）：**捕获阶段**在叶子根上设"最后操作的区"。
    捕获阶段 = 事件在到达 canvas / 面板 / 工具架之前先经过这里，于是无论用户
    点的是视口画面还是该区的下方面板，活动区都跟着指针走；用冒泡则会被
    canvas 上"恰好 stopPropagation"的处理链截断（那正是"点了 B 却切了 A"的形态）。

    它只写 `useAreaHost#setActive`（唯一写点），不做任何布局决定。
  -->
  <div
    v-if="area"
    class="area-node area-node--leaf"
    :data-area-id="area.id"
    :data-wm-region="ctx.regionIdFor(area.id)"
    @pointerdown.capture="ctx.onActivateArea(area.id)"
  >
    <AreaHost
      :area-id="area.id"
      :region-id="ctx.regionIdFor(area.id)"
      :editor-type="area.editorType"
      :instance-id="ctx.instanceIdOf(area.id)"
      :resources="ctx.resourcesOf(area.editorType)"
      :editor="componentFor(area.editorType)"
      :get-ledger="ctx.ledger"
      :local-state="ctx.localStateOf(area.id, area.editorType)"
      :on-local-state-capture="ctx.onLocalStateCapture"
      :on-ledger-change="ctx.setLedger"
      @instance-open="ctx.onInstanceOpen"
      @instance-close="ctx.onInstanceClose"
      @lifecycle-error="ctx.onLifecycleError"
    />
  </div>

  <!-- ── 内部节点：一次分割 ⇒ 一个 flex 容器 + 两个子节点 ── -->
  <div
    v-else-if="split"
    class="area-node area-node--split"
    :data-split-id="split.id"
    :data-split-direction="split.direction"
    :style="splitStyle"
  >
    <div class="area-node__first">
      <AreaNodeView :node="split.first" />
    </div>
    <div class="area-node__divider" role="separator" aria-orientation="vertical" />
    <div class="area-node__second">
      <AreaNodeView :node="split.second" />
    </div>
  </div>
</template>

<style scoped>
.area-node {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
.area-node--leaf {
  position: relative;
  overflow: hidden;
}
.area-node--split {
  /* 方向由 `splitStyle` 的 flexDirection 决定（horizontal ⇒ row） */
  align-items: stretch;
}
.area-node__first {
  flex: 0 0 var(--first-size, 50%);
  min-width: 0;
  min-height: 0;
  display: flex;
}
.area-node__second {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.area-node__divider {
  flex: 0 0 1px;
  background: var(--wb-border);
  z-index: 5;
}
</style>