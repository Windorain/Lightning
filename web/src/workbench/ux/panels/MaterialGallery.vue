<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from 'vue'
import type { BContext, MaterialQueryItem } from '@/workbench/context/bContext'
import RNAWidget from '@/workbench/ux/RNAWidget.vue'
import OperatorBtn from '@/workbench/ux/OperatorBtn.vue'
import { materialRNA } from '@/workbench/ux/rna/structs/material'

const props = defineProps<{ bctx: BContext }>()

// ---- Data ----
interface MaterialCard {
  materialId: string
  kind: 'static16' | 'animated'
  blend?: string
  locator?: string
  emissive?: number
  animation?: MaterialQueryItem['animation']
  dataUrl: string | null
}

const cards = ref<MaterialCard[]>([])
const selectedId = ref<string | null>(null)

const selected = computed(() => {
  if (!selectedId.value) return null
  return cards.value.find(c => c.materialId === selectedId.value) ?? null
})

const selectedOwner = computed(() => selected.value)

function refresh() {
  const items = props.bctx.queries?.listMaterials?.() ?? []
  cards.value = items.map((m: MaterialQueryItem) => ({
    materialId: m.materialId,
    kind: m.kind,
    blend: m.blend,
    locator: m.locator,
    emissive: m.emissive,
    animation: m.animation,
    dataUrl: m.textureDataUrl,
  }))
  if (selectedId.value && !cards.value.find(c => c.materialId === selectedId.value)) {
    selectedId.value = null
  }
}

function selectCard(id: string) {
  selectedId.value = selectedId.value === id ? null : id
}

watch(() => props.bctx.scene.scene.value, () => refresh(), { immediate: true })

// ---- Animation engine ----
const animationRefs = new Map<string, HTMLCanvasElement>()
const animationHandles = new Map<string, number>()

function setCanvasRef(el: unknown, materialId: string) {
  const canvas = el as HTMLCanvasElement | null
  if (canvas) {
    animationRefs.set(materialId, canvas)
    startAnimation(materialId)
  } else {
    stopAnimation(materialId)
    animationRefs.delete(materialId)
  }
}

function startAnimation(id: string) {
  // Find the card. For detail canvases, strip the "-detail" suffix to find the card data
  const lookupId = id.endsWith('-detail') ? id.slice(0, -7) : id
  const card = cards.value.find(c => c.materialId === lookupId)
  if (!card?.dataUrl || card.kind !== 'animated') return

  const img = new Image()
  img.src = card.dataUrl
  img.onload = () => {
    const canvas = animationRefs.get(id)
    if (!canvas) return

    const frameSize = img.width
    const frameCount = Math.floor(img.height / frameSize)
    if (frameCount <= 1) return

    canvas.width = frameSize
    canvas.height = frameSize
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    const frameTime = card.animation?.defaultFrametimeTicks ?? 1
    const tickMs = Math.max(frameTime * 50, 80)
    let currentFrame = 0
    let lastTime = performance.now()
    let elapsed = 0

    function step(now: number) {
      const delta = now - lastTime
      lastTime = now
      elapsed += delta
      while (elapsed >= tickMs && tickMs > 0) {
        elapsed -= tickMs
        currentFrame = (currentFrame + 1) % frameCount
      }
      ctx.clearRect(0, 0, frameSize, frameSize)
      ctx.drawImage(
        img,
        0, currentFrame * frameSize, frameSize, frameSize,
        0, 0, frameSize, frameSize,
      )
      animationHandles.set(id, requestAnimationFrame(step))
    }
    // Draw first frame immediately
    ctx.drawImage(img, 0, 0, frameSize, frameSize, 0, 0, frameSize, frameSize)
    animationHandles.set(id, requestAnimationFrame(step))
  }
}

function stopAnimation(id: string) {
  const handle = animationHandles.get(id)
  if (handle !== undefined) {
    cancelAnimationFrame(handle)
    animationHandles.delete(id)
  }
}

onUnmounted(() => {
  for (const handle of animationHandles.values()) {
    cancelAnimationFrame(handle)
  }
})
</script>

