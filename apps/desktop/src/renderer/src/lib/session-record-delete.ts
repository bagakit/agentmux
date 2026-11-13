import { parseAgentSessionRecordInput, type AgentSessionRecordDeleteInput } from '@agentmux/core/agent-session-record'
import type { LocalInputTarget } from './local-retained-inputs'

export const sessionRecordDeleteKey = (target: LocalInputTarget): string => JSON.stringify([target.hostId, target.agentSessionId])

/** Only the original client request reference, never a deletion fact or input body. */
export function retainedSessionRecordDelete(value: unknown, target: LocalInputTarget):
  { state: 'missing' } | { state: 'unavailable'; issue: string } | { state: 'retained'; request: AgentSessionRecordDeleteInput } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unavailable', issue: 'The saved request collection is unconfirmed. Its original value is kept.' }
  const key = sessionRecordDeleteKey(target)
  if (!Object.hasOwn(value, key)) return { state: 'missing' }
  try {
    const request = parseAgentSessionRecordInput((value as Record<string, unknown>)[key], true) as AgentSessionRecordDeleteInput
    if (request.hostId !== target.hostId || request.agentSessionId !== target.agentSessionId || request.continue !== undefined) throw new Error('scope')
    return { state: 'retained', request }
  } catch { return { state: 'unavailable', issue: 'The original saved request could not be decoded for this target. It is kept; no replacement request was created.' } }
}

export function sameSessionRecordDelete(a: AgentSessionRecordDeleteInput, b: AgentSessionRecordDeleteInput): boolean {
  return a.hostId === b.hostId && a.agentSessionId === b.agentSessionId && a.operationId === b.operationId &&
    a.expectedRetiredAt === b.expectedRetiredAt && a.expectedRetirementRevision === b.expectedRetirementRevision
}
