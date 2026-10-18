/**
 * 库入口：挂载 Wiki 结构渲染器（显式 bootstrap，无隐式配置）。
 */

import { createApp } from 'vue'

import EmbedRoot from '@/embed/EmbedRoot.vue'
import { ensureMobileFitHost } from '@/embed/mobileFitHost'
import { initEmbedTouchSim } from '@/embed/touchPointer'
import { allocateEmbedInstanceId } from '@/runtime/instanceIdentity'

import type { EmbedBootstrapOptions } from './embedContract'

import '@/styles/precision-tokens.css'
import '@/styles/embed-nei-tokens.css'
import '@/styles/embed-mobile.css'
/* Wiki 外壳规则：与 scripts/huiji/StructureRender.css 同源，构建时并入 dist/StructureRender.css 末尾 */
import '../../../scripts/huiji/StructureRender.css'

export function mount(
  target: string | Element | null | undefined,
  options: EmbedBootstrapOptions,
): void {
  const el =
    target == null
      ? document.querySelector('.web-structure-renderer') ??
        document.querySelector('#web-structure-renderer')
      : typeof target === 'string'
        ? document.querySelector(target)
        : target
  if (!el) {
    console.warn(
      '[StructureRenderer] mount: 未找到挂载节点',
      target ?? '.web-structure-renderer / #web-structure-renderer',
    )
    return
  }

  // **主题不再写全局**（P10 #261，收口 F1；#259 A33 的同一政策）。
  //
  // 旧实现是：
  //   const theme = options.ui?.theme ?? document.documentElement.dataset.neiTheme ?? 'dark'
  //   document.documentElement.dataset.neiTheme = theme      // ← 挂载期写全局
  //
  // 那有三个问题，第三个是同页多实例才会暴露的：
  //  1. **挂载期副作用**：`mount()` 本该只挂组件，却改了文档根属性；
  //  2. **写的是全局**：`data-nei-theme` 在 `documentElement` 上，全页一份；
  //  3. **同页两实例互相覆盖**：第二个 `mount()` 用**自己的** theme 覆盖第一个，
  //     于是先挂的那个被迫换了主题（F1 的原始描述）。
  //
  // 现在的落点：`EmbedViewport` 的**实例根元素**上写 `data-lk-theme`
  // （`ctx.getShellSettings().scopeAttrs`）。自定义属性沿 DOM 继承，
  // 故每个实例解析出自己的变量值，互不影响。
  //
  // 主题来源优先级不变（`options.ui.theme` > 实例偏好 > 文档根的既有属性 > `dark`）：
  // `options.ui.theme` 经 `EmbedRoot` → `buildEmbedSettingsFromBootstrap` 进实例设置；
  // 文档根属性的读取在 `shellSettings.ts` 的迁移路径里（那里**只读不写**）。
  // ⇒ 读取是"继承宿主页面的意图"，写入是"本实例的解析结果"；读取不产生覆盖。

  const mountEl = el as HTMLElement
  ensureMobileFitHost(mountEl)
  if (import.meta.env.DEV) initEmbedTouchSim(mountEl)
  // 实例身份由**装配层**分配（M7-6）：同页两次 mount 得到互不相同的 id，
  // 实例设置/viewer 偏好/日志观测面因此互不覆盖。同一次页面装载里按挂载顺序
  // 稳定（第一个嵌入恒为 embed-1）⇒ 刷新后仍读回自己的偏好。
  const instanceId = allocateEmbedInstanceId()
  createApp(EmbedRoot, { bootstrap: options, instanceId }).mount(mountEl)
}
