// web/src/workbench/tools/faceTool.ts
import type { Tool, ToolGizmo, ToolContext } from './tool'
import * as THREE from 'three'

export const faceTool: Tool = {
  id: 'annotation-face',
  label: '选面',
  icon: '◫',
  cursor: 'crosshair',
  operator: 'ANNOTATION_CREATE',
  properties: {
    type: 'face',
    color: '#4dabf7',
    title: '',
    description: '',
    visible: true,
    locked: false,
  },
  keymap: [
    { type: 'KEY', key: 'f', toolId: 'annotation-face', description: '选面工具' },
    { type: 'MOUSE', button: 0, description: '（选面由 Gizmo 处理）' },
  ],
  hints: [
    { keys: ['Click'], action: '选中面' },
  ],
}

export class FaceGizmo implements ToolGizmo {
  private _mesh: THREE.Mesh | null = null
  private _hoverQuad: {
    pos: { x: number; y: number; z: number }
    quadIndex: number
  } | null = null

  activate(_ctx: ToolContext): void {}
  deactivate(): void { this._clearPreview(); this._hoverQuad = null }

  onPointerMove(ctx: ToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked || picked.quadIndex === undefined) {
      this._hoverQuad = null
      return
    }
    this._hoverQuad = { pos: picked.pos, quadIndex: picked.quadIndex }
  }

  onPointerDown(ctx: ToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked || picked.quadIndex === undefined) return

    const draft = {
      ...ctx.activeTool.value?.properties,
      type: 'face' as const,
      blockPos: { ...picked.pos },
      quadIndex: picked.quadIndex,
      frameIndex: ctx.getCurrentFrame()?.index ?? 0,
    }

    ctx.invokeOperator('ANNOTATION_CREATE', { annotation: draft }, event)
  }

  onPointerUp(_ctx: ToolContext, _event: PointerEvent): void {}

  render(ctx: ToolContext): void {
    this._clearPreview()
    if (!this._hoverQuad) return

    const { pos, quadIndex } = this._hoverQuad
    const quads = ctx.getBlockGeometry(pos)
    if (!quads || quadIndex >= quads.length) return

    const quad = quads[quadIndex]
    if (!quad || quad.vertices.length < 4) return

    const center = ctx.gridCenterWorld(pos)
    if (!center) return

    // Compute face normal from edge vectors, ensure outward-facing
    const NUDGE = 0.001
    const v0 = quad.vertices[0], v1 = quad.vertices[1], v2 = quad.vertices[2]
    const ax = v1.x - v0.x, ay = v1.y - v0.y, az = v1.z - v0.z
    const bx = v2.x - v0.x, by = v2.y - v0.y, bz = v2.z - v0.z
    let nx = ay * bz - az * by
    let ny = az * bx - ax * bz
    let nz = ax * by - ay * bx
    let qcx = 0, qcy = 0, qcz = 0
    for (const v of quad.vertices) { qcx += v.x; qcy += v.y; qcz += v.z }
    if (nx * qcx + ny * qcy + nz * qcz < 0) { nx = -nx; ny = -ny; nz = -nz }
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= nLen; ny /= nLen; nz /= nLen

    const verts: number[] = []
    const cx = center.x - 0.5
    const cy = center.y - 0.5
    const cz = center.z - 0.5

    for (const v of quad.vertices) {
      verts.push(
        v.x + cx + nx * NUDGE,
        v.y + cy + ny * NUDGE,
        v.z + cz + nz * NUDGE,
      )
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    // Two triangles from quad: 0-1-2, 0-2-3
    geo.setIndex([0, 1, 2, 0, 2, 3])
    geo.computeVertexNormals()

    const color = ctx.activeTool.value?.color ?? '#4dabf7'
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color as string),
      transparent: true,
      opacity: 0.5,
      depthTest: true,
      side: THREE.DoubleSide,
    })

    this._mesh = new THREE.Mesh(geo, mat)
    this._mesh.raycast = () => {} // Don't self-intercept the pick
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
