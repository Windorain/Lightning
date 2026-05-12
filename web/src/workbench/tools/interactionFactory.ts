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

    const min = { x: Infinity, y: Infinity, z: Infinity }
    const max = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (const t of targets) {
      if (t.pos.x < min.x) min.x = t.pos.x; if (t.pos.y < min.y) min.y = t.pos.y; if (t.pos.z < min.z) min.z = t.pos.z
      if (t.pos.x > max.x) max.x = t.pos.x; if (t.pos.y > max.y) max.y = t.pos.y; if (t.pos.z > max.z) max.z = t.pos.z
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
