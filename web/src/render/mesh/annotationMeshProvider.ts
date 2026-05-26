// web/src/render/mesh/annotationMeshProvider.ts
import * as THREE from 'three'
import type { MeshProvider, MeshOutput } from './providerTypes'
import type { StructureDefinition } from '../schema/types'
import type { MaterialLibraryApi } from '../materials/simpleMaterialLibrary'
import type { Annotation, BoxAnnotation, PointAnnotation, LineAnnotation, TextAnnotation, FaceAnnotation } from '../data/annotationTypes'
import { isBox, isPoint, isLine, isText, isFace } from '../data/annotationTypes'
import { computeBoxFrameBars } from '../data/aabb'
import type { BakedQuadsGeometry, BakedQuad } from '../schema/types'
import { decodeBakedGeometry } from './bakedGeometryDecode'

export class AnnotationMeshProvider implements MeshProvider {
  priority = 50
  target = 'overlay' as const

  private _annotations: Annotation[] = []

  setAnnotations(annotations: Annotation[]): void {
    this._annotations = annotations.filter(a => a.visible !== false)
  }

  async build(
    _def: StructureDefinition,
    _lib: MaterialLibraryApi,
    _opts?: Record<string, unknown>,
  ): Promise<MeshOutput[]> {
    const group = new THREE.Group()
    group.name = 'annotations'

    for (const anno of this._annotations) {
      if (isBox(anno)) this._buildBox(group, anno)
      else if (isPoint(anno)) this._buildPoint(group, anno)
      else if (isLine(anno)) this._buildLine(group, anno)
      else if (isText(anno)) this._buildText(group, anno)
      else if (isFace(anno)) this._buildFace(group, anno, _def)
    }

    return [{
      kind: 'object3d',
      object: group,
      dispose: () => {
        group.traverse((c) => {
          if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
            c.geometry?.dispose()
            ;(c.material as THREE.Material)?.dispose()
          }
        })
      },
    }]
  }

  private _buildBox(group: THREE.Group, a: BoxAnnotation): void {
    if (a.renderStyle === 'hidden') return

    const color = new THREE.Color(a.color)
    const overlay = a.overlay ?? false
    const matDepth = overlay ? { depthTest: false, depthWrite: false } : { depthTest: true }
    const objOrder = overlay ? { renderOrder: 999 } : {}

    if (a.renderStyle === 'wireframe') {
      this._buildWireframeBars(group, a, color, 0.02, a.renderOpacity, matDepth, objOrder)
    }

    if (a.renderStyle === 'boxFrame') {
      this._buildBoxFrame(group, a, color, matDepth, objOrder)
      if ((a.fillOpacity ?? 0) > 0) {
        this._buildBoxFill(group, a, color, a.fillOpacity, matDepth, objOrder)
      }
    }

    if (a.renderStyle === 'translucent') {
      this._buildWireframeBars(group, a, color, 0.02, a.renderOpacity, matDepth, objOrder)
      this._buildBoxFill(group, a, color, a.fillOpacity, matDepth, objOrder)
    }
  }

  private _buildBoxFrame(
    group: THREE.Group,
    a: BoxAnnotation,
    color: THREE.Color,
    matDepth: Record<string, unknown>,
    objOrder: Record<string, unknown>,
  ): void {
    const bars = computeBoxFrameBars(a.min, a.max, (a.frameThickness ?? 0.04) / 2)
    const mat = new THREE.MeshBasicMaterial({ color, ...matDepth })
    for (const d of bars) {
      const geo = new THREE.BoxGeometry(d.sx, d.sy, d.sz)
      const bar = new THREE.Mesh(geo, mat)
      bar.position.set(d.cx, d.cy, d.cz)
      bar.name = `anno-box-bar-${a.id}`
      Object.assign(bar, objOrder)
      group.add(bar)
    }
  }

  /** Thin wireframe bars — visually thicker than WebGL 1px LineSegments */
  private _buildWireframeBars(
    group: THREE.Group,
    a: BoxAnnotation,
    color: THREE.Color,
    halfThickness: number,
    opacity: number,
    matDepth: Record<string, unknown>,
    objOrder: Record<string, unknown>,
  ): void {
    const bars = computeBoxFrameBars(a.min, a.max, halfThickness)
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      ...matDepth,
    })
    for (const d of bars) {
      const geo = new THREE.BoxGeometry(d.sx, d.sy, d.sz)
      const bar = new THREE.Mesh(geo, mat)
      bar.position.set(d.cx, d.cy, d.cz)
      bar.name = `anno-box-wf-${a.id}`
      Object.assign(bar, objOrder)
      group.add(bar)
    }
  }

  private _buildBoxFill(
    group: THREE.Group,
    a: BoxAnnotation,
    color: THREE.Color,
    opacity: number,
    matDepth: Record<string, unknown>,
    objOrder: Record<string, unknown>,
  ): void {
    const boxGeo = new THREE.BoxGeometry(
      a.max.x - a.min.x,
      a.max.y - a.min.y,
      a.max.z - a.min.z,
    )
    boxGeo.translate(
      (a.min.x + a.max.x) / 2,
      (a.min.y + a.max.y) / 2,
      (a.min.z + a.max.z) / 2,
    )
    const fillMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      ...matDepth,
    })
    const fill = new THREE.Mesh(boxGeo, fillMat)
    fill.name = `anno-box-fill-${a.id}`
    Object.assign(fill, objOrder)
    group.add(fill)
  }

  private _buildPoint(group: THREE.Group, a: PointAnnotation): void {
    const geo = new THREE.SphereGeometry(a.size * 0.1, 8, 8)
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(a.color),
      depthTest: false,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(a.pos.x, a.pos.y, a.pos.z)
    mesh.name = `anno-point-${a.id}`
    group.add(mesh)
  }

  private _buildLine(group: THREE.Group, a: LineAnnotation): void {
    const positions = new Float32Array(a.points.length * 3)
    for (let i = 0; i < a.points.length; i++) {
      positions[i * 3] = a.points[i].x
      positions[i * 3 + 1] = a.points[i].y
      positions[i * 3 + 2] = a.points[i].z
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(a.color),
      depthTest: true,
    })
    const line = new THREE.Line(geo, mat)
    line.name = `anno-line-${a.id}`
    group.add(line)
  }

  private _buildText(group: THREE.Group, a: TextAnnotation): void {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const ctx2d = canvas.getContext('2d')
    if (ctx2d) {
      ctx2d.fillStyle = `rgba(0,0,0,${(a.backgroundAlpha ?? 0xCC) / 255})`
      ctx2d.fillRect(0, 0, canvas.width, canvas.height)
      ctx2d.fillStyle = a.color
      ctx2d.font = `${a.fontSize}px monospace`
      ctx2d.fillText(a.text, 8, canvas.height / 2 + a.fontSize / 2)
    }
    const texture = new THREE.CanvasTexture(canvas)
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      depthWrite: false,
    })
    const sprite = new THREE.Sprite(spriteMat)
    sprite.position.set(a.anchorPos.x, a.anchorPos.y, a.anchorPos.z)
    sprite.scale.set(2, 0.5, 1)
    sprite.name = `anno-text-${a.id}`
    group.add(sprite)
  }

  private _buildFace(group: THREE.Group, a: FaceAnnotation, def: StructureDefinition): void {
    const { cellGrid, blockPalette } = def
    const sizeZ = cellGrid.length
    const sizeRow = cellGrid[0]?.length ?? 0
    const sizeCol = cellGrid[0]?.[0]?.length ?? 0
    if (sizeZ === 0 || sizeRow === 0 || sizeCol === 0) return

    // Convert Y-up grid coords to cellGrid indices
    const row = sizeRow - 1 - a.blockPos.y
    const col = a.blockPos.x
    const zSlice = a.blockPos.z
    const idx = cellGrid[zSlice]?.[row]?.[col]
    if (idx === undefined || idx < 0 || idx >= blockPalette.length) return

    const entry = blockPalette[idx]
    if (!entry?.geometry) return

    let quads: BakedQuad[]
    try { quads = decodeBakedGeometry(entry.geometry as BakedQuadsGeometry) } catch { return }
    if (a.quadIndex >= quads.length) return

    const quad = quads[a.quadIndex]
    if (!quad || quad.vertices.length < 4) return

    // Compute face normal from edge vectors, ensure outward-facing
    const NUDGE = 0.001
    const v0 = quad.vertices[0], v1 = quad.vertices[1], v2 = quad.vertices[2]
    const ax = v1.x - v0.x, ay = v1.y - v0.y, az = v1.z - v0.z
    const bx = v2.x - v0.x, by = v2.y - v0.y, bz = v2.z - v0.z
    let nx = ay * bz - az * by
    let ny = az * bx - ax * bz
    let nz = ax * by - ay * bx
    // Flip inward-pointing normals (dot with centroid should be > 0)
    let qcx = 0, qcy = 0, qcz = 0
    for (const v of quad.vertices) { qcx += v.x; qcy += v.y; qcz += v.z }
    if (nx * qcx + ny * qcy + nz * qcz < 0) { nx = -nx; ny = -ny; nz = -nz }
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= nLen; ny /= nLen; nz /= nLen

    // World center of the voxel
    const cx = col - sizeCol / 2 + 0.5
    const cy = a.blockPos.y - sizeRow / 2 + 0.5
    const cz = zSlice - sizeZ / 2 + 0.5

    const verts: number[] = []
    for (const v of quad.vertices) {
      verts.push(
        v.x + cx - 0.5 + nx * NUDGE,
        v.y + cy - 0.5 + ny * NUDGE,
        v.z + cz - 0.5 + nz * NUDGE,
      )
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    geo.setIndex([0, 1, 2, 0, 2, 3])
    geo.computeVertexNormals()

    const color = new THREE.Color(a.color)
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.55,
      depthTest: true,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = `anno-face-${a.id}`
    group.add(mesh)
  }
}
