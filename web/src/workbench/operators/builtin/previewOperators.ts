import type { OperatorType } from '@/workbench/operators/operatorType'

/** @deprecated syncPreview is no longer needed — EmbedPayload is built on-demand. Kept as no-op for backward compat. */
export const SyncPreviewOperator: OperatorType = {
  id: 'OPERATOR_SYNC_PREVIEW',
  label: '同步预览',
  description: '已废弃 — 嵌入 payload 按需构建',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  exec(_bctx, _props) {
    // No-op: EmbedPayload is built on-demand when Wiki workspace opens or export happens
  },
}

export const SetFrameIndexOperator: OperatorType = {
  id: 'OPERATOR_SET_FRAME_INDEX',
  label: '设置帧索引',
  description: '在多帧场景中切换当前帧',

  poll(bctx) {
    return bctx.doc.value !== null
  },

  exec(bctx, _props) {
    const index = _props.index as number
    const i = Math.floor(index)
    bctx.currentWorldFrameIndex.value = Number.isFinite(i) && i >= 0 ? i : 0
  },
}