<template>
  <div class="mg-root">
    <!-- Empty state -->
    <div v-if="cards.length === 0" class="mg-empty">
      <span>无材质数据</span>
      <span class="mg-empty-hint">加载包含 materialPalette 的场景以查看材质</span>
    </div>

    <template v-else>
      <!-- Waterfall grid -->
      <div class="mg-grid" :class="{ 'mg-grid--has-detail': selected }">
        <div
          v-for="card in cards"
          :key="card.materialId"
          class="mg-card"
          :class="{ 'mg-card--selected': selectedId === card.materialId }"
          @click="selectCard(card.materialId)"
        >
          <!-- Static texture -->
          <img
            v-if="card.dataUrl && card.kind !== 'animated'"
            :src="card.dataUrl"
            class="mg-thumb"
            :alt="card.materialId"
          />
          <!-- Animated texture -->
          <canvas
            v-else-if="card.dataUrl && card.kind === 'animated'"
            :ref="(el: unknown) => setCanvasRef(el, card.materialId)"
            class="mg-thumb"
          />
          <!-- No texture -->
          <div v-else class="mg-thumb mg-thumb--empty">
            <span>?</span>
          </div>
          <div class="mg-card-label">{{ card.locator || `#${card.materialId}` }}</div>
          <div class="mg-card-badges">
            <span v-if="card.blend && card.blend !== 'opaque'" class="mg-badge">{{ card.blend }}</span>
            <span v-if="card.kind === 'animated'" class="mg-badge mg-badge--anim">anim</span>
          </div>
        </div>
      </div>

      <!-- Detail panel -->
      <div v-if="selected" class="mg-detail">
        <div class="mg-detail-header">
          <span class="mg-detail-title">{{ selected.locator || `材质 #${selected.materialId}` }}</span>
          <button class="mg-detail-close" @click="selectedId = null">&times;</button>
        </div>

        <!-- Large preview -->
        <div class="mg-detail-preview">
          <img
            v-if="selected.dataUrl && selected.kind !== 'animated'"
            :src="selected.dataUrl"
            class="mg-detail-thumb"
          />
          <canvas
            v-else-if="selected.dataUrl && selected.kind === 'animated'"
            :ref="(el: unknown) => { if (selected) setCanvasRef(el, `${selected.materialId}-detail`) }"
            class="mg-detail-thumb"
          />
          <div v-else class="mg-detail-thumb mg-detail-thumb--empty">
            <span>无纹理</span>
          </div>
        </div>

        <!-- Properties via RNAWidget -->
        <div class="mg-detail-props">
          <div class="mg-prop-row">
            <span class="mg-prop-label">类型</span>
            <RNAWidget
              :descriptor="materialRNA.properties.find(p => p.name === 'kind')!"
              label=""
              rna-path="Material.kind"
              :owner="selectedOwner"
            />
          </div>
          <div class="mg-prop-row">
            <span class="mg-prop-label">混合</span>
            <RNAWidget
              :descriptor="materialRNA.properties.find(p => p.name === 'blend')!"
              label=""
              rna-path="Material.blend"
              :owner="selectedOwner"
            />
          </div>
          <div v-if="selected.emissive" class="mg-prop-row">
            <span class="mg-prop-label">自发光</span>
            <span class="mg-prop-value">{{ selected.emissive }}</span>
          </div>
          <div v-if="selected.locator" class="mg-prop-row">
            <span class="mg-prop-label">定位符</span>
            <span class="mg-prop-value mg-prop-value--mono">{{ selected.locator }}</span>
          </div>
          <div v-if="selected.animation" class="mg-prop-row">
            <span class="mg-prop-label">帧间隔</span>
            <span class="mg-prop-value">{{ selected.animation.defaultFrametimeTicks ?? 1 }} tick</span>
          </div>
        </div>

        <!-- Operator buttons -->
        <div class="mg-detail-ops">
          <OperatorBtn
            op-id="OPERATOR_EXPORT_TEXTURE"
            label="导出 PNG"
            :operator-props="{ materialId: selected.materialId }"
          />
          <OperatorBtn
            v-if="selected.locator"
            op-id="OPERATOR_COPY_MATERIAL_LOCATOR"
            label="复制定位符"
            :operator-props="{ materialId: selected.materialId }"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mg-root {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.mg-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--nei-text-muted);
  font-size: 12px;
}
.mg-empty-hint {
  font-size: 10px;
  opacity: 0.6;
}

/* ---- Waterfall grid ---- */
.mg-grid {
  flex: 1;
  overflow-y: auto;
  columns: 3;
  column-gap: 6px;
  padding: 6px;
  will-change: transform;
}
.mg-grid--has-detail {
  flex: 0 0 55%;
  border-right: 1px solid var(--nei-border, #555);
}

.mg-card {
  break-inside: avoid;
  margin-bottom: 6px;
  border: 1px solid var(--nei-border, #444);
  border-radius: 4px;
  overflow: hidden;
  background: var(--nei-inset-bg, #1a1a1a);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.mg-card:hover {
  border-color: var(--nei-accent, #888);
}
.mg-card--selected {
  border-color: var(--nei-accent);
  box-shadow: 0 0 0 1px var(--nei-accent);
}

.mg-thumb {
  display: block;
  width: 100%;
  height: auto;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
.mg-thumb--empty {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #222;
  color: #666;
  font-size: 18px;
  min-height: 48px;
}

.mg-card-label {
  padding: 2px 6px;
  font-size: 10px;
  font-family: ui-monospace, 'Cascadia Code', monospace;
  color: var(--nei-text, #ccc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mg-card-badges {
  display: flex;
  gap: 3px;
  padding: 0 6px 4px;
}
.mg-badge {
  font-size: 8px;
  padding: 1px 4px;
  border-radius: 3px;
  background: #333;
  color: #999;
  text-transform: uppercase;
}
.mg-badge--anim {
  background: #3a3;
  color: #fff;
}

/* ---- Detail panel ---- */
.mg-detail {
  flex: 0 0 45%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 8px;
  gap: 8px;
}

.mg-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.mg-detail-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--nei-text);
  font-family: ui-monospace, 'Cascadia Code', monospace;
  word-break: break-all;
}
.mg-detail-close {
  background: none;
  border: none;
  color: var(--nei-text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.mg-detail-close:hover {
  color: var(--nei-text);
}

.mg-detail-preview {
  text-align: center;
}
.mg-detail-thumb {
  max-width: 100%;
  max-height: 200px;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  border: 1px solid var(--nei-border, #444);
  border-radius: 4px;
}
.mg-detail-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100px;
  background: #222;
  color: #666;
  font-size: 14px;
}

.mg-detail-props {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mg-prop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0;
  border-bottom: 1px solid #333;
}
.mg-prop-label {
  font-size: 10px;
  color: var(--nei-text-muted);
  flex-shrink: 0;
}
.mg-prop-value {
  font-size: 10px;
  color: var(--nei-text);
}
.mg-prop-value--mono {
  font-family: ui-monospace, 'Cascadia Code', monospace;
  font-size: 9px;
  word-break: break-all;
  text-align: right;
  max-width: 60%;
}

.mg-detail-ops {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
</style>
