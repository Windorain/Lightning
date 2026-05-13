import type { OperatorType } from '@/workbench/operators/operatorType'

export const UndoOperator: OperatorType = {
  id: 'OPERATOR_UNDO',
  label: '撤销',
  description: '撤销上一步操作',

  poll(bctx) {
    return bctx.editHistory.canUndo.value
  },

  exec(bctx, _props) {
    bctx.editHistory.undo()
  },
}

export const RedoOperator: OperatorType = {
  id: 'OPERATOR_REDO',
  label: '重做',
  description: '重做已撤销的操作',

  poll(bctx) {
    return bctx.editHistory.canRedo.value
  },

  exec(bctx, _props) {
    bctx.editHistory.redo()
  },
}
