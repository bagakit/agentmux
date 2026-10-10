import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfileObservation, ConnectionProfileOperation, ConnectionRecord } from '@agentmux/core/connections'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import { ConnectionProfileObservationView, ConnectionProfileResult, ProfileManagementLink } from '../ConnectionProfileResult'

/** Reads one selected application's original profile operations, without another identity registry. */
export function ConnectionProfilePanel({ record }: { record: ConnectionRecord }) {
  const [expanded, setExpanded] = useState(false), [operations, setOperations] = useState<ConnectionProfileOperation[]>([])
  const [observation, setObservation] = useState<ConnectionProfileObservation | null>(null), [selected, setSelected] = useState<string | null>(null)
  const [issue, setIssue] = useState(''), [next, setNext] = useState<string | null>(null), [pending, setPending] = useState<string[]>([])
  const selection = useRef<string | null>(null), feedback = useRef(0)
  const lifetime = useRef(0), order = useRef(new Map<string, number>()), writing = useRef(new Set<string>())
  const generation = (key: string) => { const n = (order.current.get(key) ?? 0) + 1; order.current.set(key, n); return n }
  const key = JSON.stringify([record.config.connectionId, record.config.application, record.revision])
  function accept(operation: ConnectionProfileOperation) {
    if (operation.connectionId !== record.config.connectionId || operation.application.appId !== record.config.application.appId || operation.application.domain !== record.config.application.domain) return
    setOperations(current => current.some(item => item.operationId === operation.operationId) ? current.map(item => item.operationId === operation.operationId ? operation : item) : [operation, ...current])
  }
  async function list(cursor?: string) {
    const token = lifetime.current, before = new Map(order.current), sequence = generation('list'), message = feedback.current
    try {
      const result = await api.connections.call('connection.profile.ls', { connectionId: record.config.connectionId, limit: 25, ...(cursor ? { cursor } : {}) })
      if (token !== lifetime.current || order.current.get('list') !== sequence) return
      for (const operation of result.operations) if (before.get(operation.operationId) === order.current.get(operation.operationId)) accept(operation)
      setNext(result.next)
    } catch (error) { if (token === lifetime.current && message === feedback.current) setIssue(presentError(error)) }
  }
  useEffect(() => { lifetime.current++; setOperations([]); setObservation(null); setSelected(null); selection.current = null; setIssue(''); setNext(null); if (expanded) void list(); return () => { lifetime.current++ } }, [key, expanded])
  async function get() {
    const token = lifetime.current, sequence = generation('get'), message = ++feedback.current; setIssue('Reading the current online profile…')
    try {
      const result = await api.connections.call('connection.profile.get', { connectionId: record.config.connectionId, expectedConnectionRevision: record.revision })
      if (token === lifetime.current && sequence === order.current.get('get') && message === feedback.current) { setObservation(result); setIssue('The current observation is shown below. It does not confirm a previous update or publication.') }
    } catch (error) { if (token === lifetime.current && sequence === order.current.get('get') && message === feedback.current) setIssue(presentError(error)) }
  }
  async function check(id: string, advance: boolean) {
    if (advance && writing.current.has(id)) return
    const token = lifetime.current, sequence = generation(id), message = ++feedback.current
    setSelected(id); selection.current = id; setIssue('Reading the original update…')
    if (advance) { writing.current.add(id); setPending([...writing.current]) }
    try {
      const result = advance ? await api.connections.call('connection.profile.advance', { operationId: id }) : (await api.connections.call('connection.profile.inspect', { operationId: id })).operation
      if (token === lifetime.current && sequence === order.current.get(id)) { if (result) accept(result); if (selection.current === id && message === feedback.current) setIssue(result ? 'The original update is shown. Unconfirmed platform effects are not sent again.' : 'No recorded update was found. Its result remains unconfirmed.') }
    } catch (error) { if (token === lifetime.current && sequence === order.current.get(id) && selection.current === id) setIssue(presentError(error)) }
    finally { if (advance) { writing.current.delete(id); setPending([...writing.current]) } }
  }
  const operation = operations.find(item => item.operationId === selected)
  return <details className="connector-profile" data-connection-profile={record.config.connectionId} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Public bot profile</summary><p className="settings-group-note">The bot’s public profile is separate from its name in AgentMux and its connection status.</p>
    {expanded ? <><div className="connector-editor-actions"><button type="button" className="small-button" onClick={() => void get()}>Read current profile</button><button type="button" className="small-button" onClick={() => void list()}>Find original updates</button></div>
      {observation ? <><ConnectionProfileObservationView observation={observation} /><ProfileManagementLink url={observation.managementUrl} /></> : null}
      {operations.length ? <div className="bot-profile-operations">{operations.map(item => <button type="button" className="small-button" data-profile-select={item.operationId} key={item.operationId} onClick={() => void check(item.operationId, false)}>{item.desired.name ?? 'Profile update'} · {item.patch.state === 'confirmed' ? 'Written, publication separate' : item.patch.state === 'unknown' || item.patch.state === 'dispatching' ? 'Result not confirmed' : 'Update incomplete'}</button>)}</div> : <p className="settings-group-note">No saved profile update is shown in this reading window.</p>}
      {next ? <button type="button" className="small-button" onClick={() => void list(next)}>Load earlier updates</button> : null}
      {operation ? <><ConnectionProfileResult operation={operation} /><div className="connector-editor-actions"><button type="button" className="small-button" onClick={() => void check(operation.operationId, false)}>View original update</button><button type="button" className="small-button" disabled={pending.includes(operation.operationId)} onClick={() => void check(operation.operationId, true)}>Check update progress</button></div></> : null}
      {issue ? <p role="status" className="connector-issue">{issue}</p> : null}</> : null}
  </details>
}
