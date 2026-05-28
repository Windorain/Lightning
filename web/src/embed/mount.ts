/**
 * 库入口：挂载 Wiki 结构渲染器（显式 bootstrap，无隐式配置）。
 */

import { createApp } from 'vue'

import EmbedRoot from '@/embed/EmbedRoot.vue'

import type { EmbedBootstrapOptions } from './embedContract'

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

  // 主题：options.ui.theme > html[data-nei-theme] > 默认 'dark'
  const theme =
    options.ui?.theme ??
    (document.documentElement.dataset.neiTheme as 'light' | 'dark' | undefined) ??
    'dark'
  document.documentElement.dataset.neiTheme = theme

  createApp(EmbedRoot, { bootstrap: options }).mount(el)
}
