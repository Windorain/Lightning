<script setup lang="ts">
/**
 * EmbedShell — EmbedViewer 的 Controller（独立嵌入用）。
 *
 * 职责：
 * - 创建 Embed BContext 并提供给子树（view operators 需从中读 camera/domElement）
 * - 注册 embed 操作符（ViewRotate/Pan/Zoom + ResetView）
 * - ViewerCore @ready 后：将视口状态填入 BContext、注册 EventDispatcher region、
 *   添加 capture-phase DOM 监听器、注册 embedKeymapHandler
 * - 清理时注销 region 和 handler
 *
 * 工作台内不使用此组件；Wiki/Preview 路径直接使用 EmbedViewer（纯 View），
 * 由 Workbench 的 Area/Region 路由做 Controller。
 */
import { onBeforeUnmount, watch } from 'vue'

import EmbedViewer from '@/embed/EmbedViewer.vue'
import type { ViewerCoreReadyPayload } from '@/embed/components/ViewerCore.vue'
import type { View3DConfig } from '@/preview/previewConfig'
import { createEmbedBContext, provideEmbedBContext } from '@/embed/embedContext'
import { createEmbedKeymapHandler } from '@/embed/embedKeymap'
import {
  ViewRotateOperator,
  ViewPanOperator,
  ViewZoomOperator,
} from '@/workbench/operators/builtin/viewOperators'
import { ResetViewOperator } from '@/embed/operators/resetViewOperator'

let _shellInstanceSeq = 0
const EMBED_SHELL_REGION = `embed-shell-${++_shellInstanceSeq}`

const props = defineProps<{
  config: View3DConfig
}>()

// ---- BContext ----
const bctx = createEmbedBContext(props.config)
provideEmbedBContext(bctx)

watch(() => props.config, (cfg) => {
  if (bctx.config) bctx.config.value = cfg
})

// ---- Controller state ----
let unregHandlers: Array<() => void> = []

function onEmbedViewerReady(payload: ViewerCoreReadyPayload): void {
  const { camera, domElement, orbitTarget } = payload

  // Wire viewport refs synchronously for operator poll()/modal()
  bctx.viewport.camera.value = camera
  bctx.viewport.domElement.value = domElement
  bctx.viewport.orbitTarget.value = orbitTarget

  // Register embed operators
  for (const op of [ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ResetViewOperator]) {
    bctx.operators.register(op)
  }

  // EventDispatcher: register region + keymap handler
  bctx.eventDispatcher.registerRegion(EMBED_SHELL_REGION)

  unregHandlers.push(
    bctx.eventDispatcher.registerRegionHandler(
      EMBED_SHELL_REGION,
      createEmbedKeymapHandler(EMBED_SHELL_REGION, () => bctx),
    ),
  )

  // Capture-phase listeners: nav events intercepted before ViewerCore's bubble handlers
  // 注意：不调 setActiveRegion，避免污染全局 _activeRegionId（KeyboardEvent 路由用）
  domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) e.preventDefault()
    bctx.eventDispatcher.dispatch(e, { regionId: EMBED_SHELL_REGION })
  }, { capture: true })
  domElement.addEventListener('pointermove', (e) => {
    bctx.eventDispatcher.dispatch(e, { regionId: EMBED_SHELL_REGION })
  }, { capture: true })
  domElement.addEventListener('pointerup', (e) => {
    bctx.eventDispatcher.dispatch(e, { regionId: EMBED_SHELL_REGION })
  }, { capture: true })
  domElement.addEventListener('wheel', (e) => {
    bctx.eventDispatcher.dispatch(e, { regionId: EMBED_SHELL_REGION })
    e.preventDefault()
  }, { capture: true, passive: false })
  domElement.addEventListener('contextmenu', (e) => { e.preventDefault() }, { capture: true })
}

onBeforeUnmount(() => {
  unregHandlers.forEach(fn => fn())
  bctx.eventDispatcher.unregisterRegion(EMBED_SHELL_REGION)
})
</script>

<template>
  <EmbedViewer :config="config" @ready="onEmbedViewerReady" />
</template>
