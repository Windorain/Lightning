# Workbench Interaction Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the 10-tool system to real Three.js viewport interaction — gizmo rendering, pointer event routing, scene mutation commands, and tool overlays. Users can select, move, delete, and annotate blocks with visual feedback.

**Architecture:** A `GizmoManager` class owns Three.js gizmo meshes in the scene. A `createToolContext()` factory wraps camera/raycaster/contentGroup to provide real `pickVoxel()` and `execute*()` implementations. `WorkbenchViewport.vue` creates the context on mount, routes canvas pointer events through `activeTool.onPointer*()` and renders gizmos in the render loop. Each `execute*()` creates an `EditCommand`, mutates `scene.scene.value` in-place, and pushes undo.

**Tech Stack:** Three.js 0.174, Vue 3, TypeScript, existing `pickVoxelFromPointer` / `RenderViewport`

**Current baseline:** 14 commits on `feat/workbench-editing-tools`. Typecheck clean, builds pass. Tools registered, keymap wired, panels switching.

---

## File Map

```
Create:
  web/src/workbench/tools/gizmos.ts              — MoveGizmo class (arrows + planes + hit-test + modal drag)
  web/src/workbench/tools/interactionFactory.ts  — createToolContext(camera, contentGroup, def, contexts) → ThreeToolContext

Modify:
  web/src/workbench/components/WorkbenchViewport.vue — wire context + pointer routing + gizmo render loop
  web/src/workbench/tools/selectTool.ts               — integrate click-threshold, selection wireframe
  web/src/workbench/tools/moveTool.ts                 — use MoveGizmo for renderOverlay
  web/src/workbench/tools/annotationTool.ts           — bbox preview during drag
  web/src/workbench/tools/_base.ts                    — add snap ref to context
```

---

### Task 1: Move Gizmo — Three.js arrow meshes and hit-testing

**Files:**
- Create: `web/src/workbench/tools/gizmos.ts`

- [ ] **Step 1: Write MoveGizmo class**

