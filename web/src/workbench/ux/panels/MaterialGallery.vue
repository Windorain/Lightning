<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, onUnmounted } from 'vue'
import type { MaterialQueryItem } from '@/runtime/types'
import { useContext } from '@/runtime/context'
import OperatorBtn from '@/workbench/ux/OperatorBtn.vue'
import { parsePngDims } from '@/util/pngDims'
import { parseTextureSequence, sampleTextureSequence, type TextureSequence } from '@/domain/materials'
import { listMaterials, getMaterialUsageCounts } from '@/context/queries'

const ctx = useContext()

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
/**
 * 每个 canvas 上次画出的样本帧（同帧重绘是纯浪费；也是"没有自驱 tick"的可见证据）。
 *
 * 文档内容重读（`refresh`）时必须清空：换了一份贴图而帧下标恰好相同，不得因为
 * "帧没变"跳过重绘（否则画面上是上一份文档的帧）。
 */
const lastPaintedFrame = new Map<string, number>()

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
  const items = listMaterials(ctx)
  const usage = getMaterialUsageCounts(ctx)

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

  // 内容重读 ⇒ 贴图/声明可能变了，上一轮"画过第几帧"不再是事实（见 lastPaintedFrame）。
  lastPaintedFrame.clear()
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

// #301 P10f C′1（N9）：材质面板要的是**宽**信号（内容重读）—— 原地编辑也要刷新
// （`requestContentRefresh` 也自增 tick），故用 `getContentRefreshTick()`。
watch(() => ctx.getContentRefreshTick().value, () => refresh(), { immediate: true })

// ---- Animated thumbnails：统一时间 + 纯采样（#249 §19.3；退役 #11） ----
//
// 本组件此前用 `useMaterialAnimation` —— 它自持 `requestAnimationFrame` 且
// `elapsed += delta` 累积帧时间（B5 退役矩阵 #11「材质各自 tick 累积纹理时间」）。
// 现改为：**时间来自场景**（`ctx.getCurrentFrameIndex()` 与帧 `durationMs`），
// **样本来自纯采样器** `sampleTextureSequence`。两处消费者（网格缩略图与详情
// 缩略图）在同一次时间推进里用**同一个**时间值，故同时间同结果（A27）。
//
// 时钟是**外围**的：本组件不持有任何调度器，重画由两个**事件**驱动
// （文档变化、帧下标变化）。这与旧实现的差别不是"换了个循环"，而是
// **没有任何东西累积，也没有任何东西自驱**。

/** 缓存的序列（按 dataUrl + 声明解析一次；解析失败 ⇒ 不播动画）。 */
const sequences = new Map<string, TextureSequence | null>()
const animationCanvases = new Map<string, HTMLCanvasElement>()
const animationImages = new Map<string, HTMLImageElement>()

// 场景秒数**不再**在本组件里计算：唯一权威是 `domain/animation#sceneClockOf`，
// 本组件经 `ctx.getSceneSeconds()` 读它的只读投影。
//
// 被删除的旧本地实现是"Σ 当前帧之前各帧 durationMs"，与视口的连续口径
// （时间 × 帧率）不同源 —— 在不等帧时长的文档上两者给出不同的采样时刻。
// 它还带一个 `DEFAULT_FRAME_MS=50` 的缺省：场景秒**不吃**任何帧时长缺省，
// 那个常量随公式一起消失（纹理序列的 tick 缺省另有唯一出处）。

/**
 * 材质声明 → 纹理序列（纯；解析期拒绝即返回 `null`）。
 *
 * `defaultFrametimeTicks` 是 Java `.mcmeta` 的 tick 单位 ⇒ ×50ms 换成统一时间单位
 * （#249 §19.3「原格式时长由**适配器**换成统一时间单位」——本函数就是那个换算点，
 * 它只做单位换算，不含播放逻辑）。
 */
function sequenceFor(card: MaterialCard): TextureSequence | null {
  if (!card.dataUrl || card.kind !== 'animated') return null
  const cached = sequences.get(card.dataUrl)
  if (cached !== undefined) return cached

  if (!card.textureWidth || !card.textureHeight) {
    sequences.set(card.dataUrl, null)
    return null
  }
  const frameCount = Math.floor(card.textureHeight / card.textureWidth)
  if (frameCount <= 1) {
    sequences.set(card.dataUrl, null)
    return null
  }
  const frameMs = Math.max((card.animation?.defaultFrametimeTicks ?? 1) * 50, 1)
  const parsed = parseTextureSequence({
    id: card.materialId,
    resource: { assetId: card.materialId, contentVersion: card.dataUrl.length.toString(36), url: card.dataUrl },
    frames: Array.from({ length: frameCount }, (_, i) => ({ index: i })),
    defaultDurationSeconds: frameMs / 1000,
    loop: 'loop',
    // 无帧混合声明：#249 §19.3 明文「资源原本不允许混合就阶跃切换」⇒ mix 恒 0。
    frameBlendAllowed: false,
  })
  const value = parsed.ok ? parsed.value : null
  sequences.set(card.dataUrl, value)
  return value
}

/** 把一个样本画到 canvas 上（呈现消费采样结果；采样本身是纯的）。 */
function paint(canvas: HTMLCanvasElement, img: HTMLImageElement, card: MaterialCard, sample: { frame: number }): void {
  const frameSize = card.textureWidth ?? img.width
  if (canvas.width !== frameSize) canvas.width = frameSize
  if (canvas.height !== frameSize) canvas.height = frameSize
  const g = canvas.getContext('2d')
  if (!g) return
  g.imageSmoothingEnabled = false
  g.clearRect(0, 0, frameSize, frameSize)
  g.drawImage(img, 0, sample.frame * frameSize, frameSize, frameSize, 0, 0, frameSize, frameSize)
}

