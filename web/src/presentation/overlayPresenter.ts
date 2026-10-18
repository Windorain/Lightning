import * as THREE from 'three'
import { computeBoxFrameBars } from '@/pure/aabb'
import {
  ANNOTATION_OVERLAY_RENDER_ORDER,
  type AnnotationCompiled,
  type AnnotationPrimitive,
} from './annotationPlan'
import type { OutlinePlan, OutlinePrimitive, OutlineQuad } from './outlinePlan'

export interface OverlayUnrendered {
  readonly objectId: string
  readonly aspect: string
  readonly detail: string
}

export interface OverlayApplyOutcome {
  readonly drawn: number
  readonly unrendered: readonly OverlayUnrendered[]
}

export interface OverlayStats {
  applies: number
  annotationObjects: number
  outlineObjects: number
  disposals: number
}

export interface FaceQuadPort {
  faceQuadsOf(blockPos: readonly [number, number, number]): readonly OutlineQuad[] | undefined
  cellCenterOf(blockPos: readonly [number, number, number]): readonly [number, number, number] | undefined
}

export interface OverlayPresenterOptions {
  readonly scope: string
  readonly faceQuads?: FaceQuadPort
}

export interface OutlineStyle {
  readonly color: number
  readonly opacity: number
}

export const DEFAULT_OUTLINE_STYLE: OutlineStyle = Object.freeze({ color: 0xffffff, opacity: 0.9 })

const OVERLAY_DEPTH = { depthTest: false, depthWrite: false } as const