```typescript
// web/src/workbench/tools/gizmos.ts
import * as THREE from 'three'

const AXIS_COLORS = {
  x: 0xff3333, // Red
  y: 0x33ff33, // Green
  z: 0x3388ff, // Blue
} as const

const AXIS_COLORS_HI = {
  x: 0xff8888,
  y: 0x88ff88,
  z: 0x88bbff,
} as const

const ARROW_LENGTH = 1.2
const ARROW_RADIUS = 0.04
const CONE_RADIUS = 0.10
const CONE_LENGTH = 0.25
const PLANE_SIZE = 0.3
const HIT_THRESHOLD = 0.15

export type GizmoAxis = 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz'
export type GizmoPart = GizmoAxis | null

interface ArrowMeshes {
  line: THREE.Mesh
  cone: THREE.Mesh
}

interface PlaneMeshes {
  plane: THREE.Mesh
}

function makeArrow(axis: 'x' | 'y' | 'z', color: number): ArrowMeshes {
  const dir = axis === 'x' ? new THREE.Vector3(1, 0, 0)
    : axis === 'y' ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1)

  // Cylinder shaft
  const cylGeo = new THREE.CylinderGeometry(ARROW_RADIUS, ARROW_RADIUS, ARROW_LENGTH - CONE_LENGTH, 8)
  const cylMat = new THREE.MeshBasicMaterial({ color, depthTest: true, depthWrite: false })
  const line = new THREE.Mesh(cylGeo, cylMat)
  line.position.copy(dir.clone().multiplyScalar((ARROW_LENGTH - CONE_LENGTH) / 2))
  if (axis === 'x') line.rotation.z = -Math.PI / 2
  if (axis === 'z') line.rotation.x = Math.PI / 2

  // Cone tip
  const coneGeo = new THREE.ConeGeometry(CONE_RADIUS, CONE_LENGTH, 8)
  const coneMat = new THREE.MeshBasicMaterial({ color, depthTest: true, depthWrite: false })
  const cone = new THREE.Mesh(coneGeo, coneMat)
  cone.position.copy(dir.clone().multiplyScalar(ARROW_LENGTH - CONE_LENGTH / 2))
  if (axis === 'x') cone.rotation.z = -Math.PI / 2
  if (axis === 'z') cone.rotation.x = Math.PI / 2

  return { line, cone }
}

function makePlane(axes: 'xy' | 'xz' | 'yz', color: number): PlaneMeshes {
  const size = PLANE_SIZE
  const geo = new THREE.PlaneGeometry(size, size)
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: true, depthWrite: false, transparent: true, opacity: 0.3 })
  const plane = new THREE.Mesh(geo, mat)

  if (axes === 'xy') {
    // XY plane faces Z
  } else if (axes === 'xz') {
    plane.rotation.x = -Math.PI / 2
  } else {
    plane.rotation.y = Math.PI / 2
  }
  plane.position.set(
    axes === 'xy' || axes === 'xz' ? PLANE_SIZE / 2 : 0,
    axes === 'xy' || axes === 'yz' ? PLANE_SIZE / 2 : 0,
    axes === 'xz' || axes === 'yz' ? PLANE_SIZE / 2 : 0,
  )
  return { plane }
}

export class MoveGizmo {
  readonly root: THREE.Group
  private arrows: Record<'x' | 'y' | 'z', ArrowMeshes>
  private planes: Record<'xy' | 'xz' | 'yz', PlaneMeshes>
  private allMeshes: THREE.Object3D[]
  private axisRays: Record<string, THREE.Raycaster> = {}

  constructor() {
    this.root = new THREE.Group()
    this.root.visible = false

    this.arrows = {
      x: makeArrow('x', AXIS_COLORS.x),
      y: makeArrow('y', AXIS_COLORS.y),
      z: makeArrow('z', AXIS_COLORS.z),
    }
    this.planes = {
      xy: makePlane('xy', AXIS_COLORS.z),
      xz: makePlane('xz', AXIS_COLORS.y),
      yz: makePlane('yz', AXIS_COLORS.x),
    }

    this.allMeshes = []
    for (const a of Object.values(this.arrows)) {
      this.root.add(a.line)
      this.root.add(a.cone)
      this.allMeshes.push(a.line, a.cone)
    }
    for (const p of Object.values(this.planes)) {
      this.root.add(p.plane)
      this.allMeshes.push(p.plane)
    }
  }

  setPosition(pos: THREE.Vector3): void {
    this.root.position.copy(pos)
  }

  setVisible(v: boolean): void {
    this.root.visible = v
  }

  /** Hit-test gizmo parts against a raycaster. Returns the hit part or null. */
  hitTest(raycaster: THREE.Raycaster): GizmoPart {
    const hits = raycaster.intersectObjects(this.allMeshes, false)
    if (hits.length === 0) return null

    const obj = hits[0].object
    // Map back to which axis or plane was hit
    for (const [axis, arrow] of Object.entries(this.arrows)) {
      if (obj === arrow.line || obj === arrow.cone) return axis as GizmoAxis
    }
    for (const [plane, p] of Object.entries(this.planes)) {
      if (obj === p.plane) return plane as GizmoAxis
    }
    return null
  }

  /** Highlight a specific part, un-highlight others */
  setHighlight(part: GizmoPart): void {
    for (const [axis, arrow] of Object.entries(this.arrows)) {
      const active = axis === part
      const c = active ? AXIS_COLORS_HI[axis as keyof typeof AXIS_COLORS_HI] : AXIS_COLORS[axis as keyof typeof AXIS_COLORS]
      ;(arrow.line.material as THREE.MeshBasicMaterial).color.set(c)
      ;(arrow.cone.material as THREE.MeshBasicMaterial).color.set(c)
    }
    for (const [plane, p] of Object.entries(this.planes)) {
      const active = plane === part
      const mat = p.plane.material as THREE.MeshBasicMaterial
      mat.opacity = active ? 0.6 : 0.3
    }
  }

  /** Compute constrained delta along an axis given a drag ray */
  computeAxisDelta(axis: GizmoAxis, origin: THREE.Vector3, dragRay: THREE.Raycaster): number {
    if (!axis || axis.length > 1) return 0
    const dirs = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
    const dir = dirs[axis]
    // Project ray onto axis
    const rayOrigin = dragRay.ray.origin.clone()
    const rayDir = dragRay.ray.direction.clone()
    // Find closest point on axis to ray
    const w = rayOrigin.clone().sub(origin)
    const dDotD = rayDir.dot(rayDir)
    const wDotD = w.dot(rayDir)
    const t = -wDotD / dDotD
    const closestOnRay = rayOrigin.clone().addScaledVector(rayDir, t)
    const deltaVec = closestOnRay.clone().sub(origin)
    const delta = deltaVec.dot(dir)
    return Math.round(delta) // Snap to integer grid
  }

  dispose(): void {
    for (const m of this.allMeshes) {
      m.geometry?.dispose()
      ;(m.material as THREE.Material)?.dispose()
    }
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd D:/Projects/Lightning/web && npx vue-tsc --noEmit
```

