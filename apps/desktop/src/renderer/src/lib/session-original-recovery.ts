import type { AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import type { SessionSnapshot } from '../../../shared/contracts'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>

/** The current pointer is a view; original operations remain owned by Core's retained map. */
function originalOperations(session: Agent): AgentMuxContinuityOperation[] {
  const operations = new Map(Object.entries(session.continuityOperations ?? {}))
  if (session.continuity && !operations.has(session.continuity.operationId)) operations.set(session.continuity.operationId, session.continuity)
  return [...operations.values()].filter(operation => operation.agentSessionId === session.control.agentSessionId)
}

function uniqueOriginal(operations: AgentMuxContinuityOperation[]): AgentMuxContinuityOperation | undefined {
  if (operations.length > 1) throw new Error('Several original recovery operations match this Run. Re-read their original receipts before starting another operation.')
  return operations[0]
}

export function originalSessionRestart(session: Agent): AgentMuxContinuityOperation | undefined {
  return uniqueOriginal(originalOperations(session).filter(operation => operation.action === 'restart' &&
    operation.kind !== 'resumed' && operation.kind !== 'retired' &&
    !(operation.kind === 'unavailable' && operation.errorCode === 'AGENT_TERMINAL_HANDSHAKE_FAILED' && operation.newRun) &&
    (operation.previousRun.runId === session.control.run.runId || operation.newRun?.runId === session.control.run.runId)))
}

export function originalFrontendRecovery(session: Agent): AgentMuxContinuityOperation | undefined {
  const frontend = session.terminalFrontend
  if (!frontend || frontend.run.runId !== session.control.run.runId) return undefined
  return uniqueOriginal(originalOperations(session).filter(operation => operation.previousRun.runId === session.control.run.runId &&
    operation.frontendReconnect?.previousFrontendId === frontend.frontendId))
}
