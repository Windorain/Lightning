import { shallowRef, type ShallowRef } from 'vue'
import type { DocumentBinding, DocumentSourceId } from './types'

export function createEmptyBinding(): DocumentBinding {
  return {
    sourceId: 'empty',
    locator: '',
    remoteRevisionId: null,
    saveBaseline: null,
  }
}

export function createDocumentBindingRef(): ShallowRef<DocumentBinding> {
  return shallowRef(createEmptyBinding())
}

/**
 * 应用一次绑定补丁。
 *
 * ## 字段缺席 ≠ 显式 `null`（这里是**唯一**的判定点）
 *
 * 旧实现写的是 `patch.saveBaseline ?? ref.value.saveBaseline` —— 于是**传 `null`
 * 也被当成"没传"**，两个可为空的字段（`remoteRevisionId` / `saveBaseline`）就
 * 永远清不掉：调用方以为在清空绑定，实际留下的是上一份文档的 revision/基线。
 *
 * 现在的语义只有两条，且按**键是否出现**判定（不是按值的真假）：
 *
 * | 补丁里的字段 | 结果 |
 * |---|---|
 * | 缺席（`undefined` 且键不存在） | 保留当前值（部分补丁） |
 * | 出现（含显式 `null`） | 写入该值；`undefined` 归一成 `null`（"清除"） |
 *
 * 想**整体清空**时不要拼补丁 —— 用 {@link resetDocumentBinding}：它直接换成
 * {@link createEmptyBinding}，四个字段一次到位，结构上不可能漏掉 baseline/revision。
 */
export function applyDocumentBinding(
  ref: ShallowRef<DocumentBinding>,
  patch: Partial<DocumentBinding> & { sourceId: DocumentSourceId; locator: string },
): void {
  const current = ref.value
  ref.value = {
    ...current,
    ...patch,
    remoteRevisionId:
      'remoteRevisionId' in patch ? patch.remoteRevisionId ?? null : current.remoteRevisionId,
    saveBaseline: 'saveBaseline' in patch ? patch.saveBaseline ?? null : current.saveBaseline,
  }
}

/**
 * **整体清空绑定**（本地文档接管 / 无文档）。
 *
 * 语义是"当前没有任何外部文档身份"：`sourceId: 'empty'`、`locator: ''`、
 * `remoteRevisionId: null`、`saveBaseline: null` 一次写齐。
 *
 * ## 为什么必须整体替换，而不是逐字段补丁
 *
 * 四个字段**同属一份文档身份**：只清 `sourceId` 会留下旧 locator（保存确认仍以
 * 旧页为 base），只清 locator 会留下旧 revision（保存仍以旧页为 `baserevid`），
 * 不清 `saveBaseline` 则下一次"保存"会拿本地内容去推进旧 Wiki 页的基线。
 * 整体替换让"清空"在类型上就是 {@link createEmptyBinding} 这一个值，
 * 不再依赖调用方记得每个字段。
 *
 * 调用边界见 `workbench/document/pipeline#settleDocumentTakeover`。
 */
export function resetDocumentBinding(ref: ShallowRef<DocumentBinding>): void {
  ref.value = createEmptyBinding()
}

/**
 * 清除**上一份外部文档**的保存确认草稿（`pendingSaveSummary`）。
 *
 * 它只在"文档/页面已经换手"时调用（本地接管、Wiki 装载另一页、Reload）。正常当前页
 * 的保存确认仍可使用并保留自己的草稿 —— 本函数不改变那条路径。
 *
 * 用整对象替换 + 删除键（而不是写 `undefined`）：`createEmptyBinding` 里没有这个键，
 * 清理后的形状与"从未写过草稿"逐字段一致。
 */
export function clearPendingSaveSummary(ref: ShallowRef<DocumentBinding>): void {
  if (ref.value.pendingSaveSummary === undefined) return
  const next = { ...ref.value }
  delete next.pendingSaveSummary
  ref.value = next
}
