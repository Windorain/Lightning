// web/src/operators/builtin/annotationOperators.ts
import { generateId } from '@/pure/string'
import type { OperatorType } from '@/operators/operatorType'
import type { Annotation } from '@/render/data/annotationTypes'
import type { SetPropertyCommand } from '@/application/commands'
import { KERNEL_CONTEXT_ID } from '@/runtime/kernelSession'
import { KERNEL_ANNOTATION_TYPE } from '@/application/kernel-properties'
import { objectRef, propertyRef } from '@/domain/identity'
import { settlementOf } from '@/domain/editSettlement'
import { fallbackToLegacyOn } from '@/runtime/rejectionNotice'

/**
 * 内核注解对象的 id 前缀（与 `composition/kernelAssembly#annotationObjects` 一致）。
 *
 * ⚠️ 这里是**第二处**知道该前缀的生产代码（第一处是装配）。刻意不 import 装配
 * （`operators/` 依赖 `composition/` 会破分层）⇒ 由 `contentSync.test.ts`
 * 断言二者一致（改一处而忘另一处即判红）。
 */
export const ANNOTATION_OBJECT_PREFIX = 'annotation:'

/**
 * legacy 注解 → 内核 `addObject` 的 `params`（**开放通道**）。
 *
 * ⚠️ 字段走 `params` 而非 `Command` 的具名字段：那正是开放通道要求的形态
 * （"新增类型不必回来改命令类型"）。
 *
 * 只带 `addObject` 认得的构造参数：`shape` + `text`。
 * **几何与 `locked` 不在这里** —— 内核 `addObject` 只建对象骨架，
 * 它们的写入是 `setProperty` 的事（而实测：内核**尚未**为它们提供写端口，
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
 * ## 承载面
 *
 * 内核注解对象类型的属性集现在是
 * `structuralDecls()`（`name`/`visible`）+ `transformDecls()`
 * + **`text` / `title` / `description`** + **`color`/`locked`/`min`/`max`/`pos`/`renderStyle`**
 * （`application/kernel-properties.ts`；后两组是新写面 —— 写面从"只认 `text`"
 * 扩成表驱动）。
 *
 * ⚠️ **本函数仍然只映射 `title`/`description` 两个键**：其余键在 legacy 侧的值形状
 * （`min`/`max`/`pos` 的元组 or 向量、`renderOpacity` 一族的读面缺口）尚未在边界处
 * 定案 ⇒ 整体回落 legacy 的 `frozenDocumentValue()` 写。那条残留如实登记在
 * `composition/seams.ts` 的 `annotation-wide-field-face`（**未**核销）。
 *
 * ## 为什么不"部分写"
 *
 * 多字段补丁里只要有一个内核未承载，就**整体**回落 —— 部分写会让用户看到
 * "改了一半"。宁可整体走旧路径（行为与迁移前完全一致），也不静默丢字段。
 */
