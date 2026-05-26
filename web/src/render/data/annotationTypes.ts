// web/src/render/data/annotationTypes.ts

export type AnnotationType = 'box' | 'point' | 'line' | 'text' | 'face'

export interface AnnotationBase {
  id: string
  type: AnnotationType
  frameIndex: number
  visible: boolean
  locked: boolean
  color: string
  title: string
  description: string
  created_at: number
  updated_at: number
}

export interface BoxAnnotation extends AnnotationBase {
  type: 'box'
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
  renderStyle: 'wireframe' | 'boxFrame' | 'translucent' | 'hidden'
  renderOpacity: number
  overlay: boolean
  fillOpacity: number
  frameThickness: number
}

export interface PointAnnotation extends AnnotationBase {
  type: 'point'
  pos: { x: number; y: number; z: number }
  icon: 'diamond' | 'circle' | 'square' | 'cross'
  size: number
}

export interface LineAnnotation extends AnnotationBase {
  type: 'line'
  points: Array<{ x: number; y: number; z: number }>
  thickness: number
  arrow: 'none' | 'start' | 'end' | 'both'
  showPoints: boolean
}

export interface TextAnnotation extends AnnotationBase {
  type: 'text'
  anchorPos: { x: number; y: number; z: number }
  text: string
  fontSize: number
  backgroundAlpha: number
  linkedAnnotationId?: string
}

export interface FaceAnnotation extends AnnotationBase {
  type: 'face'
  blockPos: { x: number; y: number; z: number }
  quadIndex: number
}

export type Annotation = BoxAnnotation | PointAnnotation | LineAnnotation | TextAnnotation | FaceAnnotation

export function isBox(a: Annotation): a is BoxAnnotation { return a.type === 'box' }
export function isPoint(a: Annotation): a is PointAnnotation { return a.type === 'point' }
export function isLine(a: Annotation): a is LineAnnotation { return a.type === 'line' }
export function isText(a: Annotation): a is TextAnnotation { return a.type === 'text' }
export function isFace(a: Annotation): a is FaceAnnotation { return a.type === 'face' }