Expected: No errors from gizmos.ts

- [ ] **Step 3: Commit**

```bash
cd D:/Projects/Lightning
git add web/src/workbench/tools/gizmos.ts
git commit -m "feat: add MoveGizmo — axis arrows, planes, hit-testing, constrained delta"
```

---

### Task 2: Interaction factory — real ThreeToolContext

**Files:**
- Create: `web/src/workbench/tools/interactionFactory.ts`

- [ ] **Step 1: Write createToolContext**

```typescript
// web/src/workbench/tools/interactionFactory.ts
import * as THREE from 'three'
import type { ThreeToolContext } from './_base'
import type { SceneContext } from '@/workbench/sceneContext'
import type { SelectionContext, BlockRef } from '@/workbench/selectionContext'
import type { ToolRegistry } from '@/workbench/toolRegistry'
import type { UndoManager, EditCommand } from '@/workbench/editHistoryContext'
import type { StructureDefinition } from '@/render/schema/types'
import type { V2BlockInstance, V2PlainSceneDocument, V2AnnotationBox } from '@/render/data/sceneDocumentV2'
import { pickVoxelFromPointer } from '@/render/interaction/voxelPick'
import type { LayerPreviewMode } from '@/render/data/layerPreview'

function generateId(): string {
  return 'cmd_' + Math.random().toString(36).slice(2, 10)
}

function findBlock(blocks: V2BlockInstance[], pos: { x: number; y: number; z: number }): V2BlockInstance | undefined {
  return blocks.find(b => b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z)
}

export interface ToolContextDeps {
  scene: SceneContext
  selection: SelectionContext
  toolRegistry: ToolRegistry
  editHistory: UndoManager
  camera: THREE.Camera
  contentGroup: THREE.Group
  domElement: HTMLElement
  definition: StructureDefinition
  layerPreview: LayerPreviewMode
}

class ToolContextImpl implements ThreeToolContext {
  scene: SceneContext
  selection: SelectionContext
  toolRegistry: ToolRegistry
  editHistory: UndoManager
  private camera: THREE.Camera
  private contentGroup: THREE.Group
  private domElement: HTMLElement
  private definition: StructureDefinition
  private layerPreview: LayerPreviewMode

  // Transient state
  _selectStart?: { x: number; y: number } | null
  _boxSelecting?: boolean
  _moveStart?: { x: number; y: number } | null
  _moveDelta?: { x: number; y: number; z: number } | null
  _moveInitialPositions?: Array<{ x: number; y: number; z: number }> | null
  _annotStart?: { x: number; y: number; z: number } | null
  _annotEnd?: { x: number; y: number; z: number } | null
  _annotating?: boolean
  _fillStart?: { x: number; y: number } | null
  _labelPosition?: { x: number; y: number; z: number } | null
  _showLabelEditor?: boolean

  constructor(deps: ToolContextDeps) {
    this.scene = deps.scene
    this.selection = deps.selection
    this.toolRegistry = deps.toolRegistry
    this.editHistory = deps.editHistory
    this.camera = deps.camera
    this.contentGroup = deps.contentGroup
    this.domElement = deps.domElement
    this.definition = deps.definition
    this.layerPreview = deps.layerPreview
  }

  pickVoxel(event: PointerEvent): BlockRef | null {
    const result = pickVoxelFromPointer({
      clientX: event.clientX,
      clientY: event.clientY,
      domElement: this.domElement,
      camera: this.camera,
      contentGroup: this.contentGroup,
      def: this.definition,
      layerPreview: this.layerPreview,
    })
    if (!result) return null
    return {
      pos: { x: result.column, y: result.row, z: result.zSlice },
      block_state_id: result.blockId,
    }
  }

  getFrameBlocks(): BlockRef[] {
    const doc = this.scene.scene.value as V2PlainSceneDocument | null
    if (!doc?.frames?.length) return []
    const frame = doc.frames[this.selection.frameIndex.value ?? 0]
    return (frame.blocks ?? []).map(b => ({
      pos: { ...b.pos },
      block_state_id: b.block_state_id,
    }))
  }

  // --- Command executors ---

  executeMove(initialPositions: Array<{ x: number; y: number; z: number }>, delta: { x: number; y: number; z: number }): void {
    const doc = this.scene.scene.value as V2PlainSceneDocument | null
    if (!doc) return
    const frame = doc.frames[this.selection.frameIndex.value ?? 0]
    if (!frame) return

    const cmd: EditCommand = {
      id: generateId(),
      label: `移动 ${initialPositions.length} 个方块`,
      timestamp: Date.now(),
      execute: () => {
        for (const initPos of initialPositions) {
          const block = findBlock(frame.blocks, initPos)
          if (block) {
            block.pos.x = initPos.x + delta.x
            block.pos.y = initPos.y + delta.y
            block.pos.z = initPos.z + delta.z
          }
        }
        this.scene.markDirty()
      },
      undo: () => {
        for (const initPos of initialPositions) {
          const newPos = { x: initPos.x + delta.x, y: initPos.y + delta.y, z: initPos.z + delta.z }
          const block = findBlock(frame.blocks, newPos)
          if (block) {
            block.pos.x = initPos.x
            block.pos.y = initPos.y
            block.pos.z = initPos.z
          }
        }
        this.scene.markDirty()
      },
    }
    this.editHistory.push(cmd)
  }

  executeDelete(targets: BlockRef[]): void {
    const doc = this.scene.scene.value as V2PlainSceneDocument | null
    if (!doc) return
    const frame = doc.frames[this.selection.frameIndex.value ?? 0]
    if (!frame) return

    const removed: V2BlockInstance[] = []
    const targetKeys = new Set(targets.map(t => `${t.pos.x},${t.pos.y},${t.pos.z}`))

    const cmd: EditCommand = {
      id: generateId(),
      label: `删除 ${targets.length} 个方块`,
      timestamp: Date.now(),
      execute: () => {
        const keep: V2BlockInstance[] = []
        for (const b of frame.blocks) {
          const k = `${b.pos.x},${b.pos.y},${b.pos.z}`
          if (targetKeys.has(k)) { removed.push(b) } else { keep.push(b) }
        }
        frame.blocks = keep
        this.scene.markDirty()
      },
      undo: () => {
        for (const r of removed) { frame.blocks.push(r) }
        removed.length = 0
        this.scene.markDirty()
      },
    }
    this.editHistory.push(cmd)
  }

  executeReplace(replacements: Array<{ pos: { x: number; y: number; z: number }; oldBlockStateId: string; newBlockStateId: string }>): void {
    const doc = this.scene.scene.value as V2PlainSceneDocument | null
    if (!doc) return
    const frame = doc.frames[this.selection.frameIndex.value ?? 0]
    if (!frame) return

    const oldIds = replacements.map(r => ({ pos: r.pos, oldId: r.oldBlockStateId }))
    const newId = replacements[0]?.newBlockStateId ?? ''

    const cmd: EditCommand = {
      id: generateId(),
      label: `替换 ${replacements.length} 个方块`,
      timestamp: Date.now(),
      execute: () => {
        for (const r of replacements) {
          const block = findBlock(frame.blocks, r.pos)
          if (block) block.block_state_id = r.newBlockStateId
        }
        this.scene.markDirty()
      },
      undo: () => {
        for (const { pos, oldId } of oldIds) {
          const block = findBlock(frame.blocks, pos)
          if (block) block.block_state_id = oldId
        }
        this.scene.markDirty()
      },
    }
    this.editHistory.push(cmd)
  }

  executeMirror(targets: BlockRef[], axis: 'x' | 'y' | 'z'): void {
    const doc = this.scene.scene.value as V2PlainSceneDocument | null
    if (!doc) return
    const frame = doc.frames[this.selection.frameIndex.value ?? 0]
    if (!frame) return

    // Find center of selection for mirror origin
    const min = { x: Infinity, y: Infinity, z: Infinity }
    const max = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (const t of targets) {
      if (t.pos.x < min.x) min.x = t.pos.x
      if (t.pos.y < min.y) min.y = t.pos.y
      if (t.pos.z < min.z) min.z = t.pos.z
      if (t.pos.x > max.x) max.x = t.pos.x
      if (t.pos.y > max.y) max.y = t.pos.y
      if (t.pos.z > max.z) max.z = t.pos.z
    }
    const center = { x: Math.round((min.x + max.x) / 2), y: Math.round((min.y + max.y) / 2), z: Math.round((min.z + max.z) / 2) }

    const newBlocks: V2BlockInstance[] = []
    const targetKeys = new Set(targets.map(t => `${t.pos.x},${t.pos.y},${t.pos.z}`))
    const originalBlocks = frame.blocks.filter(b => targetKeys.has(`${b.pos.x},${b.pos.y},${b.pos.z}`))

    for (const b of originalBlocks) {
      const mirrored: V2BlockInstance = {
        pos: { ...b.pos },
        block_state_id: b.block_state_id,
        nbt: b.nbt ? { ...b.nbt } : undefined,
        parts: b.parts?.map(p => ({ ...p, local_id: p.local_id + '_mirror' })),
      }
      if (axis === 'x') mirrored.pos.x = center.x * 2 - mirrored.pos.x
      if (axis === 'y') mirrored.pos.y = center.y * 2 - mirrored.pos.y
      if (axis === 'z') mirrored.pos.z = center.z * 2 - mirrored.pos.z
      newBlocks.push(mirrored)
    }

    const cmd: EditCommand = {
      id: generateId(),
      label: `镜像 ${newBlocks.length} 个方块`,
      timestamp: Date.now(),
      execute: () => {
        frame.blocks.push(...newBlocks)
        this.scene.markDirty()
      },
      undo: () => {
        const keys = new Set(newBlocks.map(b => `${b.pos.x},${b.pos.y},${b.pos.z}`))
        frame.blocks = frame.blocks.filter(b => !keys.has(`${b.pos.x},${b.pos.y},${b.pos.z}`))
        this.scene.markDirty()
      },
    }
    this.editHistory.push(cmd)
  }

  executeGenerate(blockStateId: string, pos: { x: number; y: number; z: number }): void {
    const doc = this.scene.scene.value as V2PlainSceneDocument | null
    if (!doc) return
    const frame = doc.frames[this.selection.frameIndex.value ?? 0]
    if (!frame) return

    const newBlock: V2BlockInstance = { pos: { ...pos }, block_state_id: blockStateId }
    const cmd: EditCommand = {
      id: generateId(),
      label: `生成方块 ${blockStateId}`,
      timestamp: Date.now(),
      execute: () => {
        frame.blocks.push(newBlock)
        this.scene.markDirty()
      },
      undo: () => {
        frame.blocks = frame.blocks.filter(b => b !== newBlock)
        this.scene.markDirty()
      },
    }
    this.editHistory.push(cmd)
  }

  executeCreateAnnotation(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): void {
    const doc = this.scene.scene.value as V2PlainSceneDocument | null
    if (!doc) return

    const annotation: V2AnnotationBox = {
      id: 'anno_' + Math.random().toString(36).slice(2, 8),
      title: '',
      description: '',
      min: bounds.min,
      max: bounds.max,
      color: '#4488ff',
      visible: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    }

    const cmd: EditCommand = {
      id: generateId(),
      label: '创建注解框',
      timestamp: Date.now(),
      execute: () => {
        if (!doc.annotations) doc.annotations = []
        doc.annotations.push(annotation)
        this.scene.markDirty()
      },
      undo: () => {
        if (doc.annotations) {
          doc.annotations = doc.annotations.filter(a => a.id !== annotation.id)
        }
        this.scene.markDirty()
      },
    }
    this.editHistory.push(cmd)
  }
}

export function createToolContext(deps: ToolContextDeps): ThreeToolContext {
  return new ToolContextImpl(deps)
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd D:/Projects/Lightning/web && npx vue-tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd D:/Projects/Lightning
git add web/src/workbench/tools/interactionFactory.ts
git commit -m "feat: add interactionFactory — real ThreeToolContext with voxelPick + execute* commands + undo"
```

