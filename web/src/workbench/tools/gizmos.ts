import * as THREE from 'three'
import type { ToolGizmo, ToolContext } from './tool'

const AXIS_COLORS = {
  x: 0xff3333,
  y: 0x33ff33,
  z: 0x3388ff,
} as const

const AXIS_COLORS_HI = {
  x: 0xff8888,
  y: 0x88ff88,
  z: 0x88bbff,
} as const

export const ARROW_LENGTH = 1.2
const ARROW_RADIUS = 0.04
const CONE_RADIUS = 0.10
export const CONE_LENGTH = 0.25
const PLANE_SIZE = 0.3

export type GizmoAxis = 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz'
export type GizmoPart = GizmoAxis | null

interface ArrowMeshes {
  line: THREE.Mesh
  cone: THREE.Mesh
}

interface PlaneMeshes {
  plane: THREE.Mesh
}

function makeArrow(axis: 'x' | 'y' | 'z', color: number): ArrowMeshes {
  const dir = axis === 'x' ? new THREE.Vector3(1, 0, 0)
    : axis === 'y' ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1)

  const cylGeo = new THREE.CylinderGeometry(ARROW_RADIUS, ARROW_RADIUS, ARROW_LENGTH - CONE_LENGTH, 8)
  const cylMat = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false })
  const line = new THREE.Mesh(cylGeo, cylMat)
  line.position.copy(dir.clone().multiplyScalar((ARROW_LENGTH - CONE_LENGTH) / 2))
  if (axis === 'x') line.rotation.z = -Math.PI / 2
  if (axis === 'z') line.rotation.x = Math.PI / 2

  const coneGeo = new THREE.ConeGeometry(CONE_RADIUS, CONE_LENGTH, 8)
  const coneMat = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false })
  const cone = new THREE.Mesh(coneGeo, coneMat)
  cone.position.copy(dir.clone().multiplyScalar(ARROW_LENGTH - CONE_LENGTH / 2))
  if (axis === 'x') cone.rotation.z = -Math.PI / 2
  if (axis === 'z') cone.rotation.x = Math.PI / 2

  return { line, cone }
}

function makePlane(axes: 'xy' | 'xz' | 'yz', color: number): PlaneMeshes {
  const geo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE)
  const mat = new THREE.MeshBasicMaterial({
    color, side: THREE.DoubleSide, depthTest: false,
    depthWrite: false, transparent: true, opacity: 0.3,
  })
  const plane = new THREE.Mesh(geo, mat)

  if (axes === 'xz') {
    plane.rotation.x = -Math.PI / 2
  } else if (axes === 'yz') {
    plane.rotation.y = Math.PI / 2
  }
  plane.position.set(
    axes === 'xy' || axes === 'xz' ? PLANE_SIZE / 2 : 0,
    axes === 'xy' || axes === 'yz' ? PLANE_SIZE / 2 : 0,
    axes === 'xz' || axes === 'yz' ? PLANE_SIZE / 2 : 0,
  )
  return { plane }
}

export class MoveGizmo implements ToolGizmo {
  readonly root: THREE.Group
  private arrows: Record<'x' | 'y' | 'z', ArrowMeshes>
  private planes: Record<'xy' | 'xz' | 'yz', PlaneMeshes>
  private allMeshes: THREE.Mesh[]

  constructor() {
    this.root = new THREE.Group()
    this.root.visible = false

    this.arrows = {
      x: makeArrow('x', AXIS_COLORS.x),
      y: makeArrow('y', AXIS_COLORS.y),
      z: makeArrow('z', AXIS_COLORS.z),
    }
    this.planes = {
      xy: makePlane('xy', AXIS_COLORS.z),
      xz: makePlane('xz', AXIS_COLORS.y),
      yz: makePlane('yz', AXIS_COLORS.x),
    }

    this.allMeshes = []
    for (const a of Object.values(this.arrows)) {
      this.root.add(a.line)
      this.root.add(a.cone)
      this.allMeshes.push(a.line, a.cone)
    }
    for (const p of Object.values(this.planes)) {
      this.root.add(p.plane)
      this.allMeshes.push(p.plane)
    }
    // Render gizmo on top — depth always passes, drawn last among overlay objects
    for (const m of this.allMeshes) {
      m.renderOrder = 999
    }
  }

  setPosition(pos: THREE.Vector3): void {
    this.root.position.copy(pos)
    this.root.updateMatrixWorld(true)
  }

  setVisible(v: boolean): void {
    this.root.visible = v
  }

  hitTest(raycaster: THREE.Raycaster): GizmoPart {
    // 1. Exact geometry intersection
    const hits = raycaster.intersectObjects(this.allMeshes, false)
    if (hits.length > 0) {
      const obj = hits[0].object
      for (const [axis, arrow] of Object.entries(this.arrows)) {
        if (obj === arrow.line || obj === arrow.cone) return axis as GizmoAxis
      }
      for (const [plane, p] of Object.entries(this.planes)) {
        if (obj === p.plane) return plane as GizmoAxis
      }
      return null
    }

    // 2. Edge tolerance: ray 在 part 中心附近就算命中
    const TOLERANCE = 0.4
    const wp = new THREE.Vector3()

    for (const [axis, arrow] of Object.entries(this.arrows)) {
      arrow.line.getWorldPosition(wp)
      if (raycaster.ray.distanceToPoint(wp) < TOLERANCE) return axis as GizmoAxis
      arrow.cone.getWorldPosition(wp)
      if (raycaster.ray.distanceToPoint(wp) < TOLERANCE) return axis as GizmoAxis
    }
    for (const [plane, p] of Object.entries(this.planes)) {
      p.plane.getWorldPosition(wp)
      if (raycaster.ray.distanceToPoint(wp) < TOLERANCE) return plane as GizmoAxis
    }

    return null
  }

