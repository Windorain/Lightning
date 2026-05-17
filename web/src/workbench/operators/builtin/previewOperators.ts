import type { OperatorType } from '@/workbench/operators/operatorType'

export const SyncPreviewOperator: OperatorType = {
  id: 'OPERATOR_SYNC_PREVIEW',
  label: '同步预览',
  description: '从当前场景数据重建 View3DConfig',

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  async exec(bctx, _props) {
    await bctx.scene.syncPreview()
  },
}

export const SetFrameIndexOperator: OperatorType = {
  id: 'OPERATOR_SET_FRAME_INDEX',
  label: '设置帧索引',
  description: '在多帧场景中切换当前帧',

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  exec(bctx, _props) {
    const index = _props.index as number
    bctx.scene.setPreviewWorldFrameIndex(index)
  },
}