---

### Task 3: Wire WorkbenchViewport — canvas events → active tool

**Files:**
- Modify: `web/src/workbench/components/WorkbenchViewport.vue`

- [ ] **Step 1: Add imports and context setup**

Add these imports to the existing `<script setup>` block:

```typescript
import type { ThreeToolContext } from '@/workbench/tools/_base'
import { createToolContext } from '@/workbench/tools/interactionFactory'
import { MoveGizmo } from '@/workbench/tools/gizmos'
import { useToolRegistry } from '@/workbench/toolRegistry'
import { useEditHistory } from '@/workbench/editHistoryContext'
import type { LayerPreviewMode } from '@/render/data/layerPreview'
import type { StructureDefinition } from '@/render/schema/types'
```

- [ ] **Step 2: Create tool context after viewport ready**

Replace the `onViewportReady` function body to also create the tool context:

```typescript
let toolCtx: ThreeToolContext | null = null
let moveGizmo: MoveGizmo | null = null

const toolRegistry = useToolRegistry()
const editHistory = useEditHistory()

async function onViewportReady(scene: THREE.Scene): Promise<void> {
  store.registerScene(scene)
  try { await store.rebuildContentMesh() } catch (e) { console.error('[Workbench] onViewportReady', e) }

  // Create tool context once scene is ready
  const vp = (store as any)._viewport as { camera?: THREE.Camera; domElement?: HTMLElement }
  // The RenderViewport exposes camera and domElement
  // We access these through StructureViewport's exposed internals
}
```

