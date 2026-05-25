import * as THREE from 'three'
import type { SelectedEntity } from '@/workbench/selectionContext'
import type { BakedQuad } from '../schema/types'
import type { Annotation } from '../data/annotationTypes'
import { isBox, isLine, isPoint } from '../data/annotationTypes'

const HIGHLIGHT_COLOR = 0xff8800

// ---------------------------------------------------------------------------
// Pure: extract silhouette edges from model quads
// ---------------------------------------------------------------------------

interface QuadWithNormal {
  vertices: THREE.Vector3[]
  normal: THREE.Vector3
}

function quadNormal(v0: THREE.Vector3, v1: THREE.Vector3, v2: THREE.Vector3): THREE.Vector3 {
  const a = new THREE.Vector3().subVectors(v1, v0)
  const b = new THREE.Vector3().subVectors(v2, v0)
  return new THREE.Vector3().crossVectors(a, b).normalize()
}

function edgeKey(a: THREE.Vector3, b: THREE.Vector3): string {
  // Consistent ordering + rounding for dedup
  const rx = (v: number) => Math.round(v * 1e3) / 1e3
  const ax = rx(a.x), ay = rx(a.y), az = rx(a.z)
  const bx = rx(b.x), by = rx(b.y), bz = rx(b.z)
  if (ax < bx || (ax === bx && ay < by) || (ax === bx && ay === by && az < bz)) {
    return `${ax},${ay},${az},${bx},${by},${bz}`
  }
  return `${bx},${by},${bz},${ax},${ay},${az}`
}

/**
 * Pure function: BakedQuad[] + world offset → silhouette edge segments.
 *
 * An edge is drawn if:
 * - It belongs to exactly 1 quad → model boundary edge (always silhouette)
 * - It belongs to 2 quads → draw only if one quad faces camera and the other doesn't
 */
function extractModelOutlineEdges(
  quads: BakedQuad[],
  corner: { x: number; y: number; z: number },
  cameraDir: THREE.Vector3,
): Array<[THREE.Vector3, THREE.Vector3]> {
  // Step 1: convert quads to world-space quads with normals
  const wQuads: QuadWithNormal[] = []
  for (const q of quads) {
    if (q.vertices.length < 4) continue
    const v = q.vertices.map(
      vert => new THREE.Vector3(vert.x + corner.x, vert.y + corner.y, vert.z + corner.z),
    )
    const n = quadNormal(v[0], v[1], v[2])
    wQuads.push({ vertices: v, normal: n })
  }

  // Step 2: build edge → [{ normal, frontFacing }] map
  const edgeMap = new Map<string, Array<{ normal: THREE.Vector3; frontFacing: boolean }>>()
  for (const wq of wQuads) {
    const front = wq.normal.dot(cameraDir) < 0
    for (let i = 0; i < 4; i++) {
      const a = wq.vertices[i]
      const b = wq.vertices[(i + 1) % 4]
      const key = edgeKey(a, b)
      const entry = edgeMap.get(key)
      if (entry) {
        entry.push({ normal: wq.normal, frontFacing: front })
      } else {
        edgeMap.set(key, [{ normal: wq.normal, frontFacing: front }])
      }
    }
  }

  // Step 3: filter edges
  const edges: Array<[THREE.Vector3, THREE.Vector3]> = []
  for (const [_key, entries] of edgeMap) {
    if (entries.length === 1) {
      // Boundary edge — draw if the owning quad is front-facing
      if (entries[0].frontFacing) {
        edges.push([extractEndpoint(_key, 0), extractEndpoint(_key, 1)])
      }
    } else if (entries.length === 2) {
      // Shared edge — draw if:
      //   (a) one front, one back (classic silhouette), OR
      //   (b) both quads share the same normal (coplanar → boundary edge after dedup)
      const f0 = entries[0].frontFacing
      const f1 = entries[1].frontFacing
      const nSame = entries[0].normal.dot(entries[1].normal) > 0.999
      if (f0 !== f1 || nSame) {
        edges.push([extractEndpoint(_key, 0), extractEndpoint(_key, 1)])
      }
    }
    // > 2 entries shouldn't happen for well-formed models; skip
  }

  return edges
}

