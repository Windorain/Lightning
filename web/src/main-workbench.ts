/**
 * 静态工作台入口：由 Vite workbench 构建产出，供 SDE JAR 内嵌托管。
 */
import { createApp } from 'vue'

import DevApp from '@/dev/DevApp.vue'
import '@/styles/precision-tokens.css'
import '@/styles/embed-nei-tokens.css'

createApp(DevApp).mount('#app')
