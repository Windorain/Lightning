# Workbench Editing Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Lightning workbench from view+shallow-edit to a full 3D structure editor with Blender-aligned tools, plugin system, undo/redo, and v2 data model.

**Architecture:** The plan builds bottom-up: protocol v2 → data model migration → context split → plugin system → selection → edit history → tool registry → individual tools → keymap/context-menu → stats/resource browser → export format. Infrastructure nodes (Selection, EditHistory, ToolRegistry) come before consumer tools so every tool task plugs into a working framework.

**Tech Stack:** Vue 3 + TypeScript + Vite + Three.js, protobuf (buf), command-pattern UndoManager

**Related specs:**
- `docs/superpowers/specs/2026-05-11-workbench-editing-tools-design.md`
- `docs/superpowers/specs/2026-05-11-workbench-plugin-system-design.md`

---

## File Structure Map

```
web/src/
├── workbench/
│   ├── sceneContext.ts              # MODIFY — slim down to core scene I/O only
│   ├── selectionContext.ts          # CREATE — SelectionSet composable
│   ├── editHistoryContext.ts        # CREATE — UndoManager composable
│   ├── toolRegistry.ts             # CREATE — Tool/ToolRegistry interfaces + impl
│   ├── panelState.ts               # CREATE — highlighted/pinned block types
│   ├── keymap.ts                   # CREATE — default keybindings + remapping
│   ├── WorkbenchRoot.vue           # MODIFY — add plugin prop, ToolShelf, context-menu
│   ├── connectionContext.ts        # UNCHANGED
│   ├── composables/
│   │   └── useSnapping.ts          # CREATE — snapping state + toggle
│   ├── components/
│   │   ├── MenuBar.vue              # MODIFY — plugin menu items
│   │   ├── PropertiesPanel.vue      # MODIFY — tool-driven tab switching
│   │   ├── BlockInspector.vue       # MODIFY — gui_state rendering, part display
│   │   ├── ToolShelf.vue            # CREATE — left vertical toolbar
│   │   ├── ContextMenu.vue          # CREATE — right-click popup
│   │   ├── SelectionOverlay.vue     # CREATE — wireframe highlight on selected blocks
│   │   ├── StatsPanel.vue           # CREATE — Auto/Custom stats with highlight linkage
│   │   ├── ResourceBrowser.vue      # CREATE — shared resource tree browser
│   │   ├── GeneratePanel.vue        # CREATE — block palette + floor templates
│   │   ├── AnnotationEditor.vue     # CREATE — annotation box editing UI
│   │   └── LabelEditor.vue          # CREATE — label editing UI
│   └── tools/
│       ├── selectTool.ts            # CREATE — single/box/type selection
│       ├── moveTool.ts              # CREATE — translate selection with snap
│       ├── deleteTool.ts            # CREATE — soft delete
│       ├── replaceTool.ts           # CREATE — paint-brush replace
│       ├── fillTool.ts             # CREATE — flood fill / bbox fill
│       ├── mirrorTool.ts            # CREATE — axis mirror
│       ├── generateTool.ts          # CREATE — place blocks from palette
│       ├── annotationTool.ts        # CREATE — bbox drag-create
│       ├── labelTool.ts             # CREATE — place label at 3D point
│       └── eyedropperTool.ts        # CREATE — pick block type
├── render/
│   ├── data/
│   │   ├── sceneDocument.ts         # CREATE — v2 scene document types
│   │   ├── versionMigration.ts      # CREATE — v1→v2 up-migration
│   │   └── compactSceneDocument.ts  # MODIFY — add v2 envelope support
│   └── proto/                       # CREATE (buf generate) — TS types from v2 proto
├── preview/
│   └── previewFromDocument.ts       # MODIFY — accept v2 document shape
└── plugin/
    ├── WorkbenchPlugin.ts           # CREATE — plugin interface
    ├── FileSystemProvider.ts        # CREATE — storage provider interface + impls
    └── wiki/
        ├── wikiPlugin.ts            # CREATE — wiki as plugin
        └── WikiDataPageEditor.vue   # MOVE — into plugin directory
protocol/lightning/v2/
├── plain_v2.proto                   # CREATE — v2 plain scene document
└── envelope_v2.proto                # CREATE — v2 envelope

docs/superpowers/specs/
├── 2026-05-11-workbench-editing-tools-design.md   # spec
└── 2026-05-11-workbench-plugin-system-design.md   # spec
```

---

### Task 1: Protocol v2 — Define new proto files

**Files:**
- Create: `protocol/lightning/v2/plain_v2.proto`
- Create: `protocol/lightning/v2/envelope_v2.proto`

- [ ] **Step 1: Create `plain_v2.proto`**

```proto
syntax = "proto3";

package lightning.v2;

// Plain v2 — 完整场景数据，含 v2 新增字段
message PlainSceneDocument {
  string format_version = 1;          // "2.0"
  SceneMeta meta = 2;
  repeated WorldFrame frames = 3;
  map<string, BlockState> block_palette = 4;
  MaterialLibrary materials = 5;

  // v2 新增
  repeated AnnotationBox annotations = 6;
  repeated Label labels = 7;
  StatsTemplate stats_template = 8;
}

message SceneMeta {
  string name = 1;
  string author = 2;
  int64 created_at_ms = 3;
  string description = 4;
  repeated string tags = 5;
  BlockPos origin = 6;
}

message BlockPos {
  int32 x = 1;
  int32 y = 2;
  int32 z = 3;
}

message WorldFrame {
  string label = 1;
  int32 index = 2;
  repeated BlockInstance blocks = 3;
  repeated EntityInstance entities = 4;
}

message BlockInstance {
  BlockPos pos = 1;
  string block_state_id = 2;
  map<string, string> nbt = 3;
  repeated BlockPart parts = 4;       // v2 新增
  GuiState gui_state = 5;             // v2 新增
}

message BlockPart {
  string local_id = 1;                // 父块内唯一标识
  string part_kind = 2;               // modid:类型
  int32 direction = 3;                // -1=无, 0-5=DUNSWE, 6=CENTER
  map<string, string> properties = 4; // 部件属性
  string tooltip = 5;                 // 独立 tooltip
}

message GuiState {
  string layout_id = 1;
  repeated ItemSlot item_slots = 2;
  repeated FluidTank fluid_tanks = 3;
  EnergyState energy = 4;
  map<string, string> config = 5;
}

message ItemSlot {
  int32 slot_index = 1;
  string item_id = 2;
  int32 count = 3;
  int32 damage = 4;
  map<string, string> nbt = 5;
}

message FluidTank {
  int32 tank_index = 1;
  string fluid_id = 2;
  int64 amount_mb = 3;
  int64 capacity_mb = 4;
}

message EnergyState {
  int64 stored_eu = 1;
  int64 capacity_eu = 2;
}

message BlockState {
  string name = 1;
  map<string, string> properties = 2;
}

message EntityInstance {
  BlockPos pos = 1;
  string entity_id = 2;
  map<string, string> nbt = 3;
}

message MaterialLibrary {
  repeated MaterialEntry entries = 1;
}

message MaterialEntry {
  string key = 1;
  bytes texture_png = 2;
  string blend_mode = 3;
  bool is_animated = 4;
  int32 animation_ticks_per_frame = 5;
  int32 animation_frame_count = 6;
}

message AnnotationBox {
  string id = 1;
  string title = 2;
  string description = 3;             // Markdown
  BlockPos min = 4;
  BlockPos max = 5;
  string color = 6;
  bool visible = 7;
  repeated PartRef part_refs = 8;     // 可选：定向注解 part
  int64 created_at = 9;
  int64 updated_at = 10;
}

message PartRef {
  BlockPos block_pos = 1;
  string part_local_id = 2;
}

message Label {
  string id = 1;
  string text = 2;
  float x = 3;
  float y = 4;
  float z = 5;
  string color = 6;
  int32 font_size = 7;
  bool visible = 8;
}

message StatsTemplate {
  string mode = 1;                    // "auto" | "custom"
  repeated StatsGroup groups = 2;
  bool show_others = 3;
}

message StatsGroup {
  string label = 1;
  repeated StatsEntry entries = 2;
}

message StatsEntry {
  string block_state_id = 1;
  string label_override = 2;
  string icon_source = 3;
}
```

- [ ] **Step 2: Create `envelope_v2.proto`**

```proto
syntax = "proto3";

package lightning.v2;

message EnvelopeDocument {
  string format_version = 1;          // "2.0"
  EnvelopeMeta meta = 2;
  bytes compressed_payload = 3;       // gzip → JSON(PlainSceneDocument)
}

message EnvelopeMeta {
  string scene_id = 1;
  string name = 2;
  string author = 3;
  int64 created_at_ms = 4;
  int64 compressed_size_bytes = 5;
  int64 uncompressed_size_bytes = 6;
  string sha256_hex = 7;
}
```

- [ ] **Step 3: Commit**

