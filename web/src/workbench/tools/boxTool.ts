// web/src/workbench/tools/boxTool.ts
import type { Tool, ToolGizmo, ToolContext } from './tool'
import type { DetectedBounds } from './partDetect'
import { detectFaceBounds, detectPartBounds } from './partDetect'
import { computeBoxFrameBars, computeUnionAABB, aabbsIntersect, type AABB } from '@/render/data/aabb'
import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import * as THREE from 'three'

// ── Module-level state (bridge between gizmo ↔ operators, only for face-accumulation tool) ──

interface FaceSelection {
  aabb: AABB
  blockPos: { x: number; y: number; z: number }
}

let _pendingSelections: FaceSelection[] = []

export function _boxGetPending(): ReadonlyArray<FaceSelection> {
  return _pendingSelections
}

export function _boxClearPending(): void {
  _pendingSelections = []
}

function _boxAddSelection(sel: FaceSelection, modifier: 'default' | 'shift' | 'ctrl'): void {
  if (modifier === 'ctrl') {
    _pendingSelections.push(sel)
    return
  }
  if (modifier === 'shift') {
    _pendingSelections.push(sel)
    const merged = computeUnionAABB(_pendingSelections.map(s => s.aabb))
    _pendingSelections = [{ aabb: merged, blockPos: _pendingSelections[0].blockPos }]
    return
  }
  for (let i = 0; i < _pendingSelections.length; i++) {
    if (aabbsIntersect(_pendingSelections[i].aabb, sel.aabb)) {
      const merged = computeUnionAABB([_pendingSelections[i].aabb, sel.aabb])
      _pendingSelections[i] = { aabb: merged, blockPos: _pendingSelections[i].blockPos }
      return
    }
  }
  _pendingSelections.push(sel)
}

// ── Operators (for face-accumulation tool) ──

export const AnnotationBoxCommitOperator: OperatorType = {
  id: 'ANNOTATION_BOX_COMMIT',
  label: '确认注解框',
  description: '根据累加的面选择创建 box 注解',
  poll(bctx) { return bctx.doc.value !== null && _pendingSelections.length > 0 },
  invoke(bctx, _props, event) {
    const toolProps = bctx.toolRegistry.activeTool.value?.properties ?? {}
    for (const sel of _pendingSelections) {
      const draft = {
        ...toolProps, type: 'box' as const,
        min: { ...sel.aabb.min }, max: { ...sel.aabb.max },
        frameIndex: bctx.queries.getCurrentFrame()?.index ?? 0,
      }
      bctx.operators.invoke('ANNOTATION_CREATE', { annotation: draft }, event ?? undefined)
    }
    _boxClearPending()
    return OP_RESULT.FINISHED
  },
}

export const AnnotationBoxResetOperator: OperatorType = {
  id: 'ANNOTATION_BOX_RESET',
  label: '重置注解框选择',
  description: '清除所有累加的面选择',
  poll(bctx) { return bctx.doc.value !== null },
  invoke(_bctx, _props, _event) { _boxClearPending(); return OP_RESULT.FINISHED },
}

// ── Tool data ──

export const boxTool: Tool = {
  id: 'annotation-box',
  label: '注解框',
  icon: '▢',
  cursor: 'crosshair',
  operator: 'ANNOTATION_BOX_COMMIT',
  properties: {
    type: 'box', color: '#4488ff', renderStyle: 'wireframe',
    renderOpacity: 0.5, overlay: false, fillOpacity: 0.3, frameThickness: 0.04,
    title: '', description: '', visible: true, locked: false,
  },
  keymap: [
    { type: 'KEY', key: 'b', toolId: 'annotation-box', description: '注解框工具' },
    { type: 'KEY', key: 'Enter', opId: 'ANNOTATION_BOX_COMMIT', description: '确认创建注解框' },
    { type: 'KEY', key: 'Escape', opId: 'ANNOTATION_BOX_RESET', description: '重置面选择' },
    { type: 'MOUSE', button: 0, description: '选择面 / 累加面组' },
  ],
  hints: [
    { keys: ['Click'], action: '选择面组' },
    { keys: ['Shift', 'Click'], action: '强制合并' },
    { keys: ['Ctrl', 'Click'], action: '独立盒子' },
    { keys: ['Click 虚空'], action: '重置选择' },
    { keys: ['Enter'], action: '确认创建' },
    { keys: ['Esc'], action: '取消' },
  ],
  group: 'annotation-box',
}

