import { AgentMuxError } from './errors.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent } from './types.js'

export type AgentMuxHostedSessionProjection = 'full' | 'summary'
type Admission = NonNullable<AgentMuxAgentSession['promptCompletionAdmission']>
type Intent = NonNullable<Admission['intent']>
export type AgentMuxHostedPromptIntentSummary = Pick<Intent, 'run' | 'ownerInstanceId' | 'execution'> & {
  planKind: Intent['plan']['kind']
  /** UTF-8 bytes of the frozen prompt; the original body remains at its Core owner. */
  promptBytes: number
}
export type AgentMuxHostedPromptAdmissionSummary<T = Admission> = T extends Admission ? Omit<T, 'intent'> & {
  intent?: never
  intentSummary?: AgentMuxHostedPromptIntentSummary
} : never

/** A separate read projection. Exact reads and durable storage retain AgentMuxAgentSession. */
export type AgentMuxHostedAgentSessionSummary = Omit<AgentMuxAgentSession, 'promptCompletionAdmission' | 'continuityOperations'> & {
  sessionProjection: 'summary'
  /** Historical operations stay at the Core owner and are read by exact read/inspect. */
  continuityOperations?: never
  promptCompletionAdmission?: AgentMuxHostedPromptAdmissionSummary
}
export type AgentMuxHostedSession<P extends AgentMuxHostedSessionProjection> =
  P extends 'summary' ? AgentMuxHostedAgentSessionSummary : AgentMuxAgentSession

export function isHostedAgentSessionSummary(session: AgentMuxAgentSession): session is AgentMuxHostedAgentSessionSummary {
  return 'sessionProjection' in session && session.sessionProjection === 'summary'
}

/** Display-only admission facts; exact input and Session reads retain the frozen intent. */
export function hostedPromptAdmissionSummary(original: Admission): AgentMuxHostedPromptAdmissionSummary {
  const { intent, ...admission } = original
  return { ...admission,
    ...(intent ? { intentSummary: { run: { ...intent.run }, ownerInstanceId: intent.ownerInstanceId,
      planKind: intent.plan.kind, ...(intent.execution === undefined ? {} : { execution: intent.execution }), promptBytes: new TextEncoder().encode(intent.prompt).byteLength } } : {})
  }
}

export function hostedAgentSessionSummary(session: AgentMuxAgentSession): AgentMuxHostedAgentSessionSummary {
  const { continuityOperations: _history, ...source } = session
  if (isHostedAgentSessionSummary(source)) return source
  const { promptCompletionAdmission: original, ...rest } = source
  if (!original) return { ...rest, sessionProjection: 'summary' }
  return { ...rest, sessionProjection: 'summary', promptCompletionAdmission: hostedPromptAdmissionSummary(original) }
}

export function projectHostedSessionEvent(event: AgentMuxClientEvent, projection: AgentMuxHostedSessionProjection): AgentMuxClientEvent {
  return projection === 'summary' && event.type === 'agent-session'
    ? { ...event, session: hostedAgentSessionSummary(event.session) } : event
}

/** Validate only this request's projection choice; it never changes the original Session. */
export function hostedSessionProjection(value: unknown): AgentMuxHostedSessionProjection {
  if (value === undefined || value === 'full') return 'full'
  if (value === 'summary') return value
  throw new AgentMuxError('Hosted sessions must be full or summary.', 'INVALID_CONTROL_REQUEST')
}

/** Read selection only; neither a capability nor an inventory fallback. */
export function hostedSessionIds(value: unknown, code = 'INVALID_CONTROL_REQUEST'): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id || id.includes('\0')) || new Set(value).size !== value.length) {
    throw new AgentMuxError('A scoped Runtime read requires exact, unique Session IDs.', code)
  }
  return [...value]
}
export type AgentMuxHostedSessionScope = {
  agentSessionIds: readonly string[]
  missing: string[]
  unavailable: Array<{ agentSessionId: string; code: string; message: string }>
}
