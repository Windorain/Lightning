# Material Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a material gallery tab to the workbench properties area with waterfall layout, nearest-neighbor texture previews, animated texture playback, and material detail inspection.

**Architecture:** Extend the panel system to support custom Vue components (not just UILayout trees), then build a MaterialGallery component with CSS-columns masonry layout, canvas-driven animation frames, and a split detail panel. Material data is queried via `bctx.queries.listMaterials()` which bridges RuntimeDocument materialPalette + textureBlobs to UI-ready items.

**Tech Stack:** Vue 3 + TypeScript + CSS columns + Canvas 2D + Vitest

---

### Task 1: Extend PanelDeclaration to support custom component

**Files:**
- Modify: `web/src/workbench/ux/types/panel.ts`

- [ ] **Step 1: Add optional `component` field to PanelDeclaration**

```typescript
import type { BContext } from '@/workbench/context/bContext'
import type { UILayout } from './layout'
import type { SpaceType, RegionType } from './screen'
import type { Component } from 'vue'

export interface PanelDeclaration {
  id: string
  label: string
  icon?: string
  spaceType: SpaceType
  regionType: RegionType
  poll(ctx: BContext): boolean
  layout(ctx: BContext): UILayout
  /** The owner object passed to RNAWidget for property get/set. null = no owner. */
  owner?(ctx: BContext): unknown
  /** Optional custom Vue component. When set, takes precedence over layout() for rendering. */
  component?: Component
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd web && npx vue-tsc --noEmit --project tsconfig.json 2>&1 | tail -5`
Expected: No new errors from this file.

---

### Task 2: Extend PanelTabs to render custom component

**Files:**
- Modify: `web/src/workbench/ux/PanelTabs.vue`

- [ ] **Step 1: Add `component` to PanelTabItem interface and render it**

Replace the `PanelTabItem` interface (lines 7-13) and the template's `.pt-content` div (lines 71-78):

```typescript
import { ref, watch, computed, type Component } from 'vue'
import UIRenderer from './UIRenderer.vue'
import type { RNARegistry } from './rna/types'
import type { UILayout } from './types/layout'

export interface PanelTabItem {
  id: string
  label: string
  icon?: string
  layout: UILayout
  owner?: unknown
  component?: Component
}
```

Replace the `.pt-content` div template (lines 71-78):

```html
    <div class="pt-content">
      <component
        v-if="activePanel?.component"
        :is="activePanel.component"
        :bctx="bctx"
      />
      <UIRenderer
        v-else-if="activePanel"
        :layout="activePanel.layout"
        :rna="rna"
        :owner="activePanel.owner"
      />
    </div>
```

Add `bctx` to props — replace the existing props block:

```typescript
const props = defineProps<{
  panels: PanelTabItem[]
  rna: RNARegistry
  bctx?: unknown
}>()
```

The `bctx` prop is typed as `unknown` to avoid circular imports (BContext type is heavy). Custom components assert their own typing.

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd web && npx vue-tsc --noEmit --project tsconfig.json 2>&1 | tail -5`
Expected: No new errors.

---

### Task 3: Extend WorkbenchRoot to pass component and bctx to PanelTabs

**Files:**
- Modify: `web/src/workbench/WorkbenchRoot.vue`

- [ ] **Step 1: Add `component` to the panel mapping computed**

Find `activePropertiesPanels` (around line 71-75). Add `component: p.component` to the mapped object:

```typescript
const activePropertiesPanels = computed(() =>
  propertiesArea.regions.find(r => r.type === RegionType.MAIN)!.panels
    .filter(p => p.poll(bctx))
    .map(p => ({ id: p.id, label: p.label, icon: p.icon, layout: p.layout(bctx), owner: p.owner?.(bctx), component: p.component }))
)
```

- [ ] **Step 2: Pass `bctx` to PanelTabs in the template**

Find `<PanelTabs :panels="activePropertiesPanels" :rna="bctx.rna" />` in the template and add `:bctx`:

```html
              <PanelTabs :panels="activePropertiesPanels" :rna="bctx.rna" :bctx="bctx" />
