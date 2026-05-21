import type { OperatorType } from '@/workbench/operators/operatorType'

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