```bash
cd D:/Projects/Lightning
git add protocol/lightning/v2/
git commit -m "feat: add v2 protocol definitions with multipart, annotations, labels, gui_state"
```

---

### Task 2: v2 TypeScript types and v1→v2 migration

**Files:**
- Create: `web/src/render/data/sceneDocumentV2.ts`
- Create: `web/src/render/data/versionMigration.ts`
- Modify: `web/src/render/data/compactSceneDocument.ts` (add v2 detection)

- [ ] **Step 1: Write v2 TypeScript type definitions**

```typescript
// web/src/render/data/sceneDocumentV2.ts

export interface V2BlockPos {
  x: number
  y: number
  z: number
}

export interface V2BlockPart {
  local_id: string
  part_kind: string
  direction: number
  properties: Record<string, string>
  tooltip?: string
}

export interface V2ItemSlot {
  slot_index: number
  item_id: string
  count: number
  damage?: number
  nbt?: Record<string, string>
}

export interface V2FluidTank {
  tank_index: number
  fluid_id: string
  amount_mb: number
  capacity_mb: number
}

export interface V2EnergyState {
  stored_eu: number
  capacity_eu: number
}

export interface V2GuiState {
  layout_id: string
  item_slots: V2ItemSlot[]
  fluid_tanks: V2FluidTank[]
  energy?: V2EnergyState
  config: Record<string, string>
}

export interface V2BlockInstance {
  pos: V2BlockPos
  block_state_id: string
  nbt?: Record<string, string>
  parts?: V2BlockPart[]
  gui_state?: V2GuiState
}

export interface V2PartRef {
  block_pos: V2BlockPos
  part_local_id: string
}

export interface V2AnnotationBox {
  id: string
  title: string
  description: string
  min: V2BlockPos
  max: V2BlockPos
  color: string
  visible: boolean
  part_refs?: V2PartRef[]
  created_at: number
  updated_at: number
}

export interface V2Label {
  id: string
  text: string
  x: number
  y: number
  z: number
  color: string
  font_size: number
  visible: boolean
}

export interface V2StatsEntry {
  block_state_id: string
  label_override?: string
  icon_source?: string
}

export interface V2StatsGroup {
  label: string
  entries: V2StatsEntry[]
}

export interface V2StatsTemplate {
  mode: 'auto' | 'custom'
  groups?: V2StatsGroup[]
  show_others?: boolean
}

export interface V2SceneMeta {
  name: string
  author: string
  created_at_ms: number
  description: string
  tags: string[]
  origin: V2BlockPos
}

export interface V2EntityInstance {
  pos: V2BlockPos
  entity_id: string
  nbt?: Record<string, string>
}

export interface V2WorldFrame {
  label: string
  index: number
  blocks: V2BlockInstance[]
  entities: V2EntityInstance[]
}

export interface V2BlockState {
  name: string
  properties: Record<string, string>
}

export interface V2MaterialEntry {
  key: string
  texture_png: string   // base64
  blend_mode: string
  is_animated: boolean
  animation_ticks_per_frame: number
  animation_frame_count: number
}

export interface V2MaterialLibrary {
  entries: V2MaterialEntry[]
}

export interface V2PlainSceneDocument {
  format_version: '2.0'
  meta: V2SceneMeta
  frames: V2WorldFrame[]
  block_palette: Record<string, V2BlockState>
  materials: V2MaterialLibrary
  annotations?: V2AnnotationBox[]
  labels?: V2Label[]
  stats_template?: V2StatsTemplate
}
```

- [ ] **Step 2: Write v1→v2 migration**

```typescript
// web/src/render/data/versionMigration.ts

import type { V2PlainSceneDocument } from './sceneDocumentV2'

/** Detect whether a raw JSON doc is v1 or v2 */
export function detectVersion(doc: Record<string, unknown>): '1' | '2' {
  const v = doc.format_version as string | undefined
  if (v && v.startsWith('2.')) return '2'
  return '1'
}

/** Up-migrate v1 document to v2 internal model */
export function migrateV1ToV2(v1: Record<string, unknown>): V2PlainSceneDocument {
  return {
    format_version: '2.0',
    meta: migrateMeta(v1.meta as Record<string, unknown> | undefined),
    frames: migrateFrames(v1.frames as Array<Record<string, unknown>> | undefined),
    block_palette: (v1.blockPalette ?? v1.block_palette ?? {}) as Record<string, any>,
    materials: (v1.materials ?? { entries: [] }) as any,
    annotations: [],
    labels: [],
    stats_template: { mode: 'auto' },
  }
}

function migrateMeta(raw: Record<string, unknown> | undefined): V2PlainSceneDocument['meta'] {
  return {
    name: (raw?.name as string) ?? '',
    author: (raw?.author as string) ?? '',
    created_at_ms: (raw?.createdAtMs ?? raw?.created_at_ms ?? 0) as number,
    description: (raw?.description as string) ?? '',
    tags: (raw?.tags as string[]) ?? [],
    origin: {
      x: (raw?.origin as any)?.x ?? 0,
      y: (raw?.origin as any)?.y ?? 0,
      z: (raw?.origin as any)?.z ?? 0,
    },
  }
}

function migrateFrames(raw: Array<Record<string, unknown>> | undefined): V2PlainSceneDocument['frames'] {
  if (!raw) return []
  return raw.map((f, i) => ({
    label: (f.label as string) ?? `Frame ${i}`,
    index: (f.index as number) ?? i,
    blocks: ((f.blocks as any[]) ?? []).map(migrateBlock),
    entities: ((f.entities as any[]) ?? []).map(migrateEntity),
  }))
}

function migrateBlock(b: Record<string, unknown>): V2BlockInstance {
  return {
    pos: {
      x: (b.pos as any)?.x ?? 0,
      y: (b.pos as any)?.y ?? 0,
      z: (b.pos as any)?.z ?? 0,
    },
    block_state_id: (b.blockStateId ?? b.block_state_id ?? '') as string,
    nbt: (b.nbt as Record<string, string>) ?? undefined,
    // v1 blocks have no parts or gui_state
    parts: undefined,
    gui_state: undefined,
  }
}

function migrateEntity(e: Record<string, unknown>): V2EntityInstance {
  return {
    pos: {
      x: (e.pos as any)?.x ?? 0,
      y: (e.pos as any)?.y ?? 0,
      z: (e.pos as any)?.z ?? 0,
    },
    entity_id: (e.entityId ?? e.entity_id ?? '') as string,
    nbt: (e.nbt as Record<string, string>) ?? undefined,
  }
}
```

- [ ] **Step 3: Modify compactSceneDocument.ts — add v2 detection in load path**

In `web/src/render/data/compactSceneDocument.ts`, add a re-export for version helpers:

```typescript
// Append at end of file:
export { detectVersion, migrateV1ToV2 } from './versionMigration'
export type { V2PlainSceneDocument, V2BlockInstance, V2BlockPart, V2AnnotationBox, V2Label, V2GuiState, V2StatsTemplate } from './sceneDocumentV2'
```

- [ ] **Step 4: Verify typecheck**

```bash
cd D:/Projects/Lightning/web
npx vue-tsc --noEmit
```

Expected: No new type errors from these new files.

- [ ] **Step 5: Commit**

```bash
cd D:/Projects/Lightning
git add web/src/render/data/sceneDocumentV2.ts web/src/render/data/versionMigration.ts web/src/render/data/compactSceneDocument.ts
git commit -m "feat: add v2 TypeScript types and v1-to-v2 migration engine"
```

---

### Task 3: Context split — SelectionContext

**Files:**
- Create: `web/src/workbench/selectionContext.ts`
- Modify: `web/src/workbench/sceneContext.ts` (remove selectedBlock)

- [ ] **Step 1: Create SelectionContext**

