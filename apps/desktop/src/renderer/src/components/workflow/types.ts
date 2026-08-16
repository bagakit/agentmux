export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'killed' | 'paused'
export type WorkflowAgentStatus = WorkflowStatus | 'queued'

export type WorkflowAgent = {
  id: string
  label: string
  status: WorkflowAgentStatus
  model?: string
  lastTool?: string
  duration?: string
  tokens?: string
  attempts?: number
  toolCalls?: number
  queuedAt?: string
  startedAt?: string
  lastActivityAt?: string
}

export type WorkflowPhase = {
  id: string
  label: string
  completed: number
  total: number
  status: WorkflowAgentStatus
  elapsed?: string
  current?: string
  agents: readonly WorkflowAgent[]
  defaultExpanded?: boolean
}

export type WorkflowSnapshot = {
  id: string
  name: string
  status: WorkflowStatus
  completedAgents: number
  totalAgents: number
  duration: string
  tokens: string
  toolCalls: number
  current?: string
  result?: string
  phases: readonly WorkflowPhase[]
  legacyNotice?: string
}

export type WorkflowVariant = 'inline' | 'dock'

export const WORKFLOW_STATUS_LABEL: Record<WorkflowStatus | 'queued', string> = {
  running: '运行中',
  completed: '已完成',
  failed: '已失败',
  killed: '已终止',
  paused: '暂停',
  queued: '排队中'
}

export function workflowStatusLabel(status: WorkflowStatus | 'queued'): string {
  return WORKFLOW_STATUS_LABEL[status]
}

export function isQuietWorkflowAgent(agent: WorkflowAgent): boolean {
  return agent.status === 'queued' || agent.status === 'completed'
}

/**
 * Keep every active/failed item visible and only collapse a contiguous quiet tail.
 * This is the same information-preserving rule used by the reference page: a large
 * workflow may remain taller than twelve rows when that is the cost of showing all
 * live or failed work, but it never hides an item that needs attention.
 */
export function visibleWorkflowAgents(agents: readonly WorkflowAgent[], maxRows = 12): {
  visible: readonly WorkflowAgent[]
  hiddenCount: number
} {
  if (agents.length <= maxRows) return { visible: agents, hiddenCount: 0 }
  let quietTailStart = agents.length
  while (quietTailStart > 0 && isQuietWorkflowAgent(agents[quietTailStart - 1]!)) quietTailStart -= 1
  if (quietTailStart === agents.length) return { visible: agents, hiddenCount: 0 }
  return {
    visible: agents.slice(0, quietTailStart),
    hiddenCount: agents.length - quietTailStart
  }
}
