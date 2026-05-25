// web/src/workbench/tools/boxTool.ts
import type { Tool, ToolGizmo, ToolContext } from './tool'
import type { DetectedBounds } from './partDetect'
import { detectFaceBounds, detectPartBounds } from './partDetect'
import { computeBoxFrameBars, computeUnionAABB, aabbsIntersect, computeQuadNormal, type AABB, type QuadLike } from '@/render/data/aabb'
import { decodeBakedGeometry } from '@/render/mesh/bakedGeometryDecode'
import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import * as THREE from 'three'

// ── Module-level state (bridge between gizmo ↔ operators) ──

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

  // default: auto-detect adjacency — merge if AABBs intersect
  for (let i = 0; i < _pendingSelections.length; i++) {
    if (aabbsIntersect(_pendingSelections[i].aabb, sel.aabb)) {
      const merged = computeUnionAABB([_pendingSelections[i].aabb, sel.aabb])
      _pendingSelections[i] = { aabb: merged, blockPos: _pendingSelections[i].blockPos }
      return
    }
  }
  _pendingSelections.push(sel)
}

// ── Operators ──

export const AnnotationBoxCommitOperator: OperatorType = {
  id: 'ANNOTATION_BOX_COMMIT',
  label: '确认注解框',
  description: '根据累加的面选择创建 box 注解',

  poll(bctx) {
    return bctx.doc.value !== null && _pendingSelections.length > 0
  },

  invoke(bctx, _props, event) {
    const toolProps = bctx.toolRegistry.activeTool.value?.properties ?? {}
    for (const sel of _pendingSelections) {
      const draft = {
        ...toolProps,
        type: 'box' as const,
        min: { ...sel.aabb.min },
        max: { ...sel.aabb.max },
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

  poll(bctx) {
    return bctx.doc.value !== null
  },

  invoke(_bctx, _props, _event) {
    _boxClearPending()
    return OP_RESULT.FINISHED
  },
}

// ── Tool data ──

export const boxTool: Tool = {
  id: 'annotation-box',
  label: '注解框',
  icon: '▢',
  cursor: 'crosshair',
  operator: 'ANNOTATION_BOX_COMMIT',
  properties: {
    type: 'box',
    color: '#4488ff',
    renderStyle: 'wireframe',
    renderOpacity: 0.5,
    overlay: false,
    fillOpacity: 0.3,
    frameThickness: 0.04,
    title: '',
    description: '',
    visible: true,
    locked: false,
  },
  keymap: [
    { type: 'KEY', key: 'b', toolId: 'annotation-box', description: '注解框工具' },
    { type: 'KEY', key: 'Enter', opId: 'ANNOTATION_BOX_COMMIT', description: '确认创建注解框' },
    { type: 'KEY', key: 'Escape', opId: 'ANNOTATION_BOX_RESET', description: '重置面选择' },
    { type: 'MOUSE', button: 0, description: '选择面 / 累加面组' },
  ],
}

// ── Gizmo ──

export class BoxGizmo implements ToolGizmo {
  private _hoverBounds: DetectedBounds | null = null
  private _hoverPos: { x: number; y: number; z: number } | null = null
  /** Preview meshes created during this gizmo's render cycle */
  private _previews: THREE.Object3D[] = []

  activate(_ctx: ToolContext): void {
    _boxClearPending()
  }

  deactivate(): void {
    this._disposePreviews()
    this._hoverBounds = null
    this._hoverPos = null
    _boxClearPending()
  }

  onPointerMove(ctx: ToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) {
      this._hoverBounds = null
      this._hoverPos = null
      return
    }

    const def = ctx.viewport.definition.value
    if (!def) return

    this._hoverPos = picked.pos

    if (picked.normal) {
      this._hoverBounds = detectFaceBounds(
        def, picked.pos.x, picked.pos.y, picked.pos.z, picked.normal, picked.quadIndex,
      )
    } else {
      this._hoverBounds = detectPartBounds(def, picked.pos.x, picked.pos.y, picked.pos.z, null)
    }

    // ── DEBUG ──
    if (this._hoverBounds) {
      let quads: QuadLike[] = []
      try {
        const szR = def.cellGrid[0]?.length ?? 0
        const row = szR - 1 - picked.pos.y
        const idx = (def as any).cellGrid?.[picked.pos.z]?.[row]?.[picked.pos.x]
        const entry = idx >= 0 ? (def.blockPalette as any)[idx] : null
        if (entry?.geometry) quads = decodeBakedGeometry(entry.geometry)
      } catch {}

      const { min, max } = this._hoverBounds
      const stdQ = quads.filter(q => q.vertices.length === 4).length
      const triQ = quads.length - stdQ
      // Actual result from detectFaceBounds
      const actualSet = new Set(this._hoverBounds.quadIndices)

      console.group(`[boxTool] voxel(${picked.pos.x},${picked.pos.y},${picked.pos.z})  total:${quads.length} (std:${stdQ} tri:${triQ})`)
      console.log(`quadIndex: ${picked.quadIndex}  normal: (${picked.normal?.x?.toFixed(3)},${picked.normal?.y?.toFixed(3)},${picked.normal?.z?.toFixed(3)})`)
      console.log(`result: [${[...actualSet].sort((a,b)=>a-b).join(', ')}]`)
      console.log(`AABB: (${min.x.toFixed(2)},${min.y.toFixed(2)},${min.z.toFixed(2)}) → (${max.x.toFixed(2)},${max.y.toFixed(2)},${max.z.toFixed(2)})  ${(max.x-min.x).toFixed(3)}×${(max.y-min.y).toFixed(3)}×${(max.z-min.z).toFixed(3)}`)

      const lines = quads.map((q, i) => {
        const n = computeQuadNormal(q)
        const mark = actualSet.has(i) ? ' ✓' : ''
        return `[${i}] v${q.vertices.length} (${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)})${mark}`
      })
      console.log('quads:\n  ' + lines.join('\n  '))
      console.groupEnd()
    }
  }

  onPointerDown(_ctx: ToolContext, event: PointerEvent): void {
    if (!this._hoverBounds || !this._hoverPos) {
      // Click on void → reset
      _boxClearPending()
      return
    }

    const modifier = event.shiftKey ? 'shift'
      : (event.ctrlKey || event.metaKey) ? 'ctrl'
      : 'default'

    _boxAddSelection(
      {
        aabb: { min: this._hoverBounds.min, max: this._hoverBounds.max },
        blockPos: { ...this._hoverPos },
      },
      modifier,
    )

    // Clear hover so the next move re-detects
    this._hoverBounds = null
    this._hoverPos = null
  }

  onPointerUp(_ctx: ToolContext, _event: PointerEvent): void {}

  render(ctx: ToolContext): void {
    this._disposePreviews()

    const color = ctx.activeTool.value?.color ?? '#4488ff'
    const overlay = ctx.viewport.overlayGroup.value
    if (!overlay) return

    // Draw committed selections
    for (const sel of _boxGetPending()) {
      this._addWireframe(overlay, sel.aabb, color, 0.8)
    }

    // Draw hover preview
    if (this._hoverBounds) {
      this._addWireframe(
        overlay,
        { min: this._hoverBounds.min, max: this._hoverBounds.max },
        color,
        0.4,
      )
    }
  }

  private _addWireframe(
    parent: THREE.Group,
    aabb: AABB,
    color: string,
    opacity: number,
  ): void {
    const bars = computeBoxFrameBars(aabb.min, aabb.max, 0.02)
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      depthTest: true,
      transparent: true,
      opacity,
    })
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
      if (m instanceof THREE.Mesh || m instanceof THREE.LineSegments) {
        m.geometry?.dispose()
        ;(m.material as THREE.Material)?.dispose()
      }
    }
    this._previews = []
  }
}