- [ ] **Step 3: Handle pointer events through active tool**

Add pointer event handlers that delegate to the active tool:

```typescript
function handlePointerDown(event: PointerEvent): void {
  if (!toolCtx) return
  toolRegistry.activeTool.value?.onPointerDown?.(toolCtx, event)
}

function handlePointerMove(event: PointerEvent): void {
  if (!toolCtx) return
  toolRegistry.activeTool.value?.onPointerMove?.(toolCtx, event)
}

function handlePointerUp(event: PointerEvent): void {
  if (!toolCtx) return
  toolRegistry.activeTool.value?.onPointerUp?.(toolCtx, event)
}
```

- [ ] **Step 4: Wire pointer events to canvas element**

In `onViewportReady`, attach listeners to the canvas:

```typescript
// After scene setup, wire canvas pointer events
const canvas = scene.userData?.canvas as HTMLElement | undefined
  ?? (store as any)._viewport?.domElement as HTMLElement | undefined

if (canvas) {
  canvas.addEventListener('pointerdown', handlePointerDown)
  canvas.addEventListener('pointermove', handlePointerMove)
  canvas.addEventListener('pointerup', handlePointerUp)
}
```

and clean up in `onBeforeUnmount`:

```typescript
onBeforeUnmount(() => {
  const canvas = /* get ref */
  canvas?.removeEventListener('pointerdown', handlePointerDown)
  canvas?.removeEventListener('pointermove', handlePointerMove)
  canvas?.removeEventListener('pointerup', handlePointerUp)
  store.disposeCachesAndLibrary()
  moveGizmo?.dispose()
})
```