```

- [ ] **Step 3: Verify TypeScript compilation**

Run: `cd web && npx vue-tsc --noEmit --project tsconfig.json 2>&1 | tail -5`
Expected: No new errors.

---

### Task 4: Add listMaterials() query to sceneQueries

**Files:**
- Modify: `web/src/workbench/context/bContext.ts`
- Modify: `web/src/workbench/context/sceneQueries.ts`

- [ ] **Step 1: Add MaterialQueryItem type and BContextQueries method**

In `bContext.ts`, add after the existing imports:

```typescript
export interface MaterialQueryItem {
  materialId: string
  kind: 'static16' | 'animated'
  blend?: 'opaque' | 'cutout' | 'translucent'
  locator?: string
  emissive?: number
  animation?: {
    defaultFrametimeTicks?: number
    frameSequence?: Array<{ index: number; timeTicks?: number }>
    interpolate?: boolean
  }
  textureDataUrl: string | null
  atlas?: string | null
  linear?: boolean
  useMipmaps?: boolean
}
```

In the `BContextQueries` interface, add:

```typescript
  /** List all materials with their texture data URLs */
  listMaterials(): MaterialQueryItem[]
```

- [ ] **Step 2: Implement listMaterials in sceneQueries.ts**

Add import at top of `sceneQueries.ts`:

```typescript
import type { MaterialQueryItem } from '@/workbench/context/bContext'
```

Add inside `createProductionQueries()` return object:

```typescript
    listMaterials(): MaterialQueryItem[] {
      const doc = bctx.scene.scene.value
      if (!doc) return []
      const palette = doc.materialPalette as any[] | undefined
      if (!palette?.length) return []
      const blobs = doc.textureBlobs as Record<string, unknown> | undefined

      function getBlob(index: number): string | null {
        if (!blobs) return null
        const key = String(index)
        const b = blobs[key]
        if (typeof b !== 'string') return null
        const t = b.trim()
        if (t.startsWith('data:')) return t
        return `data:image/png;base64,${t}`
      }

      return palette.map((entry: any, i: number) => {
        const idx = entry.textureBlobIndex
        const dataUrl = (typeof idx === 'number' && Number.isFinite(idx))
          ? getBlob(Math.floor(idx))
          : null
        return {
          materialId: String(i),
          kind: entry.kind ?? 'static16',
          blend: entry.blend,
          locator: entry.locator,
          emissive: entry.emissive,
          animation: entry.animation,
          textureDataUrl: dataUrl,
          atlas: entry.atlas,
          linear: entry.linear,
          useMipmaps: entry.useMipmaps,
        }
      })
    },
```

- [ ] **Step 3: Write unit test for listMaterials**

Create: `web/src/workbench/context/__tests__/materialQueries.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import { createProductionQueries } from '@/workbench/context/sceneQueries'
import type { BContext } from '@/workbench/context/bContext'

function makeMockBctx(doc: RuntimeDocument): BContext {
  return {
    scene: {
      scene: { value: doc },
    },
    selection: { items: { value: new Set() } },
  } as unknown as BContext
}

describe('listMaterials', () => {
  it('returns empty array when no document', () => {
    const q = createProductionQueries({ scene: { scene: { value: null } } } as any)
    expect(q.listMaterials()).toEqual([])
  })

  it('returns empty array when no materialPalette', () => {
    const doc = new RuntimeDocument({ id: 'test' })
    const q = createProductionQueries(makeMockBctx(doc))
    expect(q.listMaterials()).toEqual([])
  })

  it('returns materials with textureDataUrl from textureBlobs', () => {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg=='
    const doc = new RuntimeDocument({
      id: 'test',
      materialPalette: [
        { textureBlobIndex: 0, kind: 'static16', blend: 'opaque' },
        { textureBlobIndex: 1, kind: 'animated', animation: { defaultFrametimeTicks: 2 } },
      ],
      textureBlobs: { '0': pngBase64, '1': pngBase64 },
    })
    const q = createProductionQueries(makeMockBctx(doc))
    const result = q.listMaterials()

    expect(result).toHaveLength(2)
    expect(result[0].materialId).toBe('0')
    expect(result[0].kind).toBe('static16')
    expect(result[0].blend).toBe('opaque')
    expect(result[0].textureDataUrl).toContain('data:image/png;base64,')

    expect(result[1].materialId).toBe('1')
    expect(result[1].kind).toBe('animated')
    expect(result[1].animation).toEqual({ defaultFrametimeTicks: 2 })
  })

  it('returns null textureDataUrl when textureBlobIndex is missing', () => {
    const doc = new RuntimeDocument({
      id: 'test',
      materialPalette: [
        { kind: 'static16', locator: 'minecraft:textures/blocks/stone' },
      ],
      textureBlobs: {},
    })
    const q = createProductionQueries(makeMockBctx(doc))
    const result = q.listMaterials()

    expect(result).toHaveLength(1)
    expect(result[0].textureDataUrl).toBeNull()
    expect(result[0].locator).toBe('minecraft:textures/blocks/stone')
  })
})
```

- [ ] **Step 4: Run the new test**

Run: `cd web && npx vitest run src/workbench/context/__tests__/materialQueries.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/workbench/context/bContext.ts web/src/workbench/context/sceneQueries.ts web/src/workbench/context/__tests__/materialQueries.test.ts
git commit -m "feat: add listMaterials() query to sceneQueries"
```

---

### Task 5: Create materialRNA struct

**Files:**
- Create: `web/src/workbench/ux/rna/structs/material.ts`

- [ ] **Step 1: Write materialRNA**

```typescript
import type { RNAStruct } from '../types'
import type { MaterialQueryItem } from '@/workbench/context/bContext'

