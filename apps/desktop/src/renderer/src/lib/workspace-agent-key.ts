import type { SessionSnapshot } from '../../../shared/contracts'

export function workspaceAgentOrderKey(session: { hostId: string; id: string; control?: SessionSnapshot['control'] }): string {
  return session.control?.kind === 'agent' ? JSON.stringify([session.control.hostId, session.control.agentSessionId]) : JSON.stringify([session.hostId, session.id])
}
