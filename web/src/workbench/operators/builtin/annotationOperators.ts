// web/src/workbench/operators/builtin/annotationOperators.ts
import type { OperatorType } from '@/workbench/operators/operatorType'
import type { Annotation } from '@/render/data/annotationTypes'

function generateId(): string {
  return 'anno_' + Math.random().toString(36).slice(2, 10)
}

export const AnnotationCreateOperator: OperatorType = {
  id: 'ANNOTATION_CREATE',
  label: '创建注解',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  exec(bctx, props) {
    const doc = bctx.scene.scene.value as Record<string, any> | null
    if (!doc) return

    const annotation = props.annotation as Annotation
    if (!annotation) return

    annotation.id = annotation.id ?? generateId()
    annotation.created_at = Date.now()
    annotation.updated_at = Date.now()

    if (!doc.annotations) doc.annotations = []
    doc.annotations.push(annotation)
    bctx.scene.markDirty()
  },
}

export const AnnotationUpdateOperator: OperatorType = {
  id: 'ANNOTATION_UPDATE',
  label: '更新注解',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  exec(bctx, props) {
    const doc = bctx.scene.scene.value as Record<string, any> | null
    if (!doc?.annotations) return

    const id = props.id as string
    const patch = props.patch as Partial<Annotation>
    if (!id || !patch) return

    const annotations = doc.annotations as Annotation[]
    const idx = annotations.findIndex((a: Annotation) => a.id === id)
    if (idx === -1) return

    // Mutate in place so the draft reference stays bound to doc.annotations
    Object.assign(annotations[idx], patch, { updated_at: Date.now() })
    bctx.scene.markDirty()
  },
}

export const AnnotationDeleteOperator: OperatorType = {
  id: 'ANNOTATION_DELETE',
  label: '删除注解',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  exec(bctx, props) {
    const doc = bctx.scene.scene.value as Record<string, any> | null
    if (!doc?.annotations) return

    const id = props.id as string
    if (!id) return

    const annotations = doc.annotations as Annotation[]
    const idx = annotations.findIndex((a: Annotation) => a.id === id)
    if (idx === -1) return

    annotations.splice(idx, 1)
    bctx.scene.markDirty()
    // Clear draft so the panel disappears
    ;(bctx as any).annotationState?.clearDraft()
  },
}