- [ ] **Step 5: Update the old hardcoded shelf to hide when ToolShelf renders**

The old `wv-shelf` div (lines 127-131) duplicates ToolShelf. Remove it:

```html
<!-- REMOVE these lines:
    <div class="wv-shelf">
      <div class="wv-shelf-panel">
        <div class="wv-shelf-title">{{ t('tools') }}</div>
        <button class="wv-tool-btn wv-tool-btn--active">{{ t('select') }}</button>
      </div>
    </div>
-->
```

- [ ] **Step 6: Verify typecheck + build**

```bash
cd D:/Projects/Lightning/web && npx vue-tsc --noEmit && npm run build:all 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
cd D:/Projects/Lightning
git add web/src/workbench/components/WorkbenchViewport.vue
git commit -m "feat: wire WorkbenchViewport — tool context, pointer event routing, remove old shelf"
```

---

### Task 4: Wire gizmo rendering in render loop

**Files:**
- Modify: `web/src/workbench/components/WorkbenchViewport.vue` (further changes)

- [ ] **Step 1: Add render loop hook for gizmo overlay**

After tool context creation, add MoveGizmo to the scene and a per-frame update:

```typescript
// In onViewportReady, after scene is registered:
moveGizmo = new MoveGizmo()
scene.add(moveGizmo.root)

// Per-frame update: position gizmo at selection center, active tool overlay
function onBeforeRender(): void {
  if (!moveGizmo) return

  // Position gizmo at selection center
  const items = selection.items.value
  if (items.size > 0) {
    let cx = 0, cy = 0, cz = 0
    for (const item of items) {
      cx += item.pos.x
      cy += item.pos.y
      cz += item.pos.z
    }
    cx /= items.size; cy /= items.size; cz /= items.size
    moveGizmo.setPosition(new THREE.Vector3(cx, cy, cz))
    moveGizmo.setVisible(toolRegistry.activeTool.value?.id === 'move')
  } else {
    moveGizmo.setVisible(false)
  }

  // Render active tool's overlay
  if (toolCtx) {
    toolRegistry.activeTool.value?.renderOverlay?.(toolCtx)
  }
}

// Hook into RenderViewport's render loop
// StructureViewport already has a render loop via RenderViewport
// We append our callback
```

