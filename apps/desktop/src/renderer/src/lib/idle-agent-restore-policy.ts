import type { AgentStatus, AgentMuxRunState } from '@agentmux/core'
import { isAgentActivityStatusSource } from '@agentmux/core/agent-status'

export type AgentStartupRecoveryDecision =
  | { kind: 'reattach' }
  | { kind: 'resume' }
  | { kind: 'pending'; reason: 'runtime-unverified' | 'idle-unknown' | 'not-idle' | 'idle-over-day' }

/** Desktop's fixed cold-start policy; timestamps and process facts remain Core-owned. */
export function agentStartupRecoveryDecision(input: {
  runState: AgentMuxRunState | 'missing'
  semanticStatus?: AgentStatus
  canonical: boolean
  now: number
}): AgentStartupRecoveryDecision {
  // Reattaching cannot start a CLI. An already healthy Run never pays an idle gate.
  if (input.runState === 'running') return { kind: 'reattach' }
  if (!input.canonical) return { kind: 'pending', reason: 'runtime-unverified' }
  const status = input.semanticStatus
  if (!status || !isAgentActivityStatusSource(status.source)) return { kind: 'pending', reason: 'idle-unknown' }
  if (status.state !== 'done') return { kind: 'pending', reason: 'not-idle' }
  const enteredAt = status.stateEnteredAt
  if (enteredAt === undefined || !Number.isFinite(enteredAt) || enteredAt < 0 || !Number.isFinite(input.now) || enteredAt > input.now) {
    return { kind: 'pending', reason: 'idle-unknown' }
  }
  return input.now - enteredAt > 24 * 60 * 60 * 1000
    ? { kind: 'pending', reason: 'idle-over-day' }
    : { kind: 'resume' }
}

export function agentStartupRecoveryDetail(decision: AgentStartupRecoveryDecision): string {
  if (decision.kind !== 'pending') return 'The Agent is not running. Send your next request or use Resume to restore it.'
  switch (decision.reason) {
    case 'runtime-unverified': return 'Runtime identity is unverified. The original Session is kept; check the host before restoring.'
    case 'idle-over-day': return 'Idle for over a day. Reading and drafting keep it stopped; your next request restores it.'
    case 'not-idle': return 'No idle completion was confirmed. Reading and drafting keep it stopped; your next request restores it.'
    case 'idle-unknown': return 'Idle time is unknown. Reading and drafting keep it stopped; your next request restores it.'
  }
}
