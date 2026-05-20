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
  textureWidth: number | null
  textureHeight: number | null
  usageCount: number
}

const cards = ref<MaterialCard[]>([])
const selectedId = ref<string | null>(null)
const focusedIndex = ref(0)

// ---- Filters & sort ----
const searchQuery = ref('')
const kindFilter = ref<'all' | 'static16' | 'animated'>('all')
const blendFilter = ref<'all' | 'opaque' | 'cutout' | 'translucent'>('all')
const sortBy = ref<'name' | 'usage' | 'kind'>('usage')

const selected = computed(() => {
  if (!selectedId.value) return null
  return cards.value.find(c => c.materialId === selectedId.value) ?? null
})

const selectedOwner = computed(() => selected.value)

const filteredCards = computed(() => {
  let list = cards.value

  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase()
    list = list.filter(c => c.locator?.toLowerCase().includes(q))
  }
  if (kindFilter.value !== 'all') {
    list = list.filter(c => c.kind === kindFilter.value)
  }
  if (blendFilter.value !== 'all') {
    list = list.filter(c => (c.blend ?? 'opaque') === blendFilter.value)
  }

  switch (sortBy.value) {
    case 'name':
      list = [...list].sort((a, b) => (a.locator ?? a.materialId).localeCompare(b.locator ?? b.materialId))
      break
    case 'usage':
      list = [...list].sort((a, b) => b.usageCount - a.usageCount || a.materialId.localeCompare(b.materialId))
      break
    case 'kind':
      list = [...list].sort((a, b) => a.kind.localeCompare(b.kind) || (a.locator ?? a.materialId).localeCompare(b.locator ?? b.materialId))
      break
  }

  return list
})

// ---- Data loading ----
function parsePngDims(dataUrl: string): { w: number; h: number } | null {
  try {
    const b64 = dataUrl.slice(dataUrl.indexOf('base64,') + 7)
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return null // not PNG
    // Bytes 16-19: width (big-endian), 20-23: height
    const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]
    const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]
    return { w, h }
  } catch {
    return null
  }
}

function refresh() {
  const items = props.bctx.queries?.listMaterials?.() ?? []
  const usage = props.bctx.queries?.getMaterialUsageCounts?.() ?? {}

  cards.value = items.map((m: MaterialQueryItem) => {
    let textureWidth: number | null = null
    let textureHeight: number | null = null
    if (m.textureDataUrl) {
      const dims = parsePngDims(m.textureDataUrl)
      if (dims) {
        textureWidth = dims.w
        textureHeight = dims.h
      }
    }
    return {
      materialId: m.materialId,
      kind: m.kind,
      blend: m.blend,
      locator: m.locator,
      emissive: m.emissive,
      animation: m.animation,
      dataUrl: m.textureDataUrl,
      textureWidth,
      textureHeight,
      usageCount: usage[m.materialId] ?? 0,
    }
  })

  if (selectedId.value && !cards.value.find(c => c.materialId === selectedId.value)) {
    selectedId.value = null
  }
  if (focusedIndex.value >= filteredCards.value.length) {
    focusedIndex.value = Math.max(0, filteredCards.value.length - 1)
  }
}

function selectCard(id: string) {
  selectedId.value = selectedId.value === id ? null : id
}

watch(() => props.bctx.scene.scene.value, () => refresh(), { immediate: true })

// ---- Keyboard navigation ----
const gridEl = ref<HTMLElement | null>(null)

function handleKeydown(e: KeyboardEvent) {
  const list = filteredCards.value
  if (list.length === 0) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    focusedIndex.value = (focusedIndex.value + 1) % list.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    focusedIndex.value = (focusedIndex.value - 1 + list.length) % list.length
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    // Advance roughly one "column" worth — approximate with 3 items
    focusedIndex.value = Math.min(focusedIndex.value + 3, list.length - 1)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    focusedIndex.value = Math.max(focusedIndex.value - 3, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const card = list[focusedIndex.value]
    if (card) selectCard(card.materialId)
  }
}

