// web/src/workbench/selectionContext.ts

import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref, shallowRef } from 'vue'
import { logCenter } from '@/workbench/logging/LogCenter'
import type { ScenePickEntity } from '@/render/interaction/scenePick'
import { posKey, isSamePosition } from '@/pure/vec'
import type { AnnotationType } from '@/render/data/annotationTypes'

/**
 * Convert a scene pick result to a SelectedEntity (or null if not matchable).
 */
export function scenePickToSelectedEntity(
  pick: ScenePickEntity,
):
  | { kind: 'block'; ref: { pos: { x: number; y: number; z: number }; block_state_id: string } }
  | { kind: 'annotation'; id: string; type: AnnotationType }
  | null {
  if (
    pick.kind === 'block' &&
    pick.blockId &&
    pick.column !== undefined &&
    pick.row !== undefined &&
    pick.zSlice !== undefined
  ) {
    return {
      kind: 'block',
      ref: {
        pos: { x: pick.column, y: pick.row, z: pick.zSlice },
        block_state_id: pick.blockId,
      },
    }
  }
  if (pick.kind === 'annotation' && pick.annotationId && pick.annotationType) {
    return {
      kind: 'annotation',
      id: pick.annotationId,
      type: pick.annotationType,
    }
  }
  return null
}

// Re-exported from render layer — these are pure data types shared across layers
export type { BlockRef, SelectedEntity } from '@/render/schema/types'

export type SelectionMode = 'single' | 'box' | 'type' | 'annotation'

/** Active data — block for block selector, string for annotation ID */
export type ActiveItem = BlockRef | string

export interface SelectionContext {
  readonly items: Ref<Set<SelectedEntity>>
  readonly mode: Ref<SelectionMode>
  /** Currently active item: BlockRef for blocks, string (annotation ID) for annotations */
  readonly active: Ref<ActiveItem | null>
  select(voxel: BlockRef): void
  selectBox(min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }, blocks: BlockRef[]): void
  selectByType(blockStateId: string, blocks: BlockRef[]): void
  add(voxels: BlockRef[]): void
  remove(voxels: BlockRef[]): void
  clear(): void
  invert(blocks: BlockRef[]): void
  isSelected(pos: { x: number; y: number; z: number }): boolean

  /** Unified entity selection — canonical entry point for pick-then-select */
  selectEntity(entity: SelectedEntity): void

  /** Pick cycling state */
  readonly cycleState: { lastPoint: { x: number; y: number } | null; candidates: SelectedEntity[]; index: number }
  setCycleState(state: { lastPoint: { x: number; y: number }; candidates: SelectedEntity[]; index: number }): void
  resetCycle(): void
}

export const selectionContextKey: InjectionKey<SelectionContext> = Symbol('selectionContext')

export function createSelectionContext(): SelectionContext {
  const items = ref<Set<SelectedEntity>>(new Set())
  const mode = ref<SelectionMode>('single')
  const active = ref<ActiveItem | null>(null)

  const index = ref<Map<string, BlockRef>>(new Map())
  const annotationIndex = ref<Set<string>>(new Set())

  const cycleState = shallowRef<SelectionContext['cycleState']>({
    lastPoint: null,
    candidates: [],
    index: 0,
  })

  function setCycleState(state: SelectionContext['cycleState']): void {
    cycleState.value = state
  }

  function resetCycle(): void {
    cycleState.value = { lastPoint: null, candidates: [], index: 0 }
  }

  function selectEntity(entity: SelectedEntity): void {
    if (entity.kind === 'block') {
      select(entity.ref)
      return
    }
    active.value = entity.id
    items.value = new Set([entity])
    index.value = new Map()
    annotationIndex.value = new Set([entity.id])
    mode.value = 'annotation'
    logCenter.debug('Selection', 'annotation selected', { id: entity.id, type: entity.type })
  }

  function select(voxel: BlockRef): void {
    const entity: SelectedEntity = { kind: 'block', ref: voxel }
    active.value = voxel
    items.value = new Set([entity])
    index.value = new Map([[posKey(voxel.pos), voxel]])
    annotationIndex.value = new Set()
    mode.value = 'single'
    logCenter.debug('Selection', 'block selected', { id: voxel.block_state_id, x: voxel.pos.x, y: voxel.pos.y, z: voxel.pos.z })
  }

  function selectBox(min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }, blocks: BlockRef[]): void {
    active.value = null
    const set = new Set<SelectedEntity>()
    const map = new Map<string, BlockRef>()
    for (const b of blocks) {
      if (
        b.pos.x >= min.x && b.pos.x <= max.x &&
        b.pos.y >= min.y && b.pos.y <= max.y &&
        b.pos.z >= min.z && b.pos.z <= max.z
      ) {
        set.add({ kind: 'block', ref: b })
        map.set(posKey(b.pos), b)
      }
    }
    items.value = set
    index.value = map
    annotationIndex.value = new Set()
    mode.value = 'box'
    if (set.size > 0) {
      logCenter.debug('Selection', 'box select', { count: set.size, min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } })
    }
  }

  function selectByType(blockStateId: string, blocks: BlockRef[]): void {
    active.value = null
    const set = new Set<SelectedEntity>()
    const map = new Map<string, BlockRef>()
    for (const b of blocks) {
      if (b.block_state_id === blockStateId) {
        set.add({ kind: 'block', ref: b })
        map.set(posKey(b.pos), b)
      }
    }
    items.value = set
    index.value = map
    annotationIndex.value = new Set()
    mode.value = 'type'
  }

  function add(voxels: BlockRef[]): void {
    const set = new Set(items.value)
    const map = new Map(index.value)
    for (const v of voxels) {
      set.add({ kind: 'block', ref: v })
      map.set(posKey(v.pos), v)
    }
    items.value = set
    index.value = map
    annotationIndex.value = new Set()
  }

  function remove(voxels: BlockRef[]): void {
    const set = new Set(items.value)
    const map = new Map(index.value)
    for (const v of voxels) {
      for (const e of set) {
        if (e.kind === 'block' && e.ref.pos.x === v.pos.x && e.ref.pos.y === v.pos.y && e.ref.pos.z === v.pos.z) {
          set.delete(e)
          break
        }
      }
      map.delete(posKey(v.pos))
    }
    items.value = set
    index.value = map
  }

  function clear(): void {
    active.value = null
    items.value = new Set()
    index.value = new Map()
    annotationIndex.value = new Set()
  }

  function invert(blocks: BlockRef[]): void {
    const newSet = new Set<SelectedEntity>()
    const map = new Map<string, BlockRef>()
    const currentKeys = new Set<string>()
    for (const e of items.value) {
      if (e.kind === 'block') currentKeys.add(posKey(e.ref.pos))
    }
    for (const b of blocks) {
      if (!currentKeys.has(posKey(b.pos))) {
        newSet.add({ kind: 'block', ref: b })
        map.set(posKey(b.pos), b)
      }
    }
    items.value = newSet
    index.value = map
    annotationIndex.value = new Set()
  }

  function isSelected(pos: { x: number; y: number; z: number }): boolean {
    return index.value.has(posKey(pos))
  }

  return {
    items: items as unknown as Ref<Set<SelectedEntity>>,
    mode: mode as unknown as Ref<SelectionMode>,
    active: active as unknown as Ref<ActiveItem | null>,
    select, selectBox, selectByType, add, remove, clear, invert, isSelected,
    selectEntity,
    get cycleState() { return cycleState.value },
    setCycleState,
    resetCycle,
  }
}

