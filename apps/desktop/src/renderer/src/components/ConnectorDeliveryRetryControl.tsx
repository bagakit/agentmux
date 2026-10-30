import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionDelivery, ConnectionDeliveryContinuation, ConnectionDeliveryRetrySource, RoomBinding } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from '../lib/api'
import { deliveryMatches, groupTarget } from '../lib/group-diagnosis'
import { connectorRoomIntentKey, sameConnectorTarget, type ConnectorRoomIntent } from '../lib/connector-room-intent'
import { retainConnectorRoomIntent, useAppStore } from '../store'

type Intent = Extract<ConnectorRoomIntent, { method: 'connection.delivery.retry' }>
const sameSource = (a: ConnectionDeliveryRetrySource | undefined, b: ConnectionDeliveryRetrySource | undefined) => !!a && !!b && a.kind === b.kind && a.attempt === b.attempt

/** The selected original receipt borrows its exact Host source; no client qualification owner. */
export function ConnectorDeliveryRetryControl({ delivery, binding, hostingTarget, onObserve }: {
  delivery: ConnectionDelivery; binding: RoomBinding; hostingTarget?: ConnectionHostingTarget | null | undefined; onObserve(value: ConnectionDelivery): void
}) {
  const intents = useAppStore(state => state.connectorRoomIntents)
  const target = { executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
  const history = useMemo(() => Object.values(intents).filter((intent): intent is Intent => intent.method === 'connection.delivery.retry' && intent.input.operationId === delivery.operationId &&
    sameConnectorTarget(intent.target, target) && intent.hostingTarget?.hostId === hostingTarget?.hostId && intent.hostingTarget?.runtimeId === hostingTarget?.runtimeId),
    [intents, delivery.operationId, binding.executionHostId, binding.agentSessionId, hostingTarget?.hostId, hostingTarget?.runtimeId])
  const [selected, setSelected] = useState<string | null>(null)
  const retained = selected ? history.find(intent => connectorRoomIntentKey(intent) === selected) : history.at(-1)
  useEffect(() => { if (selected === null && retained) setSelected(connectorRoomIntentKey(retained)) }, [selected, retained])
  const key = JSON.stringify([groupTarget(binding), hostingTarget, delivery.operationId])
  const current = useRef(key); current.current = key
  const live = useRef(true), flight = useRef(false), saving = useRef('')
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState(''), [localIssue, setLocalIssue] = useState(false)
  const [reply, setReply] = useState<{ inputKey: string; continuation: ConnectionDeliveryContinuation } | null>(null)
  const accepts = (original: string) => live.current && current.current === original
  useEffect(() => { live.current = true; return () => { live.current = false } }, [key])
  const source = delivery.retrySource
  const accepted = !!retained && (sameSource(delivery.lastContinuation?.source, retained.input.source) ||
    reply?.inputKey === connectorRoomIntentKey(retained) && sameSource(reply.continuation.source, retained.input.source))
  const newSource = !!hostingTarget && !!source && (!retained || !sameSource(source, retained.input.source))
  async function run(action: 'inspect' | 'continue' | 'new') {
    if (flight.current) return
    if (action !== 'inspect' && !hostingTarget) { setIssue('Original hosting Runtime unconfirmed. Check this group again.'); return }
    const originalKey = key
    const original = action === 'continue' ? retained : undefined
    const intent: Intent | undefined = action === 'inspect' ? retained : original ?? (source && hostingTarget ? { method: 'connection.delivery.retry', target, hostingTarget: structuredClone(hostingTarget), phase: 'may-have-dispatched',
      input: { operationId: delivery.operationId, source: structuredClone(source) } } : undefined)
    flight.current = true; setBusy(true); setIssue('')
    try {
      if (action !== 'inspect' && intent) {
        // Memory is recorded synchronously by the existing owner. Its disk ACK
        // cannot become a permission or progress prerequisite for this action.
        const inputKey = connectorRoomIntentKey(intent); saving.current = inputKey
        setSelected(inputKey)
        setLocalIssue(true)
        void retainConnectorRoomIntent(intent).then(saved => { if (accepts(originalKey) && saving.current === inputKey) setLocalIssue(!saved.localStorageWritten) }, () => { if (accepts(originalKey) && saving.current === inputKey) setLocalIssue(true) })
      }
      let result: { delivery: ConnectionDelivery | null } | null = null
      let continuation: ConnectionDeliveryContinuation | undefined
      if (action === 'inspect') result = await api.connections.call('connection.delivery.inspect', { operationId: delivery.operationId }, hostingTarget ?? undefined)
      else if (intent) {
        const response = await api.connections.call('connection.delivery.retry', intent.input, intent.hostingTarget)
        result = response; continuation = response.continuation
      }
      if (!accepts(originalKey)) return
      if (!result?.delivery || !deliveryMatches(result.delivery, groupTarget(binding))) { setIssue('Original delivery result unconfirmed. Keep the original request.'); return }
      if (continuation && intent) setReply({ inputKey: connectorRoomIntentKey(intent), continuation })
      onObserve(result.delivery)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (accepts(originalKey)) setIssue(code === 'PUBLICATION_NOT_AUTHORIZED' ? 'This Binding no longer authorizes a new retry. Check the original result.' :
        code === 'RUNTIME_OWNER_MISMATCH' ? 'Original hosting Runtime changed. Use the original Host.' :
        code === 'PUBLICATION_RETRY_UNCONFIRMED' ? 'This source cannot start another retry. Check the original result.' : action === 'inspect' ? 'Original result observation unconfirmed. Keep the original request.' : 'Retry reply unconfirmed. Check the original result.')
    }
    finally { flight.current = false; if (accepts(originalKey)) setBusy(false) }
  }
  const retryButton = newSource ? <button className="small-button" type="button" data-delivery-action="retry" disabled={busy} onClick={() => void run('new')}>{retained ? 'Retry latest failure' : source?.kind === 'content-upload' ? 'Retry upload' : 'Retry message'}</button> : null
  return <div className="agent-connector-fields" data-delivery-retry>
    {retained ? <small role="status">{accepted ? 'Retry accepted · platform result is separate' : 'Original retry result unconfirmed'}</small> : !source ? <small>Original platform result only; no retry source confirmed.</small> : null}
    <div className="agent-connector-row">
      {!retained || accepted ? retryButton : null}
      <button className={retained && !accepted ? 'small-button' : 'agent-connector-text-action'} type="button" data-delivery-action="inspect" disabled={busy} onClick={() => void run('inspect')}>Check original result</button>
      {retained && !accepted ? <button className="agent-connector-text-action" type="button" data-delivery-action="continue" disabled={busy} onClick={() => void run('continue')}>Continue original retry</button> : null}
    </div>
    {issue ? <small role="status">{issue}</small> : null}
    {localIssue ? <small role="status">Local request copy unconfirmed; its original input is kept here.</small> : null}
    {retained ? <details className="agent-connector-disclosure"><summary>Original retry</summary><div className="agent-connector-fields">
      {history.length > 1 ? <label className="agent-connector-field"><span>Submitted source</span><select aria-label="Submitted retry source" value={connectorRoomIntentKey(retained)} onChange={event => { setSelected(event.target.value); setIssue('') }}>
        {history.map(intent => <option key={connectorRoomIntentKey(intent)} value={connectorRoomIntentKey(intent)}>{intent.input.source.kind} · attempt {intent.input.source.attempt}</option>)}
      </select></label> : <code>{retained.input.source.kind} · attempt {retained.input.source.attempt}</code>}
      <button className="agent-connector-text-action" onClick={() => void api.ui.writeClipboardText(JSON.stringify({ hostingTarget: retained.hostingTarget, ...retained.input }, null, 2))}>Copy original request</button>
      {!accepted && newSource ? <><small>A later failure is available. Choosing it starts a separate continuation.</small>{retryButton}</> : null}
    </div></details> : null}
  </div>
}