function vec(t: readonly [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(t[0], t[1], t[2])
}

export class OverlayPresenter {
  private readonly group = new THREE.Group()
  private readonly annotationWorld = new THREE.Group()
  private readonly annotationOverlay = new THREE.Group()
  private readonly outlineGroup = new THREE.Group()
  private readonly stats: OverlayStats = {
    applies: 0,
    annotationObjects: 0,
    outlineObjects: 0,
    disposals: 0,
  }

  constructor(private readonly options: OverlayPresenterOptions) {
    this.group.name = `presentation-overlay:${options.scope}`
    this.annotationWorld.name = `annotations-world:${options.scope}`
    this.annotationOverlay.name = `annotations-overlay:${options.scope}`
    this.outlineGroup.name = `outline:${options.scope}`
    this.group.add(this.annotationWorld, this.annotationOverlay, this.outlineGroup)
  }

  get object3d(): THREE.Group {
    return this.group
  }

  statsSnapshot(): OverlayStats {
    return {
      ...this.stats,
      annotationObjects: this.annotationWorld.children.length + this.annotationOverlay.children.length,
      outlineObjects: this.outlineGroup.children.length,
    }
  }

  clearAnnotations(): void {
    this.clearGroup(this.annotationWorld)
    this.clearGroup(this.annotationOverlay)
  }

  clearOutline(): void {
    this.clearGroup(this.outlineGroup)
  }

  applyAnnotations(compiled: AnnotationCompiled): OverlayApplyOutcome {
    this.stats.applies += 1
    this.clearAnnotations()
    const unrendered = compiled.skipped.map((s) => ({
      objectId: s.objectId,
      aspect: `skipped:${s.reason}`,
      detail: s.detail,
    }))
    let drawn = 0
    for (const p of compiled.primitives) {
      if (this.buildAnnotation(p, unrendered) > 0) drawn += 1
    }
    return { drawn, unrendered }
  }

  applyOutline(plan: OutlinePlan, style: OutlineStyle = DEFAULT_OUTLINE_STYLE): OverlayApplyOutcome {
    this.stats.applies += 1
    this.clearOutline()
    const unrendered: OverlayUnrendered[] = []
    let drawn = 0
    for (const p of plan.primitives) {
      if (this.buildOutline(p, style, unrendered)) drawn += 1
    }
    return { drawn, unrendered }
  }

  /**
   * **WebGL 上下文丢失**：放弃注解/描边的全部 GPU 对象（旧代次句柄不复用）。
   *
   * 与 `dispose()` 的差别只在**是否逐对象 dispose**：设备丢失后 `gl.delete*` 已无意义
   * （句柄属于失效的上下文），逐条 dispose 只会产生错误日志。语义与
   * `BatchedPresenter#handleContextLost` 的 `abandonAll` 同口径：
   * **放弃**≠**正常回收**。恢复后由 `PresenterSession#handleContextRestored`
   * 用上次编译产物重画（A30「恢复后按当前有效版本重建」）。
   */
  handleContextLost(): void {
    this.abandonGroup(this.annotationWorld)
    this.abandonGroup(this.annotationOverlay)
    this.abandonGroup(this.outlineGroup)
  }

  dispose(): void {
    this.clearAnnotations()
    this.clearOutline()
    this.group.clear()
  }

  /** 只摘除子对象、**不** dispose（设备丢失：旧上下文里的句柄已不可用）。 */
  private abandonGroup(group: THREE.Group): void {
    for (const child of [...group.children]) group.remove(child)
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child)
      this.disposeTree(child)
    }
  }

  private disposeTree(node: THREE.Object3D): void {
    node.traverse((child) => {
      const mesh = child as THREE.Mesh
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined
      geometry?.dispose?.()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) for (const m of material) m.dispose()
      else material?.dispose?.()
      this.stats.disposals += 1
    })
  }

  private buildAnnotation(p: AnnotationPrimitive, unrendered: OverlayUnrendered[]): number {
    const bucket = p.overlay ? this.annotationOverlay : this.annotationWorld
    switch (p.kind) {
      case 'box': {
        this.buildBox(bucket, p)
        return 1
      }
      case 'point': {
        bucket.add(this.buildPoint(p))
        return 1
      }
      case 'line': {
        const objects = this.buildLine(p, unrendered)
        for (const o of objects) bucket.add(o)
        return objects.length > 0 ? 1 : 0
      }
      case 'text': {
        const sprite = buildTextSprite(p)
        if (sprite === null) {
          unrendered.push({
            objectId: p.objectId,
            aspect: 'text:no-canvas',
            detail: '当前环境没有 canvas 2d（非浏览器）⇒ 文字注解不画，不冒充',
          })
          return 0
        }
        bucket.add(sprite)
        return 1
      }
      case 'face': {
        const mesh = this.buildFace(p, unrendered)
        if (mesh === null) return 0
        bucket.add(mesh)
        return 1
      }
    }
  }

  private buildBox(bucket: THREE.Group, p: Extract<AnnotationPrimitive, { kind: 'box' }>): void {
    const color = new THREE.Color(p.color)
    const depth = p.overlay ? OVERLAY_DEPTH : { depthTest: true }
    const renderOrder = p.overlay ? ANNOTATION_OVERLAY_RENDER_ORDER : 0
    const min = vec(p.min)
    const max = vec(p.max)

    if (p.renderStyle === 'boxFrame') {
      this.addBars(bucket, p.objectId, min, max, p.frameThickness / 2, {
        color,
        opacity: p.opacity,
        transparent: true,
        ...depth,
        renderOrder,
        name: 'frame',
      })
      if (p.fillOpacity > 0) {
        this.addFill(bucket, p.objectId, min, max, { color, opacity: p.fillOpacity, ...depth, renderOrder })
      }
      return
    }

    this.addBars(bucket, p.objectId, min, max, p.wireframeThickness, {
      color,
      opacity: p.opacity,
      transparent: true,
      ...depth,
      renderOrder,
      name: 'wireframe',
    })
    if (p.renderStyle === 'translucent') {
      this.addFill(bucket, p.objectId, min, max, { color, opacity: p.fillOpacity, ...depth, renderOrder })
    }
  }

  private addBars(
    bucket: THREE.Group,
    objectId: string,
    min: THREE.Vector3,
    max: THREE.Vector3,
    halfThickness: number,
    opts: {
      color: THREE.Color
      opacity: number
      transparent: boolean
      depthTest: boolean
      depthWrite?: boolean
      renderOrder: number
      name: string
    },
  ): void {
    const material = new THREE.MeshBasicMaterial({
      color: opts.color,
      opacity: opts.opacity,
      transparent: opts.transparent,
      depthTest: opts.depthTest,
      ...(opts.depthWrite === undefined ? {} : { depthWrite: opts.depthWrite }),
    })
    const bars = computeBoxFrameBars(
      { x: min.x, y: min.y, z: min.z },
      { x: max.x, y: max.y, z: max.z },
      halfThickness,
    )
    bars.forEach((d, i) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(d.sx, d.sy, d.sz), material)
      bar.position.set(d.cx, d.cy, d.cz)
      bar.name = `anno-box-${opts.name}-${objectId}-${i}`
      bar.renderOrder = opts.renderOrder
      bar.userData.objectId = objectId
      bucket.add(bar)
    })
  }

  private addFill(
    bucket: THREE.Group,
    objectId: string,
    min: THREE.Vector3,
    max: THREE.Vector3,
    opts: { color: THREE.Color; opacity: number; depthTest: boolean; depthWrite?: boolean; renderOrder: number },
  ): void {
    const geometry = new THREE.BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z)
    geometry.translate((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2)
    const fill = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: opts.color,
        transparent: true,
        opacity: opts.opacity,
        depthTest: opts.depthTest,
        ...(opts.depthWrite === undefined ? {} : { depthWrite: opts.depthWrite }),
      }),
    )
    fill.name = `anno-box-fill-${objectId}`
    fill.renderOrder = opts.renderOrder
    fill.userData.objectId = objectId
    bucket.add(fill)
  }

  private buildPoint(p: Extract<AnnotationPrimitive, { kind: 'point' }>): THREE.Mesh {
    const geometry = pointGeometry(p.icon, p.size)
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(p.color),
        transparent: true,
        opacity: p.opacity,
        ...OVERLAY_DEPTH,
      }),
    )
    mesh.position.copy(vec(p.pos))
    mesh.name = `anno-point-${p.objectId}`
    mesh.renderOrder = ANNOTATION_OVERLAY_RENDER_ORDER
    mesh.userData.objectId = p.objectId
    return mesh
  }

  private buildLine(p: Extract<AnnotationPrimitive, { kind: 'line' }>, unrendered: OverlayUnrendered[]): THREE.Object3D[] {
    if (p.points.length < 2) {
      unrendered.push({ objectId: p.objectId, aspect: 'line:points', detail: '少于 2 个点，构不成线段' })
      return []
    }
    const objects: THREE.Object3D[] = []
    const color = new THREE.Color(p.color)
    const depth = p.overlay ? OVERLAY_DEPTH : { depthTest: true }
    const renderOrder = p.overlay ? ANNOTATION_OVERLAY_RENDER_ORDER : 0
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: p.opacity,
      ...depth,
    })
    const first = vec(p.points[0]!)
    const last = vec(p.points[p.points.length - 1]!)
    if (p.thickness > 0) {
      for (let i = 0; i + 1 < p.points.length; i++) {
        const a = vec(p.points[i]!)
        const b = vec(p.points[i + 1]!)
        if (a.distanceTo(b) === 0) continue
        objects.push(segmentMesh(a, b, p.thickness, material, objectId(p, i), renderOrder))
      }
    } else {
      const positions = new Float32Array(p.points.length * 3)
      p.points.forEach((pt, i) => positions.set([pt[0], pt[1], pt[2]], i * 3))
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: p.opacity }))
      line.name = `anno-line-${p.objectId}`
      line.renderOrder = renderOrder
      objects.push(line)
    }
    if (p.arrow !== 'none') {
      const heads: Array<[THREE.Vector3, THREE.Vector3]> = []
      if (p.arrow === 'end' || p.arrow === 'both') heads.push([last, first])
      if (p.arrow === 'start' || p.arrow === 'both') heads.push([first, last])
      for (const [tip, from] of heads) {
        objects.push(
          coneMesh(tip, from, Math.max(p.thickness, 0.05) * 3, material, `anno-line-arrow-${p.objectId}`, renderOrder),
        )
      }
    }
    if (p.showPoints) {
      for (let i = 0; i < p.points.length; i++) {
        objects.push(this.buildPoint({
          kind: 'point',
          objectId: `${p.objectId}#v${i}`,
          pos: p.points[i]!,
          icon: 'circle',
          size: Math.max(p.thickness, 0.05) * 3,
          color: p.color,
          opacity: p.opacity,
          overlay: p.overlay,
        }))
      }
    }
    return objects
  }

  private buildFace(
    p: Extract<AnnotationPrimitive, { kind: 'face' }>,
    unrendered: OverlayUnrendered[],
  ): THREE.Mesh | null {
    const port = this.options.faceQuads
    if (port === undefined) {
      unrendered.push({
        objectId: p.objectId,
        aspect: 'face:no-quad-port',
        detail: '面标注需要几何端口（blockPos+quadIndex → 烘焙四边形）；端口缺席时不画',
      })
      return null
    }
    const quads = port.faceQuadsOf(p.blockPos)
    if (quads === undefined) {
      unrendered.push({ objectId: p.objectId, aspect: 'face:missing-geometry', detail: '该格查不到烘焙四边形' })
      return null
    }
    const quad = quads[p.quadIndex]
    if (quad === undefined) {
      unrendered.push({
        objectId: p.objectId,
        aspect: 'face:quad-index',
        detail: `quadIndex ${p.quadIndex} 超出该格四边形数 ${quads.length}`,
      })
      return null
    }
    const center = port.cellCenterOf(p.blockPos)
    if (center === undefined) {
      unrendered.push({ objectId: p.objectId, aspect: 'face:missing-cell', detail: '该格不在当前网格里' })
      return null
    }
    const origin = new THREE.Vector3(center[0] - 0.5, center[1] - 0.5, center[2] - 0.5)
    const geometry = quadGeometry([quad], origin, true)
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(p.color),
        transparent: true,
        opacity: p.opacity,
        side: THREE.DoubleSide,
        depthTest: true,
      }),
    )
    mesh.name = `anno-face-${p.objectId}`
    mesh.userData.objectId = p.objectId
    return mesh
  }

  private buildOutline(
    p: OutlinePrimitive,
    style: OutlineStyle,
    unrendered: OverlayUnrendered[],
  ): boolean {
    const material = new THREE.MeshBasicMaterial({
      color: style.color,
      transparent: true,
      opacity: style.opacity,
      ...OVERLAY_DEPTH,
    })
    const lineMaterial = new THREE.LineBasicMaterial({
      color: style.color,
      transparent: true,
      opacity: style.opacity,
      ...OVERLAY_DEPTH,
    })
    switch (p.kind) {
      case 'objectBounds':
      case 'partBoxes':
      case 'cellBox': {
        const boxes: ReadonlyArray<readonly [readonly [number, number, number], readonly [number, number, number]]> =
          p.kind === 'objectBounds'
            ? [[p.min, p.max]]
            : p.kind === 'partBoxes'
              ? p.boxes.map((b) => [b.min, b.max] as const)
              : [[p.origin, [p.origin[0] + 1, p.origin[1] + 1, p.origin[2] + 1]] as const]
        if (boxes.length === 0) {
          unrendered.push({ objectId: p.objectId, aspect: 'outline:empty', detail: '没有盒可画' })
          return false
        }
        const group = new THREE.Group()
        group.name = `outline-${p.kind}-${p.objectId}`
        for (const [min, max] of boxes) {
          group.add(boxWireframe(vec(min), vec(max), material, p.objectId))
        }
        this.outlineGroup.add(group)
        return true
      }
      case 'element': {
        if (p.points.length === 0) {
          unrendered.push({ objectId: p.objectId, aspect: 'outline:empty', detail: '元素点集为空' })
          return false
        }
        const positions = new Float32Array(p.points.length * 3)
        p.points.forEach((pt, i) => positions.set([pt[0], pt[1], pt[2]], i * 3))
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        const points = new THREE.Points(geometry, lineMaterial)
        points.name = `outline-element-${p.objectId}-${p.elementId}`
        this.outlineGroup.add(points)
        return true
      }
      case 'cellQuads': {
        const mesh = new THREE.Mesh(quadGeometry(p.quads, vec(p.origin), false), material)
        mesh.name = `outline-cell-${p.objectId}`
        this.outlineGroup.add(mesh)
        return true
      }
    }
  }
}

