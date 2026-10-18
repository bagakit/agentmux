import { useEffect, useState } from 'react'
import type { ConnectionDelivery, RoomBindingOperation } from '@agentmux/core/connections'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../lib/api'

const LoadingIcon = semanticIconComponent('status.loading')
const labels = { connected: 'Connection notice', disconnected: 'Disconnection notice', paused: 'Pause notice', resumed: 'Resume notice', updated: 'Sharing update notice' }

/** The applied relationship and its original platform notice keep independent receipts. */
export function ConnectorBindingNotices({ operation }: { operation: RoomBindingOperation | null }) {
  const original = operation?.state === 'applied' && operation.notices?.length ? operation : null
  const key = original?.operationId ?? '', [read, setRead] = useState<{ key: string; deliveries: Record<string, ConnectionDelivery | null>; issue: boolean } | null>(null)
  const [pending, setPending] = useState(false), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!original) return
    let live = true
    setPending(true)
    void Promise.all(original.notices!.map(async notice => {
      let delivery: ConnectionDelivery | null = null
      try {
        const result = await api.connections.call('connection.delivery.inspect', { operationId: notice.deliveryOperationId })
        const value = result.delivery, source = value?.reference.source, binding = original.binding
        if (value?.operationId === notice.deliveryOperationId && source?.kind === 'binding-operation' && source.operationId === original.operationId && source.event === notice.event &&
          value.bindingId === binding.bindingId && value.reference.hostId === binding.executionHostId && value.reference.agentSessionId === binding.agentSessionId) delivery = value
      } catch { /* Preserve the applied relationship independently of this bounded receipt read. */ }
      return [notice.deliveryOperationId, delivery] as const
    })).then(deliveries => { if (live) { setRead(previous => ({ key, deliveries: Object.fromEntries(deliveries.map(([id, delivery]) => [id, delivery ?? (previous?.key === key ? previous.deliveries[id] ?? null : null)])), issue: deliveries.some(([, delivery]) => delivery === null) })); setPending(false) } })
    return () => { live = false }
  }, [key, attempt])
  if (!original) return null
  return <section className="agent-connector-fields" aria-label="Connection notices" aria-busy={pending}>
    <div className="agent-connector-section-title"><h3>Group notice</h3><button type="button" className="agent-connector-text-action" disabled={pending} onClick={() => setAttempt(value => value + 1)}>{pending ? <LoadingIcon size={13} animation="spin" /> : null}Check notice</button></div>
    {original.notices!.map(notice => {
      const delivery = read?.key === key ? read.deliveries[notice.deliveryOperationId] : null
      const status = delivery?.receipt?.state === 'confirmed' ? 'Delivered to the group.'
        : delivery?.state === 'not-applied' ? 'Could not be delivered. The connection change is saved.'
        : delivery?.state === 'pending' ? 'Queued for delivery.'
        : delivery?.state === 'dispatching' ? 'Sending to the group…'
        : 'Delivery is not confirmed. The connection change is saved.'
      return <p key={notice.deliveryOperationId} className="agent-connector-note" role="status"><strong>{labels[notice.event]}</strong> · {status}</p>
    })}
    {read?.key === key && read.issue ? <p className="agent-connector-note" role="status">The latest notice check is unconfirmed. Earlier receipts are kept.</p> : null}
  </section>
}
