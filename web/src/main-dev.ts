/**
 * 本地 Vite 开发入口：挂载 DevApp（场景来自 data/scenes/*.json；配置见 URL 查询参数）。
 */
import { createApp } from 'vue'

import DevApp from '@/dev/DevApp.vue'
import '@/styles/nei-tokens.css'

createApp(DevApp).mount('#app')