```typescript
// web/src/workbench/selectionContext.ts

import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'

export interface BlockRef {
  pos: { x: number; y: number; z: number }
  block_state_id: string
}

export type SelectionMode = 'single' | 'box' | 'type'

export interface SelectionContext {
  readonly items: Ref<Set<BlockRef>>
  readonly mode: Ref<SelectionMode>
  readonly frameIndex: Ref<number>
  select(voxel: BlockRef): void
  selectBox(min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }, blocks: BlockRef[]): void
  selectByType(blockStateId: string, blocks: BlockRef[]): void
  add(voxels: BlockRef[]): void
  remove(voxels: BlockRef[]): void
  clear(): void
  invert(blocks: BlockRef[]): void
  isSelected(pos: { x: number; y: number; z: number }): boolean
}

export const selectionContextKey: InjectionKey<SelectionContext> = Symbol('selectionContext')

function posKey(pos: { x: number; y: number; z: number }): string {
  return `${pos.x},${pos.y},${pos.z}`
}

export function provideSelectionContext(): SelectionContext {
  const items = ref<Set<BlockRef>>(new Set())
  const mode = ref<SelectionMode>('single')
  const frameIndex = ref(0)

  const index = ref<Map<string, BlockRef>>(new Map())

  function select(voxel: BlockRef): void {
    items.value = new Set([voxel])
    index.value = new Map([[posKey(voxel.pos), voxel]])
    mode.value = 'single'
  }

  function selectBox(min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }, blocks: BlockRef[]): void {
    const set = new Set<BlockRef>()
    const map = new Map<string, BlockRef>()
    for (const b of blocks) {
      if (
        b.pos.x >= min.x && b.pos.x <= max.x &&
        b.pos.y >= min.y && b.pos.y <= max.y &&
        b.pos.z >= min.z && b.pos.z <= max.z
      ) {
        set.add(b)
        map.set(posKey(b.pos), b)
      }
    }
    items.value = set
    index.value = map
    mode.value = 'box'
  }

  function selectByType(blockStateId: string, blocks: BlockRef[]): void {
    const set = new Set<BlockRef>()
    const map = new Map<string, BlockRef>()
    for (const b of blocks) {
      if (b.block_state_id === blockStateId) {
        set.add(b)
        map.set(posKey(b.pos), b)
      }
    }
    items.value = set
    index.value = map
    mode.value = 'type'
  }

  function add(voxels: BlockRef[]): void {
    const set = new Set(items.value)
    const map = new Map(index.value)
    for (const v of voxels) {
      set.add(v)
      map.set(posKey(v.pos), v)
    }
    items.value = set
    index.value = map
  }

  function remove(voxels: BlockRef[]): void {
    const set = new Set(items.value)
    const map = new Map(index.value)
    for (const v of voxels) {
      set.delete(v)
      map.delete(posKey(v.pos))
    }
    items.value = set
    index.value = map
  }

  function clear(): void {
    items.value = new Set()
    index.value = new Map()
  }

  function invert(blocks: BlockRef[]): void {
    const newSet = new Set<BlockRef>()
    const map = new Map<string, BlockRef>()
    const currentKeys = new Set([...items.value].map(b => posKey(b.pos)))
    for (const b of blocks) {
      if (!currentKeys.has(posKey(b.pos))) {
        newSet.add(b)
        map.set(posKey(b.pos), b)
      }
    }
    items.value = newSet
    index.value = map
  }

  function isSelected(pos: { x: number; y: number; z: number }): boolean {
    return index.value.has(posKey(pos))
  }

  const ctx: SelectionContext = {
    items: items as unknown as Ref<Set<BlockRef>>,
    mode: mode as unknown as Ref<SelectionMode>,
    frameIndex: frameIndex as unknown as Ref<number>,
    select, selectBox, selectByType, add, remove, clear, invert, isSelected,
  }

  provide(selectionContextKey, ctx)
  return ctx
}

export function useSelectionContext(): SelectionContext {
  const ctx = inject(selectionContextKey)
  if (!ctx) throw new Error('useSelectionContext() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
```

- [ ] **Step 2: Remove `selectedBlock` from sceneContext.ts**

Remove the `selectedBlock` field and `setSelectedBlock` method from `sceneContext.ts`, and the `SelectedBlock` interface. Selection now lives in SelectionContext.

- [ ] **Step 3: Update WorkbenchRoot.vue to provide SelectionContext**

```typescript
// Add to WorkbenchRoot.vue script setup:
import { provideSelectionContext } from '@/workbench/selectionContext'

const selection = provideSelectionContext()
```

- [ ] **Step 4: Typecheck and commit**

```bash
cd D:/Projects/Lightning/web
npx vue-tsc --noEmit
```

```bash
cd D:/Projects/Lightning
git add web/src/workbench/selectionContext.ts web/src/workbench/sceneContext.ts web/src/workbench/WorkbenchRoot.vue
git commit -m "feat: extract SelectionContext from SceneContext — multi-select, box, type modes"
```

---

### Task 4: Context split — EditHistoryContext (UndoManager)

**Files:**
- Create: `web/src/workbench/editHistoryContext.ts`

- [ ] **Step 1: Write EditHistoryContext**

```typescript
// web/src/workbench/editHistoryContext.ts

import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref, readonly } from 'vue'

export interface EditCommand {
  id: string
  label: string
  timestamp: number
  execute(): void
  undo(): void
  canMergeWith?(other: EditCommand): boolean
  merge?(other: EditCommand): void
}

export interface UndoManager {
  readonly canUndo: Ref<boolean>
  readonly canRedo: Ref<boolean>
  readonly undoLabel: Ref<string | null>
  readonly redoLabel: Ref<string | null>
  push(command: EditCommand): void
  undo(): void
  redo(): void
  clear(): void
}

export const editHistoryKey: InjectionKey<UndoManager> = Symbol('editHistory')

export function provideEditHistory(maxStack = 256): UndoManager {
  const undoStack: EditCommand[] = []
  const redoStack: EditCommand[] = []
  const canUndo = ref(false)
  const canRedo = ref(false)
  const undoLabel = ref<string | null>(null)
  const redoLabel = ref<string | null>(null)

  function refreshFlags(): void {
    canUndo.value = undoStack.length > 0
    canRedo.value = redoStack.length > 0
    undoLabel.value = undoStack.length > 0 ? undoStack[undoStack.length - 1].label : null
    redoLabel.value = redoStack.length > 0 ? redoStack[redoStack.length - 1].label : null
  }

  function push(command: EditCommand): void {
    // Try to merge with last command
    if (undoStack.length > 0) {
      const last = undoStack[undoStack.length - 1]
      if (last.canMergeWith?.(command)) {
        last.merge?.(command)
        refreshFlags()
        return
      }
    }

    undoStack.push(command)
    if (undoStack.length > maxStack) {
      undoStack.shift()
    }
    redoStack.length = 0
    refreshFlags()
    command.execute()
  }

  function undo(): void {
    const cmd = undoStack.pop()
    if (!cmd) return
    redoStack.push(cmd)
    cmd.undo()
    refreshFlags()
  }

  function redo(): void {
    const cmd = redoStack.pop()
    if (!cmd) return
    undoStack.push(cmd)
    cmd.execute()
    refreshFlags()
  }

  function clear(): void {
    undoStack.length = 0
    redoStack.length = 0
    refreshFlags()
  }

  provide(editHistoryKey, { canUndo, canRedo, undoLabel, redoLabel, push, undo, redo, clear })
  return { canUndo, canRedo, undoLabel, redoLabel, push, undo, redo, clear }
}

export function useEditHistory(): UndoManager {
  const ctx = inject(editHistoryKey)
  if (!ctx) throw new Error('useEditHistory() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
```

- [ ] **Step 2: Provide EditHistory in WorkbenchRoot**

Add `import { provideEditHistory } from '@/workbench/editHistoryContext'` and call `provideEditHistory()`.

- [ ] **Step 3: Typecheck and commit**

```bash
cd D:/Projects/Lightning/web && npx vue-tsc --noEmit
cd D:/Projects/Lightning && git add web/src/workbench/editHistoryContext.ts web/src/workbench/WorkbenchRoot.vue
git commit -m "feat: add UndoManager — command-pattern undo/redo with merge support"
```

---

### Task 5: Tool system — Tool/ToolRegistry interfaces + ToolShelf

**Files:**
- Create: `web/src/workbench/toolRegistry.ts`
- Create: `web/src/workbench/components/ToolShelf.vue`
- Modify: `web/src/workbench/WorkbenchRoot.vue` (provide ToolRegistry, add ToolShelf to layout)
- Modify: `web/src/workbench/layout/WorkbenchShell.vue` (slot for ToolShelf)

- [ ] **Step 1: Write ToolRegistry**

```typescript
// web/src/workbench/toolRegistry.ts

import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'
import type { ThreeToolContext } from './tools/_base'

export interface Tool {
  id: string
  label: string
  icon: string
  cursor?: string
  defaultKey?: string
  onActivate?(ctx: ThreeToolContext): void
  onDeactivate?(ctx: ThreeToolContext): void
  onPointerDown?(ctx: ThreeToolContext, event: PointerEvent): void
  onPointerMove?(ctx: ThreeToolContext, event: PointerEvent): void
  onPointerUp?(ctx: ThreeToolContext, event: PointerEvent): void
  onKeyDown?(ctx: ThreeToolContext, event: KeyboardEvent): void
  renderOverlay?(ctx: ThreeToolContext): void
}

export interface ToolRegistry {
  readonly activeTool: Ref<Tool | null>
  readonly tools: Map<string, Tool>
  register(tool: Tool): void
  activate(id: string): void
  deactivate(): void
  getPreviousEditToolId(): string | null
}

export const toolRegistryKey: InjectionKey<ToolRegistry> = Symbol('toolRegistry')

export function provideToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>()
  const activeTool = ref<Tool | null>(null)
  let previousEditToolId: string | null = null

  function register(tool: Tool): void {
    tools.set(tool.id, tool)
  }

  function activate(id: string): void {
    const tool = tools.get(id)
    if (!tool || activeTool.value?.id === id) return
    // Track last non-select tool for Tab toggle
    if (activeTool.value && activeTool.value.id !== 'select') {
      previousEditToolId = activeTool.value.id
    }
    activeTool.value = tool
  }

  function deactivate(): void {
    activeTool.value = tools.get('select') ?? null
    previousEditToolId = null
  }

  function getPreviousEditToolId(): string | null {
    return previousEditToolId
  }

  const registry: ToolRegistry = { activeTool, tools, register, activate, deactivate, getPreviousEditToolId }
  provide(toolRegistryKey, registry)
  return registry
}

export function useToolRegistry(): ToolRegistry {
  const ctx = inject(toolRegistryKey)
  if (!ctx) throw new Error('useToolRegistry() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
```