// Scroll focused card into view when index changes
watch(focusedIndex, () => {
  const el = gridEl.value?.querySelector('.mg-card--focused')
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})

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
  <div class="mg-root" @keydown="handleKeydown">
    <!-- Empty state -->
    <div v-if="cards.length === 0" class="mg-empty">
      <span class="mg-empty-icon">&#x1F3A8;</span>
      <span class="mg-empty-text">无材质数据</span>
      <span class="mg-empty-hint">加载包含 materialPalette 的场景以查看材质</span>
    </div>

    <template v-else>
      <!-- Main area: toolbar + waterfall -->
      <div class="mg-main">
        <!-- Toolbar -->
        <div class="mg-toolbar">
          <input
            v-model="searchQuery"
            type="text"
            class="mg-search"
            placeholder="搜索材质名称..."
          />
          <select v-model="kindFilter" class="mg-select">
            <option value="all">全部类型</option>
            <option value="static16">静态</option>
            <option value="animated">动画</option>
          </select>
          <select v-model="blendFilter" class="mg-select">
            <option value="all">全部混合</option>
            <option value="opaque">不透明</option>
            <option value="cutout">裁剪</option>
            <option value="translucent">半透明</option>
          </select>
          <select v-model="sortBy" class="mg-select">
            <option value="usage">按引用数</option>
            <option value="name">按名称</option>
            <option value="kind">按类型</option>
          </select>
          <span class="mg-count">{{ filteredCards.length }} / {{ cards.length }}</span>
        </div>

        <!-- Waterfall grid -->
        <div ref="gridEl" class="mg-grid" tabindex="0">
          <div
            v-for="(card, i) in filteredCards"
            :key="card.materialId"
            class="mg-card"
            :class="{
              'mg-card--selected': selectedId === card.materialId,
              'mg-card--focused': i === focusedIndex,
            }"
            @click="selectCard(card.materialId)"
          >
            <img
              v-if="card.dataUrl && card.kind !== 'animated'"
              :src="card.dataUrl"
              class="mg-thumb"
              :alt="card.materialId"
              loading="lazy"
            />
            <canvas
              v-else-if="card.dataUrl && card.kind === 'animated'"
              :ref="(el: unknown) => setCanvasRef(el, card.materialId)"
              class="mg-thumb"
            />
            <div v-else class="mg-thumb mg-thumb--empty">
              <span>?</span>
            </div>
            <div class="mg-card-footer">
              <span class="mg-card-label">{{ card.locator || `#${card.materialId}` }}</span>
              <span v-if="card.usageCount > 0" class="mg-badge mg-badge--usage">{{ card.usageCount }}</span>
              <span v-if="card.kind === 'animated'" class="mg-badge mg-badge--anim">anim</span>
              <span v-else-if="card.blend && card.blend !== 'opaque'" class="mg-badge">{{ card.blend }}</span>
            </div>
          </div>
          <div v-if="filteredCards.length === 0" class="mg-grid-empty">
            无匹配材质
          </div>
        </div>
      </div>

      <!-- Detail panel — always visible -->
      <div class="mg-detail">
        <template v-if="selected">
          <div class="mg-detail-header">
            <span class="mg-detail-title">{{ selected.locator || `材质 #${selected.materialId}` }}</span>
            <button class="mg-detail-deselect" @click="selectedId = null" title="取消选中">&times;</button>
          </div>

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
            <div v-else class="mg-detail-thumb mg-detail-thumb--empty">无纹理</div>
          </div>

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
            <div v-if="selected.textureWidth" class="mg-prop-row">
              <span class="mg-prop-label">尺寸</span>
              <span class="mg-prop-value mg-prop-value--mono">{{ selected.textureWidth }}&times;{{ selected.textureHeight }}</span>
            </div>
            <div class="mg-prop-row">
              <span class="mg-prop-label">引用数</span>
              <span class="mg-prop-value">{{ selected.usageCount }} 个方块</span>
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

          <div class="mg-detail-ops">
            <OperatorBtn
              v-if="selected.kind === 'animated'"
              op-id="OPERATOR_EXPORT_GIF"
              label="导出 GIF"
              :operator-props="{ materialId: selected.materialId }"
            />
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
        </template>

        <!-- Placeholder when nothing selected -->
        <div v-else class="mg-detail-placeholder">
          <span class="mg-detail-placeholder-icon">&#x1F5BC;</span>
          <span class="mg-detail-placeholder-text">点击左侧材质<br />查看详情</span>
          <span class="mg-detail-placeholder-hint">方向键导航 · 回车选中</span>
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
  outline: none;
}

/* ---- Empty state ---- */
.mg-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--nei-text-muted);
}
.mg-empty-icon { font-size: 32px; }
.mg-empty-text { font-size: 13px; }
.mg-empty-hint { font-size: 11px; opacity: 0.5; }

/* ---- Main area ---- */
.mg-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--nei-viewport-bg);
}

