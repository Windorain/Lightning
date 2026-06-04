/**
 * 灰机 Wiki StructureWorkbench 入口（无 SDE，profile=wiki）。
 */
import { createApp } from 'vue'
import DevApp from '@/dev/DevApp.vue'
import '@/styles/precision-tokens.css'
import '@/styles/embed-nei-tokens.css'

const root = document.getElementById('wsr-workbench-app') ?? document.getElementById('app')
if (!root) {
  throw new Error('缺少 #wsr-workbench-app 或 #app 挂载点')
}

createApp(DevApp).mount(root)