export const materialRNA: RNAStruct = {
  name: 'Material',
  properties: [
    {
      name: 'kind',
      type: 'enum',
      label: '类型',
      description: '静态纹理或动画纹理',
      enumItems: [
        { value: 'static16', label: '静态 (16x)' },
        { value: 'animated', label: '动画' },
      ],
      get(owner: unknown) {
        return (owner as MaterialQueryItem).kind
      },
      set(_owner: unknown, _value: unknown) {},
    },
    {
      name: 'blend',
      type: 'enum',
      label: '混合模式',
      description: '纹理透明度处理方式',
      enumItems: [
        { value: 'opaque', label: '不透明' },
        { value: 'cutout', label: '裁剪' },
        { value: 'translucent', label: '半透明' },
      ],
      get(owner: unknown) {
        return (owner as MaterialQueryItem).blend ?? 'opaque'
      },
      set(_owner: unknown, _value: unknown) {},
    },
    {
      name: 'emissive',
      type: 'number',
      label: '自发光',
      description: '自发光强度 (0-15)',
      min: 0,
      max: 15,
      get(owner: unknown) {
        return (owner as MaterialQueryItem).emissive ?? 0
      },
      set(_owner: unknown, _value: unknown) {},
    },
    {
      name: 'locator',
      type: 'string',
      label: '资源定位符',
      description: 'MC 资源包定位符 (namespace:path)',
      get(owner: unknown) {
        return (owner as MaterialQueryItem).locator ?? ''
      },
      set(_owner: unknown, _value: unknown) {},
    },
  ],
}
```

- [ ] **Step 2: Export from rna barrel**

Modify `web/src/workbench/ux/rna/index.ts` — read it first to see current exports, then add:

```typescript
export { materialRNA } from './structs/material'
```

- [ ] **Step 3: Verify TypeScript compilation**

Run: `cd web && npx vue-tsc --noEmit --project tsconfig.json 2>&1 | tail -5`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/workbench/ux/rna/structs/material.ts web/src/workbench/ux/rna/index.ts
git commit -m "feat: add materialRNA struct for material property display"
```

---

### Task 6: Create material operators

**Files:**
- Create: `web/src/workbench/operators/builtin/materialOperators.ts`

- [ ] **Step 1: Write the three operators**

