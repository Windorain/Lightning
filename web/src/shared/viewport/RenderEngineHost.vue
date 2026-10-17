<script setup lang="ts">

/**

 * 薄 Vue 壳：挂载 RenderEngine（RAF + WebGL），不处理 hover（走 WM HOVER）。

 * ## 本组件的生命周期 = **视口宿主/画布的生命周期**（#397，SPEC §7.3/§7.4）

 * 挂载 ⇒ 新建 WebGL 画布（新的 canvas DOM 节点）；卸载 ⇒ 画布被销毁。
 * 因此**挂载条件不得含资源瞬时态**：材质库/贴图在资源重建期会瞬时为空，
 * 而它不是本宿主的输入（贴图绑定归呈现会话 `PresenterSession`；材质库只服务
 * 方块图标缓存）—— 旧代码正是让 `materialLibrary` 参与 `v-if`，导致第一次内容
 * 编辑把画布换成了新节点（#397 实测：2 帧宿主与画布同时缺席、空窗 512 ms）。

 * 判据（由两个宿主各自把关，见 `WorkbenchViewport.vue` / `EmbedViewport.vue`）：
 * 有已解析的场景（`loadStatus === 'ok' && structureDefinition`）才挂载；
 * 之后的资源到达/失败/重建只更新画面内容（经 `contentGroup` 的呈现会话），**不重挂宿主**。

 */

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { LayerPreviewMode } from '@/render/data/layerPreview'

import type { StructureDefinition } from '@/render/schema/types'

import { RenderEngine, type RenderEngineReadyPayload } from '@/runtime/renderEngine'



const props = withDefaults(

  defineProps<{

    definition: StructureDefinition

    contentGroup: import('three').Group | null

    layerPreviewMode: LayerPreviewMode

    sceneBackground?: number

    showAxesGizmo?: boolean

  }>(),

  {

    sceneBackground: 0x0b1217,

    showAxesGizmo: true,

  },

)



const emit = defineEmits<{

  ready: [RenderEngineReadyPayload]

}>()



const container = ref<HTMLDivElement | null>(null)

const engine = new RenderEngine()



defineExpose({

  screenshot() { engine.screenshot() },

  resetView() { engine.resetView() },

  addFrameHook(fn: () => void) { return engine.addFrameHook(fn) },

})



onMounted(() => {

  const el = container.value

  if (!el) return

  engine.mount(el, {

    definition: props.definition,

    contentGroup: props.contentGroup,

    layerPreviewMode: props.layerPreviewMode,

    sceneBackground: props.sceneBackground,

    showAxesGizmo: props.showAxesGizmo,

  }, (payload) => emit('ready', payload))

})



watch(

  () => props.contentGroup,

  (g) => engine.updateOptions({ contentGroup: g }),

  { flush: 'post' },

)

watch(() => props.showAxesGizmo, (v) => engine.updateOptions({ showAxesGizmo: v }))

watch(() => props.sceneBackground, (v) => engine.updateOptions({ sceneBackground: v }))



onBeforeUnmount(() => {

  engine.dispose()

})

</script>



<template>

  <div ref="container" class="vc-viewport" style="overflow: hidden" />

</template>



<style scoped>

.vc-viewport {

  flex: 1; min-height: 320px; min-width: 0;

  background: var(--nei-viewport-bg);

  overflow: hidden;

}

</style>

