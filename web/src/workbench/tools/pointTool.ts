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
  ],
  keymapFallback: [
    { type: 'MOUSE', button: 0, opId: 'OPERATOR_SELECT', description: '选择（回退）' },
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
    const def = ctx.viewport.definition.value
    if (!def) return
    // Convert voxel to world position (cell center)
    const sCol = def.cellGrid[0]?.[0]?.length ?? 1
    const sRow = def.cellGrid[0]?.length ?? 1
    const sZ = def.cellGrid.length ?? 1
    this._hoverPos = {
      x: picked.pos.x - sCol / 2 + 0.5,
      y: picked.pos.y - sRow / 2 + 0.5,
      z: picked.pos.z - sZ / 2 + 0.5,
    }
  }

  onPointerDown(ctx: ToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    const def = ctx.viewport.definition.value
    if (!def) return
    const sCol = def.cellGrid[0]?.[0]?.length ?? 1
    const sRow = def.cellGrid[0]?.length ?? 1
    const sZ = def.cellGrid.length ?? 1

    const draft = {
      ...ctx.activeTool.value?.properties,
      type: 'point' as const,
      pos: {
        x: picked.pos.x - sCol / 2 + 0.5,
        y: picked.pos.y - sRow / 2 + 0.5,
        z: picked.pos.z - sZ / 2 + 0.5,
      },
      frameIndex: ctx.getCurrentFrame()?.index ?? 0,
    }

    ctx.invokeOperator('ANNOTATION_CREATE', { annotation: draft }, event)
    ctx.setAnnotationDraft(draft as Record<string, unknown>)
  }

  onPointerUp(_ctx: ToolContext, _event: PointerEvent): void {}

  render(ctx: ToolContext): void {
    this._clearPreview()
    if (!this._hoverPos) return

    const color = (ctx.activeTool.value?.properties as any)?.color ?? '#ffaa00'
    const geo = new THREE.SphereGeometry(0.15, 8, 8)
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      depthTest: false,
      depthWrite: false,
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