- [ ] **Step 2: Gizmo hover highlighting on pointer move**

In `handlePointerMove`, after forwarding to active tool, run gizmo hit-test:

```typescript
function handlePointerMove(event: PointerEvent): void {
  if (!toolCtx) return
  toolRegistry.activeTool.value?.onPointerMove?.(toolCtx, event)

  // Hover-highlight gizmo parts
  if (moveGizmo && toolRegistry.activeTool.value?.id === 'move') {
    const raycaster = /* use scene camera raycaster from viewport */
    // ... highlight hit part
  }
}
```

- [ ] **Step 3: Gizmo drag for Move tool**

In `handlePointerDown/Move/Up`, integrate gizmo drag:

```typescript
let gizmoDragPart: string | null = null
let gizmoDragOrigin: THREE.Vector3 | null = null

function handlePointerDown(event: PointerEvent): void {
  if (!toolCtx) return

  // Check gizmo hit first for Move tool
  if (toolRegistry.activeTool.value?.id === 'move' && moveGizmo) {
    const raycaster = /* ... */
    const hit = moveGizmo.hitTest(raycaster)
    if (hit) {
      gizmoDragPart = hit
      gizmoDragOrigin = moveGizmo.root.position.clone()
      return // Don't forward to tool — gizmo handles the drag
    }
  }

  toolRegistry.activeTool.value?.onPointerDown?.(toolCtx, event)
}

function handlePointerUp(event: PointerEvent): void {
  if (gizmoDragPart && gizmoDragOrigin && toolCtx) {
    const delta = /* compute from gizmo drag */
    if (delta.x || delta.y || delta.z) {
      const items = [...selection.items.value]
      toolCtx.executeMove(items.map(i => ({ ...i.pos })), delta)
      selection.clear()
    }
  }
  gizmoDragPart = null
  gizmoDragOrigin = null
  if (!toolCtx) return
  toolRegistry.activeTool.value?.onPointerUp?.(toolCtx, event)
}
```

- [ ] **Step 4: Typecheck + build + commit**

```bash
cd D:/Projects/Lightning/web && npx vue-tsc --noEmit
cd D:/Projects/Lightning && git add web/src/workbench/components/WorkbenchViewport.vue
git commit -m "feat: wire gizmo rendering — MoveGizmo in render loop, hover highlight, drag delta"
```

