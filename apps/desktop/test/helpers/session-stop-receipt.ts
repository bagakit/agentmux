import type { AgentMuxAgentStopReceipt } from '@agentmux/core'
import type { AgentSessionControl } from '../../src/shared/contracts'

/** Confirm the same original operation in UI transport fixtures; void is not an Agent Stop receipt. */
export function sessionStopReceipt(control: AgentSessionControl, operationId: string): AgentMuxAgentStopReceipt {
  const observedAt = Date.now()
  return { agentSessionId: control.agentSessionId, expectedRun: { ...control.run }, operationId,
    lifecycleOperationId: `stop:${operationId}`, admission: 'new', runtime: { observed: 'running', stop: 'graceful' }, retiredAt: observedAt,
    stages: [{ stage: 'retire-commit', startedAt: observedAt, endedAt: observedAt, outcome: 'ok' }] }
}
