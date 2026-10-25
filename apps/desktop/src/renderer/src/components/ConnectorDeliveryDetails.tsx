import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RoomBinding } from '@agentmux/core/connections'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import { api } from '../lib/api'
import { deliveryFacts, deliveryMatches, formatGroupDiagnosis, groupTarget, readGroupDiagnosis, retainGroupDiagnosis, type GroupDiagnosis, type GroupWindow } from '../lib/group-diagnosis'

import { connectorGroupSummary } from '../lib/connector-group-status'
import { ConnectorTrafficSummary } from './ConnectorTrafficSummary'
import { OriginalInputWaitingControl } from './OriginalInputWaitingControl'

const LoadingIcon = semanticIconComponent('status.loading')
/** Bounded original incoming/outgoing observations. Reading or copying never retries an effect. */
export function ConnectorDeliveryDetails({ binding, hostingTarget, onMembers }: { binding: RoomBinding; hostingTarget?: ConnectionHostingTarget | null; onMembers?: () => void }) {
  const target = groupTarget(binding), key = JSON.stringify([target, hostingTarget]), originalSource = api.connections.call
  const source: typeof api.connections.call = useMemo(() => (method, params) => {
    if (hostingTarget === null) return Promise.reject(new Error('The original bot hosting owner is unconfirmed.'))
    return originalSource(method, params, hostingTarget)
  }, [originalSource, key])
  const current = useRef({ key, source }), live = useRef(false), epoch = useRef(0), exportRead = useRef(0)
  current.current = { key, source }
  const [read, setRead] = useState<{ key: string; value: GroupDiagnosis; checkedAt: number } | null>(null), [pending, setPending] = useState(false), [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<{ key: string; value: ReturnType<typeof deliveryFacts> | null; issue: boolean } | null>(null)
  const [input, setInput] = useState<{ key: string; ingressId: string; receipt: AgentInputSubmissionReceipt | null; issue: boolean } | null>(null)
  const [copying, setCopying] = useState(false), [feedback, setFeedback] = useState('')
  const originalSections = useRef<Record<'incoming' | 'receipts' | 'content', HTMLElement | null>>({ incoming: null, receipts: null, content: null })
  const reveal = useRef<'incoming' | 'receipts' | 'content' | null>(null)
  const visible = read?.key === key ? read.value : null
  const original = detail?.key === key ? detail : null
  const accepts = () => live.current && current.current.key === key && current.current.source === source && api.connections.call === originalSource
  function focusOriginal(section: 'incoming' | 'receipts' | 'content') {
    const node = originalSections.current[section]
    node?.scrollIntoView({ block: 'nearest' }); node?.focus({ preventScroll: true })
  }
  function showOriginal(section: 'incoming' | 'receipts' | 'content') {
    if (expanded) focusOriginal(section)
    else { reveal.current = section; setExpanded(true) }
  }
  useEffect(() => {
    if (expanded && reveal.current) { focusOriginal(reveal.current); reveal.current = null }
  }, [expanded, key])
  async function inspect(window: GroupWindow = {}) {
    const request = ++epoch.current; setPending(true)
    const result = await readGroupDiagnosis(source, target, window)
    if (!accepts() || request !== epoch.current) return
    setRead(previous => ({ key, value: retainGroupDiagnosis(previous?.key === key ? previous.value : null, result), checkedAt: Date.now() })); setPending(false)
  }
  async function inspectOriginal(operationId: string) {
    const request = ++epoch.current; setPending(true)
    try {
      const result = await source('connection.delivery.inspect', { operationId })
      if (!accepts() || request !== epoch.current) return
      const matched = result.delivery?.operationId === operationId && deliveryMatches(result.delivery, target)
      setDetail({ key, value: matched ? deliveryFacts(result.delivery!) : null, issue: !matched })
    } catch { if (accepts() && request === epoch.current) setDetail({ key, value: null, issue: true }) }
    finally { if (accepts() && request === epoch.current) setPending(false) }
  }
  async function inspectInput(row: NonNullable<GroupDiagnosis['incoming']['value']>['rows'][number]) {
    const request = ++epoch.current; setPending(true)
    try {
      const result = await source('connection.ingress.inspect', { ingressId: row.ingressId })
      if (!accepts() || request !== epoch.current) return
      const ingress = result.ingress, saved = ingress?.kind !== 'action' ? ingress?.input : undefined, receipt = result.inputReceipt
      const matches = ingress?.ingressId === row.ingressId && ingress.externalConversationId === target.externalConversationId && ingress.application.domain === target.domain && ingress.application.appId === target.appId &&
        saved?.operationId === row.inputOperationId && saved.hostId === target.executionHostId && saved.agentSessionId === target.agentSessionId && saved.author.bindingId === target.bindingId && saved.author.bindingRevision === row.bindingRevision && saved.author.connectionId === target.connectionId &&
        receipt?.originalControlOperationId === saved.operationId && receipt.key.kind === 'message' && receipt.key.agentSessionId === saved.agentSessionId && receipt.key.expectedRun.runId === saved.expectedRun.runId && receipt.key.messageId === saved.messageId
      setInput(previous => ({ key, ingressId: row.ingressId, receipt: matches ? receipt! : previous?.key === key && previous.ingressId === row.ingressId ? previous.receipt : null, issue: !matches }))
    } catch { if (accepts() && request === epoch.current) setInput(previous => ({ key, ingressId: row.ingressId, receipt: previous?.key === key && previous.ingressId === row.ingressId ? previous.receipt : null, issue: true })) }
    finally { if (accepts() && request === epoch.current) setPending(false) }
  }
  async function copyDiagnosis() {
    const request = ++exportRead.current
    // Freeze exact target and current bounded cursors at the click, separately from the changing display.
    const window: GroupWindow = { ...(visible?.outgoing.value?.after ? { after: visible.outgoing.value.after } : {}), ...(visible?.outgoing.value?.afterContent ? { afterContent: visible.outgoing.value.afterContent } : {}), ...(visible?.incoming.value?.beforeIngressId ? { beforeIngressId: visible.incoming.value.beforeIngressId } : {}) }
    setCopying(true); setFeedback('Reading this bounded group window…')
    try {
      const report = await readGroupDiagnosis(source, target, window)
      if (!accepts() || request !== exportRead.current) return
      await api.ui.writeClipboardText((hostingTarget ? `Bot hosting: ${hostingTarget.hostId} · Runtime: ${hostingTarget.runtimeId}\n` : '') + formatGroupDiagnosis(report))
      if (accepts() && request === exportRead.current) setFeedback('Bounded sanitized group diagnosis copied.')
    } catch { if (accepts() && request === exportRead.current) setFeedback('The diagnosis could not be copied. Original receipts remain available.') }
    finally { if (accepts() && request === exportRead.current) setCopying(false) }
  }
  useEffect(() => {
    live.current = true; reveal.current = null; setFeedback(''); setCopying(false); setDetail(null); setInput(null); void inspect()
    return () => { live.current = false; epoch.current++; exportRead.current++ }
  }, [key, source])
  const outgoing = visible?.outgoing.value, incoming = visible?.incoming.value
  const sectionIssue = (name: string, section: { issue: string | null; retained?: true } | undefined) => section?.issue ? <p className="agent-connector-note" role="status">{name} observation unconfirmed{section.retained ? '; earlier observed facts are kept.' : '.'}</p> : null
  const readFailed = !!visible && [visible.service, visible.adapterService, visible.connection, visible.binding, visible.outgoing, visible.incoming].some(section => section.issue)
  return <section className="agent-connector-fields connector-delivery-details" aria-busy={pending} aria-label="Group delivery" data-connection-section="activity" tabIndex={-1}>
    <div className="agent-connector-section-title"><div><h3>Group activity</h3>{visible && read ? <small className="agent-connector-checked">Checked <time dateTime={new Date(read.checkedAt).toISOString()}>{new Date(read.checkedAt).toLocaleTimeString()}</time> · recent receipt window</small> : null}</div><button className="agent-connector-text-action" aria-busy={pending} disabled={pending} onClick={() => void inspect()}>{pending ? <LoadingIcon size={13} animation="spin" /> : null}Check group activity</button></div>
    <ConnectorTrafficSummary summary={connectorGroupSummary(visible)} actions={{ ...(onMembers ? { members: onMembers } : {}),
      incoming: () => showOriginal('incoming'), receipts: () => showOriginal('receipts'), content: () => showOriginal('content') }} />

    <details className="agent-connector-disclosure connector-delivery-details__originals" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>Original records and details</summary><div className="agent-connector-fields">
      <section className="connector-delivery-details__section" aria-label="Connection observation">
      <h4>Connection observation</h4>
      {readFailed ? <p className="agent-connector-note" role="status">The latest check is incomplete. Earlier matching observations are kept.</p> : null}
      {visible?.service.value ? <p className="agent-connector-note">Automatic service: {visible.service.value.enabled ? 'on' : 'off'} · revision {visible.service.value.revision}</p> : null}
      {visible?.adapterService.value ? <p className="agent-connector-note">Platform: {visible.adapterService.value.enabled ? 'on' : 'off'} · revision {visible.adapterService.value.revision}</p> : null}
      {visible?.connection.value ? <p className="agent-connector-note">Application revision {visible.connection.value.revision} · authentication: {visible.connection.value.authentication.state} · transport: {visible.connection.value.transport.state} · intake: {visible.connection.value.intake.state} · delivery: {visible.connection.value.delivery.state}</p> : null}
      {visible?.binding.value ? <p className="agent-connector-note">Binding: {visible.binding.value.state} · {visible.binding.value.activeInputGrants} active input grants · current revision {visible.binding.value.currentRevision ?? 'unconfirmed'}</p> : null}
      {sectionIssue('Automatic service', visible?.service)}{sectionIssue('Platform policy', visible?.adapterService)}{sectionIssue('Application', visible?.connection)}{sectionIssue('Binding', visible?.binding)}
      {outgoing?.observation ? <p className="agent-connector-note">{outgoing.observation.reason === 'access-unconfirmed' ? <>Member access check unavailable. Application permissions could not be checked; saved decisions are kept. Review member access and check group activity again.</> : outgoing.observation.reason === 'effect-unconfirmed' ? <>Platform request observation: {outgoing.observation.state}. {outgoing.observation.state === 'unknown' ? 'Some original platform request results are unconfirmed.' : 'Check each original platform request receipt below for its outcome.'} Each request has its own receipt below. Unconfirmed requests are not sent again.</> : <>Source observation: {outgoing.observation.state}{outgoing.observation.reason ? ' · ' + outgoing.observation.reason : ''}. This describes local source reading, not platform delivery.</>}</p> : null}
      {sectionIssue('Outgoing', visible?.outgoing)}
      </section>
      <section ref={node => { originalSections.current.incoming = node }} className="connector-delivery-details__section" data-receipt-section="incoming" tabIndex={-1} aria-label="Incoming message details">
      <h4>Incoming events & Core input</h4>
      <p className="agent-connector-note">Latest 5 records from this application and group, including other receiving connections. Platform acknowledgement is not recorded by this read API.</p>
      {incoming ? <><p className="agent-connector-note">Group window: {incoming.rows.length} records, newest first · has next: {String(incoming.next !== null)}</p>
        {!incoming.rows.length ? <p className="agent-connector-note">No intake in this exact group window. This is not a complete-history or platform-receipt claim.</p> : null}
        {incoming.rows.map(row => <div className="agent-connector-receipt" key={row.ingressId}><span>Conversation record: {row.recording?.state ?? 'not confirmed'}{row.recording?.code ? ' · ' + row.recording.code : ''} · Host intake: {row.state}{row.code ? ' · ' + row.code : ''} · Core input: {row.coreStatus ?? (row.inputOperationId ? 'unconfirmed' : 'not started')}{row.scope === 'other-binding' ? ' · another binding revision' : ''}</span><code>{row.ingressId}</code>{row.inputOperationId ? <code>{row.inputOperationId}</code> : null}{row.waiting ? <small>{row.waiting.wake === 'explicit-rejoin' ? 'Input recovery needed. Review the saved input before explicitly rejoining its wait.' : 'The saved input will be checked when its original runtime or session is restored.'}</small> : null}{row.coreObservation === 'unavailable' ? <small>Original Core receipt read unavailable; no input was replayed.</small> : null}
          {row.kind === 'message' && row.scope === 'current-binding' && row.inputOperationId ? <button className="small-button" disabled={pending} onClick={() => void inspectInput(row)}>Open original input</button> : null}
          {input?.key === key && input.ingressId === row.ingressId ? <>
            {input.issue ? <small role="status">Original input receipt could not be confirmed. Saved input and any earlier receipt are kept.</small> : null}
            {input.receipt ? <OriginalInputWaitingControl hostId={target.executionHostId} receipt={input.receipt} onRefresh={() => inspect(visible?.window)} /> : null}
            <button className="small-button" onClick={() => setInput(null)}>Close original input</button>
          </> : null}
        </div>)}
        {incoming.next ? <button className="small-button" disabled={pending} onClick={() => void inspect({ beforeIngressId: incoming.next! })}>Earlier intake</button> : null}</> : null}
      {sectionIssue('Incoming', visible?.incoming)}
      </section>
      <section ref={node => { originalSections.current.receipts = node }} className="connector-delivery-details__section" data-receipt-section="receipts" tabIndex={-1} aria-label="Platform delivery details">
      <h4>Platform delivery receipts</h4>
      <p className="agent-connector-note">Outgoing window: up to 5 receipts · has next: {String(outgoing?.next !== null && outgoing?.next !== undefined)}. These pages are not the complete group history.</p>
      {outgoing?.deliveries.map(delivery => <div className="agent-connector-receipt" key={delivery.operationId}><span>{delivery.kind === 'binding-notice' ? 'Connection notice' : delivery.kind === 'permission' ? 'Permission request' : 'Conversation message'} · Queue: {delivery.state} · Platform receipt: {delivery.receipt ?? 'Not recorded'}</span><code>{delivery.operationId}</code>{delivery.platformMessageId ? <code>{delivery.platformMessageId}</code> : null}<button className="small-button" disabled={pending} onClick={() => void inspectOriginal(delivery.operationId)}>Check receipt</button></div>)}
      {outgoing?.next ? <button className="small-button" disabled={pending} onClick={() => void inspect({ after: outgoing.next! })}>Earlier receipts</button> : null}
      {original ? <p className="agent-connector-note" role="status">{original.value ? 'Original queue: ' + original.value.state + ' · Platform receipt: ' + (original.value.receipt ?? 'Not recorded') + ' · ' + original.value.operationId : 'Original receipt unavailable; no retry was sent.'}</p> : null}
      <button className="small-button" disabled={pending} onClick={() => void inspect()}>Latest receipts</button>
      </section>
      <section ref={node => { originalSections.current.content = node }} className="connector-delivery-details__section" data-receipt-section="content" tabIndex={-1} aria-label="Conversation content details">
      <h4>Conversation content</h4>
      <p className="agent-connector-note">These source checks describe what could be shared. They do not change the delivery results of other messages.</p>
      <p className="agent-connector-note">Content coverage: {outgoing?.coverage?.state ?? 'not recorded'} · content has next: {String(!!outgoing?.coverage?.nextContent)}</p>
      {outgoing?.coverage?.gaps.map(gap => <p className="agent-connector-note" key={gap.gapKey}>{gap.reason} · <code>{gap.gapKey}</code></p>)}
      {outgoing?.coverage?.omittedGapCount ? <p className="agent-connector-note">{outgoing.coverage.omittedGapCount} additional gaps in this owner page.</p> : null}
      {outgoing?.coverage?.nextContent ? <button className="small-button" disabled={pending} onClick={() => void inspect({ afterContent: outgoing.coverage!.nextContent! })}>Next content window</button> : null}
      </section>
    <div className="agent-connector-row"><button className="small-button" aria-busy={copying} disabled={copying} onClick={() => void copyDiagnosis()}>{copying ? <LoadingIcon size={13} animation="spin" /> : null}Copy group diagnosis</button>{copying ? <button className="small-button" onClick={() => { exportRead.current++; setCopying(false); setFeedback('Group diagnosis copy canceled.') }}>Cancel copy</button> : null}</div>
    {feedback ? <p className="agent-connector-note" role="status">{feedback}</p> : null}
    </div></details>
  </section>
}