---

### Task 5: Selection wireframe overlay

**Files:**
- Modify: `web/src/workbench/components/SelectionOverlay.vue` (or integrate into WorkbenchViewport)
- Modify: `web/src/workbench/tools/selectTool.ts` (add renderOverlay)

- [ ] **Step 1: Add selection wireframe to selectTool's renderOverlay**

In `selectTool.ts`, implement `renderOverlay`:

```typescript
renderOverlay(ctx: ThreeToolContext): void {
  // Selection wireframe is rendered by WorkbenchViewport using SelectionContext
  // This method is a no-op — the viewport reads selection directly
}
```

The actual wireframe rendering happens in `WorkbenchViewport.vue` — for each position in `selection.items`, render a wireframe cube at that position. This builds on the existing `selectedVoxel` prop in `StructureViewport`.

- [ ] **Step 2: Extend selectedVoxel from single to array**

Modify `WorkbenchViewport.vue` to pass all selected positions to StructureViewport:

```typescript
const selectedVoxels = computed(() => {
  return [...selection.items.value].map(item => ({
    column: item.pos.x,
    row: item.pos.y,
    zSlice: item.pos.z,
  }))
})
```

- [ ] **Step 3: Typecheck + commit**

```bash
cd D:/Projects/Lightning/web && npx vue-tsc --noEmit
cd D:/Projects/Lightning && git add web/src/workbench/tools/selectTool.ts web/src/workbench/components/WorkbenchViewport.vue
git commit -m "feat: add multi-block selection wireframe overlay"
```

---

### Task 6: Annotation box preview during drag

**Files:**
- Modify: `web/src/workbench/tools/annotationTool.ts`

- [ ] **Step 1: Add bbox preview to annotationTool's renderOverlay**

```typescript
renderOverlay(ctx: ThreeToolContext): void {
  if (!ctx._annotating || !ctx._annotStart) return
  const end = ctx._annotEnd ?? ctx._annotStart
  const min = {
    x: Math.min(ctx._annotStart.x, end.x),
    y: Math.min(ctx._annotStart.y, end.y),
    z: Math.min(ctx._annotStart.z, end.z),
  }
  const max = {
    x: Math.max(ctx._annotStart.x, end.x),
    y: Math.max(ctx._annotStart.y, end.y),
    z: Math.max(ctx._annotStart.z, end.z),
  }
  // Store preview bbox on ctx for viewport to render
  ctx._annotPreview = { min, max }
}
```

Add `_annotPreview` field to `ThreeToolContext` in `_base.ts`.

- [ ] **Step 2: Render preview bbox in viewport render loop**

In `onBeforeRender` (from Task 4), check `toolCtx._annotPreview` and render a wireframe box.

- [ ] **Step 3: Typecheck + commit**

```bash
cd D:/Projects/Lightning/web && npx vue-tsc --noEmit
cd D:/Projects/Lightning && git add web/src/workbench/tools/annotationTool.ts web/src/workbench/tools/_base.ts web/src/workbench/components/WorkbenchViewport.vue
git commit -m "feat: add annotation box preview during drag"
```

---

## Task Dependency Order

```
Task 1 (MoveGizmo)
  └─> Task 2 (interactionFactory)
       └─> Task 3 (wire WorkbenchViewport)
            ├─> Task 4 (gizmo render loop)
            ├─> Task 5 (selection wireframe)
            └─> Task 6 (annotation preview)
```

Tasks 1-2 are strict sequential. Tasks 4/5/6 can be done in parallel or any order after Task 3.

---

## Testing Strategy

| Component | Manual test |
|-----------|------------|
| MoveGizmo | Load scene, select block(s), press G — see 3 colored arrows at selection center |
| Gizmo drag | Hover red arrow (turns pink), drag — blocks move along X axis, Ctrl+Z to undo |
| Selection wireframe | Click blocks — wireframe cubes appear. A key — all wireframe |
| Annotation preview | Select annotation tool, drag in viewport — semi-transparent bbox appears |
| Click threshold | Click quickly without moving — select. Move >3px — drag |
