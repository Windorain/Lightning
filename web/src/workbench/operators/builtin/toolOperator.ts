import type { OperatorType } from '@/workbench/operators/operatorType'

export const ToolSetOperator: OperatorType = {
  id: 'OPERATOR_TOOL_SET',
  label: '切换工具',
  description: '激活指定工具',

  exec(bctx, props) {
    const toolId = props.toolId as string
    if (!toolId) return
    bctx.toolRegistry.activate(toolId, bctx)
    if (props.brushId) {
      // Set the appropriate brush setting based on the activated tool
      if (toolId === 'OPERATOR_FILL') {
        bctx.settings.fillBrush = props.brushId as string
      } else {
        bctx.settings.replaceBrush = props.brushId as string
      }
    }
  },
}
