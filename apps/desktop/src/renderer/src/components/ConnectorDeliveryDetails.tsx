import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionDeliveryResultMap, RoomBinding } from '@agentmux/core/connections'
import { api } from '../lib/api'

/** One bounded original delivery window. Opening or observing never retries an effect. */
export function ConnectorDeliveryDetails({ binding }: { binding: RoomBinding }) {
  const [read, setRead] = useState<ConnectionDeliveryResultMap['connection.delivery.ls'] | null>(null), [issue, setIssue] = useState('')
  const [detail, setDetail] = useState<ConnectionDeliveryResultMap['connection.delivery.inspect'] | null>(null), [pending, setPending] = useState(false), [expanded, setExpanded] = useState(false)
  const flight = useRef(false), live = useRef(true)
  async function inspect(after?: string) {
    if (flight.current) return
    flight.current = true; setPending(true)
    try {
      const result = await api.connections.call('connection.delivery.ls', { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision, limit: 5, ...(after ? { after } : {}) })
      if (live.current) { setRead(result); setIssue('') }
    } catch (error) { if (live.current) setIssue(presentError(error)) }
    finally { flight.current = false; if (live.current) setPending(false) }
  }
  async function inspectOriginal(operationId: string) {
    if (flight.current) return
    flight.current = true; setPending(true)
    try { const result = await api.connections.call('connection.delivery.inspect', { operationId }); if (live.current) { setDetail(result); setIssue('') } }
    catch (error) { if (live.current) setIssue(presentError(error)) }
    finally { flight.current = false; if (live.current) setPending(false) }
  }
  useEffect(() => { live.current = true; void inspect(); return () => { live.current = false } }, [])
  const latest = read?.deliveries[0], receipt = latest?.receipt
  const incomplete = read?.observation?.reason === 'content-unconfirmed'
  return <section className="agent-connector-fields" aria-busy={pending} aria-label="Group delivery">
    <div className="agent-connector-section-title"><h3>Delivery</h3><button className="agent-connector-text-action" disabled={pending} onClick={() => void inspect()}>Check delivery</button></div>
    {incomplete ? <div className="agent-connector-service" role="status"><strong>Some content has not synced</strong><p className="agent-connector-note">You can keep working in the original conversation. Check the original delivery for what has reached this group.</p><button className="agent-connector-text-action" onClick={() => setExpanded(true)}>View original delivery</button></div> : null}
    <p className="agent-connector-note">{receipt?.state === 'confirmed' ? 'Latest delivery confirmed' : receipt?.state === 'not-applied' ? 'Latest delivery was not sent' : receipt?.state === 'unknown' || issue ? 'Delivery not confirmed' : read ? 'No new delivery receipt recorded' : 'Checking delivery…'}</p>
    <details className="agent-connector-disclosure" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>Delivery receipt details</summary><div className="agent-connector-fields">
      {read?.observation ? <p className="agent-connector-note">Service: {read.observation.state}{read.observation.reason ? ' · ' + read.observation.reason : ''}</p> : null}
      {read?.deliveries.map(delivery => <div className="agent-connector-receipt" key={delivery.operationId}><span>Queue: {delivery.state} · Platform receipt: {delivery.receipt?.state ?? 'Not recorded'}</span><code>{delivery.operationId}</code><button className="small-button" disabled={pending} onClick={() => void inspectOriginal(delivery.operationId)}>Check receipt</button></div>)}
      {read && !read.deliveries.length ? <p className="agent-connector-note">No delivery in this reading window. This does not prove platform availability.</p> : null}
      {read?.next ? <button className="small-button" disabled={pending} onClick={() => void inspect(read.next!)}>Earlier receipts</button> : null}
      {detail ? <p className="agent-connector-note" role="status">{detail.delivery ? 'Original queue: ' + detail.delivery.state + ' · Platform receipt: ' + (detail.delivery.receipt?.state ?? 'Not recorded') + ' · ' + detail.delivery.operationId : 'Original receipt unavailable; no retry was sent.'}</p> : null}
      {issue ? <p role="status" className="agent-connector-note">Delivery observation unconfirmed · {issue}</p> : null}
      <button className="small-button" disabled={pending} onClick={() => void inspect()}>Latest receipts</button>
    </div></details>
  </section>
}
