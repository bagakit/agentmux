import { connectionDiagnosisGapKey, connectionDiagnosisEventKey, connectionDiagnosisRecordKey, connectionDiagnosisSourceKey, connectionDiagnosisPartKey } from './connection-diagnosis-source.js'
import type { ConversationItemRef, ConversationRef } from './conversation.js'
import type { ConnectionDeliveryGap } from './connection-delivery-contract.js'
import type { ConnectionDelivery } from './connection-delivery-contract.js'
import type { ConnectionIngressRecord } from './ingress-contract.js'
import { roomPublicationReference, sameRoomPublication, type RoomBinding } from './room-binding-contract.js'
import type { ConnectionPort } from './connections-contract.js'
import { parseConnectionServiceResult } from './connection-service-codec.js'
import { connectionDiagnosisIntakeCodes, connectionDiagnosisRecordingCodes, connectionDiagnosisSourceCodes, connectionDiagnosisWindowLimit, type ConnectionDiagnosisInput, type ConnectionDiagnosis, type ConnectionGroupDiagnosis, type ConnectionDiagnosisTarget, type ConnectionDiagnosisWindow, type ConnectionDiagnosisReading, type GroupDiagnosis } from './connection-diagnosis-contract.js'

export const groupWindowLimit = connectionDiagnosisWindowLimit
export function groupTarget(binding: RoomBinding) {
  return { bindingId: binding.bindingId, bindingRevision: binding.revision, publicationRevision: roomPublicationReference(binding).revision, connectionId: binding.connectionId,
    domain: binding.application.domain, appId: binding.application.appId, externalConversationId: binding.externalConversationId,
    executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
}
type GroupTarget = ConnectionDiagnosisTarget
type GroupWindow = ConnectionDiagnosisWindow
type Reading<T> = ConnectionDiagnosisReading<T>
async function reading<T>(work: () => Promise<T>): Promise<Reading<T>> {
  try { return { value: await work(), issue: null } } catch { return { value: null, issue: 'read-unavailable' } }
}
const applicationMatches = (application: { domain: string; appId: string }, target: GroupTarget) => application.domain === target.domain && application.appId === target.appId
export function deliveryMatches(delivery: ConnectionDelivery, target: GroupTarget) {
  return delivery.bindingId === target.bindingId && delivery.bindingRevision === target.publicationRevision && delivery.target.connectionId === target.connectionId &&
    delivery.target.externalConversationId === target.externalConversationId && applicationMatches(delivery.target.application, target)
}
export function deliveryFacts(delivery: ConnectionDelivery) {
  const kind = delivery.reference.source.kind === 'binding-operation' ? 'binding-notice' as const : delivery.reference.source.kind === 'interaction' ? 'permission' as const : delivery.reference.source.kind === 'ingress' ? 'query-feedback' as const : 'conversation' as const
  const record = delivery.reference.source.kind === 'native' || delivery.reference.source.kind === 'captured' ? delivery.reference as ConversationItemRef : undefined
  return { kind, association: association(delivery.reference, { ...(record ? { record } : {}), ...(delivery.event ? { event: delivery.event } : {}) }), operationId: delivery.operationId, state: delivery.state, receipt: delivery.receipt?.state ?? null,
    platformMessageId: delivery.receipt?.state === 'confirmed' ? delivery.receipt.mapping.messageId : null,
    reason: delivery.receipt && delivery.receipt.state !== 'confirmed' ? delivery.receipt.reason : delivery.reason ?? null,
    resourceUpload: delivery.resourceUpload?.state ?? null }
}
function association(reference: ConversationRef, value: Pick<ConnectionDeliveryGap, 'record' | 'source' | 'event' | 'part'>) {
  const record = value.record ?? value.part?.record
  return { sourceKey: value.source || record ? connectionDiagnosisSourceKey(reference, value.source ?? record!.source) : null,
    recordKey: record ? connectionDiagnosisRecordKey(record) : null,
    eventKey: value.event && record ? connectionDiagnosisEventKey(record, value.event) : null,
    partKey: value.part ? connectionDiagnosisPartKey(value.part) : null }
}
function recordMatches(record: { hostId: string; agentSessionId: string }, target: GroupTarget, sourceHostId?: string): boolean {
  return record.agentSessionId === target.agentSessionId && record.hostId === (sourceHostId ?? target.executionHostId)
}
function gapMatches(gap: ConnectionDeliveryGap, target: GroupTarget, sourceHostId?: string): boolean {
  return [gap.record, gap.part?.record, gap.anchor?.record].every(record => !record || recordMatches(record, target, sourceHostId))
}
const ingressMatches = (ingress: ConnectionIngressRecord, target: GroupTarget) => ingress.externalConversationId === target.externalConversationId && applicationMatches(ingress.application, target)
// Original owner codes only. Arbitrary error text, body and exception properties are never diagnosis inputs.
const intakeCodes = connectionDiagnosisIntakeCodes
const intakeCode = (value?: string) => intakeCodes.find(code => code === value) ?? null
const recordingCode = (value?: string) => connectionDiagnosisRecordingCodes.find(code => code === value)

/** One explicit bounded local window. None of these original read ports dispatches an effect. */
async function readGroup(owner: ConnectionPort, target: GroupTarget, window: GroupWindow = {}): Promise<ConnectionGroupDiagnosis> {
  const [connection, binding, outgoing, incoming] = await Promise.all([
    reading(() => owner.inspect({ connectionId: target.connectionId })),
    reading(() => owner.bindings!.inspect({ bindingId: target.bindingId })),
    reading(() => owner.delivery!.list({ connectionId: target.connectionId, bindingId: target.bindingId, bindingRevision: target.publicationRevision, order: 'newest', limit: groupWindowLimit, ...(window.after ? { after: window.after } : {}), ...(window.afterContent ? { afterContent: window.afterContent } : {}) })),
    reading(() => owner.ingress!.listAudience!({ application: { domain: target.domain, appId: target.appId }, externalConversationId: target.externalConversationId, limit: groupWindowLimit, ...(window.beforeIngressId ? { beforeIngressId: window.beforeIngressId } : {}) }))
  ])
  const c = connection.value?.connection, b = binding.value?.binding
  const sameConnection = !!c && c.config.connectionId === target.connectionId && applicationMatches(c.config.application, target)
  const adapterService: ConnectionGroupDiagnosis['adapterService'] = sameConnection ? await reading(async () => {
    const input = { adapterId: c.config.adapterId }
    const value = parseConnectionServiceResult('connection.service.get', await owner.service!.get(input), input)
    return { adapterId: input.adapterId, enabled: value.enabled, revision: value.revision }
  }) : { value: null, issue: connection.issue ?? 'target-unconfirmed' }
  const sameBinding = !!b && b.bindingId === target.bindingId && b.revision === target.bindingRevision && roomPublicationReference(b).revision === target.publicationRevision && b.connectionId === target.connectionId &&
    b.externalConversationId === target.externalConversationId && applicationMatches(b.application, target) && b.executionHostId === target.executionHostId && b.agentSessionId === target.agentSessionId
  const rows = incoming.value?.ingresses.filter(ingress => ingressMatches(ingress, target)) ?? []
  const intake = await Promise.all(rows.map(async original => {
    const inspected = await reading(() => owner.ingress!.inspect({ ingressId: original.ingressId }))
    const observed = inspected.value?.ingress
    const valid = observed?.ingressId === original.ingressId && ingressMatches(observed, target)
    const ingress = valid ? observed : original, author = ingress.input?.author
    const frozen = ingress.kind !== 'action' ? ingress.group?.target : null
    const relation = author ? { bindingId: author.bindingId, bindingRevision: author.bindingRevision, connectionId: author.connectionId, hostId: ingress.input!.hostId, agentSessionId: ingress.input!.agentSessionId } : frozen
    const subject = !!relation && relation.bindingId === target.bindingId && relation.connectionId === target.connectionId && relation.hostId === target.executionHostId && relation.agentSessionId === target.agentSessionId
    const originalBinding = subject && sameBinding && relation.bindingRevision !== target.bindingRevision
      ? await reading(() => owner.bindings!.inspect({ bindingId: relation.bindingId, revision: relation.bindingRevision })) : null
    // This is a historical association, not current permission or dispatch authority.
    const current = subject && (relation.bindingRevision === target.bindingRevision || !!b && !!originalBinding?.value?.binding && sameRoomPublication(originalBinding.value.binding, b))
    const receipt = valid && current ? inspected.value?.inputReceipt : null
    const interaction = valid && current ? inspected.value?.interactionReceipt : null
    const waiting = receipt?.control.waiting
    const recording = ingress.kind !== 'action' && ingress.group ? ingress.group.recorded ? { state: 'recorded' as const }
      : ingress.group.recording ? { state: ingress.group.recording.state, ...(recordingCode(ingress.group.recording.code) ? { code: recordingCode(ingress.group.recording.code)! } : {}) }
      : ingress.code === 'INGRESS_CONTENT_UNSUPPORTED' ? { state: 'refused' as const, code: 'INGRESS_CONTENT_UNSUPPORTED' as const }
      : { state: 'not-started' as const } : null
    return { ingressId: ingress.ingressId, sourceConnectionId: ingress.connectionId, targetConnectionId: relation?.connectionId ?? null, waiting: waiting ? { phase: waiting.phase, reason: waiting.reason, wake: waiting.wake } : null, kind: ingress.kind === 'action' ? 'action' as const : 'message' as const, state: ingress.state,
      code: intakeCode(ingress.code), codeRecorded: ingress.code !== undefined, bindingId: relation?.bindingId ?? null, bindingRevision: relation?.bindingRevision ?? null,
      scope: relation ? current ? 'current-binding' as const : 'other-binding' as const : 'group-event' as const, recording,
      inputOperationId: ingress.input?.operationId ?? null, coreStatus: receipt?.status ?? interaction?.delivery ?? null,
      coreObservation: inspected.issue || !valid ? 'unavailable' as const : inspected.value!.observation,
      nativeAdoption: interaction?.nativeAdoption ?? null,
      ...(valid && current && inspected.value?.context ? { context: inspected.value.context } : {}) }
  }))
  const effective = binding.value?.access ? binding.value.access.flatMap(access => access.effective ? [access.effective] : []) : binding.value?.grants.filter(grant => grant.bindingId === target.bindingId && grant.bindingRevision === target.bindingRevision) ?? []
  const scopedOutgoing = outgoing.value && outgoing.value.deliveries.every(delivery => deliveryMatches(delivery, target) && recordMatches(delivery.reference, target, ['native', 'captured'].includes(delivery.reference.source.kind) ? b?.sourceFrontier?.sourceHostId : target.executionHostId)) && (outgoing.value.coverage?.gaps.every(gap => gapMatches(gap, target, b?.sourceFrontier?.sourceHostId)) ?? true)
  return { target: { ...target }, window: { ...(window.after ? { after: window.after } : {}), ...(window.afterContent ? { afterContent: window.afterContent } : {}), ...(window.beforeIngressId ? { beforeIngressId: window.beforeIngressId } : {}) }, limit: groupWindowLimit,
    adapterService,
    connection: { value: sameConnection ? { revision: c.revision, enabled: c.config.enabled,
      authentication: { state: c.observation.authentication.state, ...(c.observation.authentication.reason ? { reason: c.observation.authentication.reason } : {}) },
      transport: { state: c.observation.transport.state, ...(c.observation.transport.reason ? { reason: c.observation.transport.reason } : {}) },
      intake: { state: c.observation.intake.state, ...(c.observation.intake.reason ? { reason: c.observation.intake.reason } : {}) },
      delivery: { state: c.observation.delivery.state, ...(c.observation.delivery.reason ? { reason: c.observation.delivery.reason } : {}) } } : null,
      issue: connection.issue ?? (sameConnection ? null : 'target-unconfirmed' as const) },
    binding: { value: sameBinding ? { state: b.state, currentRevision: binding.value?.current?.revision ?? null,
      scope: { input: b.scope.input, publication: b.scope.publication },
      activeAnswerGrants: effective.filter(grant => grant.state === 'active' && grant.capabilities.includes('answer')).length,
      activePermissionGrants: effective.filter(grant => grant.state === 'active' && grant.capabilities.includes('permission')).length,
      activeInputGrants: effective.filter(grant => grant.state === 'active' && grant.capabilities.includes('input')).length } : null,
      issue: binding.issue ?? (sameBinding ? null : 'target-unconfirmed' as const) },
    outgoing: { value: scopedOutgoing ? { after: window.after ?? null, afterContent: window.afterContent ?? null, next: outgoing.value!.next,
      deliveries: outgoing.value!.deliveries.map(deliveryFacts), observation: outgoing.value!.observation ? { state: outgoing.value!.observation.state, ...(outgoing.value!.observation.reason ? { reason: outgoing.value!.observation.reason } : {}) } : null,
      sourceObservation: outgoing.value!.sourceObservation ?? null, effectObservation: outgoing.value!.effectObservation ?? null,
      coverage: outgoing.value!.coverage ? { state: outgoing.value!.coverage.state, nextContent: outgoing.value!.coverage.nextContent,
        gaps: outgoing.value!.coverage.gaps.slice(0, groupWindowLimit).map(gap => ({ gapKey: connectionDiagnosisGapKey(target, gap.gapId), reason: gap.reason, association: association({ hostId: b?.sourceFrontier?.sourceHostId ?? target.executionHostId, agentSessionId: target.agentSessionId }, gap), code: connectionDiagnosisSourceCodes.find(code => code === gap.code) ?? null, codeRecorded: gap.code !== undefined, sourceKind: gap.source?.kind ?? null })), originCount: outgoing.value!.coverage.origins.length, omittedGapCount: Math.max(0, outgoing.value!.coverage.gaps.length - groupWindowLimit) } : null } : null,
      issue: outgoing.issue ?? (scopedOutgoing ? null : 'target-unconfirmed' as const) },
    incoming: { value: incoming.value && incoming.value.ingresses.every(row => ingressMatches(row, target)) ? { beforeIngressId: window.beforeIngressId ?? null, next: incoming.value.nextBeforeIngressId, rows: intake } : null, issue: incoming.issue ?? (incoming.value?.ingresses.every(row => ingressMatches(row, target)) ? null : 'target-unconfirmed' as const) }
  }
}

/** Read original local owners directly; only this projection, never their private DTOs, crosses the diagnostic edge. */
export async function readConnectionDiagnosis(owner: ConnectionPort, input: ConnectionDiagnosisInput): Promise<ConnectionDiagnosis> {
  const service = await reading(async () => { const value = await owner.service!.get(); return { enabled: value.enabled, revision: value.revision } })
  const selection = await reading(async () => input.bindingId
    ? { bindings: [(await owner.bindings!.inspect({ bindingId: input.bindingId, ...(input.bindingRevision ? { revision: input.bindingRevision } : {}) })).binding].filter((value): value is RoomBinding => value !== null) }
    : await owner.bindings!.list({ executionHostId: input.executionHostId, agentSessionId: input.agentSessionId }))
  const bindings = selection.value?.bindings
  if (!bindings || input.bindingId && bindings.length !== 1 || bindings.some(binding => binding.executionHostId !== input.executionHostId || binding.agentSessionId !== input.agentSessionId || input.bindingId && binding.bindingId !== input.bindingId || input.bindingRevision && binding.revision !== input.bindingRevision)) {
    return { target: { ...input }, service, groups: { value: null, issue: selection.issue ?? 'target-unconfirmed' } }
  }
  const sorted = bindings.slice().sort((a, b) => a.bindingId.localeCompare(b.bindingId))
  const before = input.afterBindingId ? sorted.findIndex(binding => binding.bindingId === input.afterBindingId) : -1
  if (input.afterBindingId && before < 0) return { target: { ...input }, service, groups: { value: null, issue: 'target-unconfirmed' } }
  const selected = sorted.slice(before + 1, before + 1 + groupWindowLimit)
  const items = await Promise.all(selected.map(binding => readGroup(owner, groupTarget(binding), input)))
  return { target: { ...input }, service, groups: { value: { items, nextBindingId: sorted.length > before + 1 + selected.length ? selected.at(-1)!.bindingId : null }, issue: null } }
}
/** Keep explicitly labelled earlier observations after a local read failure, never under another target or page. */
export function retainGroupDiagnosis(previous: GroupDiagnosis | null, next: GroupDiagnosis): GroupDiagnosis {
  if (!previous || JSON.stringify(previous.target) !== JSON.stringify(next.target) || JSON.stringify(previous.window) !== JSON.stringify(next.window)) return next
  const retain = <T,>(before: Reading<T>, after: Reading<T>): Reading<T> => after.issue && before.value ? { value: before.value, issue: after.issue, retained: true } : after
  return { ...next, service: retain(previous.service, next.service), adapterService: retain(previous.adapterService, next.adapterService), connection: retain(previous.connection, next.connection), binding: retain(previous.binding, next.binding), outgoing: retain(previous.outgoing, next.outgoing), incoming: retain(previous.incoming, next.incoming) }
}
/** Only the projected facts above enter the text; no original DTO is serialized. */
export function formatGroupDiagnosis(report: GroupDiagnosis) {
  const { target: t, service, adapterService, connection, binding, outgoing, incoming } = report, lines = [
    'Group diagnosis — bounded local observations, not an atomic history',
    `Binding: ${t.bindingId} · configuration ${t.bindingRevision} · publication ${t.publicationRevision}`, `Connection: ${t.connectionId} · ${t.domain} · ${t.appId}`,
    `Group: ${t.externalConversationId}`, `Agent: ${t.executionHostId} · ${t.agentSessionId}`, `Window limit: ${report.limit}`
  ]
  const section = (name: string, value: { issue: string | null; retained?: true }) => { if (value.issue) lines.push(`${name}: ${value.issue}${value.retained ? ' (earlier observed facts retained)' : ''}`) }
  section('Service read', service); section('Platform service read', adapterService); section('Connection read', connection); section('Binding read', binding); section('Delivery read', outgoing); section('Ingress read', incoming)
  if (service.value) lines.push(`Automatic service: ${service.value.enabled ? 'on' : 'off'} · revision ${service.value.revision}`)
  if (adapterService.value) lines.push(`Platform automatic service: ${adapterService.value.adapterId} · ${adapterService.value.enabled ? 'on' : 'off'} · revision ${adapterService.value.revision}`)
  if (connection.value) { lines.push(`Connection revision: ${connection.value.revision} · enabled ${connection.value.enabled}`); for (const stage of ['authentication', 'transport', 'intake', 'delivery'] as const) lines.push(`Application ${stage}: ${connection.value[stage].state} · ${connection.value[stage].reason ?? 'no recorded reason'}`) }
  if (binding.value) lines.push(`Binding state: ${binding.value.state} · current revision ${binding.value.currentRevision ?? 'unconfirmed'} · scope ${binding.value.scope.input} / ${binding.value.scope.publication} · active grants input ${binding.value.activeInputGrants} / answer ${binding.value.activeAnswerGrants} / permission ${binding.value.activePermissionGrants}`)
  const out = outgoing.value
  if (out) {
    lines.push(`Lane observation: ${out.observation?.state ?? 'unrecorded'} · ${out.observation?.reason ?? 'no recorded reason'} (not platform readiness)`, `Delivery window after: ${out.after ?? 'start'} · content after: ${out.afterContent ?? 'start'}`, `Delivery has next: ${out.next !== null} · content has next: ${out.coverage?.nextContent !== null && out.coverage?.nextContent !== undefined}`)
    lines.push(`Source read: ${out.sourceObservation?.state ?? 'unrecorded'} · ${out.sourceObservation?.reason ?? 'no recorded reason'} · code ${out.sourceObservation?.code ?? (out.sourceObservation?.codeRecorded ? 'recorded code withheld' : 'unrecorded')} · checkpoint key ${out.sourceObservation?.checkpointKey ?? 'unrecorded'}`, `Unresolved effects: ${out.effectObservation?.state ?? 'unrecorded'} · ${out.effectObservation?.reason ?? 'no recorded reason'} (not complete-delivery proof)` )
    if (!out.deliveries.length) lines.push('No delivery in this reading window; this is not an empty-history or platform-availability claim.')
    const related = (a: import('./connection-diagnosis-contract.js').ConnectionDiagnosisAssociation) => `source key ${a.sourceKey ?? 'unrecorded'} · record key ${a.recordKey ?? 'unrecorded'} · event key ${a.eventKey ?? 'unrecorded'} · part key ${a.partKey ?? 'unrecorded'}`
    for (const d of out.deliveries) lines.push(`Outgoing ${d.operationId}: ${d.kind} · queue ${d.state} · platform receipt ${d.receipt ?? 'unrecorded'} · message ${d.platformMessageId ?? 'unrecorded'} · reason ${d.reason ?? 'unrecorded'} · resource upload ${d.resourceUpload ?? 'unrecorded'} · ${related(d.association)}`)
    lines.push(`Content coverage: ${out.coverage?.state ?? 'unrecorded'} · observed origins ${out.coverage?.originCount ?? 'unrecorded'}`)
    if (out.coverage?.omittedGapCount) lines.push(`Additional gaps in this owner page: ${out.coverage.omittedGapCount}`)
    for (const gap of out.coverage?.gaps ?? []) lines.push(`Content gap ${gap.gapKey}: ${gap.reason} · source ${gap.sourceKind ?? 'unrecorded'} · code ${gap.code ?? (gap.codeRecorded ? 'recorded code withheld' : 'unrecorded')} · ${related(gap.association)}`)
  }
  const input = incoming.value
  if (input) {
    lines.push(`Incoming group window before: ${input.beforeIngressId ?? 'latest'} · records ${input.rows.length} · has next ${input.next !== null}`, 'Incoming platform acknowledgement: not recorded by this read API.')
    if (!input.rows.length) lines.push('No intake in this exact group window; this is not a complete-history or platform-receipt claim.')
    for (const i of input.rows) lines.push(`Incoming ${i.ingressId}: ${i.kind} · receiver ${i.sourceConnectionId} · target connection ${i.targetConnectionId ?? 'unclaimed'} · intake ${i.state} · code ${i.code ?? (i.codeRecorded ? 'recorded code withheld' : 'unrecorded')} · scope ${i.scope} · original binding ${i.bindingId ?? 'unclaimed'} / ${i.bindingRevision ?? 'unclaimed'} · conversation record ${i.recording?.state ?? 'not-applicable'}${i.recording?.code ? ' / ' + i.recording.code : ''} · Core operation ${i.inputOperationId ?? 'not-started'} · Core input ${i.coreStatus ?? (i.inputOperationId ? 'unconfirmed' : 'not-started')} · waiting ${i.waiting ? i.waiting.phase + ' / ' + i.waiting.reason + ' / ' + i.waiting.wake : 'unrecorded'} · read ${i.coreObservation} · native adoption ${i.nativeAdoption ?? 'not-recorded'}${i.context ? ` · quoted context ${i.context.coverage} / ${i.context.quotedMessages} messages / ${i.context.gapCount} gaps · confirmed position ${i.context.positionMessageId ?? 'unestablished'} · context read ${i.context.observation}${i.context.code ? ' · known-message deduplication observation unavailable' : ''}` : ''}`)
  }
  lines.push('Core terminal-confirmed/bytes-accepted means ordered input bytes, not Native acceptance. Observing or copying never retries a message or input.')
  return lines.join('\n')
}
