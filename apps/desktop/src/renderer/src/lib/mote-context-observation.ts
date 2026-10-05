import { AgentMuxError, moteContextOperationMatches, parseMoteContextObservation,
  type AgentMuxControlInspectMoteContextRequest, type AgentMuxMoteContextObservation } from '@agentmux/core/control'
import { contextOperationKey, moteContextOperationSchema, type MoteContextOperations } from '../../../shared/mote-context-observation'

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** Exact lookup of the original action facts. No files, preparation or UI transition. */
export function observeMoteContextOperation(operations: MoteContextOperations,
  request: AgentMuxControlInspectMoteContextRequest): AgentMuxMoteContextObservation {
  const query = request.target
  const original = operations[contextOperationKey({ ...query.scope,
    reference: query.action === 'open-space' ? query.reference : null }, query.action)]
  const result: AgentMuxMoteContextObservation = { schema: 'agentmux.mote-context-observation.v1', target: query,
    data: null, raw: { retention: 'unknown', returned: 'unavailable', truncated: null }, issue: null }
  if (!original) return result
  const parsed = moteContextOperationSchema.safeParse(original)
  if (!parsed.success || !moteContextOperationMatches(query, parsed.data)) {
    throw new AgentMuxError('The original Mote context source is invalid for this exact scope.', 'CONTROL_PROTOCOL_ERROR')
  }
  const source = parsed.data, failure = source.failure
  const target = (v: typeof source.target) => ({ ...v, reference: v.reference ? { ...v.reference } : null })
  result.data = { kind: 'mote-context-client', operation: { target: target(source.target), action: source.action,
    state: source.state, startedAt: source.startedAt, settledAt: source.settledAt,
    failure: failure ? { step: failure.step, observedAt: failure.observedAt, target: target(failure.target) } : null },
    original: null, coverage: 'latest-per-scope-action', omissions: [] }
  result.raw = { retention: failure ? 'retained' : 'not-retained', returned: failure ? 'withheld' : 'unavailable', truncated: null }
  // Validate the captured failure too; a correct map key cannot bless a wrong source.
  parseMoteContextObservation(result, query, false)
  if (bytes(result) > request.maxBytes) return { ...result, data: null, issue: 'query-budget' }
  // Default reads do not send arbitrary cause text across the Renderer/Main boundary.
  if (request.includeRaw && failure) {
    result.data.original = { cause: failure.cause }; result.raw.returned = 'included'
    if (bytes(result) > request.maxBytes) {
      result.data.original = null; result.data.omissions.push('raw-query-budget'); result.raw.returned = 'withheld'
    }
  }
  return result
}
