import type { SelectionContext } from '@/workbench/selectionContext'
import type { SceneContext } from '@/workbench/sceneContext'
import type { ToolRegistry } from '@/workbench/toolRegistry'
import type { UndoManager } from '@/workbench/editHistoryContext'
import type { BlockRef } from '@/workbench/selectionContext'

export interface ThreeToolContext {
  scene: SceneContext
  selection: SelectionContext
  toolRegistry: ToolRegistry
  editHistory: UndoManager

  /** Raycast to pick a voxel from a pointer event. Returns the block at that position or null. */
  pickVoxel(event: PointerEvent): BlockRef | null

  /** Get all BlockRef items for the current frame */
  getFrameBlocks(): BlockRef[]

  // --- Command executors (each creates and pushes an EditCommand) ---

  executeMove(initialPositions: Array<{ x: number; y: number; z: number }>, delta: { x: number; y: number; z: number }): void
  executeDelete(targets: BlockRef[]): void
  executeReplace(replacements: Array<{ pos: { x: number; y: number; z: number }; oldBlockStateId: string; newBlockStateId: string }>): void
  executeMirror(targets: BlockRef[], axis: 'x' | 'y' | 'z'): void
  executeGenerate(blockStateId: string, pos: { x: number; y: number; z: number }): void
  executeCreateAnnotation(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): void

  // --- Transient tool state (for drag operations, cleared on tool deactivate) ---
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
}