/**
 * Minimal interface for pick-then-select operations.
 * Accepts only what applyPickSelection needs — avoids coupling to full bContext.
 */
export interface PickHandler {
  pickVoxel(event: PointerEvent): BlockRef | null
  selection: {
    select(voxel: BlockRef): void
    add(voxels: BlockRef[]): void
    remove(voxels: BlockRef[]): void
    clear(): void
  }
}

// ---------------------------------------------------------------------------
// Pick Cycling
// ---------------------------------------------------------------------------

export interface PickHandlerV2 {
  pickAll(event: PointerEvent): ScenePickEntity[]
  selection: {
    selectEntity(entity: SelectedEntity): void
    add(voxels: BlockRef[]): void
    remove(voxels: BlockRef[]): void
    clear(): void
  }
  cycleState: SelectionContext['cycleState']
  setCycleState(s: { lastPoint: { x: number; y: number }; candidates: SelectedEntity[]; index: number }): void
  resetCycle(): void
}

export function applyPickSelectionWithCycle(
  ctx: PickHandlerV2,
  event: PointerEvent,
): SelectedEntity | null {
  const point = { x: event.clientX, y: event.clientY }
  const all = ctx.pickAll(event)
  const candidates: SelectedEntity[] = []
  for (const p of all) {
    const e = scenePickToSelectedEntity(p)
    if (e) candidates.push(e)
  }

  if (candidates.length === 0) {
    ctx.resetCycle()
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) ctx.selection.clear()
    return null
  }

  // Same position → cycle
  const cs = ctx.cycleState
  if (cs.lastPoint && isSamePosition(cs.lastPoint, point)) {
    const nextIndex = (cs.index + 1) % candidates.length
    ctx.setCycleState({ lastPoint: point, candidates, index: nextIndex })
    const entity = candidates[nextIndex]
    ctx.selection.selectEntity(entity)
    return entity
  }

  // New position → pick closest, start cycle
  ctx.setCycleState({ lastPoint: point, candidates, index: 0 })
  const entity = candidates[0]
  if (event.shiftKey) {
    if (entity.kind === 'block') {
      ctx.selection.add([entity.ref])
    } else {
      ctx.selection.selectEntity(entity)
    }
  } else if (event.ctrlKey || event.metaKey) {
    if (entity.kind === 'block') {
      ctx.selection.remove([entity.ref])
    }
  } else {
    ctx.selection.selectEntity(entity)
  }
  return entity
}

export function provideSelectionContext(): SelectionContext {
  const ctx = createSelectionContext()
  provide(selectionContextKey, ctx)
  return ctx
}

export function useSelectionContext(): SelectionContext {
  const ctx = inject(selectionContextKey)
  if (!ctx) throw new Error('useSelectionContext() 须在 WorkbenchRoot 子树内调用')
  return ctx
}