- [ ] **Step 2: Write ToolShelf.vue**

```vue
<!-- web/src/workbench/components/ToolShelf.vue -->
<script setup lang="ts">
import { useToolRegistry } from '@/workbench/toolRegistry'
import { useSnapping } from '@/workbench/composables/useSnapping'

const registry = useToolRegistry()
const { snapEnabled, toggleSnap } = useSnapping()
</script>

<template>
  <div class="toolshelf">
    <button
      v-for="[_id, tool] in registry.tools"
      :key="tool.id"
      class="toolshelf__btn"
      :class="{ 'toolshelf__btn--active': registry.activeTool.value?.id === tool.id }"
      :title="tool.label + (tool.defaultKey ? ` (${tool.defaultKey})` : '')"
      @click="registry.activate(tool.id)"
    >
      <span class="toolshelf__icon">{{ tool.icon }}</span>
    </button>
    <div class="toolshelf__sep" />
    <button class="toolshelf__btn" :class="{ 'toolshelf__btn--active': snapEnabled }"
      title="吸附 / Snap" @click="toggleSnap()">
      <span class="toolshelf__icon">{{ snapEnabled ? '⊞' : '⊟' }}</span>
    </button>
  </div>
</template>

<style scoped>
.toolshelf {
  position: absolute; top: 4px; left: 4px; z-index: 100;
  display: flex; flex-direction: column; gap: 2px;
  padding: 4px; background: var(--nei-dropdown-bg); border: 1px solid var(--nei-border);
  border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.toolshelf__btn {
  width: 32px; height: 32px; border: 1px solid transparent;
  background: transparent; color: var(--nei-label); font-size: 16px;
  cursor: pointer; border-radius: 4px; display: flex; align-items: center; justify-content: center;
}
.toolshelf__btn:hover { background: var(--nei-panel-hover); }
.toolshelf__btn--active { background: var(--nei-dropdown-hover); color: #fff; border-color: var(--nei-border); }
.toolshelf__sep { height: 1px; background: var(--nei-border); margin: 2px 0; }
.toolshelf__icon { line-height: 1; }
</style>
```

- [ ] **Step 3: Write snapping composable**

```typescript
// web/src/workbench/composables/useSnapping.ts
import { ref } from 'vue'

const snapEnabled = ref(true)

export function useSnapping() {
  function toggleSnap(): void { snapEnabled.value = !snapEnabled.value }
  return { snapEnabled, toggleSnap }
}
```

- [ ] **Step 4: Provide ToolRegistry in WorkbenchRoot and add ToolShelf**

In `WorkbenchRoot.vue`:
- Import and call `provideToolRegistry()`
- Add `<ToolShelf />` in the viewport slot template

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/Projects/Lightning/web && npx vue-tsc --noEmit
cd D:/Projects/Lightning && git add web/src/workbench/toolRegistry.ts web/src/workbench/components/ToolShelf.vue web/src/workbench/composables/useSnapping.ts web/src/workbench/WorkbenchRoot.vue
git commit -m "feat: add ToolRegistry, ToolShelf, and snapping composable"
```

---

### Task 6: PanelState — shared highlight/pin state

**Files:**
- Create: `web/src/workbench/panelState.ts`

- [ ] **Step 1: Write PanelState**

```typescript
// web/src/workbench/panelState.ts

import { ref, computed } from 'vue'

const _highlightedBlockTypes = ref<Set<string>>(new Set())
const _pinnedBlockTypes = ref<Set<string>>(new Set())

export interface PanelState {
  /** Hover-highlighted block types (temporary, cleared on mouse leave) */
  readonly highlightedBlockTypes: ReadonlySet<string>
  /** Click-pinned block types (persistent until unpinned) */
  readonly pinnedBlockTypes: ReadonlySet<string>
  /** Combined set for viewport overlay rendering */
  readonly activeBlockTypes: ReadonlySet<string>
  highlightType(blockStateId: string): void
  clearHighlight(): void
  pinType(blockStateId: string): void
  unpinType(blockStateId: string): void
  clearPins(): void
}

function setUnion(a: Set<string>, b: Set<string>): Set<string> {
  const s = new Set(a)
  for (const v of b) s.add(v)
  return s
}

const activeBlockTypes = computed<ReadonlySet<string>>(() =>
  setUnion(_highlightedBlockTypes.value, _pinnedBlockTypes.value)
)