```typescript
import type { OperatorType } from '@/workbench/operators/operatorType'
import type { MaterialQueryItem } from '@/workbench/context/bContext'

/** Resolve the dataUrl of the material — shared helper */
function resolveMaterialDataUrl(bctx: any, materialId: string): string | null {
  const materials = bctx.queries?.listMaterials?.() ?? []
  const m = materials.find((item: MaterialQueryItem) => item.materialId === materialId)
  return m?.textureDataUrl ?? null
}

/** Download a data URL as a PNG file */
function downloadPng(dataUrl: string, filename: string): void {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename.endsWith('.png') ? filename : `${filename}.png`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

export const ExportTextureOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_TEXTURE',
  label: '导出纹理 PNG',
  description: '将当前选中的材质纹理导出为 PNG 文件',

  poll(bctx) {
    const materials = bctx.queries?.listMaterials?.() ?? []
    return materials.length > 0
  },

  exec(bctx, props) {
    const materialId = (props?.materialId as string) ?? '0'
    const dataUrl = resolveMaterialDataUrl(bctx, materialId)
    if (!dataUrl) {
      bctx.log?.warn('导出', `材质 ${materialId} 无纹理数据`)
      return
    }
    const materials = bctx.queries?.listMaterials?.() ?? []
    const m = materials.find((item: MaterialQueryItem) => item.materialId === materialId)
    const name = m?.locator
      ? m.locator.replace(/^.*[\\/]/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
      : `material_${materialId}`
    downloadPng(dataUrl, name)
  },
}

export const ExportAllTexturesOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_ALL_TEXTURES',
  label: '导出全部纹理',
  description: '将所有材质纹理逐个导出为 PNG 文件',

  poll(bctx) {
    return (bctx.queries?.listMaterials?.() ?? []).some(
      (m: MaterialQueryItem) => m.textureDataUrl !== null,
    )
  },

  exec(bctx, _props) {
    const materials = bctx.queries?.listMaterials?.() ?? []
    let count = 0
    for (const m of materials) {
      if (!m.textureDataUrl) continue
      const name = m.locator
        ? m.locator.replace(/^.*[\\/]/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
        : `material_${m.materialId}`
      // Slight delay between downloads to avoid browser blocking
      setTimeout(() => downloadPng(m.textureDataUrl!, name), count * 100)
      count++
    }
    if (count === 0) {
      bctx.log?.warn('导出', '没有可导出的纹理')
    }
  },
}

export const CopyMaterialLocatorOperator: OperatorType = {
  id: 'OPERATOR_COPY_MATERIAL_LOCATOR',
  label: '复制定位符',
  description: '复制材质资源定位符到剪贴板',

  poll(bctx) {
    const materials = bctx.queries?.listMaterials?.() ?? []
    return materials.some((m: MaterialQueryItem) => !!m.locator)
  },

  async exec(bctx, props) {
    const materialId = (props?.materialId as string) ?? '0'
    const materials = bctx.queries?.listMaterials?.() ?? []
    const m = materials.find((item: MaterialQueryItem) => item.materialId === materialId)
    if (!m?.locator) {
      bctx.log?.warn('操作', `材质 ${materialId} 无定位符`)
      return
    }
    try {
      await navigator.clipboard.writeText(m.locator)
    } catch {
      // Fallback for older browsers
      const ta = document.createElement('textarea')
      ta.value = m.locator
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
  },
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd web && npx vue-tsc --noEmit --project tsconfig.json 2>&1 | tail -5`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/workbench/operators/builtin/materialOperators.ts
git commit -m "feat: add material export/copy operators"
```

---

### Task 7: Create MaterialGallery Vue component

**Files:**
- Create: `web/src/workbench/ux/panels/MaterialGallery.vue`

This is the core UI component. It handles waterfall layout, nearest-neighbor rendering, canvas-based animation, click-to-select, and the right detail panel.

- [ ] **Step 1: Write the MaterialGallery component**

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
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

// For RNAWidget — wrap the selected material as a reactive owner
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

// Refresh when scene changes
watch(() => props.bctx.scene.scene.value, () => refresh(), { immediate: true })

// ---- Animation engine ----
const animationRefs = new Map<string, HTMLCanvasElement>()
const animationHandles = new Map<string, number>()

function setCanvasRef(el: HTMLCanvasElement | null, materialId: string) {
  if (el) {
    animationRefs.set(materialId, el)
    startAnimation(materialId)
  } else {
    stopAnimation(materialId)
    animationRefs.delete(materialId)
  }
}

function startAnimation(id: string) {
  const card = cards.value.find(c => c.materialId === id)
  if (!card?.dataUrl || card.kind !== 'animated') return

  const img = new Image()
  img.src = card.dataUrl
  img.onload = () => {
    const canvas = animationRefs.get(id)
    if (!canvas) return

    const frameSize = img.width // each frame is square, width = height
    const frameCount = Math.floor(img.height / frameSize)
    if (frameCount <= 1) return

    canvas.width = frameSize
    canvas.height = frameSize
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    const frameTime = card.animation?.defaultFrametimeTicks ?? 1
    const tickMs = Math.max(frameTime * 50, 80) // ~1 tick = 50ms, min 80ms
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
            :ref="(el: any) => setCanvasRef(el as HTMLCanvasElement, card.materialId)"
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
            :ref="(el: any) => setCanvasRef(el as HTMLCanvasElement, `${selected.materialId}-detail`)"
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
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd web && npx vue-tsc --noEmit --project tsconfig.json 2>&1 | tail -5`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/workbench/ux/panels/MaterialGallery.vue
git commit -m "feat: add MaterialGallery component with waterfall layout and animation"
```

---

### Task 8: Create materialGallery panel declaration

**Files:**
- Create: `web/src/workbench/ux/panels/materialGallery.ts`

- [ ] **Step 1: Write panel declaration**

```typescript
import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import MaterialGallery from './MaterialGallery.vue'

