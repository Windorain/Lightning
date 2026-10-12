// web/src/operators/builtin/annotationOperators.ts
import { generateId } from '@/pure/string'
import type { OperatorType } from '@/operators/operatorType'
import type { Annotation } from '@/render/data/annotationTypes'
import type { SetPropertyCommand } from '@/application/commands'
import { KERNEL_CONTEXT_ID } from '@/runtime/kernelSession'
import { KERNEL_ANNOTATION_TYPE } from '@/application/kernel-properties'
import { objectRef, propertyRef } from '@/domain/identity'

/**
 * 内核注解对象的 id 前缀（与 `composition/kernelAssembly#annotationObjects` 一致）。
 *
 * ⚠️ 这里是**第二处**知道该前缀的生产代码（第一处是装配）。刻意不 import 装配
 * （`operators/` 依赖 `composition/` 会破分层）⇒ 由 `p10fContentSync.test.ts`
 * 断言二者一致（改一处而忘另一处即判红）。
 */
export const ANNOTATION_OBJECT_PREFIX = 'annotation:'

/**
 * legacy 注解 → 内核 `addObject` 的 `params`（**开放通道**，A21）。
 *
 * ⚠️ 字段走 `params` 而非 `Command` 的具名字段：那正是 A21 要求的形态
 * （"新增类型不必回来改命令类型"）。
 *
 * 只带 `addObject` 认得的构造参数：`shape` + `text`。
 * **几何与 `locked` 不在这里** —— 内核 `addObject` 只建对象骨架，
 * 它们的写入是 `setProperty` 的事（而 C′2 实测：内核**尚未**为它们提供写端口，
 * 见 {@link annotationPatchCommand} 的说明）。
 */
function annotationParamsOf(a: Annotation): Readonly<Record<string, unknown>> {
  const shape = (a as { type?: unknown }).type
  const title = (a as { title?: unknown }).title
  const description = (a as { description?: unknown }).description
  const t = typeof title === 'string' ? title : ''
  const d = typeof description === 'string' ? description : ''
  // 与装配的**正向**合成规则同口径（`title\n\ndescription`；只有一个 ⇒ 那一个）
  const text = t !== '' && d !== '' ? `${t}\n\n${d}` : t !== '' ? t : d
  return Object.freeze({
    ...(typeof shape === 'string' ? { shape } : {}),
    ...(text !== '' ? { text } : {}),
  })
}

/**
 * legacy 单字段补丁 → 内核 `setProperty` 命令；**内核未承载该字段即返回 `null`**。
 *
 * ## ⚠️ 实测边界：本批**只**支持 `text`（其余字段一律回落 legacy）
 *
 * 内核注解对象类型的属性集实测为
 * `structuralDecls()`（`name`/`visible`）+ `transformDecls()` + `text`
 * （`application/kernel-properties.ts:162-172`），且写端口
 * `editors/property-writers#writeAnnotationProperty` 只实现了 `text` 与分量写。
 *
 * ⇒ 本批**只**迁移 `text`；`locked`/`priority`/几何等一律回落 legacy。
 * 这是**如实的能力边界**，不是遗漏：把它们硬凑成 `setProperty` 会在
 * `writeAnnotationProperty` 里落到 `default: UnsupportedOperation`
 * ⇒ 命令 `rejected` ⇒ 我的调用点会误判为"未装配"而再次写 legacy（双写）。
 *
 * ## 为什么不"部分写"
 *
 * 多字段补丁里只要有一个内核未承载，就**整体**回落 —— 部分写会让用户看到
 * "改了一半"。宁可整体走旧路径（行为与迁移前完全一致），也不静默丢字段。
 */
function annotationPatchCommand(id: string, patch: Partial<Annotation>): SetPropertyCommand | null {
  const keys = Object.keys(patch)
  // 只支持**单字段**补丁：内核 `setProperty` 是"一组 refs + 一个 value"
  // ⇒ 多字段不同值无法用一条命令表达（多字段本批回落 legacy）。
  if (keys.length !== 1) return null
  const only = keys[0]!
  if (only !== 'title') return null
  const title = (patch as { title?: unknown }).title
  if (typeof title !== 'string') return null
  return {
    kind: 'setProperty',
    contextId: KERNEL_CONTEXT_ID,
    refs: [
      // ⚠️ `property` 是**限定式 id** `"<objectTypeId>.<localId>"`（见
      // `application/kernel-properties#localOf`），而 `owner` 只带 `{kind, id}`
      // —— 对象**类型**不在 `EntityRef` 里（我第一版按 `{kind,type,id}` 写，
      // 被 TS2352 当场拦下；类型系统在这里帮了忙）。
      propertyRef(objectRef(`${ANNOTATION_OBJECT_PREFIX}${id}`), `${KERNEL_ANNOTATION_TYPE}.text`),
    ],
    value: title,
  } as SetPropertyCommand
}

