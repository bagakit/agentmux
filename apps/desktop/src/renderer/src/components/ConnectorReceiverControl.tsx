import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import type { ConnectionRecord, ConnectionReceiverRecoveryOperation, GroupDiagnosis, RoomBinding } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from '../lib/api'
import { retainConnectorRoomIntent, clearConnectorRoomIntent, useAppStore } from '../store'
import type { ConnectorRoomIntent } from '../lib/connector-room-intent'
import { sameConnectorTarget } from '../lib/connector-room-intent'

type Intent = Extract<ConnectorRoomIntent, { method: 'connection.receiver.recover' }>
/** Local action presentation over the original submitted correlation and Host journal. */
export function ConnectorReceiverControl({ binding, connection, observed, hostingTarget, onRefresh, render }: {
  binding: RoomBinding; connection?: ConnectionRecord | undefined; observed?: GroupDiagnosis['connection'] | undefined
  hostingTarget?: ConnectionHostingTarget | null | undefined; onRefresh(): void
  render?(view: { primary: ReactNode; diagnostics: ReactNode; feedback?: ReactNode }): ReactNode
}) {
  const intents = useAppStore(state => state.connectorRoomIntents)
  const target = { executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
  const retained = useMemo(() => Object.values(intents).filter((intent): intent is Intent => intent.method === 'connection.receiver.recover' &&
    intent.input.connectionId === binding.connectionId && sameConnectorTarget(intent.target, target) &&
    intent.hostingTarget?.hostId === hostingTarget?.hostId && intent.hostingTarget?.runtimeId === hostingTarget?.runtimeId).at(-1),
    [intents, binding.connectionId, binding.executionHostId, binding.agentSessionId, hostingTarget?.hostId, hostingTarget?.runtimeId])
  const key = JSON.stringify([hostingTarget, binding.connectionId, target])
  const current = useRef(key); current.current = key
  const flight = useRef(false), alive = useRef(true)
  const [operation, setOperation] = useState<ConnectionReceiverRecoveryOperation | null>(null)
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState(''), [localIssue, setLocalIssue] = useState(false)
  const receiver = observed?.issue || observed?.retained ? undefined : observed?.value?.receiver
  // An unknown reply keeps its original ID. A known joined/read/policy decision
  // is not a permanent gate once this receiver has actually ended.
  const previousFinished = !!operation && (operation.disposition !== 'scheduled' || operation.receiverRef !== receiver?.ref)
  const canStart = !!hostingTarget && connection?.capabilities?.receiverRecovery === true && receiver?.state === 'ended' && receiver.nextAttemptAt === undefined &&
    (!retained || previousFinished)
  const accepts = (original: string) => alive.current && current.current === original
  useEffect(() => { alive.current = true; setOperation(null); setIssue(''); setLocalIssue(false); return () => { alive.current = false } }, [key])
  async function run(action: 'inspect' | 'continue' | 'new') {
    if (flight.current || !hostingTarget) return
    const originalKey = key
    // A continuation retains the complete original tuple, including its operation ID.
    const original = action !== 'new' ? retained : undefined
    const intent: Intent = original ?? { method: 'connection.receiver.recover', target, hostingTarget: structuredClone(hostingTarget), phase: 'may-have-dispatched',
      input: { operationId: mintObjectId(), connectionId: binding.connectionId, expectedRevision: observed!.value!.revision, receiverRef: receiver!.ref } }
    flight.current = true; setBusy(true); setIssue('')
    try {
      if (action !== 'inspect') {
        try { const saved = await retainConnectorRoomIntent({ ...intent, phase: 'may-have-dispatched' }); if (accepts(originalKey)) setLocalIssue(!saved.clientStateWritten) }
        catch { if (accepts(originalKey)) setLocalIssue(true) } // Local durability is not management authority.
      }
      const result = action === 'inspect'
        ? await api.connections.call('connection.receiver.inspect', { operationId: intent.input.operationId }, intent.hostingTarget)
        : await api.connections.call('connection.receiver.recover', intent.input, intent.hostingTarget)
      if (!accepts(originalKey)) return
      setOperation(result.operation)
      if (!result.operation) setIssue('Recovery is not confirmed. Keep this original request.')
      if (action === 'new' && retained) void clearConnectorRoomIntent(retained.input.operationId).catch(() => {})
      onRefresh()
    } catch { if (accepts(originalKey)) setIssue('Recovery reply unconfirmed. Check the original request.') }
    finally { flight.current = false; if (accepts(originalKey)) setBusy(false) }
  }
  useEffect(() => { if (retained) void run('inspect') }, [key, retained?.input.operationId])
  const complete = !!operation && receiver?.state === 'ready'
  const automatic = receiver?.state === 'starting' || receiver?.state === 'recovering' ||
    receiver?.state === 'ended' && receiver.nextAttemptAt !== undefined && receiver.nextAttemptAt > Date.now()
  const status = complete ? 'Recovery recorded' : operation?.disposition === 'scheduled' ? 'Reconnect requested' : operation?.disposition === 'joined' ? 'Joining original recovery' :
    operation?.disposition === 'already-ready' ? 'No reconnect was needed' : operation?.disposition === 'not-current' ? 'Original receiver changed' :
    operation?.disposition === 'disabled' ? 'Automatic receiving is off' : operation ? 'Connection unconfirmed' : ''
  if (render) {
    const online = receiver?.state === 'ready' && observed?.value?.transport.state === 'ready'
    const primaryAction = canStart ? 'new' : retained && !complete && !online ? 'inspect' : null
    const primary = primaryAction ? <button type="button" className="primary-button" disabled={busy} data-receiver-action={primaryAction === 'new' ? 'recover' : 'inspect'} onClick={() => void run(primaryAction)}>{primaryAction === 'new' ? 'Reconnect bot' : automatic || receiver?.nextAttemptAt !== undefined ? 'Check progress' : 'Check recovery'}</button> : null
    const diagnostics = canStart || retained ? <div data-receiver-control>
      {status ? <small role="status">{status}</small> : null}
      {busy ? <small role="status">Checking the saved receiver…</small> : null}
      {issue ? <small role="status">{issue}</small> : null}
      {localIssue ? <small role="status">This request is kept here; its local copy is not durable.</small> : null}
      {retained ? <div className="agent-connector-fields"><code>{retained.input.operationId}</code><div className="agent-connector-row">
        {primaryAction !== 'inspect' && !complete ? <button type="button" className="small-button" disabled={busy} data-receiver-action="inspect" onClick={() => void run('inspect')}>Check recovery</button> : null}
        {!canStart && !automatic && !complete ? <button type="button" className="agent-connector-text-action" disabled={busy} data-receiver-action="continue" onClick={() => void run('continue')}>Continue this request</button> : null}
      </div></div> : null}
    </div> : null
    const feedback = !online && (status || issue || busy) ? <small role="status">{busy ? 'Checking this receiver…' : issue || status}</small> : null
    return render({ primary, diagnostics, feedback })
  }
  if (!canStart && !retained) return null
  return <div className="connector-traffic-summary__receiver" data-receiver-control>
    {status ? <small role="status">{status}</small> : null}
    <div className="agent-connector-row">
      {canStart ? <button type="button" className="small-button" disabled={busy} data-receiver-action="recover" onClick={() => void run('new')}>Reconnect bot</button> : null}
      {retained && !complete ? <><button type="button" className="small-button" disabled={busy} data-receiver-action="inspect" onClick={() => void run('inspect')}>Check recovery</button>
        {!canStart && !automatic ? <button type="button" className="agent-connector-text-action" disabled={busy} data-receiver-action="continue" onClick={() => void run('continue')}>Continue recovery</button> : null}</> : null}
    </div>
    {busy ? <small role="status">Checking original receiver…</small> : null}
    {issue ? <small role="status">{issue}</small> : null}
    {localIssue ? <small role="status">This request is kept here; its local copy is not durable.</small> : null}
    {retained ? <details className="agent-connector-disclosure"><summary>Original recovery</summary><code>{retained.input.operationId}</code>
      <button className="agent-connector-text-action" onClick={() => void api.ui.writeClipboardText(JSON.stringify({ hostingTarget: retained.hostingTarget, ...retained.input }, null, 2))}>Copy original request</button></details> : null}
  </div>
}
