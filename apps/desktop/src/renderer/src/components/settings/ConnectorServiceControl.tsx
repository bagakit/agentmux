import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { parseConnectionServiceResult, type ConnectionServiceOperation, type ConnectionServiceState } from '@agentmux/core/connections'
import { retainConnectorServiceIntent, useAppStore } from '../../store'
import { api } from '../../lib/api'
import { observeConnectorService, readConnectorService } from '../../lib/connector-service-observation'

type RequestObservation = { receipt?: ConnectionServiceOperation | null; issue?: string }

/** Presentation and raw submitted inputs only; the original ConnectionHost owns policy and ACKs. */
export function ConnectorServiceControl({ active }: { active: boolean }) {
  const observed = useAppStore(state => state.connectorServiceObservation)
  const intents = useAppStore(state => state.connectorServiceIntents)
  const state = observed?.source === api.connections.call ? observed.state : null
  const issue = observed?.source === api.connections.call ? observed.issue : ''
  const [draft, setDraft] = useState<boolean | null>(null)
  const [baseline, setBaseline] = useState<{ state: ConnectionServiceState; source: typeof api.connections.call } | null>(null)
  const [needsCurrent, setNeedsCurrent] = useState(false)
  const [requests, setRequests] = useState<Record<string, RequestObservation>>({})
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const selection = useRef(0), reading = useRef(0), writing = useRef(false)
  useEffect(() => {
    ++selection.current
    const generation = ++reading.current
    if (active) void readConnectorService(() => generation === reading.current).catch(() => {})
    return () => { ++selection.current; ++reading.current }
  }, [active])
  function checkCurrent() {
    const generation = ++reading.current
    void readConnectorService(() => generation === reading.current).catch(() => {})
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
    const generation = ++selection.current, choice = draft, source = api.connections.call
    try {
      const read = await readConnectorService(() => generation === selection.current)
      if (generation !== selection.current || source !== api.connections.call) return
      const current = useAppStore.getState().connectorServiceObservation
      const next = current?.source === api.connections.call && current.state && current.state.revision >= read.revision ? current.state : read
      setBaseline({ state: next, source }); setNeedsCurrent(false); setDraft(choice ?? next.enabled); setNotice('The next save is a new request. Previous requests remain available below.')
    } catch { /* The persistent service window keeps the last confirmed policy and recovery action. */ }
  }
  async function save() {
    if (writing.current || draft === null || !baseline || needsCurrent || baseline.source !== api.connections.call) return
    const input = { operationId: crypto.randomUUID(), expectedRevision: baseline.state.revision, service: { enabled: draft } }
    const generation = selection.current, source = api.connections.call
    writing.current = true; setBusy(true); setNeedsCurrent(true); setNotice('')
    try {
      const retained = await retainConnectorServiceIntent({ input, phase: 'not-dispatched' })
      if (!retained.localStorageWritten) throw new Error('The original service request could not be saved. No request was sent.')
      const dispatch = await retainConnectorServiceIntent({ input, phase: 'may-have-dispatched' })
      if (!dispatch.localStorageWritten) {
        await retainConnectorServiceIntent({ input, phase: 'not-dispatched' })
        throw new Error('The original dispatch input could not be saved. No request was sent.')
      }
      const receipt = await source('connection.service.configure', input)
      observeRequest(input.operationId, { receipt, issue: '' })
      observeConnectorService(receipt.service, source)
      if (generation === selection.current) { setDraft(null); setBaseline(null); setNeedsCurrent(false); setNotice('Connector service saved. Each application keeps its own enabled preference.') }
    } catch (error) {
      observeRequest(input.operationId, { issue: presentError(error) })
      if (generation === selection.current) setNotice('The save reply is unconfirmed. Check the original request below. Its confirmed receipts are kept separately from current service reads.')
    } finally { writing.current = false; setBusy(false) }
  }
  async function inspect(operationId: string) {
    try {
      const result = await api.connections.call('connection.service.inspect', { operationId })
      const input = useAppStore.getState().connectorServiceIntents[operationId]?.input
      if (!input) throw new Error('The original submitted input is unavailable. Keep the request reference and inspect it in the original service.')
      const receipt = result.operation ? parseConnectionServiceResult('connection.service.configure', result.operation, input) : null
      // An original receipt is historical evidence, never a setter for the current policy or draft.
      observeRequest(operationId, { receipt, issue: '' })
    } catch (error) { observeRequest(operationId, { issue: presentError(error) }) }
  }

  if (!active) return null
  return <section className="settings-group connector-service-control" aria-label="Connector service" data-connector-service>
    <div className="connector-service-control__heading"><h3>Connector service</h3><span role="status" data-connector-service-state={state ? state.enabled ? 'on' : 'off' : 'unconfirmed'}>{state ? `${issue ? 'Last confirmed: ' : ''}${state.enabled ? 'On' : 'Off'}` : 'State not confirmed'}</span></div>
    <p className="settings-group-note">Controls automatic messages in both directions for all applications. Turning it off keeps your bots, groups and individual application preferences.</p>
    {state ? <label className="connector-enabled"><input type="checkbox" aria-label="Enable Agent Conversation Connector" checked={draft ?? state.enabled} onChange={event => {
      ++selection.current; if (!needsCurrent) setBaseline({ state, source: api.connections.call }); setDraft(event.target.checked); setNotice('')
    }} /><span>Enable Agent Conversation Connector</span></label> : null}
    <div className="connector-editor-actions"><button className="primary-button" disabled={busy || draft === null || !baseline || needsCurrent || baseline.source !== api.connections.call} onClick={() => void save()}>{busy ? 'Saving service…' : 'Save Connector service'}</button><button className="small-button" onClick={checkCurrent}>Check current service</button>{draft !== null ? <button className="small-button" onClick={() => void newChoice()}>Use current revision for a new change</button> : null}</div>
    {issue ? <p className="connector-issue" role="status">The current service check is unconfirmed. {issue} Application management and original request checks remain available.</p> : null}
    {notice ? <p className="settings-group-note" role="status">{notice}</p> : null}
    {Object.values(intents).length ? <details className="connector-service-requests"><summary>Original service requests</summary><p className="settings-group-note">These are the submitted inputs and their original receipts. A current state read cannot confirm an earlier save.</p>{Object.values(intents).map(intent => {
      const result = requests[intent.input.operationId]
      return <div className="agent-connector-receipt" key={intent.input.operationId} data-service-operation={intent.input.operationId}>
        <strong>Requested {intent.input.service.enabled ? 'On' : 'Off'}</strong><code>{intent.input.operationId}</code>
        <span role="status">{result?.receipt ? `Original request confirmed: ${result.receipt.service.enabled ? 'On' : 'Off'} at revision ${result.receipt.service.revision}` : result?.receipt === null ? 'No receipt found for this original request. Its result is unconfirmed.' : intent.phase === 'not-dispatched' ? 'Request retained before dispatch; no dispatch is confirmed.' : 'The original request result is unconfirmed.'}</span>
        {result?.issue ? <p className="connector-issue" role="status">{result.issue}</p> : null}
        <button className="small-button" aria-label={`Check original service request ${intent.input.operationId}`} onClick={() => void inspect(intent.input.operationId)}>Check original request</button>
        <details><summary>Submitted input</summary><code>{JSON.stringify(intent.input)}</code></details>
      </div>
    })}</details> : null}
  </section>
}