/**
 * 所有在册缩略图按同一场景时间重画一次（跳帧/倒退/暂停都由它体现）。
 *
 * ## 为什么这里是**事件驱动**而不是 rAF 循环（合流后修正）
 *
 * P4 初版让一个 `requestAnimationFrame` 循环每帧调用本函数。那是**多余且有害**的：
 *
 *  - `sceneSeconds()`（见下）是**帧下标的纯函数** —— 没有累积量、没有独立时钟。
 *    帧下标不变时它每次都返回同一个数，于是那个循环每帧重画**完全相同的像素**；
 *  - 而两个输入都已各自被 `watch` 覆盖（文档变化 → `refresh()`；帧下标变化 →
 *    本函数）。⇒ 循环没有提供任何新的重画时机。
 *
 * 合流到 P5 后被 `presentation-purity.test.ts` 的「遗留 RAF 双向登记」闸门抓到
 * （它普查 `src/` 全部真实 RAF 调用点，未登记即判红）。**正确的处置不是把它
 * 登记成 `paint-wakeup`，而是删除它** —— 登记是给"暂时无法消除的接缝"用的，
 * 而这一处可以直接消除。这也更贴合 #249 §19.3「禁止材质/视口自行累计 tick」
 * 与 §15 第 6 条「业务推进可枚举」的意图：**能不留自驱调度就不留**。
 */
function paintAll(): void {
  // 时间来自**唯一权威**（与视口/导出同一函数），不是本组件的独立累加器。
  const seconds = ctx.getSceneSeconds()
  for (const [key, canvas] of animationCanvases) {
    const img = animationImages.get(key)
    const card = cards.value.find(c => c.materialId === key || `${c.materialId}-detail` === key)
    if (!img || !card) continue
    const seq = sequenceFor(card)
    if (!seq) continue
    const sample = sampleTextureSequence(seq, seconds)
    if (!sample.ok) continue
    const frame = sample.value.frame
    if (lastPaintedFrame.get(key) === frame) continue
    paint(canvas, img, card, sample.value)
    lastPaintedFrame.set(key, frame)
  }
}

/** Vue `:ref` 绑定入口（与旧 `useMaterialAnimation().setCanvasRef` 同一调用形态）。 */
function setCanvasRef(el: unknown, materialId: string): void {
  const canvas = el as HTMLCanvasElement | null
  if (!canvas) {
    animationCanvases.delete(materialId)
    animationImages.delete(materialId)
    return
  }
  const lookupId = materialId.endsWith('-detail') ? materialId.slice(0, -7) : materialId
  const card = cards.value.find(c => c.materialId === lookupId)
  if (!card?.dataUrl || card.kind !== 'animated') return
  animationCanvases.set(materialId, canvas)
  const img = new Image()
  img.onload = () => {
    animationImages.set(materialId, img)
    // 图片到达后立即画首帧（此时才拿得到像素）。
    // 之后的每次重画都由**事件**驱动：文档变化（`refresh`）与帧下标变化（下面的 watch）
    // —— 没有自驱循环（原因见 `paintAll` 的说明）。
    const seq = sequenceFor(card)
    if (seq) {
      const sample = sampleTextureSequence(seq, ctx.getSceneSeconds())
      if (sample.ok) {
        paint(canvas, img, card, sample.value)
        lastPaintedFrame.set(materialId, sample.value.frame)
      }
    }
  }
  img.src = card.dataUrl
}

onUnmounted(() => {
  animationCanvases.clear()
  animationImages.clear()
  lastPaintedFrame.clear()
})

/**
 * **帧时钟订阅**（播放驱动）+ **帧下标 watch**（暂停态拖动定位）。
 *
 * ## 为什么必须订阅时钟（而不只 watch 帧下标）
 *
 * 旧驱动只有 `watch(() => ctx.getFrameIndex())`。M5-1 拆掉多方块帧轴后，
 * 多方块文档 `frameCount()===0`、帧下标恒 0 ⇒ 播放不会触发 watch，面板冻结。
 * 而纹理时间**本来就不该**依赖世界帧轴（`domain/animation#sceneClockOf` 只吃 frame/fps）。
 *
 * ## 为什么只在本组件订阅、不自己起调度器
 *
 * 时钟归外壳（`Context#getFrameClock`，一个 `EditContext` 一个），本组件只**订阅**：
 * 不累加任何 delta、不持有 rAF。暂停时 `advanced===false`（内核时间没变）⇒ 不重绘。
 * 帧时钟不可用（组件挂载早于外壳装配）时由 `watch(clock)` 在它出现后补订阅。
 */
let unframe: (() => void) | null = null
function subscribeClock(): void {
  unframe?.()
  unframe = null
  const clock = ctx.getFrameClock()
  if (clock === null) return
  unframe = clock.onFrame((info) => {
    if (info.advanced) paintAll()
  })
}
watch(() => ctx.getFrameClock(), () => subscribeClock())
onMounted(() => subscribeClock())
onBeforeUnmount(() => {
  unframe?.()
  unframe = null
})

// 暂停态拖动定位（时间变了但时钟 `advanced` 未必触发）⇒ 也重画一次。
watch(() => ctx.getFrameIndex(), () => paintAll())

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

// ---- Animation engine injected via useMaterialAnimation() above ----
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