/* ---- Toolbar ---- */
.mg-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--nei-bg-deep);
  border-bottom: 1px solid var(--nei-border);
}
.mg-search {
  flex: 1;
  min-width: 120px;
  padding: 3px 8px;
  border: 1px solid var(--nei-border);
  border-radius: 3px;
  background: #1a1a1a;
  color: var(--nei-text);
  font-size: 11px;
  font-family: ui-monospace, 'Cascadia Code', monospace;
  outline: none;
}
.mg-search:focus {
  border-color: var(--nei-accent);
}
.mg-search::placeholder {
  color: #555;
}
.mg-select {
  padding: 3px 6px;
  border: 1px solid var(--nei-border);
  border-radius: 3px;
  background: #1a1a1a;
  color: var(--nei-text);
  font-size: 10px;
  cursor: pointer;
  outline: none;
}
.mg-select:focus {
  border-color: var(--nei-accent);
}
.mg-count {
  font-size: 10px;
  color: var(--nei-text-muted);
  white-space: nowrap;
  min-width: 50px;
  text-align: right;
}

/* ---- Waterfall grid ---- */
.mg-grid {
  flex: 1;
  overflow-y: auto;
  column-width: 160px;
  column-gap: 8px;
  padding: 10px;
  outline: none;
}

.mg-card {
  break-inside: avoid;
  margin-bottom: 8px;
  border: 1px solid var(--nei-border, #3a3a3a);
  border-radius: 4px;
  overflow: hidden;
  background: var(--nei-bg-deep, #1a1a1a);
  cursor: pointer;
  transition: border-color 0.15s;
}
.mg-card:hover {
  border-color: var(--nei-accent, #6a6a6a);
}
.mg-card--selected {
  border-color: var(--nei-accent);
  box-shadow: 0 0 0 1px var(--nei-accent);
}
.mg-card--focused {
  border-color: var(--nei-accent);
  box-shadow: 0 0 0 1px rgba(255,255,255,0.3);
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
  background: #1e1e1e;
  color: #555;
  font-size: 20px;
  min-height: 64px;
}

.mg-card-footer {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 6px 4px;
}
.mg-card-label {
  flex: 1;
  font-size: 10px;
  font-family: ui-monospace, 'Cascadia Code', monospace;
  color: var(--nei-text, #ccc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mg-badge {
  flex-shrink: 0;
  font-size: 7px;
  padding: 1px 4px;
  border-radius: 2px;
  background: #333;
  color: #999;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.mg-badge--anim {
  background: #2a6a2a;
  color: #8f8;
}
.mg-badge--usage {
  background: #3a3a5a;
  color: #aac;
}

.mg-grid-empty {
  break-inside: avoid;
  padding: 20px;
  text-align: center;
  color: var(--nei-text-muted);
  font-size: 12px;
}

/* ---- Detail panel ---- */
.mg-detail {
  flex-shrink: 0;
  width: 260px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 10px;
  gap: 10px;
  background: var(--nei-bg-deep);
  border-left: 1px solid var(--nei-border);
}

.mg-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}
.mg-detail-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--nei-text);
  font-family: ui-monospace, 'Cascadia Code', monospace;
  word-break: break-all;
  line-height: 1.3;
}
.mg-detail-deselect {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--nei-text-muted);
  font-size: 15px;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
}
.mg-detail-deselect:hover {
  color: var(--nei-text);
}

.mg-detail-preview {
  text-align: center;
}
.mg-detail-thumb {
  max-width: 100%;
  max-height: 180px;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  border: 1px solid var(--nei-border, #3a3a3a);
  border-radius: 4px;
}
.mg-detail-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 80px;
  background: #1e1e1e;
  color: #555;
  font-size: 12px;
}

.mg-detail-props {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mg-prop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 0;
  border-bottom: 1px solid rgba(255,255,255,0.05);
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
  flex-direction: column;
  gap: 4px;
}

/* ---- Detail placeholder ---- */
.mg-detail-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--nei-text-muted);
}
.mg-detail-placeholder-icon {
  font-size: 28px;
  opacity: 0.5;
}
.mg-detail-placeholder-text {
  font-size: 11px;
  text-align: center;
  line-height: 1.5;
  opacity: 0.5;
}
.mg-detail-placeholder-hint {
  font-size: 9px;
  opacity: 0.3;
  margin-top: 4px;
  font-family: ui-monospace, 'Cascadia Code', monospace;
}
</style>
