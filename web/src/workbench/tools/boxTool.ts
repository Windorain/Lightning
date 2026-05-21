// web/src/workbench/tools/boxTool.ts
import type { Tool, ToolGizmo, ToolContext } from './tool'
import type { PartBounds } from './partDetect'
import { detectPartBounds } from './partDetect'
import * as THREE from 'three'

// ── Tool data ──
export const boxTool: Tool = {
  id: 'annotation-box',
  label: '注解框',
  icon: '▢',
  cursor: 'crosshair',
  operator: 'ANNOTATION_CREATE',
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
    { type: 'MOUSE', button: 0, description: '（注解放置由 Gizmo 处理）' },
  ],
}

// ── Gizmo ──
export class BoxGizmo implements ToolGizmo {
  private _mesh: THREE.LineSegments | null = null
  private _hoverBounds: PartBounds | null = null

  activate(_ctx: ToolContext): void {}
  deactivate(): void { this._clearPreview(); this._hoverBounds = null }

  onPointerMove(ctx: ToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) { this._hoverBounds = null; return }

    const def = ctx.viewport.definition.value
    if (!def) return

    const bounds = detectPartBounds(def, picked.pos.x, picked.pos.y, picked.pos.z, null)
    this._hoverBounds = bounds
  }

  onPointerDown(ctx: ToolContext, event: PointerEvent): void {
    if (!this._hoverBounds) return

    const draft = {
      ...ctx.activeTool.value?.properties,
      type: 'box' as const,
      min: { ...this._hoverBounds.min },
      max: { ...this._hoverBounds.max },
      frameIndex: ctx.getCurrentFrame()?.index ?? 0,
    }

    ctx.invokeOperator('ANNOTATION_CREATE', { annotation: draft }, event)
  }

  onPointerUp(_ctx: ToolContext, _event: PointerEvent): void {}

  render(ctx: ToolContext): void {
    this._clearPreview()
    if (!this._hoverBounds) return

    const { min, max } = this._hoverBounds
    const color = ctx.activeTool.value?.color ?? '#4488ff'
    const verts = boxWireframeVerts(min, max)

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(color),
      depthTest: true,
      transparent: true,
      opacity: 0.6,
    })
    this._mesh = new THREE.LineSegments(geo, mat)
    ctx.viewport.overlayGroup.value?.add(this._mesh)
  }

  private _clearPreview(): void {
    if (this._mesh) {
      this._mesh.parent?.remove(this._mesh)
      this._mesh.geometry?.dispose()
      ;(this._mesh.material as THREE.Material)?.dispose()
      this._mesh = null
    }
  }
}

function boxWireframeVerts(
  min: { x: number; y: number; z: number },
  max: { x: number; y: number; z: number },
): number[] {
  const x1 = min.x, y1 = min.y, z1 = min.z
  const x2 = max.x, y2 = max.y, z2 = max.z
  return [
    x1,y1,z1, x2,y1,z1, x2,y1,z1, x2,y2,z1, x2,y2,z1, x1,y2,z1, x1,y2,z1, x1,y1,z1,
    x1,y1,z2, x2,y1,z2, x2,y1,z2, x2,y2,z2, x2,y2,z2, x1,y2,z2, x1,y2,z2, x1,y1,z2,
    x1,y1,z1, x1,y1,z2, x2,y1,z1, x2,y1,z2, x2,y2,z1, x2,y2,z2, x1,y2,z1, x1,y2,z2,
  ]
}
