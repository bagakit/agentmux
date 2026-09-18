import type { AgentMuxAgentSession } from '@agentmux/core'
import type { SessionSnapshot } from '../../src/shared/contracts'

/** Explicit synthetic creation identity for tests that already supply a Session projection. */
export function agentCreationFixture(session: Extract<SessionSnapshot, { kind: 'agent' }>): AgentMuxAgentSession {
  return { kind: 'agent', agentSessionId: session.id, providerId: session.providerId, executorId: session.executorId,
    hostId: session.hostId, workspacePath: session.workspacePath, run: session.control.run, retiredRuns: [],
    createdAt: session.createdAt, updatedAt: session.updatedAt }
}