export const AnnotationCreateOperator: OperatorType = {
  id: 'ANNOTATION_CREATE',
  label: '创建注解',
  flagUndo: true,

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  exec(ctx, props) {
    // #301 P10f D3（R1）：存在性判定的同义替代（GF-15 读面）。
    if (!ctx.hasLoadedDocument()) return

    const annotation = props.annotation as Annotation
    if (!annotation) return

    annotation.id = annotation.id ?? generateId('anno_')
    annotation.created_at = Date.now()
    annotation.updated_at = Date.now()

    // #301 P10f C′2：**内核写优先**（裁决 1）。
    //
    // `submitContentEdit` 一步完成"① 内核命令 + ② 投影回 legacy"；
    // 成功 ⇒ legacy 已被回写成最新，**不得**再走下面的 legacy 路径
    // （再写一次会以旧数组覆盖回写产物 ⇒ 内容丢失）。
    if (ctx.submitContentEdit({
      kind: 'addObject',
      contextId: KERNEL_CONTEXT_ID,
      objectType: 'annotation',
      name: annotation.title || annotation.id,
      // ⚠️ **显式 id**（裁决 (a)）：内核对象 id 必须与装配同口径
      // （`annotation:<legacyId>`），否则 `selection.active` 与属性面板的
      // `EntityRef` 对不上 ⇒ 面板后续每次写都打到不存在的 id（实测的阻塞）。
      params: { ...annotationParamsOf(annotation), objectId: `${ANNOTATION_OBJECT_PREFIX}${annotation.id}` },
    })) {
      ctx.getSelection().active.value = annotation.id
      return
    }

    // 回落：未装配（GF-16 = false）/ 无会话 ⇒ legacy 是权威（能力不回退）。
    // R8：**替换式**写 ⇒ 要的是**冻结副本**（`frozenDocumentValue()` 就是 clone）。
    const newDoc = ctx.frozenDocumentValue()
    if (!newDoc) return
    ;(newDoc.annotations as Annotation[]).push(annotation)
    ctx.setDocument(newDoc)
    ctx.getSelection().active.value = annotation.id
  },
}

export const AnnotationUpdateOperator: OperatorType = {
  id: 'ANNOTATION_UPDATE',
  label: '更新注解',
  flagUndo: true,

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  exec(ctx, props) {
    // #301 P10f D3（R1）。
    if (!ctx.hasLoadedDocument()) return

    const id = props.id as string
    const patch = props.patch as Partial<Annotation>
    if (!id || !patch) return

    // #301 P10f C′2：内核写优先（逐字段 `setProperty`）。
    // ⚠️ 实测边界（#262 P11-B3 措辞更正，Lead comment 6429 三 L5）：本批**只迁 `title`**
    // —— 窄的是**写面**（`annotationPatchCommand` 对非单键 `title` 的补丁返回 `null`），
    // **不是**读面：读面是 15 字段封闭表（`ANNOTATION_FIELD_PAIRS`，**含** `locked`/几何
    // `min`/`max`/`pos`/`points`/`color`/`renderStyle`）—— 原注释把本批边界说成
    // "限于读面已暴露的那 15 个"，与 `annotationPatchCommand` 的实现（只认 `title`）不符。
    // 其余字段（`locked`/`renderOpacity`…）一律回落 legacy —— 宁可走旧路径，也不静默丢字段。
    const command = annotationPatchCommand(id, patch)
    if (command !== null && ctx.submitContentEdit(command)) return

    // 回落：未装配 / 无会话 / 补丁含内核未承载字段 ⇒ legacy 是权威。
    const newDoc = ctx.frozenDocumentValue()
    if (!newDoc) return
    const annotations = newDoc.annotations as Annotation[]
    const idx = annotations.findIndex((a: Annotation) => a.id === id)
    if (idx === -1) return

    annotations[idx] = { ...annotations[idx], ...patch, updated_at: Date.now() } as Annotation
    ctx.setDocument(newDoc)
  },
}

export const AnnotationDeleteOperator: OperatorType = {
  id: 'ANNOTATION_DELETE',
  label: '删除注解',
  flagUndo: true,

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  exec(ctx, props) {
    // #301 P10f D3（R1）。
    if (!ctx.hasLoadedDocument()) return

    const id = props.id as string
    if (!id) return

    // #301 P10f C′2：内核写优先（`deleteObject`）。
    // 内核对象 id 有 `annotation:` 前缀（装配期建立，见 `kernelAssembly#annotationObjects`）。
    if (ctx.submitContentEdit({
      kind: 'deleteObject',
      contextId: KERNEL_CONTEXT_ID,
      objectId: `${ANNOTATION_OBJECT_PREFIX}${id}`,
    })) {
      ctx.getSelection().active.value = null
      return
    }

    // 回落：未装配 / 无会话 ⇒ legacy 是权威。
    const newDoc = ctx.frozenDocumentValue()
    if (!newDoc) return
    const annotations = newDoc.annotations as Annotation[]
    const idx = annotations.findIndex((a: Annotation) => a.id === id)
    if (idx === -1) return

    annotations.splice(idx, 1)
    ctx.setDocument(newDoc)
    ctx.getSelection().active.value = null
  },
}
