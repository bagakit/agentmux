import type { AgentMuxAgentSession } from '@agentmux/core'
import type { RuntimeEvent, SessionSnapshot } from '../../src/shared/contracts'

/** Original Core refusal shape; the production decoder derives promptInputNotApplied. */
export function questionRefusalEvent(session: Extract<SessionSnapshot, { kind: 'agent' }>, submissionId: string, updatedAt = 2): RuntimeEvent {
  const core: AgentMuxAgentSession = {
    kind: 'agent', agentSessionId: session.control.agentSessionId, hostId: session.control.hostId,
    providerId: session.providerId, executorId: session.executorId, workspacePath: session.workspacePath,
    run: session.control.run, retiredRuns: [], createdAt: session.createdAt, updatedAt,
    ...(session.turnUsage ? { turnUsage: session.turnUsage } : {}),
    promptCompletionAdmission: {
      operationId: 'original-wire', submissionId, notApplied: true, startByte: 0, endByte: 0,
      intent: { run: session.control.run, ownerInstanceId: 'private-refusal-owner', prompt: 'Original frozen answer', plan: { kind: 'single-phase', data: 'Original frozen answer\r' } }
    }
  }
  return { type: 'core', hostId: session.control.hostId, event: { type: 'agent-session', session: core } }
}
