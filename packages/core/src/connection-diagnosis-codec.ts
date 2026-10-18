import { AgentMuxError } from './errors.js'
import { connectionDiagnosisIntakeCodes, connectionDiagnosisWindowLimit, type ConnectionDiagnosis, type ConnectionDiagnosisInput, type ConnectionDiagnosisReading, type ConnectionGroupDiagnosis } from './connection-diagnosis-contract.js'

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
const stageStates = ['unknown', 'ready', 'unavailable', 'disabled'] as const
function stage(value: unknown) {
  const p = object(value, ['state', 'reason'])
  return { state: member(p.state, stageStates), ...(p.reason === undefined ? {} : { reason: member(p.reason, ['not-tested', 'credential-missing', 'adapter-unavailable', 'check-failed', 'not-started'] as const) }) }
}
function scope(value: unknown) {
  const p = object(value, ['input', 'publication'])
  return { input: member(p.input, ['mentions-and-replies', 'all-messages'] as const), publication: member(p.publication, ['future-native-user-facing', 'future-shared-conversation'] as const) }
}
const deliveryReasons = ['effect-unconfirmed', 'platform-rejected', 'adapter-unavailable', 'platform-unavailable', 'rate-limited', 'thread-unavailable', 'unsupported-format', 'original-speech-withdrawn', 'private-content', 'public-content-unconfirmed', 'version-unavailable'] as const
function group(value: unknown, request: ConnectionDiagnosisInput): ConnectionGroupDiagnosis {
  const p = object(value, ['target', 'window', 'limit', 'connection', 'binding', 'outgoing', 'incoming']), t = object(p.target, ['bindingId', 'bindingRevision', 'connectionId', 'domain', 'appId', 'externalConversationId', 'executionHostId', 'agentSessionId'])
  const target = { bindingId: id(t.bindingId), bindingRevision: count(t.bindingRevision, 1), connectionId: id(t.connectionId), domain: text(t.domain), appId: text(t.appId), externalConversationId: text(t.externalConversationId), executionHostId: id(t.executionHostId), agentSessionId: id(t.agentSessionId) }
  if (target.executionHostId !== request.executionHostId || target.agentSessionId !== request.agentSessionId || request.bindingId && target.bindingId !== request.bindingId || request.bindingRevision && target.bindingRevision !== request.bindingRevision || p.limit !== connectionDiagnosisWindowLimit) return fail()
  const window = object(p.window, ['after', 'afterContent', 'beforeIngressId'])
  if (['after', 'afterContent', 'beforeIngressId'].some(key => window[key] !== request[key as keyof ConnectionDiagnosisInput])) return fail()
  const connection = reading(p.connection, value => {
    const c = object(value, ['revision', 'enabled', 'authentication', 'transport', 'intake', 'delivery'])
    return { revision: count(c.revision, 1), enabled: bool(c.enabled), authentication: stage(c.authentication), transport: stage(c.transport), intake: stage(c.intake), delivery: stage(c.delivery) }
  })
  const binding = reading(p.binding, value => {
    const b = object(value, ['state', 'currentRevision', 'scope', 'activeInputGrants', 'activeAnswerGrants', 'activePermissionGrants'])
    return { state: member(b.state, ['active', 'paused'] as const), currentRevision: nullable(b.currentRevision, value => count(value, 1)), scope: scope(b.scope), activeInputGrants: count(b.activeInputGrants), activeAnswerGrants: count(b.activeAnswerGrants), activePermissionGrants: count(b.activePermissionGrants) }
  })
  const outgoing = reading(p.outgoing, value => {
    const o = object(value, ['after', 'afterContent', 'next', 'deliveries', 'observation', 'coverage'])
    if (o.after !== (request.after ?? null) || o.afterContent !== (request.afterContent ?? null)) return fail()
    return { after: nullable(o.after, text), afterContent: nullable(o.afterContent, text), next: nullable(o.next, text), deliveries: array(o.deliveries, value => {
      const d = object(value, ['operationId', 'state', 'receipt', 'platformMessageId', 'reason', 'resourceUpload'])
      const receipt = nullable(d.receipt, value => member(value, ['confirmed', 'unknown', 'not-applied'] as const))
      if (receipt !== 'confirmed' && d.platformMessageId !== null) return fail()
      return { operationId: id(d.operationId), state: member(d.state, ['pending', 'dispatching', 'unknown', 'confirmed', 'not-applied', 'cancelled', 'superseded'] as const), receipt, platformMessageId: nullable(d.platformMessageId, text), reason: nullable(d.reason, value => member(value, deliveryReasons)), resourceUpload: nullable(d.resourceUpload, value => member(value, ['pending', 'dispatching', 'unknown', 'confirmed'] as const)) }
    }), observation: nullable(o.observation, value => {
      const s = object(value, ['state', 'reason']); return { state: member(s.state, stageStates), ...(s.reason === undefined ? {} : { reason: member(s.reason, ['not-started', 'source-unconfirmed', 'source-gap', 'content-unconfirmed', 'storage-unconfirmed', 'adapter-unavailable', 'credential-missing', 'effect-unconfirmed'] as const) }) }
    }), coverage: nullable(o.coverage, value => {
      const c = object(value, ['state', 'nextContent', 'gaps', 'originCount', 'omittedGapCount'])
      return { state: member(c.state, ['complete', 'incomplete'] as const), nextContent: nullable(c.nextContent, text), originCount: count(c.originCount), omittedGapCount: count(c.omittedGapCount), gaps: array(c.gaps, value => { const g = object(value, ['gapId', 'reason']); return { gapId: id(g.gapId), reason: member(g.reason, ['public-content-unconfirmed', 'transport-unsupported', 'resource-unavailable', 'start-cut-unconfirmed', 'source-gap', 'version-unavailable'] as const) } }) }
    }) }
  })
  const incoming = reading(p.incoming, value => {
    const page = object(value, ['beforeIngressId', 'next', 'rows']); if (page.beforeIngressId !== (request.beforeIngressId ?? null)) return fail()
    const rows = array(page.rows, value => {
      const i = object(value, ['ingressId', 'sourceConnectionId', 'kind', 'state', 'code', 'codeRecorded', 'bindingId', 'bindingRevision', 'targetConnectionId', 'scope', 'inputOperationId', 'coreStatus', 'coreObservation', 'nativeAdoption', 'waiting'])
      const bindingId = nullable(i.bindingId, id), bindingRevision = nullable(i.bindingRevision, value => count(value, 1)), targetConnectionId = nullable(i.targetConnectionId, id), inputOperationId = nullable(i.inputOperationId, id)
      const rowScope = member(i.scope, ['current-binding', 'other-binding', 'group-event'] as const)
      if (rowScope === 'group-event' ? bindingId !== null || bindingRevision !== null || targetConnectionId !== null || inputOperationId !== null : !bindingId || !bindingRevision || !targetConnectionId || !inputOperationId) return fail()
      if (rowScope === 'current-binding' && (bindingId !== target.bindingId || bindingRevision !== target.bindingRevision || targetConnectionId !== target.connectionId)) return fail()
      const waiting = nullable(i.waiting, value => {
        const w = object(value, ['phase', 'reason', 'wake']), phase = member(w.phase, ['runtime', 'authorization', 'observer', 'native-environment', 'input-environment', 'service'] as const)
        const reasons = { runtime: ['runtime-unavailable'], authorization: ['author-authorization-needed'], observer: ['observer-stopped'], 'native-environment': ['original-environment-unconfirmed', 'original-target-changed'], 'input-environment': ['original-input-unconfirmed', 'original-target-changed'], service: ['observation-failed'] } as const
        const reason = member(w.reason, reasons[phase] as readonly import('./agent-input-wait.js').AgentInputWaitReason['reason'][]), wake = member(w.wake, ['runtime-restored', 'explicit-rejoin'] as const)
        if (wake !== (phase === 'runtime' ? 'runtime-restored' : 'explicit-rejoin')) return fail()
        return { phase, reason, wake }
      })
      const coreStatus = nullable(i.coreStatus, value => member(value, ['waiting', 'stopped', 'terminal-confirmed', 'admitted', 'not-applied', 'unknown', 'saved', 'bytes-accepted', 'hook-written', 'acp-acknowledged'] as const))
      if (rowScope !== 'current-binding' && (coreStatus !== null || waiting !== null || i.nativeAdoption !== null)) return fail()
      return { ingressId: id(i.ingressId), sourceConnectionId: id(i.sourceConnectionId), kind: member(i.kind, ['message', 'action'] as const), state: member(i.state, ['received', 'refused', 'claimed'] as const), code: nullable(i.code, value => member(value, connectionDiagnosisIntakeCodes)), codeRecorded: bool(i.codeRecorded), bindingId, bindingRevision, targetConnectionId, scope: rowScope, inputOperationId, coreStatus, waiting, coreObservation: member(i.coreObservation, ['not-started', 'observed', 'unavailable'] as const), nativeAdoption: nullable(i.nativeAdoption, value => member(value, ['unknown'] as const)) }
    })
    if (new Set(rows.map(row => row.ingressId)).size !== rows.length) return fail()
    return { beforeIngressId: nullable(page.beforeIngressId, id), next: nullable(page.next, id), rows }
  })
  return { target, window: { ...(request.after ? { after: request.after } : {}), ...(request.afterContent ? { afterContent: request.afterContent } : {}), ...(request.beforeIngressId ? { beforeIngressId: request.beforeIngressId } : {}) }, limit: connectionDiagnosisWindowLimit, connection, binding, outgoing, incoming }
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