function extractEndpoint(key: string, idx: 0 | 1): THREE.Vector3 {
  const parts = key.split(',').map(Number)
  return idx === 0
    ? new THREE.Vector3(parts[0], parts[1], parts[2])
    : new THREE.Vector3(parts[3], parts[4], parts[5])
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SelectionHighlightProvider {
  private _group: THREE.Group | null = null

  build(
    entities: Set<SelectedEntity>,
    annotations: Annotation[],
    getBlockGeometry: (pos: { x: number; y: number; z: number }) => BakedQuad[] | null,
    gridCenterWorld: (pos: { x: number; y: number; z: number }) => { x: number; y: number; z: number } | null,
    camera?: THREE.Camera | null,
  ): THREE.Group {
    if (this._group) {
      this._group.traverse((c) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
          c.geometry?.dispose()
          ;(c.material as THREE.Material)?.dispose()
        }
      })
      this._group.clear()
    } else {
      this._group = new THREE.Group()
      this._group.name = 'selection-highlight'
    }

    if (entities.size === 0 || entities.size > 500) return this._group

    const camDir = new THREE.Vector3()
    if (camera) camera.getWorldDirection(camDir)

    // Build selected positions set for neighbor suppression
    const selectedWorldPositions = new Set<string>()
    const blockEntries: Array<{ pos: { x: number; y: number; z: number }; center: { x: number; y: number; z: number } }> = []

    for (const entity of entities) {
      if (entity.kind === 'block') {
        const center = gridCenterWorld(entity.ref.pos)
        if (center) {
          selectedWorldPositions.add(`${center.x},${center.y},${center.z}`)
          blockEntries.push({ pos: entity.ref.pos, center })
        }
      }
    }

    // Block silhouettes from model geometry
    if (blockEntries.length > 0 && camera) {
      this._buildBlockSilhouettes(blockEntries, selectedWorldPositions, camDir, getBlockGeometry)
    }

    // Annotation highlights
    for (const entity of entities) {
      if (entity.kind !== 'block') {
        const anno = annotations.find(a => a.id === entity.id)
        if (anno) this._buildAnnotationHighlight(anno)
      }
    }

    return this._group
  }

  dispose(): void {
    if (this._group) {
      this._group.traverse((c) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments || c instanceof THREE.Line) {
          c.geometry?.dispose()
          ;(c.material as THREE.Material)?.dispose()
        }
      })
      this._group.clear()
      this._group = null
    }
  }

  // -------------------------------------------------------------------
  // Block model silhouette
  // -------------------------------------------------------------------

  private _buildBlockSilhouettes(
    blocks: Array<{ pos: { x: number; y: number; z: number }; center: { x: number; y: number; z: number } }>,
    selectedSet: Set<string>,
    cameraDir: THREE.Vector3,
    getBlockGeometry: (pos: { x: number; y: number; z: number }) => BakedQuad[] | null,
  ): void {
    const allEdgeKeys = new Set<string>()
    const allEdgePairs: Array<[THREE.Vector3, THREE.Vector3]> = []

    for (const { pos, center } of blocks) {
      const quads = getBlockGeometry(pos)
      const hasValidQuads = quads && quads.length > 0 && quads.some(q => q.vertices.length >= 4)
      if (!hasValidQuads) {
        // Fall back to unit cube if no geometry
        this._addUnitCubeEdges(center, selectedSet, cameraDir, allEdgeKeys, allEdgePairs)
        continue
      }

      const corner = { x: center.x - 0.5, y: center.y - 0.5, z: center.z - 0.5 }
      const edges = extractModelOutlineEdges(quads!, corner, cameraDir)

      if (edges.length === 0) {
        // Model produced no silhouette edges → fallback
        this._addUnitCubeEdges(center, selectedSet, cameraDir, allEdgeKeys, allEdgePairs)
        continue
      }

      for (const [a, b] of edges) {
        const key = edgeKey(a, b)
        if (allEdgeKeys.has(key)) continue
        allEdgeKeys.add(key)
        allEdgePairs.push([a, b])
      }
    }

    if (allEdgePairs.length === 0) return

    // Suppress edges between adjacent selected blocks
    const filteredEdges = this._suppressAdjacentEdges(allEdgePairs, selectedSet, 0.01)

    if (filteredEdges.length === 0) return

    const verts: number[] = []
    for (const [a, b] of filteredEdges) {
      verts.push(a.x, a.y, a.z, b.x, b.y, b.z)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    const mat = new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR, linewidth: 1, depthTest: true })
    const lines = new THREE.LineSegments(geo, mat)
    this._group!.add(lines)
  }

  /** Fallback unit cube for blocks without model geometry */
  private _addUnitCubeEdges(
    center: { x: number; y: number; z: number },
    selectedSet: Set<string>,
    cameraDir: THREE.Vector3,
    edgeKeys: Set<string>,
    edgePairs: Array<[THREE.Vector3, THREE.Vector3]>,
  ): void {
    const s = 0.5
    const x = center.x; const y = center.y; const z = center.z
    const faces = [
      { normal: new THREE.Vector3(1, 0, 0), dx: 1,  dy: 0,  dz: 0 },
      { normal: new THREE.Vector3(-1, 0, 0), dx: -1, dy: 0,  dz: 0 },
      { normal: new THREE.Vector3(0, 1, 0), dx: 0,  dy: 1,  dz: 0 },
      { normal: new THREE.Vector3(0, -1, 0), dx: 0,  dy: -1, dz: 0 },
      { normal: new THREE.Vector3(0, 0, 1), dx: 0,  dy: 0,  dz: 1 },
      { normal: new THREE.Vector3(0, 0, -1), dx: 0,  dy: 0,  dz: -1 },
    ]

    for (const face of faces) {
      if (face.normal.dot(cameraDir) >= 0) continue
      const nx = center.x + face.dx
      const ny = center.y + face.dy
      const nz = center.z + face.dz
      if (selectedSet.has(`${nx},${ny},${nz}`)) continue

      let corners: Array<{ x: number; y: number; z: number }>
      if (face.dx !== 0) {
        const fx = x + face.dx * s
        corners = [{ x: fx, y: y - s, z: z - s }, { x: fx, y: y + s, z: z - s }, { x: fx, y: y + s, z: z + s }, { x: fx, y: y - s, z: z + s }]
      } else if (face.dy !== 0) {
        const fy = y + face.dy * s
        corners = [{ x: x - s, y: fy, z: z - s }, { x: x + s, y: fy, z: z - s }, { x: x + s, y: fy, z: z + s }, { x: x - s, y: fy, z: z + s }]
      } else {
        const fz = z + face.dz * s
        corners = [{ x: x - s, y: y - s, z: fz }, { x: x + s, y: y - s, z: fz }, { x: x + s, y: y + s, z: fz }, { x: x - s, y: y + s, z: fz }]
      }

      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4]
        const av = new THREE.Vector3(a.x, a.y, a.z)
        const bv = new THREE.Vector3(b.x, b.y, b.z)
        const key = edgeKey(av, bv)
        if (edgeKeys.has(key)) continue
        edgeKeys.add(key)
        edgePairs.push([av, bv])
      }
    }
  }

  /** Remove edges that lie on a face shared between two adjacent selected blocks */
  private _suppressAdjacentEdges(
    edges: Array<[THREE.Vector3, THREE.Vector3]>,
    selectedSet: Set<string>,
    tolerance: number,
  ): Array<[THREE.Vector3, THREE.Vector3]> {
    // Pre-compute shared face planes: for each selected block, if neighbor is also selected,
    // record the plane normal + offset where edges should be suppressed
    const suppressPlanes: Array<{ axis: 'x' | 'y' | 'z'; value: number }> = []
    for (const key of selectedSet) {
      const [sx, sy, sz] = key.split(',').map(Number)
      for (const [dx, dy, dz, axis] of [[1, 0, 0, 'x'], [-1, 0, 0, 'x'], [0, 1, 0, 'y'], [0, -1, 0, 'y'], [0, 0, 1, 'z'], [0, 0, -1, 'z']] as Array<[number, number, number, 'x' | 'y' | 'z']>) {
        const nk = `${sx + dx},${sy + dy},${sz + dz}`
        if (selectedSet.has(nk)) {
          // Shared face is at half-unit offset from the first block's center
          const planeVal = axis === 'x' ? sx + dx * 0.5 : axis === 'y' ? sy + dy * 0.5 : sz + dz * 0.5
          suppressPlanes.push({ axis, value: planeVal })
        }
      }
    }

    if (suppressPlanes.length === 0) return edges

    return edges.filter(([a, b]) => {
      for (const plane of suppressPlanes) {
        const aOnPlane = Math.abs((plane.axis === 'x' ? a.x : plane.axis === 'y' ? a.y : a.z) - plane.value) < tolerance
        const bOnPlane = Math.abs((plane.axis === 'x' ? b.x : plane.axis === 'y' ? b.y : b.z) - plane.value) < tolerance
        if (aOnPlane && bOnPlane) return false
      }
      return true
    })
  }

  // -------------------------------------------------------------------
  // Annotation highlights
  // -------------------------------------------------------------------

  private _buildAnnotationHighlight(anno: Annotation): void {
    if (isBox(anno)) {
      this._buildBoxOutline(anno)
    } else if (isPoint(anno)) {
      this._buildPointHighlight(anno)
    } else if (isLine(anno)) {
      this._buildLineHighlight(anno)
    } else {
      this._buildTextHighlight(anno)
    }
  }

  private _buildBoxOutline(a: Annotation & { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): void {
    const x1 = a.min.x; const y1 = a.min.y; const z1 = a.min.z
    const x2 = a.max.x; const y2 = a.max.y; const z2 = a.max.z
    const verts = [
      x1, y1, z1, x2, y1, z1, x2, y1, z1, x2, y2, z1, x2, y2, z1, x1, y2, z1, x1, y2, z1, x1, y1, z1,
      x1, y1, z2, x2, y1, z2, x2, y1, z2, x2, y2, z2, x2, y2, z2, x1, y2, z2, x1, y2, z2, x1, y1, z2,
      x1, y1, z1, x1, y1, z2, x2, y1, z1, x2, y1, z2, x2, y2, z1, x2, y2, z2, x1, y2, z1, x1, y2, z2,
    ]
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    const mat = new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR, linewidth: 1, depthTest: true })
    const lines = new THREE.LineSegments(geo, mat)
    this._group!.add(lines)
  }

  private _buildPointHighlight(a: Annotation & { pos: { x: number; y: number; z: number }; size: number }): void {
    const torusGeo = new THREE.TorusGeometry(a.size * 0.12, 0.03, 8, 12)
    const torusMat = new THREE.MeshBasicMaterial({ color: HIGHLIGHT_COLOR, depthTest: false, depthWrite: false })
    const torus = new THREE.Mesh(torusGeo, torusMat)
    torus.position.set(a.pos.x, a.pos.y, a.pos.z)
    this._group!.add(torus)
  }

  private _buildLineHighlight(a: Annotation & { points: Array<{ x: number; y: number; z: number }> }): void {
    const positions = new Float32Array(a.points.length * 3)
    for (let i = 0; i < a.points.length; i++) {
      positions[i * 3] = a.points[i].x
      positions[i * 3 + 1] = a.points[i].y
      positions[i * 3 + 2] = a.points[i].z
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR, linewidth: 2, depthTest: true })
    const line = new THREE.Line(geo, mat)
    this._group!.add(line)
  }

  private _buildTextHighlight(a: Annotation & { anchorPos: { x: number; y: number; z: number } }): void {
    const torusGeo = new THREE.TorusGeometry(0.15, 0.03, 8, 12)
    const torusMat = new THREE.MeshBasicMaterial({ color: HIGHLIGHT_COLOR, depthTest: false, depthWrite: false })
    const torus = new THREE.Mesh(torusGeo, torusMat)
    torus.position.set(a.anchorPos.x, a.anchorPos.y, a.anchorPos.z)
    this._group!.add(torus)
  }
}
