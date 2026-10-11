<script setup lang="ts">
/**
 * Workbench 主布局壳：Blender 风格 3 列。
 * 通过 named slots 让父组件控制各区域的内容与 props。
 *
 * ## B5 #7：`VITE_HOST_PROFILE` 的最后一处组件级读取已退役
 *
 * 旧实现（本文件的历史版本）：
 *
 * ```ts
 * const wikiEmbed = import.meta.env.VITE_HOST_PROFILE === 'wiki'
 * ```
 *
 * 这是**组件在询问宿主名**（#249 §10 明文禁止），而且它把"嵌入进来时高度要
 * 撑满容器而不是 100vh"这件**布局事实**绑死在构建期常量上。
 *
 * 现在改问外壳能力：`shell.adjustableLayout === false` ⇒ 该外壳是固定布局
 * （嵌入/查看器）⇒ 用 `height: 100%` 而不是 `100vh`。
 * 语义更准：判据是"这个外壳是否可调整布局"，不是"构建时是不是 wiki"。
 */
import { useSlots } from 'vue'
import { useContext } from '@/runtime/context'
import { useShell } from '@/composition/shell'
import { usePanelResize } from './panelResize'

const ctx = useContext()
const shell = useShell()
const { rightWidth, startRightDrag, dragging } = usePanelResize(ctx)
const slots = useSlots()
const hasProperties = () => !!slots.properties
/**
 * 固定布局（不可调整 Area 布局）的外壳填满宿主容器；可调整布局的用 `100vh`。
 * 判据来自**装配结果**（`shellLayouts.adjustableLayout`），不是宿主名。
 */
const fillsHost = !shell.adjustableLayout
</script>

<template>
  <!--
    实例作用域属性（#259 A33）：主题/语言落在**实例根元素**，自定义属性沿 DOM 继承，
    于是同页两个工作台实例各持一份。旧路径写 `document.documentElement`
    （全页一份）会让第二个挂载的实例改掉第一个的呈现。
  -->
  <div
    class="wb-shell"
    :class="{ 'wb-shell--dragging': dragging, 'wb-shell--fills-host': fillsHost }"
    v-bind="ctx.getShellSettings().scopeAttrs"
  >
    <header class="wb-menubar">
      <slot name="menubar" />
    </header>

    <nav class="wb-workspace-tabs">
      <slot name="workspace-tabs" />
    </nav>

    <div class="wb-main">
      <main class="wb-viewport">
        <slot name="tool-shelf" />
        <slot name="viewport" />
      </main>

      <div
        v-if="hasProperties()"
        class="wb-divider wb-divider--right"
        @pointerdown="startRightDrag"
        role="separator"
        aria-orientation="vertical"
        tabindex="-1"
      />

      <aside v-if="hasProperties()" class="wb-properties" :style="{ width: `${rightWidth}px` }">
        <slot name="properties" />
      </aside>
    </div>

    <footer class="wb-statusbar">
      <slot name="statusbar" />
    </footer>
  </div>
</template>

<style>
.wb-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--wb-bg-deepest);
  color: var(--wb-text);
  font-family: system-ui, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
  font-size: 13px;
}
.wb-shell--dragging * { cursor: col-resize !important; }

/* 灰机词条内嵌 / 查看器外壳：填满宿主容器，不用 100vh 盖住 Wiki 顶栏。
   判据是**装配**（固定布局外壳），不是构建期宿主名 —— 见 script 注释。 */
.wb-shell--fills-host {
  height: 100%;
  min-height: 480px;
  max-height: none;
}

.wb-menubar {
  flex-shrink: 0;
  height: 36px;
  background: var(--wb-bg-elevated);
  border-bottom: 1px solid var(--wb-border);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.15);
}

.wb-workspace-tabs {
  flex-shrink: 0;
  height: 38px;
  background: var(--wb-bg-surface);
  border-bottom: 1px solid var(--wb-border);
  box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.1);
}

.wb-main {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.wb-divider {
  flex-shrink: 0;
  width: 1px;
  cursor: col-resize;
  background: var(--wb-border);
  transition: background 0.15s;
  z-index: 10;
  position: relative;
}
.wb-divider::after {
  content: '';
  position: absolute;
  inset: -4px -6px;
}
.wb-divider:hover,
.wb-divider:active {
  background: var(--wb-accent);
}

.wb-viewport {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  background: var(--wb-viewport-bg);
  background-image:
    linear-gradient(var(--wb-grid-color) 1px, transparent 1px),
    linear-gradient(90deg, var(--wb-grid-color) 1px, transparent 1px);
  background-size: 32px 32px;
}

.wb-properties {
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--wb-bg-elevated);
  border-left: 1px solid var(--wb-border);
}

.wb-statusbar {
  flex-shrink: 0;
  height: 26px;
  background: var(--wb-bg-surface);
  border-top: 1px solid var(--wb-border);
  box-shadow: 0 -1px 0 rgba(0, 0, 0, 0.15);
  font-size: 10px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  color: var(--wb-text-muted);
}
</style>
