import type { OperatorType } from '@/workbench/operators/operatorType'
import { OP_RESULT } from '@/workbench/operators/operatorType'
import { pickVoxel } from '@/workbench/context/sceneQueries'
import { setReplaceBrush, setFillBrush } from './brushState'

export const EyedropperOperator: OperatorType = {
  id: 'OPERATOR_EYEDROPPER',
  label: '拾色器',
  description: '点击方块拾取类型，设为替换/填充笔刷',

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  invoke(bctx, _props, event) {
    if (!(event instanceof PointerEvent)) return OP_RESULT.CANCELLED
    const picked = pickVoxel(bctx, event)
    if (!picked) return OP_RESULT.CANCELLED
    setReplaceBrush(picked.block_state_id)
    setFillBrush(null)
    return OP_RESULT.FINISHED
  },
}
