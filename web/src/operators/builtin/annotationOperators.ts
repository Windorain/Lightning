// web/src/operators/builtin/annotationOperators.ts
import { generateId } from '@/pure/string'
import type { OperatorType } from '@/operators/operatorType'
import type { Annotation } from '@/render/data/annotationTypes'

export const AnnotationCreateOperator: OperatorType = {
  id: 'ANNOTATION_CREATE',
  label: '创建注解',
  flagUndo: true,

  poll(ctx) {
    return ctx.doc.value !== null
  },

  exec(ctx, props) {
    const doc = ctx.doc.value
    if (!doc) return

    const annotation = props.annotation as Annotation
    if (!annotation) return

    annotation.id = annotation.id ?? generateId('anno_')
    annotation.created_at = Date.now()
    annotation.updated_at = Date.now()

    const newDoc = doc.clone()
    ;(newDoc.annotations as Annotation[]).push(annotation)
    ctx.main.replaceDoc(newDoc)
    ctx.selection.active.value = annotation.id
  },
}

export const AnnotationUpdateOperator: OperatorType = {
  id: 'ANNOTATION_UPDATE',
  label: '更新注解',
  flagUndo: true,

  poll(ctx) {
    return ctx.doc.value !== null
  },

  exec(ctx, props) {
    const doc = ctx.doc.value
    if (!doc) return

    const id = props.id as string
    const patch = props.patch as Partial<Annotation>
    if (!id || !patch) return

    const newDoc = doc.clone()
    const annotations = newDoc.annotations as Annotation[]
    const idx = annotations.findIndex((a: Annotation) => a.id === id)
    if (idx === -1) return

    annotations[idx] = { ...annotations[idx], ...patch, updated_at: Date.now() } as Annotation
    ctx.main.replaceDoc(newDoc)
  },
}

export const AnnotationDeleteOperator: OperatorType = {
  id: 'ANNOTATION_DELETE',
  label: '删除注解',
  flagUndo: true,

  poll(ctx) {
    return ctx.doc.value !== null
  },

  exec(ctx, props) {
    const doc = ctx.doc.value
    if (!doc) return

    const id = props.id as string
    if (!id) return

    const newDoc = doc.clone()
    const annotations = newDoc.annotations as Annotation[]
    const idx = annotations.findIndex((a: Annotation) => a.id === id)
    if (idx === -1) return

    annotations.splice(idx, 1)
    ctx.main.replaceDoc(newDoc)
    ctx.selection.active.value = null
  },
}
