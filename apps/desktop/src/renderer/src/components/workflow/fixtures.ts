import type { WorkflowAgent, WorkflowPhase, WorkflowSnapshot } from './types'

function agent(id: string, status: WorkflowAgent['status'], overrides: Partial<WorkflowAgent> = {}): WorkflowAgent {
  const base: WorkflowAgent = {
    id,
    label: id,
    status,
    model: status === 'queued' ? 'haiku-4.5' : 'opus-5[1m]',
    attempts: id.includes('db') ? 2 : 1,
    queuedAt: '21:02:10'
  }
  if (status !== 'queued') {
    base.lastTool = id.includes('security') ? 'Grep' : 'Read'
    base.duration = '1m 02s'
    base.tokens = '21k'
    base.toolCalls = 4
    base.startedAt = '21:02:12'
    base.lastActivityAt = '21:03:14'
  }
  return { ...base, ...overrides }
}

const reviewAgents: readonly WorkflowAgent[] = [
  agent('review:bugs', 'completed', { duration: '2m 10s', tokens: '48k' }),
  agent('review:perf', 'completed', { lastTool: 'Grep', duration: '1m 48s', tokens: '39k' }),
  agent('review:security', 'running'),
  agent('review:tests', 'queued')
]

const verifyAgents: readonly WorkflowAgent[] = [
  agent('verify:auth.ts', 'completed', { model: 'haiku-4.5', lastTool: 'Bash', duration: '1m 20s', tokens: '31k' }),
  agent('verify:api.ts', 'completed', { model: 'haiku-4.5', duration: '1m 05s', tokens: '27k' }),
  agent('verify:db.ts', 'running', { model: 'haiku-4.5', lastTool: 'Bash', duration: '0m 41s', tokens: '12k', attempts: 2 }),
  agent('verify:ui.ts', 'queued'),
  agent('verify:cli.ts', 'queued'),
  agent('verify:docs.ts', 'queued')
]

function phase(id: string, label: string, status: WorkflowPhase['status'], completed: number, total: number, agents: readonly WorkflowAgent[], extra: Partial<WorkflowPhase> = {}): WorkflowPhase {
  return { id, label, status, completed, total, agents, ...extra }
}

export const runningWorkflow: WorkflowSnapshot = {
  id: 'review-changes-running',
  name: 'review-changes',
  status: 'running',
  completedAgents: 4,
  totalAgents: 11,
  duration: '3m 42s',
  tokens: '312k',
  toolCalls: 87,
  current: 'Review: review:security',
  phases: [
    phase('review', 'Review', 'running', 2, 4, reviewAgents, { elapsed: '1 运行中 · 3m 42s', defaultExpanded: true, current: 'review:security' }),
    phase('verify', 'Verify', 'running', 2, 6, verifyAgents, { elapsed: '1 运行中 · 2m 08s', defaultExpanded: true }),
    phase('synthesize', 'Synthesize', 'queued', 0, 1, [agent('synthesize', 'queued')], { elapsed: '全部排队中' })
  ]
}

export const completedWorkflow: WorkflowSnapshot = {
  ...runningWorkflow,
  id: 'review-changes-completed',
  status: 'completed',
  completedAgents: 11,
  duration: '4m 58s',
  tokens: '412k',
  toolCalls: 106,
  phases: runningWorkflow.phases.map((item) => ({ ...item, status: 'completed', completed: item.total, agents: item.agents.map((item) => ({ ...item, status: 'completed' })) }))
}

export const failedWorkflow: WorkflowSnapshot = {
  ...runningWorkflow,
  id: 'review-changes-failed',
  status: 'failed',
  completedAgents: 9,
  duration: '6m 01s',
  tokens: '388k',
  toolCalls: 94,
  result: 'Dynamic workflow "review-changes" failed',
  phases: runningWorkflow.phases.map((item, index) => ({ ...item, status: index === 0 ? 'failed' : item.status, agents: item.agents.map((agent) => agent.id === 'review:security' ? { ...agent, status: 'failed', attempts: 2 } : agent) }))
}

export const killedWorkflow: WorkflowSnapshot = {
  ...runningWorkflow,
  id: 'review-changes-killed',
  status: 'killed',
  completedAgents: 6,
  duration: '2m 05s',
  tokens: '168k',
  toolCalls: 46,
  current: '用户已停止',
  phases: runningWorkflow.phases.slice(0, 2)
}

export const pausedWorkflow: WorkflowSnapshot = {
  ...runningWorkflow,
  id: 'review-changes-paused',
  status: 'paused',
  completedAgents: 5,
  duration: '4m 12s',
  tokens: '205k',
  toolCalls: 61,
  phases: runningWorkflow.phases.slice(0, 2)
}

export const largeWorkflow: WorkflowSnapshot = {
  ...runningWorkflow,
  id: 'kb-eval-afs-question-gen',
  name: 'kb-eval-afs-question-gen',
  completedAgents: 14,
  totalAgents: 53,
  duration: '18m 14s',
  tokens: '2.4M',
  toolCalls: 612,
  current: 'Gate2: gate2:q-0012',
  phases: [phase('gate2', 'Gate2', 'running', 9, 16, [
    ...Array.from({ length: 9 }, (_, index) => agent(`gate2:q-${String(index + 1).padStart(4, '0')}`, 'completed', { model: 'haiku-4.5', lastTool: index === 5 ? 'Grep' : 'Read', duration: `0m ${35 + index}s`, tokens: `${8 + index}.1k` })),
    agent('gate2:q-0010', 'running', { model: 'haiku-4.5', lastTool: 'Grep', duration: '0m 49s', tokens: '7.2k' }),
    agent('gate2:q-0011', 'running', { model: 'haiku-4.5', duration: '0m 44s', tokens: '6.8k' }),
    agent('gate2:q-0012', 'running', { model: 'haiku-4.5', lastTool: 'Bash', duration: '0m 31s', tokens: '5.1k' }),
    agent('gate2:q-0013', 'running', { model: 'haiku-4.5', duration: '0m 18s', tokens: '3.4k' }),
    ...Array.from({ length: 3 }, (_, index) => agent(`gate2:q-${String(index + 14).padStart(4, '0')}`, 'queued')),
    ...Array.from({ length: 37 }, (_, index) => agent(`gate2:q-${String(index + 17).padStart(4, '0')}`, 'queued'))
  ], { elapsed: '4 运行中 · 11m 43s', defaultExpanded: true }), phase('gate3', 'Gate3', 'queued', 0, 16, [], { elapsed: '全部排队中' }), phase('judge', 'Judge', 'queued', 0, 16, [], { elapsed: '全部排队中' })]
}

export const legacyDaemonWorkflow: WorkflowSnapshot = {
  id: 'legacy-review-changes',
  name: 'review-changes',
  status: 'running',
  completedAgents: 0,
  totalAgents: 0,
  duration: '2m 13s',
  tokens: '—',
  toolCalls: 0,
  phases: [],
  legacyNotice: 'daemon 版本较旧，暂无阶段明细'
}
