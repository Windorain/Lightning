<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from 'vue'
import type { MaterialQueryItem } from '@/workbench/context/bContext'
import { useBContext } from '@/workbench/context/bContext'
import OperatorBtn from '@/workbench/ux/OperatorBtn.vue'
import { parsePngDims } from '@/util/pngDims'

const bctx = useBContext()

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

const KIND_LABEL: Record<string, string> = { static16: '静态 (16×)', animated: '动画' }
const BLEND_LABEL: Record<string, string> = { opaque: '不透明', cutout: '裁剪', translucent: '半透明' }

// ---- Filters & sort ----
const searchQuery = ref('')
const kindFilter = ref<'all' | 'static16' | 'animated'>('all')
const blendFilter = ref<'all' | 'opaque' | 'cutout' | 'translucent'>('all')
const sortBy = ref<'name' | 'usage' | 'kind'>('usage')

const selected = computed(() => {
  if (!selectedId.value) return null
  return cards.value.find(c => c.materialId === selectedId.value) ?? null
})

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
function refresh() {
  const items = bctx.queries?.listMaterials?.() ?? []
  const usage = bctx.queries?.getMaterialUsageCounts?.() ?? {}

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

watch(() => bctx.doc.value, () => refresh(), { immediate: true })

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
    <div v-if="cards.length === 0" class="mg-empty">
      <span class="mg-empty-icon"><svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-1 0-.78.62-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.5-4.5-10-10-10z"/></svg></span>
      <span class="mg-empty-text">无材质数据</span>
      <span class="mg-empty-hint">加载包含 materialPalette 的场景以查看材质</span>
    </div>

    <template v-else>
      <div class="mg-main">
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
              <span v-else-if="card.blend && card.blend !== 'opaque'" class="mg-badge mg-badge--blend">{{ card.blend }}</span>
            </div>
          </div>
          <div v-if="filteredCards.length === 0" class="mg-grid-empty">
            无匹配材质
          </div>
        </div>
      </div>

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
              <span class="mg-prop-value">{{ KIND_LABEL[selected.kind] ?? selected.kind }}</span>
            </div>
            <div class="mg-prop-row">
              <span class="mg-prop-label">混合</span>
              <span class="mg-prop-value">{{ BLEND_LABEL[selected.blend ?? 'opaque'] ?? (selected.blend ?? 'opaque') }}</span>
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

        <div v-else class="mg-detail-placeholder">
          <span class="mg-detail-placeholder-icon"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span>
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
  gap: 8px;
  color: var(--wb-text-dim);
}
.mg-empty-icon { width: 36px; height: 36px; color: var(--wb-text-dim); opacity: 0.5; }
.mg-empty-text { font-size: 15px; color: var(--wb-text-muted); }
.mg-empty-hint { font-size: 12px; }

/* ---- Main area ---- */
.mg-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--wb-viewport-bg);
}

/* ---- Toolbar ---- */
.mg-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--wb-bg-elevated);
  border-bottom: 1px solid var(--wb-border);
}
.mg-search {
  flex: 1;
  min-width: 140px;
  padding: 6px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 13px;
  outline: none;
}
.mg-search:focus { border-color: var(--wb-accent); }
.mg-search::placeholder { color: var(--wb-text-dim); }
.mg-select {
  padding: 6px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-accent-muted);
  font-size: 12px;
  cursor: pointer;
  outline: none;
}
.mg-select:focus { border-color: var(--wb-accent); }
.mg-count {
  font-size: 11px;
  color: var(--wb-text-dim);
  font-family: var(--wb-font-mono);
  white-space: nowrap;
  min-width: 50px;
  text-align: right;
}

/* ---- Card Grid ---- */
.mg-grid {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
  padding: 10px;
  outline: none;
}

.mg-card {
  width: 150px;
  flex-shrink: 0;
  border: 2px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  overflow: hidden;
  background: var(--wb-bg-surface);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.mg-card:hover { border-color: var(--wb-accent); }
.mg-card--selected {
  border-color: var(--wb-accent);
  box-shadow: 0 0 10px rgba(77, 171, 247, 0.2);
}
.mg-card--focused {
  border-color: var(--wb-accent);
  box-shadow: 0 0 6px rgba(77, 171, 247, 0.3);
}

.mg-thumb {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 1;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
.mg-thumb--empty {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--wb-bg-deepest);
  color: var(--wb-text-dim);
  font-size: 24px;
  min-height: 80px;
}

.mg-card-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 6px;
  border-top: 1px solid var(--wb-border);
}
.mg-card-label {
  flex: 1;
  font-size: 11px;
  font-family: var(--wb-font-mono);
  color: var(--wb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mg-badge {
  flex-shrink: 0;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--wb-bg-hover);
  color: var(--wb-text-muted);
  font-family: var(--wb-font-mono);
}
.mg-badge--anim { background: rgba(46, 204, 113, 0.1); color: var(--wb-success); }
.mg-badge--usage { background: var(--wb-bg-hover); color: var(--wb-text-muted); }
.mg-badge--blend { background: rgba(245, 158, 11, 0.1); color: var(--wb-warn); }

.mg-grid-empty {
  flex: 0 0 100%;
  padding: 24px;
  text-align: center;
  color: var(--wb-text-dim);
  font-size: 13px;
}

/* ---- Detail panel ---- */
.mg-detail {
  flex-shrink: 0;
  width: 270px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  background: var(--wb-bg-elevated);
  border-left: 1px solid var(--wb-border);
}

.mg-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--wb-border);
  flex-shrink: 0;
}
.mg-detail-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
  font-family: var(--wb-font-mono);
  word-break: break-all;
  line-height: 1.3;
}
.mg-detail-deselect {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--wb-text-muted);
  font-size: 18px;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
}
.mg-detail-deselect:hover { color: var(--wb-text); }

.mg-detail-preview {
  text-align: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--wb-border);
  flex-shrink: 0;
}
.mg-detail-thumb {
  display: block;
  width: 100%;
  height: auto;
  max-height: 180px;
  aspect-ratio: 1;
  object-fit: contain;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-bg-surface);
}
.mg-detail-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100px;
  background: var(--wb-bg-deepest);
  color: var(--wb-text-dim);
  font-size: 14px;
}

.mg-detail-props {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--wb-border);
}
.mg-prop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.mg-prop-label {
  font-size: 12px;
  color: var(--wb-text-muted);
  flex-shrink: 0;
}
.mg-prop-value {
  font-size: 12px;
  color: var(--wb-accent-muted);
}
.mg-search:focus-visible,
.mg-select:focus-visible,
.mg-grid:focus-visible {
  outline: 2px solid var(--wb-focus-ring);
  outline-offset: 2px;
}

.mg-prop-value--mono {
  font-family: var(--wb-font-mono);
  font-size: 11px;
  word-break: break-all;
  text-align: right;
  max-width: 60%;
  color: var(--wb-text-muted);
}

.mg-detail-ops {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
}

/* ---- Detail placeholder ---- */
.mg-detail-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--wb-text-dim);
}
.mg-detail-placeholder-icon { width: 48px; height: 48px; color: var(--wb-text-dim); }
.mg-detail-placeholder-text { font-size: 13px; text-align: center; line-height: 1.5; color: var(--wb-text-dim); }
.mg-detail-placeholder-hint { font-size: 10px; color: var(--wb-text-dim); margin-top: 6px; }
</style>
