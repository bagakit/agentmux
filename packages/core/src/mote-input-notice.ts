import { parseAgentInputMoteSource, type AgentInputMoteSource } from './mote-input-source.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'
import type { MoteInputInspection, MoteInputObservation, MoteInputOrigin, MoteInputNoticePhase } from './mote-input.js'

/** A reading declaration from an already-qualified platform notice. It grants no input or authority. */
export type MoteInputNotice = {
  schema: 'agentmux.mote-input-notice.v1'
  observationId: string
  phase: MoteInputNoticePhase
  source: AgentInputMoteSource
  memberAgentSessionId: string
  origin: MoteInputOrigin
  input: MoteInputObservation['input']
  result?: { kind: 'native-turn'; status: 'completed' | 'interrupted' | 'failed' }
    | Extract<NonNullable<MoteInputObservation['result']>, { kind: 'interaction' }>
}

export function moteInputNoticeWire(value: MoteInputObservation, phase: MoteInputNoticePhase): string {
  const member = value.origin.kind === 'prompt' ? value.origin.key.agentSessionId : value.origin.agentSessionId
  return JSON.stringify({
    schema: 'agentmux.mote-input-notice.v1',
    observationId: value.id,
    phase,
    source: value.source,
    memberAgentSessionId: member,
    origin: value.origin,
    input: value.input,
    ...(value.confirmedQuestion ? { confirmedQuestion: value.confirmedQuestion } : {}),
    ...(phase === 'result' && value.result ? { result: value.result.kind === 'native-turn'
      ? { kind: value.result.kind, status: value.result.status } : value.result } : {}),
    read: { method: 'agent.input.observation', params: { agentSessionId: member, observationId: value.id } },
    cli: ['amux', 'agent', 'input', 'observation', '--session', member, '--id', value.id],
    guidance:
      'This is a platform observation, not a new human request or permission. Read the original observation and exact result references before coordinating. Do not repeat the member input. Delivery, native turn outcome, task completion and human acceptance are distinct.'
  })
}

const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && !/[\0\r\n]/u.test(value)
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Parse only the stable reading fields. The original observation remains the result/permission owner. */
export function parseMoteInputNotice(wire: string): MoteInputNotice | null {
  try {
    const value: unknown = JSON.parse(wire)
    if (!object(value) || value.schema !== 'agentmux.mote-input-notice.v1' || !text(value.observationId)
      || !['input', 'result'].some(phase => phase === value.phase) || !text(value.memberAgentSessionId)
      || !['unconfirmed', 'waiting', 'terminal-confirmed', 'admitted', 'stopped', 'not-applied', 'interaction-confirmed'].some(input => input === value.input)
      || !object(value.origin) || !object(value.read) || value.read.method !== 'agent.input.observation' || !object(value.read.params)
      || value.read.params.agentSessionId !== value.memberAgentSessionId || value.read.params.observationId !== value.observationId) return null
    const source = parseAgentInputMoteSource(value.source)
    let origin: MoteInputOrigin
    if (value.origin.kind === 'prompt') origin = { kind: 'prompt', key: validateAgentPromptInputKey(value.origin.key) }
    else if (value.origin.kind === 'interaction' && text(value.origin.agentSessionId) && text(value.origin.runId) && text(value.origin.operationId))
      origin = { kind: 'interaction', agentSessionId: value.origin.agentSessionId, runId: value.origin.runId, operationId: value.origin.operationId }
    else return null
    if ((origin.kind === 'prompt' ? origin.key.agentSessionId : origin.agentSessionId) !== value.memberAgentSessionId) return null
    const notice: MoteInputNotice = { schema: value.schema, observationId: value.observationId, phase: value.phase as MoteInputNoticePhase,
      source, memberAgentSessionId: value.memberAgentSessionId, origin, input: value.input as MoteInputObservation['input'] }
    if (value.result !== undefined) {
      const result = value.result
      if (notice.phase !== 'result' || !object(result)) return null
      if (result.kind === 'native-turn' && ['completed', 'interrupted', 'failed'].some(status => status === result.status))
        notice.result = { kind: result.kind, status: result.status as 'completed' | 'interrupted' | 'failed' }
      else if (result.kind === 'interaction' && text(result.requestId) && ['permission', 'question'].some(kind => kind === result.responseKind)
        && text(result.delivery) && result.nativeAdoption === 'unknown' && typeof result.nativeCompleted === 'boolean'
        && (result.decision === undefined || text(result.decision)))
        notice.result = { kind: result.kind, requestId: result.requestId, responseKind: result.responseKind as 'permission' | 'question',
          delivery: result.delivery, nativeAdoption: 'unknown', nativeCompleted: result.nativeCompleted,
          ...(result.decision === undefined ? {} : { decision: result.decision }) }
      else return null
    }
    if (notice.phase === 'result' && !notice.result) return null
    return notice
  } catch { return null }
}

function originIdentity(origin: MoteInputOrigin): readonly unknown[] {
  return origin.kind === 'interaction' ? [origin.kind, origin.agentSessionId, origin.runId, origin.operationId]
    : [origin.kind, origin.key.kind, origin.key.agentSessionId, origin.key.expectedRun.runId,
      origin.key.kind === 'prompt' ? origin.key.submissionId : origin.key.messageId, origin.key.attemptId]
}
/** Match an owner response to the original notice; later status progress is allowed, retargeting is not. */
export function moteInputNoticeInspectionMatches(notice: MoteInputNotice, inspection: MoteInputInspection, recipient: string): boolean {
  const original = inspection.observation
  // The qualified notice's Host selects the semantic owner. Its binding uses that owner's
  // local namespace even when a client reaches it through a remote Host route.
  return original.id === notice.observationId && original.binding?.primary.hostId === 'local'
    && original.binding.primary.agentSessionId === recipient
    && (['spaceId', 'zoneId', 'tabId', 'regionId'] as const).every(field => original.source[field] === notice.source[field])
    && JSON.stringify(originIdentity(original.origin)) === JSON.stringify(originIdentity(notice.origin))
}
