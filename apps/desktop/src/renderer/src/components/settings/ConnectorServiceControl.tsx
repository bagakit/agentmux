import { mintObjectId } from '@agentmux/core/object-id'
import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { parseConnectionServiceResult, type ConnectionServiceOperation, type ConnectionServiceState } from '@agentmux/core/connections'
import { retainConnectorServiceIntent, useAppStore } from '../../store'
import { api } from '../../lib/api'
import type { ConnectionHostingTarget } from '../../../../shared/contracts'
import { connectorServiceScope, observeConnectorService, readConnectorService, selectConnectorServiceObservation } from '../../lib/connector-service-observation'

const RefreshIcon = semanticIconComponent('action.refresh')

type RequestObservation = { receipt?: ConnectionServiceOperation | null; issue?: string }

/** Presentation and raw submitted inputs only; the original ConnectionHost owns policy and ACKs. */
export function ConnectorServiceControl({ active, hostingTarget }: { active: boolean; hostingTarget?: ConnectionHostingTarget | null }) {
  const source = api.connections.call
  const [discovered, setDiscovered] = useState<{ source: typeof source; target: ConnectionHostingTarget } | null>(null)
  const target = hostingTarget === undefined ? discovered?.source === source ? discovered.target : null : hostingTarget
  const scope = target ? connectorServiceScope(target) : null
  const observed = useAppStore(state => selectConnectorServiceObservation(state.connectorServiceObservation, target))
  const intents = useAppStore(state => state.connectorServiceIntents)
  const state = observed?.state ?? null, issue = observed?.issue ?? ''
  const [draft, setDraft] = useState<boolean | null>(null)
  const [baseline, setBaseline] = useState<{ state: ConnectionServiceState; source: typeof source; target: ConnectionHostingTarget } | null>(null)
  const [needsCurrent, setNeedsCurrent] = useState(false)
  const [requests, setRequests] = useState<Record<string, RequestObservation>>({})
  const [writes, setWrites] = useState<string[]>([]), [notice, setNotice] = useState('')
  const busy = scope !== null && writes.includes(scope)
  const selection = useRef(0), reading = useRef(0), writing = useRef(new Set<string>())
  const hostingIdentity = JSON.stringify(hostingTarget)
  useEffect(() => {
    ++selection.current; ++reading.current
    setDraft(null); setBaseline(null); setNeedsCurrent(false); setNotice('')
    if (active) checkCurrent()
    return () => { ++selection.current; ++reading.current }
  }, [active, hostingIdentity, source])
  function checkCurrent() {
    const generation = ++reading.current, selected = selection.current
    if (hostingTarget === null) { setNotice('The original connector hosting target is not confirmed. Existing requests are kept.'); return }
    void (async () => {
      const original = hostingTarget ?? await api.connections.hostingTarget()
      if (generation !== reading.current || selected !== selection.current || source !== api.connections.call) return
      if (hostingTarget === undefined) setDiscovered({ source, target: original })
      await readConnectorService(() => generation === reading.current && selected === selection.current, original)
    })().catch(error => { if (generation === reading.current && selected === selection.current) setNotice(presentError(error)) })
  }
  function observeRequest(operationId: string, next: RequestObservation) {
    setRequests(previous => {
      const original = previous[operationId]
      return { ...previous, [operationId]: { ...original, ...next,
        // A later reader gap or absent snapshot cannot revoke a confirmed original receipt.
        ...(original?.receipt ? { receipt: original.receipt } : {}),
        ...(original?.receipt && next.receipt === null ? { issue: 'The latest lookup returned no receipt. The original confirmed receipt is kept.' } : {})
      } }
    })
  }

  async function newChoice() {
    if (!target) return
    const original = target, generation = ++selection.current, choice = draft, source = api.connections.call
    try {
      const read = await readConnectorService(() => generation === selection.current, original)
      if (generation !== selection.current || source !== api.connections.call) return
      const current = selectConnectorServiceObservation(useAppStore.getState().connectorServiceObservation, original)
      const next = current?.state && current.state.revision >= read.revision ? current.state : read
      setBaseline({ state: next, source, target: original }); setNeedsCurrent(false); setDraft(choice ?? next.enabled); setNotice('The next save is a new request. Previous requests remain available below.')
    } catch { /* The persistent service window keeps the last confirmed policy and recovery action. */ }
  }
  async function save() {
    if (!target || !scope || writing.current.has(scope) || draft === null || !baseline || needsCurrent || baseline.source !== api.connections.call || connectorServiceScope(baseline.target) !== scope) return
    const original = baseline.target
    const input = { operationId: mintObjectId(), expectedRevision: baseline.state.revision, service: { enabled: draft } }
    const generation = selection.current, source = api.connections.call
    writing.current.add(scope); setWrites([...writing.current]); setNeedsCurrent(true); setNotice('')
    try {
      const retained = await retainConnectorServiceIntent({ input, hostingTarget: original, phase: 'not-dispatched' })
      if (!retained.localStorageWritten) throw new Error('The original service request could not be saved. No request was sent.')
      const dispatch = await retainConnectorServiceIntent({ input, hostingTarget: original, phase: 'may-have-dispatched' })
      if (!dispatch.localStorageWritten) {
        await retainConnectorServiceIntent({ input, hostingTarget: original, phase: 'not-dispatched' })
        throw new Error('The original dispatch input could not be saved. No request was sent.')
      }
      const receipt = await source('connection.service.configure', input, original)
      observeRequest(input.operationId, { receipt, issue: '' })
      observeConnectorService(receipt.service, source, original)
      if (generation === selection.current) { setDraft(null); setBaseline(null); setNeedsCurrent(false); setNotice('External chat sync saved. Each application keeps its own enabled preference.') }
    } catch (error) {
      observeRequest(input.operationId, { issue: presentError(error) })
      if (generation === selection.current) setNotice('The save reply is unconfirmed. Check the original request below. Its confirmed receipts are kept separately from current service reads.')
    } finally { writing.current.delete(scope); setWrites([...writing.current]) }
  }
  async function inspect(operationId: string) {
    const intent = useAppStore.getState().connectorServiceIntents[operationId]
    if (!intent?.hostingTarget) return
    try {
      const result = await api.connections.call('connection.service.inspect', { operationId }, intent.hostingTarget)
      const receipt = result.operation ? parseConnectionServiceResult('connection.service.configure', result.operation, intent.input) : null
      // An original receipt is historical evidence, never a setter for the current policy or draft.
      observeRequest(operationId, { receipt, issue: '' })
    } catch (error) { observeRequest(operationId, { issue: presentError(error) }) }
  }

  if (!active) return null
  return <section className="settings-group connector-service-control" aria-label="Connector service" data-connector-service>
    <div className="connector-service-control__heading"><div><h3>Automatic chat sync</h3><p className="settings-group-note">Automatic messages for all bots. Individual bot settings are kept.</p></div><div className="connector-service-control__setting"><span role="status" data-connector-service-state={state ? state.enabled ? 'on' : 'off' : 'unconfirmed'}>{state ? `${issue ? 'Last confirmed: ' : ''}${state.enabled ? 'On' : 'Off'}` : 'State not confirmed'}</span>{state ? <label className="connector-enabled"><input type="checkbox" aria-label="Enable external chat sync" checked={draft ?? state.enabled} onChange={event => {
      ++selection.current; if (!needsCurrent) setBaseline({ state, source: api.connections.call, target: target! }); setDraft(event.target.checked); setNotice('')
    }} /><span>Enable</span></label> : null}<button className="small-button connector-service-control__refresh" onClick={checkCurrent}><RefreshIcon size={14} />Refresh status</button></div></div>
    {draft !== null ? <div className="connector-editor-actions"><span className="settings-group-note">Unsaved change</span><button data-connector-service-save className="primary-button" disabled={busy || !baseline || needsCurrent || baseline.source !== api.connections.call || !scope || connectorServiceScope(baseline.target) !== scope} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>{needsCurrent ? <button className="small-button" onClick={() => void newChoice()}>Review latest setting</button> : null}</div> : null}
    {issue ? <p className="connector-check-feedback" role="status">Sync status could not be refreshed. You can still manage your bots.</p> : null}
    {notice ? <p className="settings-group-note" role="status">{notice}</p> : null}
    <details className="connector-service-requests"><summary>Sync settings and history</summary><p className="settings-group-note">Turning sync off pauses new automatic messages for all bots. Your bots, groups and each bot’s own setting are kept.</p>{issue ? <p className="connector-enrollment__technical">{issue}</p> : null}{Object.values(intents).length ? <p className="settings-group-note">Earlier changes and their original results are kept here. Refreshing the current status does not confirm an earlier save.</p> : null}{Object.values(intents).filter(intent => !intent.hostingTarget || target && connectorServiceScope(intent.hostingTarget) === scope).map(intent => {
      const result = requests[intent.input.operationId]
      return <div className="agent-connector-receipt" key={intent.input.operationId} data-service-operation={intent.input.operationId}>
        <strong>Requested {intent.input.service.enabled ? 'On' : 'Off'}</strong><code>{intent.input.operationId}</code>
        <span role="status">{result?.receipt ? `Original request confirmed: ${result.receipt.service.enabled ? 'On' : 'Off'} at revision ${result.receipt.service.revision}` : result?.receipt === null ? 'No receipt found for this original request. Its result is unconfirmed.' : intent.phase === 'not-dispatched' ? 'Request retained before dispatch; no dispatch is confirmed.' : 'The original request result is unconfirmed.'}</span>
        {!intent.hostingTarget ? <p className="settings-group-note">The original hosting target is not recorded. Keep this request reference; it cannot be checked against the default Host.</p> : null}
        {result?.issue ? <p className="connector-issue" role="status">{result.issue}</p> : null}
        <button className="small-button" disabled={!intent.hostingTarget} aria-label={`Check original service request ${intent.input.operationId}`} onClick={() => void inspect(intent.input.operationId)}>Check original request</button>
        <details><summary>Submitted input</summary><code>{JSON.stringify(intent.input)}</code></details>
      </div>
    })}</details>
  </section>
}
