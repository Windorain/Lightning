// web/src/render/mesh/annotationMeshProvider.ts
import * as THREE from 'three'
import type { MeshProvider, MeshOutput } from './providerTypes'
import type { StructureDefinition } from '../schema/types'
import type { MaterialLibraryApi } from '../materials/simpleMaterialLibrary'
import type { Annotation, BoxAnnotation, PointAnnotation, LineAnnotation, TextAnnotation } from '../data/annotationTypes'
import { isBox, isPoint, isLine, isText } from '../data/annotationTypes'

export class AnnotationMeshProvider implements MeshProvider {
  priority = 50
  target = 'overlay' as const

  private _annotations: Annotation[] = []

  setAnnotations(annotations: Annotation[]): void {
    this._annotations = annotations.filter(a => a.visible)
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
    const verts = boxWireframeVerts(a.min, a.max)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(a.color),
      depthTest: true,
      transparent: a.renderStyle !== 'hidden',
      opacity: a.renderOpacity,
    })
    const wireframe = new THREE.LineSegments(geo, mat)
    wireframe.name = `anno-box-${a.id}`
    group.add(wireframe)

    if (a.renderStyle === 'translucent') {
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
        color: new THREE.Color(a.color),
        transparent: true,
        opacity: a.renderOpacity * 0.3,
        depthTest: true,
      })
      const fill = new THREE.Mesh(boxGeo, fillMat)
      fill.name = `anno-box-fill-${a.id}`
      group.add(fill)
    }
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
