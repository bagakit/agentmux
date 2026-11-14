import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { optionalInputEpoch } from './agent-prompt-condition.js'
import { parseGoalAgentReference, parseGoalQualifiedAccess, type GoalQualifiedAccess } from './goal-agent-reference.js'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'

/** A freshness read for one new intent; no Goal operation, Run or input is admitted. */
export type GoalInputEpochInput = { agentReference: DemandSpaceMemberReference; access: GoalQualifiedAccess }
export type GoalInputEpoch = { runtimeId: string; inputEpoch: string | null }
export function parseGoalInputEpochInput(value: unknown): GoalInputEpochInput {
  const p = rpcRecord(value, ['agentReference', 'access']), agentReference = parseGoalAgentReference(p.agentReference)
  if (typeof agentReference === 'string') throw new AgentMuxError('Read the original qualified Source member, not a raw Session ID.', 'INVALID_CONTROL_REQUEST')
  return { agentReference, access: parseGoalQualifiedAccess(p.access) }
}
export function parseGoalInputEpoch(value: unknown, input: GoalInputEpochInput): GoalInputEpoch {
  const p = rpcRecord(value, ['runtimeId', 'inputEpoch'], 'CONTROL_PROTOCOL_ERROR')
  const runtimeId = rpcString(p.runtimeId, 'Original Goal execution Runtime')
  if (runtimeId !== input.agentReference.execution.runtimeId || p.inputEpoch !== null && typeof p.inputEpoch !== 'string') throw new AgentMuxError('The input cut belongs to another or unconfirmed original execution owner.', 'CONTROL_PROTOCOL_ERROR')
  return { runtimeId, inputEpoch: p.inputEpoch === null ? null : optionalInputEpoch(p.inputEpoch).inputEpoch! }
}