export const materialGalleryPanel: PanelDeclaration = {
  id: 'material-gallery',
  label: '材质画廊',
  icon: '🎨',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    const doc = ctx.scene.scene.value
    if (!doc) return false
    const palette = doc.materialPalette as unknown[] | undefined
    return (palette?.length ?? 0) > 0
  },

  layout(_ctx: BContext) {
    // Fallback layout — component takes precedence
    return { kind: 'column', align: false, items: [{ kind: 'label' as const, text: '材质画廊' }] }
  },

  component: MaterialGallery,
}
```

- [ ] **Step 2: Export from panels barrel**

Modify `web/src/workbench/ux/panels/index.ts` — add:

```typescript
export { materialGalleryPanel } from './materialGallery'
```

- [ ] **Step 3: Commit**

```bash
git add web/src/workbench/ux/panels/materialGallery.ts web/src/workbench/ux/panels/index.ts
git commit -m "feat: add materialGallery panel declaration"
```

---

### Task 9: Register everything in workbenchContext

**Files:**
- Modify: `web/src/workbench/context/workbenchContext.ts`

- [ ] **Step 1: Add imports**

Add near the other panel imports (after line 33):

```typescript
import { materialGalleryPanel } from '@/workbench/ux/panels/materialGallery'
```

Add near the other operator imports (after line 48):

```typescript
import { ExportTextureOperator, ExportAllTexturesOperator, CopyMaterialLocatorOperator } from '@/workbench/operators/builtin/materialOperators'
```

Add near the other RNA imports (line 25):

```typescript
import { materialRNA } from '@/workbench/ux/rna/structs/material'
```

- [ ] **Step 2: Register operators in ALL_OPERATORS array**

Add to `ALL_OPERATORS` (after line 71, before `]`):

```typescript
  ExportTextureOperator, ExportAllTexturesOperator, CopyMaterialLocatorOperator,
```

- [ ] **Step 3: Register RNA**

After `rna.register(annotationRNA)` (line 138), add:

```typescript
  rna.register(materialRNA)
```

- [ ] **Step 4: Register panel in properties area**

In the properties area push (line 173-175), add `materialGalleryPanel`:

```typescript
  propertiesArea.regions.find(r => r.type === RegionType.MAIN)!.panels.push(
    blockInspectorPanel, transformPanel, sceneInfoPanel, blockStatsPanel, annotationPanel, materialGalleryPanel,
  )
```

- [ ] **Step 5: Verify TypeScript compilation**

Run: `cd web && npx vue-tsc --noEmit --project tsconfig.json 2>&1 | tail -5`
Expected: No new errors.

- [ ] **Step 6: Run all tests**

Run: `cd web && npx vitest run`
Expected: All existing tests pass + the new materialQueries test.

- [ ] **Step 7: Commit**

```bash
git add web/src/workbench/context/workbenchContext.ts
git commit -m "feat: register material gallery panel, operators, and RNA"
```

---

### Task 10: Integration verification

**Files:**
- No new files — manual verification.

- [ ] **Step 1: Start dev server**

Run: `cd web && npm run dev:web 2>&1 | tail -5`

- [ ] **Step 2: Load a scene with materials in the browser**

Open the workbench in a browser. Load a scene that has `materialPalette` data (any V2 scene with textureBlobs). Verify:
- "材质画廊" tab appears in the properties sidebar
- Waterfall grid shows material thumbnails with pixelated rendering
- Animated textures show animation playback
- Clicking a card shows the detail panel on the right
- Detail panel shows material properties via RNAWidget
- "导出 PNG" button triggers download
- "复制定位符" button copies to clipboard

- [ ] **Step 3: Verify empty state**

Load or create a scene without materials. Verify:
- The "材质画廊" tab does NOT appear (poll returns false)

- [ ] **Step 4: Commit (if any fixes)**

```bash
git add -A
git commit -m "fix: material gallery integration fixes"
```
