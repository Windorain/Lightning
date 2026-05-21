import type { OperatorType } from '@/workbench/operators/operatorType'

export const ToolSetOperator: OperatorType = {
  id: 'OPERATOR_TOOL_SET',
  label: '切换工具',
  description: '激活指定工具',

  exec(bctx, props) {
    const toolId = props.toolId as string
    if (!toolId) return
    bctx.toolRegistry.activate(toolId)
  },
}
