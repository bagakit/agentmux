import type { AgentInteractionLabels } from '@agentmux/client-ui/components/AgentInteractionCard'

export const mobileInteractionLabels: AgentInteractionLabels = {
  readOnly: '只读 · 请回到对应对话答复', sending: '正在发送答复…', completed: '请求已完成',
  unknown: '答复是否送达尚未确认', saved: '答复已保存 · 投递待确认', awaiting: '已答复 · 等待确认',
  pending: '等待确认', unavailable: '暂时无法答复 · 可查看对话', needed: '需要你答复',
  inspect: '核对这次答复', details: '详情', tool: '工具', terminal: '查看终端',
  retry: '可选择同一选项重试。', cancel: '取消', question: 'Agent 提问',
  permission: 'Agent 权限请求', native: '此请求需要在终端确认'
}
