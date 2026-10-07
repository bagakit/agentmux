import type { AgentMuxAgentSession, AgentMuxRunState } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { currentAgentSemanticStatus, observeAgent } from '@agentmux/core/agent-status'

/** Controlled original Runtime facts; the shared Core function computes their meaning. */
export function activityStatus(session: AgentMuxAgentSession, process: AgentMuxRunState = 'running'): Awaited<ReturnType<AgentMuxHostedClient['statusAgent']>> {
  const capabilities = { terminal: true, timeline: 'complete-events' as const, permission: 'observe' as const, providerResume: true, replyCorrelation: 'none' as const }
  const observedAt = Date.now()
  return {
    session,
    run: { ...session.run, kind: 'agent', providerId: session.providerId, executorId: session.executorId, agentSessionId: session.agentSessionId,
      workspacePath: session.workspacePath, pid: null, state: process, cols: null, rows: null, observedAt, latestOutputBytes: 0, acceptedInputBytes: null, nativeService: null },
    capabilities,
    observation: observeAgent({ process, status: currentAgentSemanticStatus(session.semanticStatus) ?? { state: 'running', source: 'run-process', observedAt },
      retainedStatus: session.semanticStatus, timelineCapability: capabilities.timeline, awaitingRequest: session.pendingInteraction !== undefined, terminalCapabilityUnverified: session.terminalCapability !== undefined }, observedAt)
  }
}
