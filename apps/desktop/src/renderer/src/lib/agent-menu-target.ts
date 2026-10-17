import type { AgentSessionControl, SessionSnapshot } from '../../../shared/contracts'

/** A presentation address and its original execution control are distinct identities. */
export type AgentMenuTarget = { id: string; hostId: string; control?: AgentSessionControl }

export function agentMenuSession(sessions: readonly SessionSnapshot[], target: AgentMenuTarget | null | undefined) {
  const control = target?.control
  if (!target || !control) return undefined
  return sessions.find((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent' &&
    session.id === target.id && session.hostId === target.hostId &&
    session.control.hostId === control.hostId && session.control.agentSessionId === control.agentSessionId)
}

export function agentMenuRunMatches(session: ReturnType<typeof agentMenuSession>, control: AgentSessionControl): boolean {
  return Boolean(session && !session.runUnobserved && session.control.run.runId === control.run.runId)
}

export function retainAgentMenuTarget(target: AgentMenuTarget & { control: AgentSessionControl }) {
  return { id: target.id, hostId: target.hostId, control: { ...target.control, run: { ...target.control.run } } }
}