  setHighlight(part: GizmoPart): void {
    for (const [axis, arrow] of Object.entries(this.arrows)) {
      const active = axis === part
      const c = active
        ? AXIS_COLORS_HI[axis as keyof typeof AXIS_COLORS_HI]
        : AXIS_COLORS[axis as keyof typeof AXIS_COLORS]
      ;(arrow.line.material as THREE.MeshBasicMaterial).color.set(c)
      ;(arrow.cone.material as THREE.MeshBasicMaterial).color.set(c)
    }
    for (const [plane, p] of Object.entries(this.planes)) {
      const active = plane === part
      const mat = p.plane.material as THREE.MeshBasicMaterial
      mat.opacity = active ? 0.6 : 0.3
    }
  }

  computeAxisDelta(
    axis: GizmoAxis,
    origin: THREE.Vector3,
    dragRay: THREE.Raycaster,
  ): number {
    // Only single-character axes (x/y/z) produce a delta; plane handles return 0
    if (!axis || axis.length > 1) return 0
    const singleAxis = axis as 'x' | 'y' | 'z'
    const dirs = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
    }
    const dir = dirs[singleAxis]
    const rayOrigin = dragRay.ray.origin.clone()
    const rayDir = dragRay.ray.direction.clone()
    const w = rayOrigin.clone().sub(origin)
    const dDotD = rayDir.dot(rayDir)
    const wDotD = w.dot(rayDir)
    const t = -wDotD / dDotD
    const closestOnRay = rayOrigin.clone().addScaledVector(rayDir, t)
    const deltaVec = closestOnRay.clone().sub(origin)
    return Math.round(deltaVec.dot(dir))
  }

  dispose(): void {
    for (const m of this.allMeshes) {
      m.geometry?.dispose()
      ;(m.material as THREE.Material)?.dispose()
    }
  }

  activate(_ctx: ToolContext): void {
    void _ctx
    this.setVisible(false)
  }

  deactivate(): void {
    this.setVisible(false)
  }

  render(ctx: ToolContext): void {
    const items = ctx.selection.items.value
    const tool = ctx.activeTool.value
    const showGizmo = tool?.id === 'move' && items.size > 0
    this.setVisible(showGizmo)

    // 模态拖拽期间跳过定位，由 OPERATOR_MOVE.modal() 控制 gizmo 位置
    if (showGizmo && ctx.modalDepth('r-viewport') === 0) {
      let cx = 0, cy = 0, cz = 0
      let valid = 0
      for (const item of items) {
        if (item.kind !== 'block') continue
        const w = ctx.gridCenterWorld(item.ref.pos)
        if (w) { cx += w.x; cy += w.y; cz += w.z; valid++ }
      }
      if (valid > 0) {
        cx /= valid; cy /= valid; cz /= valid
        this.setPosition(new THREE.Vector3(cx, cy, cz))
      }
    }
  }

  onPointerMove(ctx: ToolContext, event: PointerEvent): void {
    const camera = ctx.viewport.camera.value
    const domEl = ctx.viewport.domElement.value
    if (!camera || !domEl) return
    const rect = domEl.getBoundingClientRect()
    if (!rect) return
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera)
    const hit = this.hitTest(raycaster)
    this.setHighlight(hit)
  }

  onPointerDown(ctx: ToolContext, event: PointerEvent): void {
    const camera = ctx.viewport.camera.value
    const domEl = ctx.viewport.domElement.value
    if (!camera || !domEl) return
    const rect = domEl.getBoundingClientRect()
    if (!rect) return
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera)
    const hit = this.hitTest(raycaster)
    if (!hit) return

    function project(origin: THREE.Vector3, dir: THREE.Vector3) {
      const p1 = origin.clone().project(camera!)
      const p2 = origin.clone().add(dir).project(camera!)
      const sx = ((p2.x - p1.x) / 2) * rect.width
      const sy = -((p2.y - p1.y) / 2) * rect.height
      const screenLen = Math.sqrt(sx * sx + sy * sy)
      return {
        screenDirX: screenLen > 0.001 ? sx / screenLen : 0,
        screenDirY: screenLen > 0.001 ? sy / screenLen : 0,
        k: screenLen > 0.001 ? 1 / screenLen : 0,
      }
    }

    const gPos = this.root.position
    const AXES: Record<string, THREE.Vector3> = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
    }

    if (hit.length === 1) {
      // Single axis
      const axisDir = AXES[hit]
      const proj = project(gPos, axisDir)
      ctx.invokeOperator('OPERATOR_MOVE', {
        gizmoAxis: hit,
        gizmo: this,
        screenDirX: proj.screenDirX,
        screenDirY: proj.screenDirY,
        k: proj.k,
      }, event)
    } else {
      // Plane drag (xy, xz, yz)
      const a1 = AXES[hit[0]]
      const a2 = AXES[hit[1]]
      const proj1 = project(gPos, a1)
      const proj2 = project(gPos, a2)
      ctx.invokeOperator('OPERATOR_MOVE', {
        gizmoAxis: hit,
        gizmo: this,
        screenDirX1: proj1.screenDirX, screenDirY1: proj1.screenDirY, k1: proj1.k,
        screenDirX2: proj2.screenDirX, screenDirY2: proj2.screenDirY, k2: proj2.k,
      }, event)
    }
  }

  onPointerUp(_ctx: ToolContext, _event: PointerEvent): void {
    void _ctx; void _event
    // Modal completion handled by operator internally
  }
}
