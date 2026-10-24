import { parseConnectionDeliveryObservation, parseConnectionDeliverySourceObservation } from './connection-delivery-codec.js'
import { parseConnectionObservation } from './connection-record-codec.js'
import { parseConnectionServiceState } from './connection-service-codec.js'
import { AgentMuxError } from './errors.js'
import { parseIngressContextObservation } from './ingress-codec.js'
import { connectionDiagnosisIntakeCodes, connectionDiagnosisRecordingCodes, connectionDiagnosisSourceCodes, connectionDiagnosisWindowLimit, type ConnectionDiagnosis, type ConnectionDiagnosisInput, type ConnectionDiagnosisIntake, type ConnectionDiagnosisReading, type ConnectionGroupDiagnosis } from './connection-diagnosis-contract.js'

function fail(): never { throw new AgentMuxError('The bounded connection diagnosis is malformed or belongs to another target.', 'INVALID_CONNECTION_DIAGNOSIS') }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !fields.includes(key))) return fail()
  return p
}
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) return fail(); return value }
function id(value: unknown): string { const s = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(s)) return fail(); return s }
function count(value: unknown, minimum = 0): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) return fail(); return value as number }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return fail(); return value }
function member<T extends string>(value: unknown, choices: readonly T[]): T { if (!choices.includes(value as T)) return fail(); return value as T }
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value) }
/** The original safe waiting tuple; never includes its private failure or input reference. */
export function parseConnectionDiagnosisWaiting(value: unknown): ConnectionDiagnosisIntake['waiting'] {
  return nullable(value, value => {
    const w = object(value, ['phase', 'reason', 'wake']), phase = member(w.phase, ['runtime', 'session', 'authorization', 'observer', 'native-environment', 'input-environment', 'service'] as const)
    const reasons = { runtime: ['runtime-unavailable'], session: ['session-resume-needed'], authorization: ['author-authorization-needed'], observer: ['observer-stopped'], 'native-environment': ['original-environment-unconfirmed', 'original-target-changed'], 'input-environment': ['original-input-unconfirmed', 'original-target-changed'], service: ['observation-failed'] } as const
    const reason = member(w.reason, reasons[phase] as readonly import('./agent-input-wait.js').AgentInputWaitReason['reason'][]), wake = member(w.wake, ['runtime-restored', 'session-restored', 'explicit-rejoin'] as const)
    if (!(phase === 'service' && wake === 'session-restored') && wake !== (phase === 'runtime' ? 'runtime-restored' : phase === 'session' ? 'session-restored' : 'explicit-rejoin')) return fail()
    return { phase, reason, wake }
  })
}
function array<T>(value: unknown, parse: (value: unknown) => T, max = connectionDiagnosisWindowLimit): T[] { if (!Array.isArray(value) || value.length > max) return fail(); return value.map(parse) }
function reading<T>(value: unknown, parse: (value: unknown) => T): ConnectionDiagnosisReading<T> {
  const p = object(value, ['value', 'issue']), issue = nullable(p.issue, value => member(value, ['read-unavailable', 'target-unconfirmed'] as const))
  if (p.value === null ? issue === null : issue !== null) return fail()
  return { value: nullable(p.value, parse), issue }
}
export function parseConnectionDiagnosisInput(value: unknown): ConnectionDiagnosisInput {
  const p = object(value, ['executionHostId', 'agentSessionId', 'bindingId', 'bindingRevision', 'afterBindingId', 'after', 'afterContent', 'beforeIngressId'])
  const result: ConnectionDiagnosisInput = { executionHostId: id(p.executionHostId), agentSessionId: id(p.agentSessionId) }
  for (const key of ['bindingId', 'afterBindingId', 'beforeIngressId'] as const) if (p[key] !== undefined) result[key] = id(p[key])
  for (const key of ['after', 'afterContent'] as const) if (p[key] !== undefined) result[key] = text(p[key])
  if (p.bindingRevision !== undefined) result.bindingRevision = count(p.bindingRevision, 1)
  if (!result.bindingId && ['bindingRevision', 'after', 'afterContent', 'beforeIngressId'].some(key => p[key] !== undefined) || result.bindingId && result.afterBindingId) return fail()
  return result
}
function scope(value: unknown) {
  const p = object(value, ['input', 'publication'])
  return { input: member(p.input, ['mentions-and-replies', 'all-messages'] as const), publication: member(p.publication, ['future-native-user-facing', 'future-shared-conversation'] as const) }
}
const deliveryReasons = ['effect-unconfirmed', 'platform-rejected', 'adapter-unavailable', 'platform-unavailable', 'rate-limited', 'thread-unavailable', 'unsupported-format', 'binding-revised', 'original-speech-withdrawn', 'outside-conversation-scope', 'private-content', 'public-content-unconfirmed', 'version-unavailable'] as const
function fingerprint(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return fail(); return value }
function association(value: unknown) {
  const a = object(value, ['sourceKey', 'recordKey', 'eventKey', 'partKey'])
  return { sourceKey: nullable(a.sourceKey, fingerprint), recordKey: nullable(a.recordKey, fingerprint), eventKey: nullable(a.eventKey, fingerprint), partKey: nullable(a.partKey, fingerprint) }
}
function sourceGap(value: unknown) {
  const g = object(value, ['gapKey', 'reason', 'code', 'codeRecorded', 'sourceKind', 'association'])
  const code = nullable(g.code, value => member(value, connectionDiagnosisSourceCodes)), codeRecorded = bool(g.codeRecorded)
  if (code !== null && !codeRecorded) return fail()
  return { gapKey: fingerprint(g.gapKey), reason: member(g.reason, ['public-content-unconfirmed', 'transport-unsupported', 'resource-unavailable', 'start-cut-unconfirmed', 'source-gap', 'version-unavailable'] as const),
    code, codeRecorded, association: association(g.association), sourceKind: nullable(g.sourceKind, value => member(value, ['captured', 'native', 'native-unavailable'] as const)) }
}
function group(value: unknown, request: ConnectionDiagnosisInput): ConnectionGroupDiagnosis {
  const p = object(value, ['target', 'window', 'limit', 'adapterService', 'connection', 'binding', 'outgoing', 'incoming']), t = object(p.target, ['bindingId', 'bindingRevision', 'publicationRevision', 'connectionId', 'domain', 'appId', 'externalConversationId', 'executionHostId', 'agentSessionId'])
  const target = { bindingId: id(t.bindingId), bindingRevision: count(t.bindingRevision, 1), publicationRevision: count(t.publicationRevision, 1), connectionId: id(t.connectionId), domain: text(t.domain), appId: text(t.appId), externalConversationId: text(t.externalConversationId), executionHostId: id(t.executionHostId), agentSessionId: id(t.agentSessionId) }
  if (target.publicationRevision > target.bindingRevision) return fail()
  if (target.executionHostId !== request.executionHostId || target.agentSessionId !== request.agentSessionId || request.bindingId && target.bindingId !== request.bindingId || request.bindingRevision && target.bindingRevision !== request.bindingRevision || p.limit !== connectionDiagnosisWindowLimit) return fail()
  const window = object(p.window, ['after', 'afterContent', 'beforeIngressId'])
  if (['after', 'afterContent', 'beforeIngressId'].some(key => window[key] !== request[key as keyof ConnectionDiagnosisInput])) return fail()
  const adapterService = reading(p.adapterService, value => {
    const state = parseConnectionServiceState(value)
    if (!state.adapterId) return fail()
    return { adapterId: state.adapterId, enabled: state.enabled, revision: state.revision }
  })
  const connection = reading(p.connection, value => {
    const c = object(value, ['revision', 'enabled', 'authentication', 'transport', 'intake', 'delivery'])
    return { revision: count(c.revision, 1), enabled: bool(c.enabled), ...parseConnectionObservation({ authentication: c.authentication, transport: c.transport, intake: c.intake, delivery: c.delivery }) }
  })
  const binding = reading(p.binding, value => {
    const b = object(value, ['state', 'currentRevision', 'scope', 'activeInputGrants', 'activeAnswerGrants', 'activePermissionGrants'])
    return { state: member(b.state, ['active', 'paused', 'detached'] as const), currentRevision: nullable(b.currentRevision, value => count(value, 1)), scope: scope(b.scope), activeInputGrants: count(b.activeInputGrants), activeAnswerGrants: count(b.activeAnswerGrants), activePermissionGrants: count(b.activePermissionGrants) }
  })
  const outgoing = reading(p.outgoing, value => {
    const o = object(value, ['after', 'afterContent', 'next', 'deliveries', 'observation', 'sourceObservation', 'effectObservation', 'coverage'])
    if (o.after !== (request.after ?? null) || o.afterContent !== (request.afterContent ?? null)) return fail()
    return { after: nullable(o.after, text), afterContent: nullable(o.afterContent, text), next: nullable(o.next, text), deliveries: array(o.deliveries, value => {
      const d = object(value, ['kind', 'operationId', 'state', 'receipt', 'platformMessageId', 'reason', 'resourceUpload', 'association'])
      const receipt = nullable(d.receipt, value => member(value, ['confirmed', 'unknown', 'not-applied'] as const))
      if (receipt !== 'confirmed' && d.platformMessageId !== null) return fail()
      return { association: association(d.association), kind: member(d.kind, ['conversation', 'permission', 'binding-notice'] as const), operationId: id(d.operationId), state: member(d.state, ['pending', 'dispatching', 'unknown', 'confirmed', 'not-applied', 'cancelled', 'superseded'] as const), receipt, platformMessageId: nullable(d.platformMessageId, text), reason: nullable(d.reason, value => member(value, deliveryReasons)), resourceUpload: nullable(d.resourceUpload, value => member(value, ['pending', 'dispatching', 'unknown', 'confirmed'] as const)) }
    }), observation: nullable(o.observation, parseConnectionDeliveryObservation), sourceObservation: nullable(o.sourceObservation, parseConnectionDeliverySourceObservation), effectObservation: nullable(o.effectObservation, value => {
      const s = object(value, ['state', 'reason']); return { state: member(s.state, ['unknown', 'unavailable'] as const), reason: member(s.reason, ['effect-unconfirmed'] as const) }
    }), coverage: nullable(o.coverage, value => {
      const c = object(value, ['state', 'nextContent', 'gaps', 'originCount', 'omittedGapCount'])
      return { state: member(c.state, ['complete', 'incomplete'] as const), nextContent: nullable(c.nextContent, text), originCount: count(c.originCount), omittedGapCount: count(c.omittedGapCount), gaps: array(c.gaps, sourceGap) }
    }) }
  })
  const incoming = reading(p.incoming, value => {
    const page = object(value, ['beforeIngressId', 'next', 'rows']); if (page.beforeIngressId !== (request.beforeIngressId ?? null)) return fail()
    const rows = array(page.rows, value => {
      const i = object(value, ['ingressId', 'sourceConnectionId', 'kind', 'state', 'code', 'codeRecorded', 'bindingId', 'bindingRevision', 'targetConnectionId', 'scope', 'inputOperationId', 'coreStatus', 'coreObservation', 'nativeAdoption', 'waiting', 'recording', 'context'])
      const bindingId = nullable(i.bindingId, id), bindingRevision = nullable(i.bindingRevision, value => count(value, 1)), targetConnectionId = nullable(i.targetConnectionId, id), inputOperationId = nullable(i.inputOperationId, id)
      const rowScope = member(i.scope, ['current-binding', 'other-binding', 'group-event'] as const)
      if (rowScope === 'group-event' ? bindingId !== null || bindingRevision !== null || targetConnectionId !== null || inputOperationId !== null : !bindingId || !bindingRevision || !targetConnectionId) return fail()
      // The original owner proves membership; these bounds validate displayed provenance only.
      if (rowScope === 'current-binding' && (bindingId !== target.bindingId || bindingRevision! < target.publicationRevision || bindingRevision! > target.bindingRevision || targetConnectionId !== target.connectionId)) return fail()
      const recording = nullable(i.recording, value => {
        const r = object(value, ['state', 'code']), state = member(r.state, ['recorded', 'unavailable', 'refused', 'not-started'] as const)
        if (i.kind !== 'message' || (state === 'recorded' || state === 'not-started') && r.code !== undefined || state === 'recorded' && !bindingId) return fail()
        return { state, ...(r.code === undefined ? {} : { code: member(r.code, connectionDiagnosisRecordingCodes) }) }
      })
      const waiting = parseConnectionDiagnosisWaiting(i.waiting)
      const coreStatus = nullable(i.coreStatus, value => member(value, ['waiting', 'stopped', 'terminal-confirmed', 'admitted', 'not-applied', 'unknown', 'saved', 'bytes-accepted', 'hook-written', 'acp-acknowledged'] as const))
      if ((rowScope !== 'current-binding' || inputOperationId === null) && (coreStatus !== null || waiting !== null || i.nativeAdoption !== null)) return fail()
      if (i.context !== undefined && (rowScope !== 'current-binding' || inputOperationId === null || i.kind !== 'message')) return fail()
      return { ingressId: id(i.ingressId), sourceConnectionId: id(i.sourceConnectionId), kind: member(i.kind, ['message', 'action'] as const), state: member(i.state, ['received', 'refused', 'claimed'] as const), code: nullable(i.code, value => member(value, connectionDiagnosisIntakeCodes)), codeRecorded: bool(i.codeRecorded), bindingId, bindingRevision, targetConnectionId, scope: rowScope, inputOperationId, recording, coreStatus, waiting, coreObservation: member(i.coreObservation, ['not-started', 'observed', 'unavailable'] as const), nativeAdoption: nullable(i.nativeAdoption, value => member(value, ['unknown'] as const)), ...(i.context === undefined ? {} : { context: parseIngressContextObservation(i.context) }) }
    })
    if (new Set(rows.map(row => row.ingressId)).size !== rows.length) return fail()
    return { beforeIngressId: nullable(page.beforeIngressId, id), next: nullable(page.next, id), rows }
  })
  return { target, window: { ...(request.after ? { after: request.after } : {}), ...(request.afterContent ? { afterContent: request.afterContent } : {}), ...(request.beforeIngressId ? { beforeIngressId: request.beforeIngressId } : {}) }, limit: connectionDiagnosisWindowLimit, adapterService, connection, binding, outgoing, incoming }
}
export function parseConnectionDiagnosis(value: unknown, input: ConnectionDiagnosisInput): ConnectionDiagnosis {
  const p = object(value, ['target', 'service', 'groups']), target = parseConnectionDiagnosisInput(p.target)
  if (Object.keys(target).length !== Object.keys(input).length || Object.entries(target).some(([key, value]) => value !== input[key as keyof ConnectionDiagnosisInput])) return fail()
  const service = reading(p.service, value => { const s = object(value, ['enabled', 'revision']); return { enabled: bool(s.enabled), revision: count(s.revision, 0) } })
  const groups = reading(p.groups, value => {
    const g = object(value, ['items', 'nextBindingId']), items = array(g.items, value => group(value, input))
    if (input.bindingId && (items.length !== 1 || g.nextBindingId !== null) || new Set(items.map(row => row.target.bindingId)).size !== items.length) return fail()
    return { items, nextBindingId: nullable(g.nextBindingId, id) }
  })
  return { target, service, groups }
}
