// web/src/workbench/tools/pointTool.ts
import type { Tool, ToolGizmo, ToolContext } from './tool'
import * as THREE from 'three'

export const pointTool: Tool = {
  id: 'annotation-point',
  label: '标记点',
  icon: '◆',
  cursor: 'crosshair',
  operator: 'ANNOTATION_CREATE',
  properties: {
    type: 'point',
    color: '#ffaa00',
    icon: 'diamond',
    size: 1.0,
    title: '',
    description: '',
    visible: true,
    locked: false,
  },
  keymap: [
    { type: 'KEY', key: 'p', toolId: 'annotation-point', description: '标记点工具' },
    { type: 'MOUSE', button: 0, description: '（标记点放置由 Gizmo 处理）' },
  ],
  hints: [
    { keys: ['Click'], action: '放置标记点' },
  ],
}

export class PointGizmo implements ToolGizmo {
  private _mesh: THREE.Mesh | null = null
  private _hoverPos: { x: number; y: number; z: number } | null = null

  activate(_ctx: ToolContext): void {}
  deactivate(): void { this._clearPreview(); this._hoverPos = null }

  onPointerMove(ctx: ToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) { this._hoverPos = null; return }
    this._hoverPos = ctx.gridCenterWorld(picked.pos) ?? null
  }

  onPointerDown(ctx: ToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    const worldPos = ctx.gridCenterWorld(picked.pos)
    if (!worldPos) return

    const draft = {
      ...ctx.activeTool.value?.properties,
      type: 'point' as const,
      pos: { ...worldPos },
      frameIndex: ctx.getCurrentFrame()?.index ?? 0,
    }

    ctx.invokeOperator('ANNOTATION_CREATE', { annotation: draft }, event)
  }

  onPointerUp(_ctx: ToolContext, _event: PointerEvent): void {}

  render(ctx: ToolContext): void {
    this._clearPreview()
    if (!this._hoverPos) return

    const color = ctx.activeTool.value?.color ?? '#ffaa00'
    const geo = new THREE.SphereGeometry(0.15, 8, 8)
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      depthTest: true,
    })
    this._mesh = new THREE.Mesh(geo, mat)
    this._mesh.position.set(this._hoverPos.x, this._hoverPos.y, this._hoverPos.z)
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
