<script setup lang="ts">
/**
 * 薄 Vue 壳：挂载 RenderEngine（RAF + WebGL），不处理 hover（走 WM HOVER）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type * as THREE from 'three'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { StructureDefinition } from '@/render/schema/types'
import type { Annotation } from '@/render/data/annotationTypes'
import type { InitialCamera } from '@/preview/previewConfig'
import { RenderEngine, type RenderEngineReadyPayload } from '@/runtime/renderEngine'

const props = withDefaults(
  defineProps<{
    definition: StructureDefinition
    materialLibrary: MaterialLibraryApi
    contentGroup: THREE.Group | null
    layerPreviewMode: LayerPreviewMode
    annotations?: Annotation[]
    sceneBackground?: number
    showAxesGizmo?: boolean
    initialCamera?: InitialCamera
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
})

onMounted(() => {
  const el = container.value
  if (!el) return
  engine.mount(el, {
    definition: props.definition,
    materialLibrary: props.materialLibrary,
    contentGroup: props.contentGroup,
    layerPreviewMode: props.layerPreviewMode,
    sceneBackground: props.sceneBackground,
    showAxesGizmo: props.showAxesGizmo,
    initialCamera: props.initialCamera,
  }, (payload) => emit('ready', payload))
})

watch(
  () => props.contentGroup,
  (g) => engine.updateOptions({ contentGroup: g }),
  { flush: 'post' },
)
watch(() => props.showAxesGizmo, (v) => engine.updateOptions({ showAxesGizmo: v }))
watch(() => props.sceneBackground, (v) => engine.updateOptions({ sceneBackground: v }))
watch(() => props.initialCamera?.zoom, (z) => engine.updateOptions({ initialCamera: { ...props.initialCamera, zoom: z } }))
watch(() => props.initialCamera?.yawDeg, (yaw) => engine.updateOptions({ initialCamera: { ...props.initialCamera, yawDeg: yaw } }))
watch(() => props.initialCamera?.elevationDeg, (elev) => engine.updateOptions({ initialCamera: { ...props.initialCamera, elevationDeg: elev } }))

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