function pointGeometry(icon: string, size: number): THREE.BufferGeometry {
  const r = size * 0.1
  switch (icon) {
    case 'square':
      return new THREE.BoxGeometry(r * 2, r * 2, r * 2)
    case 'diamond':
      return new THREE.OctahedronGeometry(r * 1.4)
    case 'cross':
      return new THREE.BoxGeometry(r * 3, r * 0.8, r * 0.8)
    default:
      return new THREE.SphereGeometry(r, 8, 8)
  }
}

function objectId(p: { objectId: string }, i: number): string {
  return `${p.objectId}#s${i}`
}

function segmentMesh(
  a: THREE.Vector3,
  b: THREE.Vector3,
  thickness: number,
  material: THREE.Material,
  name: string,
  renderOrder: number,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a)
  const length = dir.length()
  const geometry = new THREE.CylinderGeometry(thickness / 2, thickness / 2, length, 6)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.copy(a).addScaledVector(dir, 0.5)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
  mesh.name = `anno-line-${name}`
  mesh.renderOrder = renderOrder
  mesh.userData.objectId = name.split('#')[0]
  return mesh
}

function coneMesh(
  tip: THREE.Vector3,
  from: THREE.Vector3,
  size: number,
  material: THREE.Material,
  name: string,
  renderOrder: number,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(tip, from).normalize()
  const geometry = new THREE.ConeGeometry(size / 2, size, 8)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.copy(tip)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  mesh.name = name
  mesh.renderOrder = renderOrder
  return mesh
}

