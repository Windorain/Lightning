// web/src/workbench/selectionContext.ts

import type { InjectionKey, Ref } from 'vue'
import { inject, provide, ref } from 'vue'
import { logCenter } from '@/workbench/logging/LogCenter'

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

export function createSelectionContext(): SelectionContext {
  const items = ref<Set<BlockRef>>(new Set())
  const mode = ref<SelectionMode>('single')
  const frameIndex = ref(0)

  const index = ref<Map<string, BlockRef>>(new Map())

  function select(voxel: BlockRef): void {
    items.value = new Set([voxel])
    index.value = new Map([[posKey(voxel.pos), voxel]])
    mode.value = 'single'
    logCenter.debug('Selection', 'block selected', { id: voxel.block_state_id, x: voxel.pos.x, y: voxel.pos.y, z: voxel.pos.z })
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
    if (set.size > 0) {
      logCenter.debug('Selection', 'box select', { count: set.size, min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } })
    }
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

  return {
    items: items as unknown as Ref<Set<BlockRef>>,
    mode: mode as unknown as Ref<SelectionMode>,
    frameIndex: frameIndex as unknown as Ref<number>,
    select, selectBox, selectByType, add, remove, clear, invert, isSelected,
  }
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