/** 注解框（整块）— 直接放置，不走模态 */
export const boxFullTool: Tool = {
  id: 'annotation-box-full',
  label: '整块框',
  icon: '▣',
  cursor: 'crosshair',
  operator: 'ANNOTATION_CREATE',
  properties: {
    type: 'box', color: '#44dd88', renderStyle: 'wireframe',
    renderOpacity: 0.5, overlay: false, fillOpacity: 0.3, frameThickness: 0.04,
    title: '', description: '', visible: true, locked: false,
    detectMode: 'full',
  },
  keymap: [
    { type: 'KEY', key: 'b', toolId: 'annotation-box', description: '注解框工具（面级别）' },
    { type: 'MOUSE', button: 0, description: '点击放置整块框' },
  ],
  hints: [
    { keys: ['Click'], action: '放置整块框' },
  ],
  group: 'annotation-box',
}

// ── Gizmo (shared by both tools, branches on detectMode) ──

export class BoxGizmo implements ToolGizmo {
  private _hoverBounds: DetectedBounds | null = null
  private _hoverPos: { x: number; y: number; z: number } | null = null
  private _previews: THREE.Object3D[] = []

  activate(_ctx: ToolContext): void { _boxClearPending() }
  deactivate(): void { this._disposePreviews(); this._hoverBounds = null; this._hoverPos = null; _boxClearPending() }

  onPointerMove(ctx: ToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) { this._hoverBounds = null; this._hoverPos = null; return }
    const def = ctx.viewport.definition.value
    if (!def) return
    this._hoverPos = picked.pos
    const detectMode = ctx.activeTool.value?.properties?.detectMode as string | undefined
    if (detectMode === 'full') {
      this._hoverBounds = detectPartBounds(def, picked.pos.x, picked.pos.y, picked.pos.z, null)
    } else if (picked.normal) {
      this._hoverBounds = detectFaceBounds(def, picked.pos.x, picked.pos.y, picked.pos.z, picked.normal, picked.quadIndex)
    } else {
      this._hoverBounds = detectPartBounds(def, picked.pos.x, picked.pos.y, picked.pos.z, null)
    }
  }

  onPointerDown(ctx: ToolContext, event: PointerEvent): void {
    const detectMode = ctx.activeTool.value?.properties?.detectMode as string | undefined

    if (detectMode === 'full') {
      // Direct placement — single click creates annotation
      if (!this._hoverBounds || !this._hoverPos) return
      const draft = {
        ...ctx.activeTool.value?.properties,
        type: 'box' as const,
        min: { ...this._hoverBounds.min }, max: { ...this._hoverBounds.max },
        frameIndex: ctx.getCurrentFrame()?.index ?? 0,
      }
      ctx.invokeOperator('ANNOTATION_CREATE', { annotation: draft }, event)
      return
    }

    // Face-accumulation mode — requires Enter to commit
    if (!this._hoverBounds || !this._hoverPos) {
      _boxClearPending()
      return
    }
    const modifier = event.shiftKey ? 'shift' : (event.ctrlKey || event.metaKey) ? 'ctrl' : 'default'
    _boxAddSelection({ aabb: { min: this._hoverBounds.min, max: this._hoverBounds.max }, blockPos: { ...this._hoverPos } }, modifier)
    this._hoverBounds = null
    this._hoverPos = null
  }

  onPointerUp(_ctx: ToolContext, _event: PointerEvent): void {}

  render(ctx: ToolContext): void {
    this._disposePreviews()
    const color = ctx.activeTool.value?.color ?? '#4488ff'
    const overlay = ctx.viewport.overlayGroup.value
    if (!overlay) return

    const detectMode = ctx.activeTool.value?.properties?.detectMode as string | undefined
    if (detectMode !== 'full') {
      for (const sel of _boxGetPending()) {
        this._addWireframe(overlay, sel.aabb, color, 0.8)
      }
    }
    if (this._hoverBounds) {
      this._addWireframe(overlay, { min: this._hoverBounds.min, max: this._hoverBounds.max }, color, 0.4)
    }
  }

  private _addWireframe(parent: THREE.Group, aabb: AABB, color: string, opacity: number): void {
    const bars = computeBoxFrameBars(aabb.min, aabb.max, 0.02)
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), depthTest: true, transparent: true, opacity })
    for (const d of bars) {
      const geo = new THREE.BoxGeometry(d.sx, d.sy, d.sz)
      const bar = new THREE.Mesh(geo, mat)
      bar.position.set(d.cx, d.cy, d.cz)
      this._previews.push(bar)
      parent.add(bar)
    }
  }

  private _disposePreviews(): void {
    for (const m of this._previews) {
      m.parent?.remove(m)
      if (m instanceof THREE.Mesh || m instanceof THREE.LineSegments) { m.geometry?.dispose(); (m.material as THREE.Material)?.dispose() }
    }
    this._previews = []
  }
}