export function usePanelState(): PanelState {
  function highlightType(id: string): void {
    _highlightedBlockTypes.value = new Set([id])
  }

  function clearHighlight(): void {
    _highlightedBlockTypes.value = new Set()
  }

  function pinType(id: string): void {
    const s = new Set(_pinnedBlockTypes.value)
    if (s.has(id)) { s.delete(id) } else { s.add(id) }
    _pinnedBlockTypes.value = s
  }

  function unpinType(id: string): void {
    const s = new Set(_pinnedBlockTypes.value)
    s.delete(id)
    _pinnedBlockTypes.value = s
  }

  function clearPins(): void {
    _pinnedBlockTypes.value = new Set()
  }

  return {
    highlightedBlockTypes: _highlightedBlockTypes.value as ReadonlySet<string>,
    pinnedBlockTypes: _pinnedBlockTypes.value as ReadonlySet<string>,
    activeBlockTypes: activeBlockTypes.value as ReadonlySet<string>,
    highlightType, clearHighlight, pinType, unpinType, clearPins,
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd D:/Projects/Lightning
git add web/src/workbench/panelState.ts
git commit -m "feat: add PanelState — highlight/pin block types for viewport linkage"
```

---

### Task 7: Plugin system — WorkbenchPlugin + FileSystemProvider

**Files:**
- Create: `web/src/workbench/plugin/WorkbenchPlugin.ts`
- Create: `web/src/workbench/plugin/FileSystemProvider.ts`
- Modify: `web/src/workbench/WorkbenchRoot.vue` (accept and apply plugins)

- [ ] **Step 1: Write WorkbenchPlugin interface**

```typescript
// web/src/workbench/plugin/WorkbenchPlugin.ts

import type { Component } from 'vue'
import type { Tool } from '@/workbench/toolRegistry'
import type { SceneStorageProvider } from './FileSystemProvider'

export interface WorkbenchPlugin {
  id: string
  label: string
  storageProvider?: SceneStorageProvider
  rightPanelTabs?: Array<{
    id: string
    label: string
    component: Component
    priority?: number
  }>
  menuItems?: Array<{
    section: 'file' | 'edit' | 'view'
    label: string
    action: () => void | Promise<void>
  }>
  provideContexts?: () => Record<string, unknown>
  tools?: Tool[]
  layoutVariants?: Record<string, Component>
}
```

- [ ] **Step 2: Write FileSystemProvider interface + builtin impls**

```typescript
// web/src/workbench/plugin/FileSystemProvider.ts

export interface SceneStorageProvider {
  readonly kind: 'local-file' | 'sde' | 'remote' | 'wiki-data' | 'builtin'
  load(): Promise<unknown>
  save(json: string, opts?: { suggestedName?: string }): Promise<void>
}

/** Local File API provider — wraps browser File + FileSystemFileHandle */
export function createLocalFileProvider(): SceneStorageProvider {
  return {
    kind: 'local-file',
    load: async () => { throw new Error('load() should be handled by file picker, not provider') },
    save: async (_json, _opts) => { /* delegate to existing downloadJson / fileHandle logic */ },
  }
}

/** Builtin scene provider — reads from static dev scenes */
export function createBuiltinProvider(sceneId: string): SceneStorageProvider {
  return {
    kind: 'builtin',
    load: async () => {
      const { getDevSceneDocument } = await import('@/dev/devScenes')
      return getDevSceneDocument(sceneId)
    },
    save: async () => { throw new Error('Builtin scenes are read-only') },
  }
}
```

- [ ] **Step 3: Modify WorkbenchRoot.vue to accept plugins prop**

```typescript
// Add to WorkbenchRoot.vue script:
import type { WorkbenchPlugin } from '@/workbench/plugin/WorkbenchPlugin'

const props = defineProps<{ plugins?: WorkbenchPlugin[] }>()

// Apply plugins on init:
for (const plugin of (props.plugins ?? [])) {
  if (plugin.tools) {
    for (const tool of plugin.tools) {
      toolRegistry.register(tool)
    }
  }
  if (plugin.provideContexts) {
    const ctxs = plugin.provideContexts()
    for (const [key, value] of Object.entries(ctxs)) {
      provide(key, value)
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
cd D:/Projects/Lightning
git add web/src/workbench/plugin/
git commit -m "feat: add WorkbenchPlugin interface and FileSystemProvider abstraction"
```

---

### Task 8: Select tool + SelectionOverlay

**Files:**
- Create: `web/src/workbench/tools/selectTool.ts`
- Create: `web/src/workbench/components/SelectionOverlay.vue`
- Modify: `web/src/workbench/WorkbenchViewport.vue` (integrate selection overlay)

- [ ] **Step 1: Write Select tool**

```typescript
// web/src/workbench/tools/selectTool.ts

import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

export const selectTool: Tool = {
  id: 'select',
  label: 'Select',
  icon: '▲',
  cursor: 'default',
  defaultKey: undefined, // active by default, no single-key toggle

  onPointerDown(ctx: ThreeToolContext, event: PointerEvent): void {
    // On mousedown, record start position for drag threshold
    ctx._selectStart = { x: event.clientX, y: event.clientY }
    ctx._boxSelecting = event.shiftKey // Shift+click = box select mode
  },

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const start = ctx._selectStart
    if (!start) return

    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist < 3) {
      // Click — single select
      const picked = ctx.pickVoxel(event)
      if (picked) {
        if (event.ctrlKey || event.metaKey) {
          ctx.selection.add([picked])
        } else {
          ctx.selection.select(picked)
        }
      } else {
        ctx.selection.clear()
      }
    }
    // Box select handled in onPointerMove + onPointerUp combination if _boxSelecting
    ctx._selectStart = null
  },

  onKeyDown(ctx: ThreeToolContext, event: KeyboardEvent): void {
    if (event.key === 'a' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      const all = ctx.getFrameBlocks()
      if (ctx.selection.items.value.size === all.length) {
        ctx.selection.clear()
      } else {
        ctx.selection.selectBox(
          { x: -Infinity, y: -Infinity, z: -Infinity },
          { x: Infinity, y: Infinity, z: Infinity },
          all,
        )
      }
    }
  },
}
```

- [ ] **Step 2: Register Select tool in WorkbenchRoot and make it default active**

```typescript
toolRegistry.register(selectTool)
toolRegistry.activate('select')
```

- [ ] **Step 3: Write SelectionOverlay.vue**

```vue
<!-- web/src/workbench/components/SelectionOverlay.vue -->
<script setup lang="ts">
import { useSelectionContext } from '@/workbench/selectionContext'

const selection = useSelectionContext()
</script>

<template>
  <!-- Rendered by Three.js line segments in WorkbenchViewport -->
  <!-- This component is a marker — actual rendering uses renderOverlay pattern -->
</template>
```

- [ ] **Step 4: Commit**

```bash
cd D:/Projects/Lightning
git add web/src/workbench/tools/ web/src/workbench/components/SelectionOverlay.vue web/src/workbench/WorkbenchRoot.vue
git commit -m "feat: add Select tool with single/box/type/all selection modes"
```

---

### Task 9: Move tool + Delete tool

**Files:**
- Create: `web/src/workbench/tools/moveTool.ts`
- Create: `web/src/workbench/tools/deleteTool.ts`

- [ ] **Step 1: Write Move tool**

```typescript
// web/src/workbench/tools/moveTool.ts
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

export const moveTool: Tool = {
  id: 'move',
  label: 'Move',
  icon: '↕',
  cursor: 'move',
  defaultKey: 'g',

  onPointerDown(ctx: ThreeToolContext, event: PointerEvent): void {
    // Start move: record initial positions + pick axis from gizmo
    ctx._moveStart = { x: event.clientX, y: event.clientY }
    ctx._moveInitialPositions = [...ctx.selection.items.value].map(b => ({ ...b.pos }))
  },

  onPointerMove(ctx: ThreeToolContext, event: PointerEvent): void {
    if (!ctx._moveStart) return
    const dx = Math.round((event.clientX - ctx._moveStart.x) / 20)  // scale to grid units
    const dy = Math.round((event.clientY - ctx._moveStart.y) / 20)
    // Preview move in viewport (renderOverlay does the visual)
    ctx._moveDelta = { x: dx, y: 0, z: -dy }
  },

  onPointerUp(ctx: ThreeToolContext, _event: PointerEvent): void {
    if (!ctx._moveDelta || !ctx._moveInitialPositions) return
    const { x, y, z } = ctx._moveDelta
    if (x === 0 && y === 0 && z === 0) return
    ctx.executeMove(ctx._moveInitialPositions, { x, y, z })
    ctx._moveStart = null
    ctx._moveDelta = null
    ctx._moveInitialPositions = null
  },
}
```

- [ ] **Step 2: Write Delete tool**

```typescript
// web/src/workbench/tools/deleteTool.ts
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

export const deleteTool: Tool = {
  id: 'delete',
  label: 'Delete',
  icon: '✕',
  cursor: 'not-allowed',
  defaultKey: 'x',

  onActivate(ctx: ThreeToolContext): void {
    // Immediate action on key press — soft delete selected blocks
    const targets = [...ctx.selection.items.value]
    if (targets.length === 0) return
    ctx.executeDelete(targets)
    ctx.selection.clear()
    // Switch back to select after delete
    ctx.toolRegistry.activate('select')
  },
}
```

- [ ] **Step 3: Register Move and Delete tools, commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/tools/moveTool.ts web/src/workbench/tools/deleteTool.ts
git commit -m "feat: add Move tool (translate selection with grid snap) and Delete tool (soft delete)"
```

---

### Task 10: Replace tool + Fill tool + Mirror tool

**Files:**
- Create: `web/src/workbench/tools/replaceTool.ts`
- Create: `web/src/workbench/tools/fillTool.ts`
- Create: `web/src/workbench/tools/mirrorTool.ts`

- [ ] **Step 1: Write Replace tool**

```typescript
// web/src/workbench/tools/replaceTool.ts
import { ref } from 'vue'
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

const brushType = ref<string | null>(null)

export function getReplaceBrush(): string | null { return brushType.value }
export function setReplaceBrush(id: string | null): void { brushType.value = id }

export const replaceTool: Tool = {
  id: 'replace',
  label: 'Replace',
  icon: '🖌',
  cursor: 'crosshair',
  defaultKey: 'r',

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const target = brushType.value
    if (!target) return
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    ctx.executeReplace([{ pos: picked.pos, oldBlockStateId: picked.block_state_id, newBlockStateId: target }])
  },
}
```

- [ ] **Step 2: Write Fill tool**

```typescript
// web/src/workbench/tools/fillTool.ts
import { ref } from 'vue'
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

const fillType = ref<string | null>(null)

export function getFillType(): string | null { return fillType.value }
export function setFillType(id: string | null): void { fillType.value = id }

export const fillTool: Tool = {
  id: 'fill',
  label: 'Fill',
  icon: '▣',
  cursor: 'crosshair',
  defaultKey: 'f',

  onPointerDown(ctx: ThreeToolContext, event: PointerEvent): void {
    ctx._fillStart = { x: event.clientX, y: event.clientY }
  },

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const target = fillType.value
    if (!target || !ctx._fillStart) return
    const dx = Math.abs(event.clientX - ctx._fillStart.x)
    const dy = Math.abs(event.clientY - ctx._fillStart.y)

    if (dx < 4 && dy < 4) {
      // Click fill — replace single block under pointer
      const picked = ctx.pickVoxel(event)
      if (picked) {
        ctx.executeReplace([{ pos: picked.pos, oldBlockStateId: picked.block_state_id, newBlockStateId: target }])
      }
    } else {
      // Box fill — get all blocks in selection box and replace
      const blocks = ctx.selection.items.value
      if (blocks.size > 0) {
        const replacements = [...blocks].map(b => ({
          pos: b.pos, oldBlockStateId: b.block_state_id, newBlockStateId: target,
        }))
        ctx.executeReplace(replacements)
      }
    }
  },
}
```

- [ ] **Step 3: Write Mirror tool**

```typescript
// web/src/workbench/tools/mirrorTool.ts
import { ref } from 'vue'
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

const mirrorAxis = ref<'x' | 'y' | 'z'>('x')

export function getMirrorAxis(): string { return mirrorAxis.value }
export function setMirrorAxis(a: 'x' | 'y' | 'z'): void { mirrorAxis.value = a }

export const mirrorTool: Tool = {
  id: 'mirror',
  label: 'Mirror',
  icon: '⇔',
  cursor: 'crosshair',
  defaultKey: 'Ctrl+m',

  onActivate(ctx: ThreeToolContext): void {
    const targets = [...ctx.selection.items.value]
    if (targets.length === 0) return
    ctx.executeMirror(targets, mirrorAxis.value)
    ctx.toolRegistry.activate('select')
  },
}
```

- [ ] **Step 4: Register and commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/tools/replaceTool.ts web/src/workbench/tools/fillTool.ts web/src/workbench/tools/mirrorTool.ts
git commit -m "feat: add Replace, Fill, and Mirror editing tools"
```

---

### Task 11: Annotation tool + Label tool + Eyedropper tool

**Files:**
- Create: `web/src/workbench/tools/annotationTool.ts`
- Create: `web/src/workbench/tools/labelTool.ts`
- Create: `web/src/workbench/tools/eyedropperTool.ts`
- Create: `web/src/workbench/components/AnnotationEditor.vue`
- Create: `web/src/workbench/components/LabelEditor.vue`

- [ ] **Step 1: Write Annotation tool**

```typescript
// web/src/workbench/tools/annotationTool.ts
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

export const annotationTool: Tool = {
  id: 'annotation',
  label: 'Annotate',
  icon: '▢',
  cursor: 'crosshair',
  defaultKey: undefined,

  onPointerDown(ctx: ThreeToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    ctx._annotStart = picked.pos
    ctx._annotating = true
  },

  onPointerMove(ctx: ThreeToolContext, event: PointerEvent): void {
    if (!ctx._annotating) return
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    ctx._annotEnd = picked.pos
    // renderOverlay draws the preview bbox
  },

  onPointerUp(ctx: ThreeToolContext, _event: PointerEvent): void {
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
    ctx.executeCreateAnnotation({ min, max })
    ctx._annotating = false
    ctx._annotStart = null
    ctx._annotEnd = null
  },
}
```

- [ ] **Step 2: Write Label tool**

```typescript
// web/src/workbench/tools/labelTool.ts
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

export const labelTool: Tool = {
  id: 'label',
  label: 'Label',
  icon: 'T',
  cursor: 'text',
  defaultKey: undefined,

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    // Open label editor at the picked position
    ctx._labelPosition = { x: picked.pos.x + 0.5, y: picked.pos.y + 1, z: picked.pos.z + 0.5 }
    ctx._showLabelEditor = true
  },
}
```

- [ ] **Step 3: Write Eyedropper tool**

```typescript
// web/src/workbench/tools/eyedropperTool.ts
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'
import { setReplaceBrush } from './replaceTool'
import { setFillType } from './fillTool'

export const eyedropperTool: Tool = {
  id: 'eyedropper',
  label: 'Eyedropper',
  icon: '💉',
  cursor: 'crosshair',
  defaultKey: 'e',

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    setReplaceBrush(picked.block_state_id)
    setFillType(picked.block_state_id)
    // Switch to Select after picking
    ctx.toolRegistry.activate('select')
  },
}
```

- [ ] **Step 4: Register all three tools, commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/tools/annotationTool.ts web/src/workbench/tools/labelTool.ts web/src/workbench/tools/eyedropperTool.ts
git commit -m "feat: add Annotation, Label, and Eyedropper tools"
```

---

### Task 12: Keymap system

**Files:**
- Create: `web/src/workbench/keymap.ts`
- Modify: `web/src/workbench/WorkbenchRoot.vue` (wire keymap)

- [ ] **Step 1: Write keymap**

```typescript
// web/src/workbench/keymap.ts

export interface KeyBinding {
  key: string
  ctrl?: boolean
  shift?: boolean
  toolId?: string
  action?: string
  description: string
}

export const DEFAULT_KEYMAP: KeyBinding[] = [
  { key: 'a', toolId: undefined, action: 'select-all', description: '全选/取消全选' },
  { key: 'b', toolId: 'select', action: 'box-select', description: '框选模式' },
  { key: 'g', toolId: 'move', description: '移动工具' },
  { key: 'x', toolId: 'delete', description: '删除工具' },
  { key: 'r', toolId: 'replace', description: '替换工具' },
  { key: 'f', toolId: 'fill', description: '填充工具' },
  { key: 'e', toolId: 'eyedropper', description: '拾色器' },
  { key: 'm', ctrl: true, toolId: 'mirror', description: '镜像工具' },
  { key: 'a', shift: true, toolId: 'generate', description: '生成工具' },
  { key: 'z', ctrl: true, shift: false, action: 'undo', description: '撤销' },
  { key: 'z', ctrl: true, shift: true, action: 'redo', description: '重做' },
  { key: 'i', ctrl: true, action: 'invert', description: '反选' },
  { key: 'Tab', action: 'toggle-tool', description: 'Select/上次工具切换' },
  { key: 't', action: 'toggle-toolshelf', description: '工具栏显示' },
  { key: 'n', action: 'toggle-properties', description: '属性面板显示' },
]

const STORAGE_KEY = 'lightning-workbench-keymap'

export function loadKeymap(): KeyBinding[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as KeyBinding[]
  } catch { /* ignore */ }
  return DEFAULT_KEYMAP
}

export function saveKeymap(keymap: KeyBinding[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keymap)) } catch { /* */ }
}

export function matchBinding(
  binding: KeyBinding,
  event: KeyboardEvent,
): boolean {
  const keyMatch = event.key.toLowerCase() === binding.key.toLowerCase()
  if (!keyMatch) return false
  if (binding.ctrl !== undefined && binding.ctrl !== (event.ctrlKey || event.metaKey)) return false
  if (binding.shift !== undefined && binding.shift !== event.shiftKey) return false
  return true
}
```

- [ ] **Step 2: Wire keymap in WorkbenchRoot**

Add global `keydown` listener that matches keymap entries and dispatches to ToolRegistry.activate() or EditHistory.undo()/redo().

- [ ] **Step 3: Commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/keymap.ts web/src/workbench/WorkbenchRoot.vue
git commit -m "feat: add keymap system with default Blender-aligned bindings and local storage remapping"
```

---

### Task 13: Context menu

**Files:**
- Create: `web/src/workbench/components/ContextMenu.vue`
- Modify: `web/src/workbench/WorkbenchViewport.vue` (right-click listener)

- [ ] **Step 1: Write ContextMenu.vue**

```vue
<!-- web/src/workbench/components/ContextMenu.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { useSelectionContext } from '@/workbench/selectionContext'
import { useToolRegistry } from '@/workbench/toolRegistry'
import { useEditHistory } from '@/workbench/editHistoryContext'

const selection = useSelectionContext()
const toolRegistry = useToolRegistry()
const history = useEditHistory()

defineProps<{ x: number; y: number; visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

function run(action: string): void {
  switch (action) {
    case 'inspect': toolRegistry.activate('select'); break
    case 'annotate': toolRegistry.activate('annotation'); break
    case 'label': toolRegistry.activate('label'); break
    case 'delete': toolRegistry.activate('delete'); break
    case 'eyedropper': toolRegistry.activate('eyedropper'); break
    case 'move': toolRegistry.activate('move'); break
    case 'mirror': toolRegistry.activate('mirror'); break
    case 'undo': history.undo(); break
    case 'redo': history.redo(); break
  }
  emit('close')
}

const hasSelection = selection.items.value.size > 0
const hasMultiple = selection.items.value.size > 1
</script>

<template>
  <div v-if="visible" class="ctx-menu" :style="{ left: x + 'px', top: y + 'px' }" @click.stop>
    <template v-if="!hasSelection">
      <button class="ctx-item" @click="run('label')">放置标签</button>
    </template>
    <template v-else-if="!hasMultiple">
      <button class="ctx-item" @click="run('inspect')">检查</button>
      <button class="ctx-item" @click="run('annotate')">注解</button>
      <button class="ctx-item" @click="run('label')">放置标签</button>
      <button class="ctx-item" @click="run('delete')">移除此方块</button>
      <button class="ctx-item" @click="run('eyedropper')">拾取类型</button>
    </template>
    <template v-else>
      <button class="ctx-item" @click="run('annotate')">批量注解</button>
      <button class="ctx-item" @click="run('move')">移动选中</button>
      <button class="ctx-item" @click="run('delete')">删除选中</button>
      <button class="ctx-item" @click="run('mirror')">镜像选中</button>
    </template>
    <div class="ctx-sep" />
    <button class="ctx-item" @click="run('undo')" :disabled="!history.canUndo.value">撤销</button>
    <button class="ctx-item" @click="run('redo')" :disabled="!history.canRedo.value">重做</button>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed; z-index: 2000; min-width: 160px;
  padding: 4px; background: var(--nei-dropdown-bg); border: 1px solid var(--nei-border);
  border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.ctx-item {
  display: block; width: 100%; padding: 5px 10px; border: none;
  background: transparent; color: var(--nei-text-dark); font-size: 12px;
  text-align: left; cursor: pointer; border-radius: 3px;
}
.ctx-item:hover { background: var(--nei-dropdown-hover); color: #fff; }
.ctx-item:disabled { color: var(--nei-muted); cursor: default; }
.ctx-sep { height: 1px; background: var(--nei-border); margin: 2px 0; }
</style>
```

- [ ] **Step 2: Wire into WorkbenchViewport**

Add `@contextmenu.prevent` handler that sets menu position and `visible`.

- [ ] **Step 3: Commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/components/ContextMenu.vue web/src/workbench/components/WorkbenchViewport.vue
git commit -m "feat: add right-click context menu (Blender-aligned)"
```

---

### Task 14: StatsPanel — Auto/Custom modes with highlight linkage

**Files:**
- Create: `web/src/workbench/components/StatsPanel.vue`
- Modify: `web/src/workbench/WorkbenchRoot.vue` (add StatsPanel to layout)

- [ ] **Step 1: Write StatsPanel.vue**

The StatsPanel component:
- Reads `scene.scene.value` to aggregate blocks
- If `stats_template.mode === 'auto'`: flat group by block_state_id with counts
- If `stats_template.mode === 'custom'`: match against template groups, show target vs actual
- Each row on hover calls `panelState.highlightType(blockStateId)`, on click calls `panelState.pinType(blockStateId)`
- Highlighted/pinned types render wireframe overlay in viewport (consumed by WorkbenchViewport's renderOverlay loop)

```vue
<!-- web/src/workbench/components/StatsPanel.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { useSceneContext } from '@/workbench/sceneContext'
import { usePanelState } from '@/workbench/panelState'
import { useSelectionContext } from '@/workbench/selectionContext'
import type { V2StatsTemplate } from '@/render/data/sceneDocumentV2'

const scene = useSceneContext()
const { highlightType, clearHighlight, pinType } = usePanelState()
const selection = useSelectionContext()

const template = computed<V2StatsTemplate | null>(() => {
  return (scene.scene.value as any)?.stats_template ?? null
})

const mode = computed(() => template.value?.mode ?? 'auto')

interface StatRow {
  block_state_id: string
  label: string
  count: number
}

const rows = computed<StatRow[]>(() => {
  const doc = scene.scene.value
  if (!doc) return []
  const currentFrame = (doc as any).frames?.[selection.frameIndex.value ?? 0]
  const blocks = (currentFrame?.blocks ?? []) as Array<{ block_state_id: string }>

  if (mode.value === 'auto') {
    const counts = new Map<string, number>()
    for (const b of blocks) {
      counts.set(b.block_state_id, (counts.get(b.block_state_id) ?? 0) + 1)
    }
    return [...counts.entries()].map(([id, n]) => ({ block_state_id: id, label: id, count: n }))
  }

  // Custom mode
  const groups = template.value?.groups ?? []
  const countMap = new Map<string, number>()
  for (const b of blocks) {
    countMap.set(b.block_state_id, (countMap.get(b.block_state_id) ?? 0) + 1)
  }
  const result: StatRow[] = []
  for (const g of groups) {
    for (const e of g.entries) {
      result.push({
        block_state_id: e.block_state_id,
        label: e.label_override ?? e.block_state_id,
        count: countMap.get(e.block_state_id) ?? 0,
      })
    }
  }
  return result
})

function onMouseEnter(id: string): void { highlightType(id) }
function onMouseLeave(): void { clearHighlight() }
function onClick(id: string): void { pinType(id) }
</script>

<template>
  <div class="stats-panel">
    <div class="stats-panel__header">
      <span>Stats ({{ mode }})</span>
    </div>
    <div class="stats-panel__list">
      <div
        v-for="row in rows" :key="row.block_state_id"
        class="stats-row"
        @mouseenter="onMouseEnter(row.block_state_id)"
        @mouseleave="onMouseLeave"
        @click="onClick(row.block_state_id)"
      >
        <span class="stats-row__label">{{ row.label }}</span>
        <span class="stats-row__count">{{ row.count }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats-panel { padding: 8px; font-size: 12px; color: var(--nei-text-dark); }
.stats-panel__header { font-weight: 600; margin-bottom: 4px; }
.stats-panel__list { max-height: 300px; overflow-y: auto; }
.stats-row {
  display: flex; justify-content: space-between; padding: 2px 6px;
  border-radius: 3px; cursor: pointer;
}
.stats-row:hover { background: var(--nei-panel-hover); }
.stats-row__label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats-row__count { font-variant-numeric: tabular-nums; color: var(--nei-muted); margin-left: 8px; }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/components/StatsPanel.vue
git commit -m "feat: add StatsPanel with Auto/Custom modes and viewport highlight linkage"
```

---

### Task 15: Resource browser (shared infrastructure)

**Files:**
- Create: `web/src/workbench/components/ResourceBrowser.vue`

- [ ] **Step 1: Write ResourceBrowser.vue**

A tree-based resource browser sharing the same highlight/search/filter infrastructure from StatsPanel:

```vue
<!-- web/src/workbench/components/ResourceBrowser.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSceneContext } from '@/workbench/sceneContext'
import { usePanelState } from '@/workbench/panelState'

const scene = useSceneContext()
const { highlightType, clearHighlight, pinType, activeBlockTypes } = usePanelState()

const searchQuery = ref('')
const selectedTab = ref<'blocks' | 'annotations' | 'labels' | 'frames' | 'materials'>('blocks')

type TreeNode = { id: string; label: string; count?: number; children?: TreeNode[] }

const tree = computed<TreeNode[]>(() => {
  // Build tree from scene data based on selectedTab
  return [] // Stub — implementation builds real tree from scene
})

function onMouseEnter(id: string): void { highlightType(id) }
function onMouseLeave(): void { clearHighlight() }
function onClick(id: string): void { pinType(id) }
</script>

<template>
  <div class="resource-browser">
    <input v-model="searchQuery" class="rb-search" placeholder="Filter..." />
    <div class="rb-tabs">
      <button v-for="t in (['blocks','annotations','labels','frames','materials'] as const)" :key="t"
        class="rb-tab" :class="{ 'rb-tab--active': selectedTab === t }" @click="selectedTab = t">
        {{ t }}
      </button>
    </div>
    <div class="rb-tree">
      <div v-for="node in tree" :key="node.id" class="rb-node"
        @mouseenter="onMouseEnter(node.id)" @mouseleave="onMouseLeave" @click="onClick(node.id)">
        <span class="rb-node__label">{{ node.label }}</span>
        <span v-if="node.count !== undefined" class="rb-node__count">{{ node.count }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.resource-browser { padding: 8px; font-size: 12px; color: var(--nei-text-dark); }
.rb-search { width: 100%; padding: 4px 8px; border: 1px solid var(--nei-border); border-radius: 4px;
  background: var(--nei-bg); color: var(--nei-text-dark); font-size: 12px; margin-bottom: 4px; }
.rb-tabs { display: flex; gap: 2px; margin-bottom: 4px; }
.rb-tab { padding: 2px 8px; border: none; background: transparent; color: var(--nei-muted);
  font-size: 11px; cursor: pointer; border-radius: 3px; }
.rb-tab--active { background: var(--nei-dropdown-hover); color: #fff; }
.rb-tab:hover { background: var(--nei-panel-hover); }
.rb-tree { max-height: 300px; overflow-y: auto; }
.rb-node { display: flex; justify-content: space-between; padding: 2px 6px; border-radius: 3px; cursor: pointer; }
.rb-node:hover { background: var(--nei-panel-hover); }
.rb-node__label { flex: 1; }
.rb-node__count { color: var(--nei-muted); margin-left: 8px; }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/components/ResourceBrowser.vue
git commit -m "feat: add ResourceBrowser — shared tree browser for blocks/annotations/labels/frames/materials"
```

---

### Task 16: Generate panel — block palette + floor templates

**Files:**
- Create: `web/src/workbench/components/GeneratePanel.vue`
- Create: `web/src/workbench/tools/generateTool.ts`

- [ ] **Step 1: Write Generate tool**

```typescript
// web/src/workbench/tools/generateTool.ts
import { ref } from 'vue'
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

const generateType = ref<string | null>(null)

export function getGenerateType(): string | null { return generateType.value }
export function setGenerateType(id: string | null): void { generateType.value = id }

// Floor templates
export const FLOOR_TEMPLATES = [
  { id: 'floor_solid_white', label: '白色地板', color: '#ffffff' },
  { id: 'floor_solid_gray', label: '灰色地板', color: '#808080' },
  { id: 'floor_solid_black', label: '黑色地板', color: '#222222' },
  { id: 'floor_checker', label: '棋盘格', color: '#ffffff/#000000' },
  { id: 'floor_ruler', label: '坐标标尺', color: '#ff4444' },
] as const

export const generateTool: Tool = {
  id: 'generate',
  label: 'Generate',
  icon: '◆',
  cursor: 'crosshair',
  defaultKey: 'Shift+a',

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const type = generateType.value
    if (!type) return
    const picked = ctx.pickVoxel(event)
    const pos = picked?.pos ?? { x: 0, y: 0, z: 0 }
    ctx.executeGenerate(type, pos)
  },
}
```

- [ ] **Step 2: Write GeneratePanel.vue**

Minimal palette picker + floor template buttons.

- [ ] **Step 3: Register and commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/tools/generateTool.ts web/src/workbench/components/GeneratePanel.vue
git commit -m "feat: add Generate tool with block palette and floor templates"
```

---

### Task 17: Export format — Embed vs Workbench

**Files:**
- Create: `web/src/workbench/utils/exportFormat.ts`
- Modify: `web/src/workbench/components/ExportWorkspace.vue` (add format selector)

- [ ] **Step 1: Write export format utilities**

```typescript
// web/src/workbench/utils/exportFormat.ts

import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'

export function buildEmbedEnvelope(doc: V2PlainSceneDocument): V2PlainSceneDocument {
  return {
    format_version: doc.format_version,
    meta: {
      ...doc.meta,
      description: doc.meta.description.replace(/[#*`\[\]()]/g, ''), // strip markdown
    },
    frames: doc.frames.map(f => ({
      ...f,
      blocks: f.blocks.map(b => ({ pos: b.pos, block_state_id: b.block_state_id, nbt: b.nbt })),
      entities: f.entities,
    })),
    block_palette: doc.block_palette,
    materials: doc.materials,
    // Omit: annotations, labels, stats_template
  }
}

export function buildWorkbenchEnvelope(doc: V2PlainSceneDocument): V2PlainSceneDocument {
  return doc // Full data, no stripping
}
```

- [ ] **Step 2: Update ExportWorkspace.vue**

Add a format selector radio: "Workbench (完整)" vs "Embed (精简)".
When "Embed" selected, call `buildEmbedEnvelope()` before serializing.

- [ ] **Step 3: Commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/utils/exportFormat.ts web/src/workbench/components/ExportWorkspace.vue
git commit -m "feat: add dual export format — Embed (stripped) vs Workbench (full v2)"
```

---

### Task 18: BlockInspector upgrade — gui_state + parts display

**Files:**
- Modify: `web/src/workbench/components/BlockInspector.vue`

- [ ] **Step 1: Add gui_state rendering to BlockInspector**

When selected block has `gui_state`, render a simplified machine GUI:
- Item slot grid with icons
- Fluid tank bars
- Energy bar

- [ ] **Step 2: Add parts display**

When selected block has `parts[]`, render each part as a sub-row with:
- Direction label (DUNSWE / CENTER / None)
- Part kind (modid:type)
- Individual tooltip

- [ ] **Step 3: Commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/components/BlockInspector.vue
git commit -m "feat: upgrade BlockInspector with gui_state rendering and multipart display"
```

---

### Task 19: Integration — PropertiesPanel tool-driven tab switching

**Files:**
- Modify: `web/src/workbench/components/PropertiesPanel.vue`

- [ ] **Step 1: Update PropertiesPanel to react to active tool**

```vue
<!-- Add to PropertiesPanel.vue script -->
<script setup lang="ts">
import { computed } from 'vue'
import { useToolRegistry } from '@/workbench/toolRegistry'
import { useSelectionContext } from '@/workbench/selectionContext'

const toolRegistry = useToolRegistry()
const selection = useSelectionContext()

const activeTab = computed(() => {
  const tool = toolRegistry.activeTool.value
  if (!tool) return 'block-inspector'
  switch (tool.id) {
    case 'select':
      return selection.items.value.size > 1 ? 'batch-edit' : 'block-inspector'
    case 'move':
      return 'transform'
    case 'annotation':
      return 'annotation-editor'
    case 'label':
      return 'label-editor'
    case 'generate':
      return 'generate-panel'
    default:
      return 'block-inspector'
  }
})
</script>
```

- [ ] **Step 2: Commit**

```bash
cd D:/Projects/Lightning && git add web/src/workbench/components/PropertiesPanel.vue
git commit -m "feat: wire PropertiesPanel tool-driven tab switching"
```

---

### Task 20: Final integration — WorkbenchRoot layout update

**Files:**
- Modify: `web/src/workbench/WorkbenchRoot.vue`
- Modify: `web/src/workbench/layout/WorkbenchShell.vue`

- [ ] **Step 1: Update WorkbenchRoot.vue**

Integrate all context providers and components:
```typescript
// Full provide chain:
const scene = provideSceneContext()
const selection = provideSelectionContext()
const editHistory = provideEditHistory(256)
const toolRegistry = provideToolRegistry()
provideConnectionContext(scene)

// Register all tools:
toolRegistry.register(selectTool)
toolRegistry.register(moveTool)
toolRegistry.register(deleteTool)
toolRegistry.register(replaceTool)
toolRegistry.register(fillTool)
toolRegistry.register(mirrorTool)
toolRegistry.register(generateTool)
toolRegistry.register(annotationTool)
toolRegistry.register(labelTool)
toolRegistry.register(eyedropperTool)
toolRegistry.activate('select')

// Apply plugin tools
for (const plugin of (props.plugins ?? [])) {
  if (plugin.tools) for (const t of plugin.tools) toolRegistry.register(t)
  if (plugin.provideContexts) {
    const ctxs = plugin.provideContexts()
    for (const [k, v] of Object.entries(ctxs)) provide(k, v)
  }
}

// Keymap listener
onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
})
```

- [ ] **Step 2: Update WorkbenchShell.vue layout**

Add ToolShelf slot in left position, StatsPanel/ResourceBrowser in bottom panel.

- [ ] **Step 3: Full typecheck and build verification**

```bash
cd D:/Projects/Lightning/web
npx vue-tsc --noEmit
npm run build:all
```

Expected: No type errors, both embed and workbench builds succeed.

- [ ] **Step 4: Commit**

```bash
cd D:/Projects/Lightning
git add -A
git commit -m "feat: final integration — wire all contexts, tools, panels, and keymap into WorkbenchRoot"
```

---

## Task Dependency Order

```
Task 1 (Protocol v2)
  └─> Task 2 (v2 TS types + migration)
       └─> Task 3 (SelectionContext)
            └─> Task 4 (EditHistory)
                 └─> Task 5 (ToolRegistry + ToolShelf)
                      ├─> Task 6 (PanelState)
                      ├─> Task 7 (Plugin system)
                      ├─> Task 8 (Select tool)
                      │    └─> Task 9,10,11 (editing tools)
                      ├─> Task 12 (Keymap)
                      ├─> Task 13 (ContextMenu)
                      ├─> Task 14 (StatsPanel)
                      ├─> Task 15 (ResourceBrowser)
                      ├─> Task 16 (GeneratePanel)
                      ├─> Task 17 (Export format)
                      ├─> Task 18 (BlockInspector upgrade)
                      ├─> Task 19 (PropertiesPanel)
                      └─> Task 20 (Final integration)
```

Tasks 1-5 are strict sequential. Tasks 6-19 can be parallelized after Task 5 completes. Task 20 is last.

---

## Testing Strategy

| Component | Test approach |
|-----------|--------------|
| versionMigration | Unit: v1 fixture → v2 output shape, verify all fields mapped |
| SelectionContext | Manual: single click, shift+click, box drag, A key, Ctrl+I |
| EditHistory | Manual: execute move → Ctrl+Z → Ctrl+Shift+Z, verify block positions |
| ToolRegistry | Manual: click each tool in ToolShelf, verify cursor and behavior change |
| Keymap | Manual: press each bound key, verify tool activation |
| StatsPanel | Manual: load scene → hover stats row → verify viewport highlight |
| Export | Manual: export both formats, diff JSON output |

No automated test infrastructure exists in the project yet; tests are manual smoke checks for now.

## Gaps & Follow-ups

| Gap | Detail | Resolution |
|-----|--------|------------|
| `ThreeToolContext` interface | Imported as `./_base` in all tool files but not defined in plan | Define in Task 5 alongside ToolRegistry; aggregates SceneContext + SelectionContext + viewport refs + command executors |
| U5 — StatsEditorWorkspace | Independent workspace page for custom stats template editing | Deferred: needs resource pack browser + drag-drop grouping editor; follows after ResourceBrowser (Task 15) and StatsPanel (Task 14) are stable |
| P6 — Resource pack loading | Loading MC resource packs for block textures in Generate tool | Deferred: requires zip parsing + texture extraction pipeline; plugin system (Task 7) provides extension point |
| WorldFrame frame switching interaction | Selection clear on frame switch, undo per-frame behavior | Not addressed in this plan by design (spec marked as F6 — reserved extension point) |
| Incremental mesh construction | Rebuild only affected voxel meshes on edit | Not addressed by design (spec marked as F7 — reserved extension point) |