function boxWireframe(
  min: THREE.Vector3,
  max: THREE.Vector3,
  material: THREE.Material,
  id: string,
): THREE.LineSegments {
  const sx = max.x - min.x
  const sy = max.y - min.y
  const sz = max.z - min.z
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz))
  const lines = new THREE.LineSegments(edges, material)
  lines.position.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2)
  lines.name = `outline-box-${id}`
  return lines
}

const QUAD_NUDGE = 0.001

function quadGeometry(quads: readonly OutlineQuad[], origin: THREE.Vector3, nudge: boolean): THREE.BufferGeometry {
  const positions: number[] = []
  for (const quad of quads) {
    const vs = quad.vertices
    if (vs.length < 3) continue
    const dx = vs[1]!.x - vs[0]!.x
    const dy = vs[1]!.y - vs[0]!.y
    const dz = vs[1]!.z - vs[0]!.z
    const ex = vs[2]!.x - vs[0]!.x
    const ey = vs[2]!.y - vs[0]!.y
    const ez = vs[2]!.z - vs[0]!.z
    let nx = dy * ez - dz * ey
    let ny = dz * ex - dx * ez
    let nz = dx * ey - dy * ex
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= len
    ny /= len
    nz /= len
    const cx = origin.x + 0.5
    const cy = origin.y + 0.5
    const cz = origin.z + 0.5
    if (nx * (vs[0]!.x - cx) + ny * (vs[0]!.y - cy) + nz * (vs[0]!.z - cz) < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }
    const off = nudge ? QUAD_NUDGE : 0
    const at = (i: number): [number, number, number] => [
      vs[i]!.x + origin.x + nx * off,
      vs[i]!.y + origin.y + ny * off,
      vs[i]!.z + origin.z + nz * off,
    ]
    const p0 = at(0)
    for (let i = 1; i + 1 < vs.length; i++) {
      const p1 = at(i)
      const p2 = at(i + 1)
      positions.push(...p0, ...p1, ...p2)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

interface TextSpriteInput {
  readonly objectId: string
  readonly anchor: readonly [number, number, number]
  readonly text: string
  readonly fontSize: number
  readonly backgroundAlpha: number
  readonly color: string
  readonly opacity: number
}

function buildTextSprite(p: TextSpriteInput): THREE.Sprite | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx2d = canvas.getContext('2d')
  if (ctx2d === null) return null
  ctx2d.fillStyle = `rgba(0,0,0,${p.backgroundAlpha})`
  ctx2d.fillRect(0, 0, canvas.width, canvas.height)
  ctx2d.fillStyle = p.color
  ctx2d.font = `${p.fontSize}px monospace`
  ctx2d.fillText(p.text, 8, canvas.height / 2 + p.fontSize / 2)
  const texture = new THREE.CanvasTexture(canvas)
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: p.opacity,
      ...OVERLAY_DEPTH,
    }),
  )
  sprite.position.copy(vec(p.anchor))
  sprite.scale.set(2, 0.5, 1)
  sprite.name = `anno-text-${p.objectId}`
  sprite.renderOrder = ANNOTATION_OVERLAY_RENDER_ORDER
  sprite.userData.objectId = p.objectId
  return sprite
}