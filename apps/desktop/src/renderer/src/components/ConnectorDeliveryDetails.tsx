import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RoomBinding } from '@agentmux/core/connections'
import { api } from '../lib/api'
import { deliveryFacts, deliveryMatches, formatGroupDiagnosis, groupTarget, readGroupDiagnosis, retainGroupDiagnosis, type GroupDiagnosis, type GroupWindow } from '../lib/group-diagnosis'

const LoadingIcon = semanticIconComponent('status.loading')
/** Bounded original incoming/outgoing observations. Reading or copying never retries an effect. */
export function ConnectorDeliveryDetails({ binding }: { binding: RoomBinding }) {
  const target = groupTarget(binding), key = JSON.stringify(target), source = api.connections.call
  const current = useRef({ key, source }), live = useRef(false), epoch = useRef(0), exportRead = useRef(0)
  current.current = { key, source }
  const [read, setRead] = useState<GroupDiagnosis | null>(null), [pending, setPending] = useState(false), [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<{ key: string; value: ReturnType<typeof deliveryFacts> | null; issue: boolean } | null>(null)
  const [copying, setCopying] = useState(false), [feedback, setFeedback] = useState('')
  const visible = read && JSON.stringify(read.target) === key ? read : null
  const original = detail?.key === key ? detail : null
  const accepts = () => live.current && current.current.key === key && current.current.source === source && api.connections.call === source
  async function inspect(window: GroupWindow = {}) {
    const request = ++epoch.current; setPending(true)
    const result = await readGroupDiagnosis(source, target, window)
    if (!accepts() || request !== epoch.current) return
    setRead(previous => retainGroupDiagnosis(previous, result)); setPending(false)
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
  async function copyDiagnosis() {
    const request = ++exportRead.current
    // Freeze exact target and current bounded cursors at the click, separately from the changing display.
    const window: GroupWindow = { ...(visible?.outgoing.value?.after ? { after: visible.outgoing.value.after } : {}), ...(visible?.outgoing.value?.afterContent ? { afterContent: visible.outgoing.value.afterContent } : {}), ...(visible?.incoming.value?.beforeIngressId ? { beforeIngressId: visible.incoming.value.beforeIngressId } : {}) }
    setCopying(true); setFeedback('Reading this bounded group window…')
    try {
      const report = await readGroupDiagnosis(source, target, window)
      if (!accepts() || request !== exportRead.current) return
      await api.ui.writeClipboardText(formatGroupDiagnosis(report))
      if (accepts() && request === exportRead.current) setFeedback('Bounded sanitized group diagnosis copied.')
    } catch { if (accepts() && request === exportRead.current) setFeedback('The diagnosis could not be copied. Original receipts remain available.') }
    finally { if (accepts() && request === exportRead.current) setCopying(false) }
  }
  useEffect(() => {
    live.current = true; setFeedback(''); setCopying(false); setDetail(null); void inspect()
    return () => { live.current = false; epoch.current++; exportRead.current++ }
  }, [key, source])
  const outgoing = visible?.outgoing.value, incoming = visible?.incoming.value, receipt = outgoing?.deliveries[0]?.receipt
  const incomplete = outgoing?.coverage?.state === 'incomplete' || outgoing?.observation?.reason === 'content-unconfirmed'
  const sectionIssue = (name: string, section: { issue: string | null; retained?: true } | undefined) => section?.issue ? <p className="agent-connector-note" role="status">{name} observation unconfirmed{section.retained ? '; earlier observed facts are kept.' : '.'}</p> : null
  const lastInput = incoming?.rows[0]
  const incomingSummary = visible?.service.value?.enabled === false ? 'Automatic service is paused.'
    : lastInput?.scope === 'other-binding' ? 'An earlier group connection has a receipt. Its current result is unconfirmed.'
    : lastInput?.state === 'refused' ? lastInput.code === 'INGRESS_ACTOR_NOT_AUTHORIZED' ? 'Approve this member to send requests.' : 'A request was refused. Check its original receipt below.'
    : lastInput?.coreStatus === 'admitted' ? 'Request accepted.'
    : lastInput?.coreStatus === 'terminal-confirmed' || lastInput?.coreStatus === 'bytes-accepted' ? 'Request submitted; Agent acknowledgement is unconfirmed.'
    : lastInput ? 'A received message is recorded. Its result is unconfirmed.'
    : incoming ? 'No received messages in this checked window.' : 'The incoming result is not confirmed.'
  const readFailed = !!visible && [visible.service, visible.connection, visible.binding, visible.outgoing, visible.incoming].some(section => section.issue)
  return <section className="agent-connector-fields" aria-busy={pending} aria-label="Group delivery">
    <div className="agent-connector-section-title"><h3>Group activity</h3><button className="agent-connector-text-action" aria-busy={pending} disabled={pending} onClick={() => void inspect()}>{pending ? <LoadingIcon size={13} animation="spin" /> : null}Check group activity</button></div>
    {pending ? <p className="agent-connector-note" role="status">Reading original local group receipts…</p> : null}
    <p className="agent-connector-note"><strong>Incoming</strong> · {incomingSummary}</p>
    {visible?.binding.value?.activeInputGrants === 0 ? <p className="agent-connector-note">No member approved to send requests. Review member access above.</p> : null}
    <p className="agent-connector-note"><strong>Outgoing</strong> · {receipt === 'confirmed' ? 'Delivery confirmed in this window' : receipt === 'not-applied' ? 'Delivery in this window was not sent' : receipt === 'unknown' || visible?.outgoing.issue ? 'Delivery not confirmed. Check the original receipt below.' : outgoing?.deliveries.length ? 'An outgoing request is recorded. Its platform receipt is not confirmed.' : outgoing ? 'No new delivery receipt recorded. No delivery in this reading window.' : 'The delivery result is not confirmed.'}</p>
    {readFailed ? <p className="agent-connector-note" role="status">The latest check is unconfirmed. Earlier observed receipts are kept; check group activity again.</p> : null}
    {incomplete ? <div className="agent-connector-service" role="status"><strong>Some content has not synced</strong><p className="agent-connector-note">You can keep working in the original conversation. Check the original delivery for the remaining content.</p><button className="agent-connector-text-action" onClick={() => setExpanded(true)}>View original delivery</button></div> : null}
    <details className="agent-connector-disclosure" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>Delivery receipt details</summary><div className="agent-connector-fields">
      {visible?.service.value ? <p className="agent-connector-note">Automatic service: {visible.service.value.enabled ? 'on' : 'off'} · revision {visible.service.value.revision}</p> : null}
      {visible?.connection.value ? <p className="agent-connector-note">Application revision {visible.connection.value.revision} · authentication: {visible.connection.value.authentication.state} · transport: {visible.connection.value.transport.state} · intake: {visible.connection.value.intake.state} · delivery: {visible.connection.value.delivery.state}</p> : null}
      {visible?.binding.value ? <p className="agent-connector-note">Binding: {visible.binding.value.state} · {visible.binding.value.activeInputGrants} active input grants · current revision {visible.binding.value.currentRevision ?? 'unconfirmed'}</p> : null}
      {sectionIssue('Automatic service', visible?.service)}{sectionIssue('Application', visible?.connection)}{sectionIssue('Binding', visible?.binding)}
      {outgoing?.observation ? <p className="agent-connector-note">Source observation: {outgoing.observation.state}{outgoing.observation.reason ? ' · ' + outgoing.observation.reason : ''}. This describes local source reading, not platform delivery.</p> : null}
      {sectionIssue('Outgoing', visible?.outgoing)}
      <div className="agent-connector-section-title"><h3>Incoming events & Core input</h3></div>
      <p className="agent-connector-note">Latest 5 records from this application and group, including other receiving connections. Platform acknowledgement is not recorded by this read API.</p>
      {incoming ? <><p className="agent-connector-note">Group window: {incoming.rows.length} records, newest first · has next: {String(incoming.next !== null)}</p>
        {!incoming.rows.length ? <p className="agent-connector-note">No intake in this exact group window. This is not a complete-history or platform-receipt claim.</p> : null}
        {incoming.rows.map(row => <div className="agent-connector-receipt" key={row.ingressId}><span>Host intake: {row.state}{row.code ? ' · ' + row.code : ''} · Core input: {row.coreStatus ?? (row.inputOperationId ? 'unconfirmed' : 'not started')}{row.scope === 'other-binding' ? ' · another binding revision' : ''}</span><code>{row.ingressId}</code>{row.inputOperationId ? <code>{row.inputOperationId}</code> : null}{row.waiting ? <small>Core waiting: {row.waiting.phase} · {row.waiting.reason} · {row.waiting.wake}</small> : null}{row.coreObservation === 'unavailable' ? <small>Original Core receipt read unavailable; no input was replayed.</small> : null}</div>)}
        {incoming.next ? <button className="small-button" disabled={pending} onClick={() => void inspect({ beforeIngressId: incoming.next! })}>Earlier intake</button> : null}</> : null}
      {sectionIssue('Incoming', visible?.incoming)}
      <p className="agent-connector-note">Outgoing window: up to 5 receipts · has next: {String(outgoing?.next !== null && outgoing?.next !== undefined)}. These pages are not the complete group history.</p>
      {outgoing?.deliveries.map(delivery => <div className="agent-connector-receipt" key={delivery.operationId}><span>Queue: {delivery.state} · Platform receipt: {delivery.receipt ?? 'Not recorded'}</span><code>{delivery.operationId}</code>{delivery.platformMessageId ? <code>{delivery.platformMessageId}</code> : null}<button className="small-button" disabled={pending} onClick={() => void inspectOriginal(delivery.operationId)}>Check receipt</button></div>)}
      {outgoing?.next ? <button className="small-button" disabled={pending} onClick={() => void inspect({ after: outgoing.next! })}>Earlier receipts</button> : null}
      <p className="agent-connector-note">Content coverage: {outgoing?.coverage?.state ?? 'not recorded'} · content has next: {String(!!outgoing?.coverage?.nextContent)}</p>
      {outgoing?.coverage?.gaps.map(gap => <p className="agent-connector-note" key={gap.gapId}>{gap.reason} · <code>{gap.gapId}</code></p>)}
      {outgoing?.coverage?.omittedGapCount ? <p className="agent-connector-note">{outgoing.coverage.omittedGapCount} additional gaps in this owner page.</p> : null}
      {outgoing?.coverage?.nextContent ? <button className="small-button" disabled={pending} onClick={() => void inspect({ afterContent: outgoing.coverage!.nextContent! })}>Next content window</button> : null}
      {original ? <p className="agent-connector-note" role="status">{original.value ? 'Original queue: ' + original.value.state + ' · Platform receipt: ' + (original.value.receipt ?? 'Not recorded') + ' · ' + original.value.operationId : 'Original receipt unavailable; no retry was sent.'}</p> : null}
      <button className="small-button" disabled={pending} onClick={() => void inspect()}>Latest receipts</button>
    </div></details>
    <div className="agent-connector-row"><button className="small-button" aria-busy={copying} disabled={copying} onClick={() => void copyDiagnosis()}>{copying ? <LoadingIcon size={13} animation="spin" /> : null}Copy group diagnosis</button>{copying ? <button className="small-button" onClick={() => { exportRead.current++; setCopying(false); setFeedback('Group diagnosis copy canceled.') }}>Cancel copy</button> : null}</div>
    <p className="agent-connector-note" role="status">{feedback}</p>
  </section>
}
