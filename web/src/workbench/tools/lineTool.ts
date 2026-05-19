// web/src/workbench/tools/lineTool.ts
import type { Tool, ToolGizmo, ToolContext } from './tool'
import * as THREE from 'three'

export const lineTool: Tool = {
  id: 'annotation-line',
  label: '线段',
  icon: '╱',
  cursor: 'crosshair',
  operator: 'ANNOTATION_CREATE',
  properties: {
    type: 'line',
    color: '#ffaa00',
    thickness: 1.0,
    arrow: 'none',
    showPoints: true,
    title: '',
    description: '',
    visible: true,
    locked: false,
  },
  keymap: [
    { type: 'KEY', key: 'l', toolId: 'annotation-line', description: '线段工具' },
  ],
  keymapFallback: [
    { type: 'MOUSE', button: 0, opId: 'OPERATOR_SELECT', description: '选择（回退）' },
  ],
}

export class LineGizmo implements ToolGizmo {
  private _points: Array<{ x: number; y: number; z: number }> = []
  private _mesh: THREE.Line | null = null

  activate(_ctx: ToolContext): void { this._points = [] }
  deactivate(): void { this._points = []; this._clearPreview() }

  onPointerMove(ctx: ToolContext, event: PointerEvent): void {
    if (this._points.length === 0) return
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    this._renderPreview(ctx, [...this._points, picked.pos])
  }

  onPointerDown(ctx: ToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    this._points.push(picked.pos)

    if (this._points.length >= 2) {
      const draft = {
        ...ctx.activeTool.value?.properties,
        type: 'line' as const,
        points: [...this._points],
        frameIndex: ctx.getCurrentFrame()?.index ?? 0,
      }
      ctx.invokeOperator('ANNOTATION_CREATE', { annotation: draft }, event)
      ctx.setAnnotationDraft(draft as Record<string, unknown>)
      this._points = []
      this._clearPreview()
    }
  }

  onPointerUp(_ctx: ToolContext, _event: PointerEvent): void {}

  render(ctx: ToolContext): void {
    this._clearPreview()
    if (this._points.length === 0) return
    this._renderPreview(ctx, this._points)
  }

  private _renderPreview(ctx: ToolContext, pts: Array<{ x: number; y: number; z: number }>): void {
    this._clearPreview()
    const positions = new Float32Array(pts.length * 3)
    for (let i = 0; i < pts.length; i++) {
      positions[i * 3] = pts[i].x
      positions[i * 3 + 1] = pts[i].y
      positions[i * 3 + 2] = pts[i].z
    }
    if (positions.length < 6) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const color = (ctx.activeTool.value?.properties as any)?.color ?? '#ffaa00'
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(color), depthTest: true })
    this._mesh = new THREE.Line(geo, mat)
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
