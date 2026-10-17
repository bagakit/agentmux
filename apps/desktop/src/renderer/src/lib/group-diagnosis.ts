import type { ConnectionDelivery, ConnectionIngressRecord, RoomBinding } from '@agentmux/core/connections'
import type { api } from './api'

type Source = typeof api.connections.call
export const groupWindowLimit = 5
export function groupTarget(binding: RoomBinding) {
  return { bindingId: binding.bindingId, bindingRevision: binding.revision, connectionId: binding.connectionId,
    domain: binding.application.domain, appId: binding.application.appId, externalConversationId: binding.externalConversationId,
    executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
}
export type GroupTarget = ReturnType<typeof groupTarget>
export type GroupWindow = { after?: string; afterContent?: string; afterIngressId?: string }
type Reading<T> = { value: T | null; issue: 'read-unavailable' | 'target-unconfirmed' | null; retained?: true }
async function reading<T>(work: () => Promise<T>): Promise<Reading<T>> {
  try { return { value: await work(), issue: null } } catch { return { value: null, issue: 'read-unavailable' } }
}
const applicationMatches = (application: { domain: string; appId: string }, target: GroupTarget) => application.domain === target.domain && application.appId === target.appId
export function deliveryMatches(delivery: ConnectionDelivery, target: GroupTarget) {
  return delivery.bindingId === target.bindingId && delivery.bindingRevision === target.bindingRevision && delivery.target.connectionId === target.connectionId &&
    delivery.target.externalConversationId === target.externalConversationId && applicationMatches(delivery.target.application, target)
}
export function deliveryFacts(delivery: ConnectionDelivery) {
  return { operationId: delivery.operationId, state: delivery.state, receipt: delivery.receipt?.state ?? null,
    platformMessageId: delivery.receipt?.state === 'confirmed' ? delivery.receipt.mapping.messageId : null,
    reason: delivery.receipt && delivery.receipt.state !== 'confirmed' ? delivery.receipt.reason : delivery.reason ?? null,
    resourceUpload: delivery.resourceUpload?.state ?? null }
}
const ingressMatches = (ingress: ConnectionIngressRecord, target: GroupTarget) => ingress.connectionId === target.connectionId &&
  ingress.externalConversationId === target.externalConversationId && applicationMatches(ingress.application, target)
// Original owner codes only. Arbitrary error text, body and exception properties are never diagnosis inputs.
const intakeCodes = ['INGRESS_ACTOR_NOT_AUTHORIZED', 'INGRESS_BINDING_UNAVAILABLE', 'INGRESS_INPUT_OUTSIDE_SCOPE', 'INGRESS_ADDRESSING_UNCONFIRMED', 'INGRESS_AUTHORITY_REVISED', 'INGRESS_CONNECTION_UNAVAILABLE', 'INGRESS_SERVICE_DISABLED', 'INGRESS_SERVICE_UNCONFIRMED', 'INGRESS_STORAGE_UNCONFIRMED', 'INGRESS_TARGET_UNCONFIRMED', 'INGRESS_ACTION_UNSUPPORTED', 'INGRESS_CONTENT_UNSUPPORTED', 'INGRESS_CORE_UNAVAILABLE'] as const
const intakeCode = (value?: string) => intakeCodes.find(code => code === value) ?? null

/** One explicit bounded local window. None of these original read ports dispatches an effect. */
export async function readGroupDiagnosis(source: Source, target: GroupTarget, window: GroupWindow = {}) {
  const [service, connection, binding, outgoing, incoming] = await Promise.all([
    reading(() => source('connection.service.get', {})),
    reading(() => source('connection.inspect', { connectionId: target.connectionId })),
    reading(() => source('connection.binding.inspect', { bindingId: target.bindingId, revision: target.bindingRevision })),
    reading(() => source('connection.delivery.ls', { connectionId: target.connectionId, bindingId: target.bindingId, bindingRevision: target.bindingRevision, limit: groupWindowLimit, ...(window.after ? { after: window.after } : {}), ...(window.afterContent ? { afterContent: window.afterContent } : {}) })),
    // A Binding filter excludes refusals which never acquired input.author. Keep the connection page explicit instead.
    reading(() => source('connection.ingress.ls', { connectionId: target.connectionId, limit: groupWindowLimit, ...(window.afterIngressId ? { afterIngressId: window.afterIngressId } : {}) }))
  ])
  const c = connection.value?.connection, b = binding.value?.binding
  const sameConnection = !!c && c.config.connectionId === target.connectionId && applicationMatches(c.config.application, target)
  const sameBinding = !!b && b.bindingId === target.bindingId && b.revision === target.bindingRevision && b.connectionId === target.connectionId &&
    b.externalConversationId === target.externalConversationId && applicationMatches(b.application, target) && b.executionHostId === target.executionHostId && b.agentSessionId === target.agentSessionId
  const rows = incoming.value?.ingresses.filter(ingress => ingressMatches(ingress, target)) ?? []
  const intake = await Promise.all(rows.map(async original => {
    const inspected = await reading(() => source('connection.ingress.inspect', { ingressId: original.ingressId }))
    const observed = inspected.value?.ingress
    const valid = observed?.ingressId === original.ingressId && ingressMatches(observed, target)
    const ingress = valid ? observed : original, author = ingress.input?.author
    const current = !!author && author.bindingId === target.bindingId && author.bindingRevision === target.bindingRevision
    const receipt = valid && current ? inspected.value?.inputReceipt : null
    const interaction = valid && current ? inspected.value?.interactionReceipt : null
    return { ingressId: ingress.ingressId, kind: ingress.kind === 'action' ? 'action' as const : 'message' as const, state: ingress.state,
      code: intakeCode(ingress.code), codeRecorded: ingress.code !== undefined, bindingId: author?.bindingId ?? null, bindingRevision: author?.bindingRevision ?? null,
      scope: author ? current ? 'current-binding' as const : 'other-binding' as const : 'group-event' as const,
      inputOperationId: ingress.input?.operationId ?? null, coreStatus: receipt?.status ?? interaction?.delivery ?? null,
      coreObservation: inspected.issue || !valid ? 'unavailable' as const : inspected.value!.observation,
      nativeAdoption: interaction?.nativeAdoption ?? null }
  }))
  const scopedOutgoing = outgoing.value && outgoing.value.deliveries.every(delivery => deliveryMatches(delivery, target))
  return { target: { ...target }, limit: groupWindowLimit,
    service: { value: service.value ? { enabled: service.value.enabled, revision: service.value.revision } : null, issue: service.issue },
    connection: { value: sameConnection ? { revision: c.revision, enabled: c.config.enabled,
      authentication: { state: c.observation.authentication.state, reason: c.observation.authentication.reason ?? null },
      transport: { state: c.observation.transport.state, reason: c.observation.transport.reason ?? null },
      intake: { state: c.observation.intake.state, reason: c.observation.intake.reason ?? null },
      delivery: { state: c.observation.delivery.state, reason: c.observation.delivery.reason ?? null } } : null,
      issue: connection.issue ?? (sameConnection ? null : 'target-unconfirmed' as const) },
    binding: { value: sameBinding ? { state: b.state, currentRevision: binding.value?.current?.revision ?? null,
      activeInputGrants: binding.value!.grants.filter(grant => grant.bindingId === target.bindingId && grant.bindingRevision === target.bindingRevision && grant.state === 'active' && grant.capabilities.includes('input')).length } : null,
      issue: binding.issue ?? (sameBinding ? null : 'target-unconfirmed' as const) },
    outgoing: { value: scopedOutgoing ? { after: window.after ?? null, afterContent: window.afterContent ?? null, next: outgoing.value!.next,
      deliveries: outgoing.value!.deliveries.map(deliveryFacts), observation: outgoing.value!.observation ? { state: outgoing.value!.observation.state, reason: outgoing.value!.observation.reason ?? null } : null,
      coverage: outgoing.value!.coverage ? { state: outgoing.value!.coverage.state, nextContent: outgoing.value!.coverage.nextContent,
        gaps: outgoing.value!.coverage.gaps.map(gap => ({ gapId: gap.gapId, reason: gap.reason })), originCount: outgoing.value!.coverage.origins.length } : null } : null,
      issue: outgoing.issue ?? (scopedOutgoing ? null : 'target-unconfirmed' as const) },
    incoming: { value: incoming.value ? { afterIngressId: window.afterIngressId ?? null, next: incoming.value.nextAfterIngressId, inspectedConnectionRecords: incoming.value.ingresses.length, rows: intake } : null, issue: incoming.issue }
  }
}
export type GroupDiagnosis = Awaited<ReturnType<typeof readGroupDiagnosis>>
/** Keep explicitly labelled earlier observations after a local read failure, never under another target or page. */
export function retainGroupDiagnosis(previous: GroupDiagnosis | null, next: GroupDiagnosis): GroupDiagnosis {
  if (!previous || JSON.stringify(previous.target) !== JSON.stringify(next.target)) return next
  const retain = <T,>(before: Reading<T>, after: Reading<T>): Reading<T> => after.issue && before.value ? { value: before.value, issue: after.issue, retained: true } : after
  return { ...next, service: retain(previous.service, next.service), connection: retain(previous.connection, next.connection), binding: retain(previous.binding, next.binding), outgoing: retain(previous.outgoing, next.outgoing), incoming: retain(previous.incoming, next.incoming) }
}
/** Only the projected facts above enter the text; no original DTO is serialized. */
export function formatGroupDiagnosis(report: GroupDiagnosis) {
  const { target: t, service, connection, binding, outgoing, incoming } = report, lines = [
    'Group diagnosis — bounded local observations, not an atomic history',
    `Binding: ${t.bindingId} · revision ${t.bindingRevision}`, `Connection: ${t.connectionId} · ${t.domain} · ${t.appId}`,
    `Group: ${t.externalConversationId}`, `Agent: ${t.executionHostId} · ${t.agentSessionId}`, `Window limit: ${report.limit}`
  ]
  const section = (name: string, value: { issue: string | null; retained?: true }) => { if (value.issue) lines.push(`${name}: ${value.issue}${value.retained ? ' (earlier observed facts retained)' : ''}`) }
  section('Service read', service); section('Connection read', connection); section('Binding read', binding); section('Delivery read', outgoing); section('Ingress read', incoming)
  if (service.value) lines.push(`Automatic service: ${service.value.enabled ? 'on' : 'off'} · revision ${service.value.revision}`)
  if (connection.value) { lines.push(`Connection revision: ${connection.value.revision} · enabled ${connection.value.enabled}`); for (const stage of ['authentication', 'transport', 'intake', 'delivery'] as const) lines.push(`Application ${stage}: ${connection.value[stage].state} · ${connection.value[stage].reason ?? 'no recorded reason'}`) }
  if (binding.value) lines.push(`Binding state: ${binding.value.state} · current revision ${binding.value.currentRevision ?? 'unconfirmed'} · active input grants ${binding.value.activeInputGrants}`)
  const out = outgoing.value
  if (out) {
    lines.push(`Source observation: ${out.observation?.state ?? 'unrecorded'} · ${out.observation?.reason ?? 'no recorded reason'} (not platform readiness)`, `Delivery window after: ${out.after ?? 'start'} · content after: ${out.afterContent ?? 'start'}`, `Delivery has next: ${out.next !== null} · content has next: ${out.coverage?.nextContent !== null && out.coverage?.nextContent !== undefined}`)
    if (!out.deliveries.length) lines.push('No delivery in this reading window; this is not an empty-history or platform-availability claim.')
    for (const d of out.deliveries) lines.push(`Outgoing ${d.operationId}: queue ${d.state} · platform receipt ${d.receipt ?? 'unrecorded'} · message ${d.platformMessageId ?? 'unrecorded'} · reason ${d.reason ?? 'unrecorded'} · resource upload ${d.resourceUpload ?? 'unrecorded'}`)
    lines.push(`Content coverage: ${out.coverage?.state ?? 'unrecorded'} · observed origins ${out.coverage?.originCount ?? 'unrecorded'}`)
    for (const gap of out.coverage?.gaps ?? []) lines.push(`Content gap ${gap.gapId}: ${gap.reason}`)
  }
  const input = incoming.value
  if (input) {
    lines.push(`Incoming connection window after: ${input.afterIngressId ?? 'start'} · inspected ${input.inspectedConnectionRecords} · matching group ${input.rows.length} · has next ${input.next !== null}`, 'Incoming platform acknowledgement: not recorded by this read API.')
    if (!input.rows.length) lines.push('No matching group intake in this connection window; earlier or later intake is not ruled out.')
    for (const i of input.rows) lines.push(`Incoming ${i.ingressId}: ${i.kind} · intake ${i.state} · code ${i.code ?? (i.codeRecorded ? 'recorded code withheld' : 'unrecorded')} · scope ${i.scope} · original binding ${i.bindingId ?? 'unclaimed'} / ${i.bindingRevision ?? 'unclaimed'} · Core operation ${i.inputOperationId ?? 'not-started'} · Core input ${i.coreStatus ?? (i.inputOperationId ? 'unconfirmed' : 'not-started')} · read ${i.coreObservation} · native adoption ${i.nativeAdoption ?? 'not-recorded'}`)
  }
  lines.push('Core terminal-confirmed/bytes-accepted means ordered input bytes, not Native acceptance. Observing or copying never retries a message or input.')
  return lines.join('\n')
}