function annotationPatchCommand(id: string, patch: Partial<Annotation>): SetPropertyCommand | null {
  const keys = Object.keys(patch)
  // 只支持**单字段**补丁：内核 `setProperty` 是"一组 refs + 一个 value"
    // ⇒ 多字段不同值无法用一条命令表达（多字段暂回落 legacy）。
  if (keys.length !== 1) return null
  const only = keys[0]!
  /**
   * 标题/描述是载荷 `text` 的**两个半边**，内核已把它们声明成一等字段
   * （`application/kernel-properties` 的 `annotation.title`/`annotation.description`）。
   *
   * ⚠️ 这里**必须**写 `title` 而不是 `text`：写 `text` 是**整体替换**，改标题会把
   * 既有描述一起抹掉 —— 迁移前这里正是 `annotation.text`，即"改标题丢描述"的静默
   * 数据丢失（连同内核字段一起修正）。
   */
  const local = only === 'title' ? 'title' : only === 'description' ? 'description' : null
  if (local === null) return null
  const next = (patch as Record<string, unknown>)[only]
  if (typeof next !== 'string') return null
  return {
    kind: 'setProperty',
    contextId: KERNEL_CONTEXT_ID,
    refs: [
      // ⚠️ `property` 是**限定式 id** `"<objectTypeId>.<localId>"`（见
      // `application/kernel-properties#localOf`），而 `owner` 只带 `{kind, id}`
      // —— 对象**类型**不在 `EntityRef` 里（我第一版按 `{kind,type,id}` 写，
      // 被 TS2352 当场拦下；类型系统在这里帮了忙）。
      propertyRef(objectRef(`${ANNOTATION_OBJECT_PREFIX}${id}`), `${KERNEL_ANNOTATION_TYPE}.${local}`),
    ],
    value: next,
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
      // 存在性判定的同义替代（内核读面）。
    if (!ctx.hasLoadedDocument()) return

    const annotation = props.annotation as Annotation
    if (!annotation) return

    annotation.id = annotation.id ?? generateId('anno_')
    annotation.created_at = Date.now()
    annotation.updated_at = Date.now()

      // **内核写优先**。
    //
    // `submitContentEdit` 一步完成"① 内核命令 + ② 投影回 legacy"；
    // 成功 ⇒ legacy 已被回写成最新，**不得**再走下面的 legacy 路径
    // （再写一次会以旧数组覆盖回写产物 ⇒ 内容丢失）。
      // 取**结算**（三分派）而不是布尔 —— 布尔把"被拒"与"未装配"压成同一个 false，
      // 于是内核拒绝会被当成未装配而**回落 legacy 写**，把拒绝抹成成功（最恶劣的形态）。
    const created = settlementOf(ctx.submitContentEditSettlement({
      kind: 'addObject',
      contextId: KERNEL_CONTEXT_ID,
      objectType: 'annotation',
      name: annotation.title || annotation.id,
      // ⚠️ **显式 id**：内核对象 id 必须与装配同口径
      // （`annotation:<legacyId>`），否则 `selection.active` 与属性面板的
      // `EntityRef` 对不上 ⇒ 面板后续每次写都打到不存在的 id（实测的阻塞）。
      params: { ...annotationParamsOf(annotation), objectId: `${ANNOTATION_OBJECT_PREFIX}${annotation.id}` },
    }))
    // 被拒 ⇒ 底栏成句原因**且不回落**；未装配 ⇒ 既有 legacy 回落（双轨接缝的合法分支）。
    if (!fallbackToLegacyOn(ctx, created, 'annotationEdit')) {
      ctx.getSelection().active.value = annotation.id
      return
    }

      // 回落：未装配 / 无会话 ⇒ legacy 是权威（能力不回退）。
      // **替换式**写 ⇒ 要的是**冻结副本**（`frozenDocumentValue()` 就是 clone）。
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
      // 经内核读面。
    if (!ctx.hasLoadedDocument()) return

    const id = props.id as string
    const patch = props.patch as Partial<Annotation>
    if (!id || !patch) return

      // 内核写优先（逐字段 `setProperty`）。
      // ⚠️ 实测边界：这里**只迁 `title`**
    // —— 窄的是**写面**（`annotationPatchCommand` 对非单键 `title` 的补丁返回 `null`），
    // **不是**读面：读面是 15 字段封闭表（`ANNOTATION_FIELD_PAIRS`，**含** `locked`/几何
      // `min`/`max`/`pos`/`points`/`color`/`renderStyle`）—— 原注释把迁移边界说成
    // "限于读面已暴露的那 15 个"，与 `annotationPatchCommand` 的实现（只认 `title`）不符。
    // 其余字段（`locked`/`renderOpacity`…）一律回落 legacy —— 宁可走旧路径，也不静默丢字段。
    const command = annotationPatchCommand(id, patch)
    if (command !== null) {
      const settled = settlementOf(ctx.submitContentEditSettlement(command))
      // 补丁是**单字段**且内核承载 ⇒ 内核的结论就是结论：
      // applied/unchanged ⇒ 完成；rejected ⇒ 底栏成句原因、**不回落**；
      // not-assembled ⇒ 才走下面的 legacy 回落。
      if (!fallbackToLegacyOn(ctx, settled, 'annotationEdit')) return
    }

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
      // 经内核读面。
    if (!ctx.hasLoadedDocument()) return

    const id = props.id as string
    if (!id) return

      // 内核写优先（`deleteObject`）。
    // 内核对象 id 有 `annotation:` 前缀（装配期建立，见 `kernelAssembly#annotationObjects`）。
    const deleted = settlementOf(ctx.submitContentEditSettlement({
      kind: 'deleteObject',
      contextId: KERNEL_CONTEXT_ID,
      objectId: `${ANNOTATION_OBJECT_PREFIX}${id}`,
    }))
    // 同上：被拒**不回落**（否则"删不掉"会表现为"删掉了但内容还在"）。
    if (!fallbackToLegacyOn(ctx, deleted, 'annotationEdit')) {
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
