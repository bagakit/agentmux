import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionConfigureInput, ConnectionRecord, ConnectionStage } from '@agentmux/core/connections'
import { api } from '../../lib/api'

const stage = (value: ConnectionStage): string => value.state === 'ready' ? 'Ready' : value.state === 'disabled' ? 'Disabled' : value.state === 'unavailable' ? 'Unavailable' : 'Not confirmed'
export function ExternalConnectionsSettings({ active }: { active: boolean }) {
  const [records, setRecords] = useState<ConnectionRecord[]>([]), [issue, setIssue] = useState(''), [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<ConnectionRecord | null>(null), [label, setLabel] = useState(''), [appId, setAppId] = useState(''), [domain, setDomain] = useState('open.feishu.cn'), [secret, setSecret] = useState(''), [enabled, setEnabled] = useState(true)
  const pending = useRef<ConnectionConfigureInput | null>(null), generation = useRef(0), writing = useRef(false)
  const read = async (epoch = generation.current) => {
    try { const result = await api.connections.call('connection.ls', {}); if (epoch === generation.current) setRecords(result.connections) }
    catch (error) { if (epoch === generation.current) setIssue(presentError(error)) }
  }
  useEffect(() => { const epoch = ++generation.current; if (active) void read(epoch); return () => { generation.current++ } }, [active])
  const edit = (record: ConnectionRecord | null) => {
    if (pending.current) { setIssue('Check the pending save before editing another connection.'); return }
    setSelected(record); setLabel(record?.config.label ?? ''); setAppId(record?.config.application.appId ?? ''); setDomain(record?.config.application.domain ?? 'open.feishu.cn'); setEnabled(record?.config.enabled ?? true); setSecret(''); setIssue('')
  }
  const save = async () => {
    if (writing.current) return
    writing.current = true; setBusy(true); setIssue('')
    const epoch = generation.current
    try {
      if (!pending.current) {
        const operationId = crypto.randomUUID(), connectionId = selected?.config.connectionId ?? crypto.randomUUID()
        pending.current = { operationId, expectedRevision: selected?.revision ?? null, connection: { connectionId, adapterId: 'lark', application: { domain, appId }, label, enabled, credentialRef: selected?.config.credentialRef ?? '' } }
      }
      const input = pending.current
      // Reconcile the original config first. A lost response never creates a new operation.
      const existing = await api.connections.call('connection.inspect', { operationId: input.operationId })
      if (!existing.operation) {
        if (secret) {
          const credentialOperation = input.operationId + ':credential'
          const saved = await api.connections.inspectCredential(credentialOperation) ?? await api.connections.storeCredential({ operationId: credentialOperation, secret })
          input.connection.credentialRef = saved.credentialRef
          setSecret('')
        }
        if (!input.connection.credentialRef) throw new Error('Enter the application secret before saving this connection.')
        const saved = await api.connections.call('connection.configure', input)
        if (epoch === generation.current) setSelected(saved.connection)
      } else if (epoch === generation.current) setSelected(existing.connection ?? existing.operation.connection)
      pending.current = null
      if (epoch === generation.current) { setIssue('Connection saved. Check authentication before linking a conversation.'); await read(epoch) }
    } catch (error) { if (epoch === generation.current) setIssue(`Save is unconfirmed. Check this same save before changing its input. ${presentError(error)}`) }
    finally { writing.current = false; setBusy(false) }
  }
  const reviewSave = async () => {
    if (!pending.current || writing.current) return
    writing.current = true; setBusy(true)
    try {
      const input = pending.current, saved = await api.connections.call('connection.inspect', { operationId: input.operationId })
      if (saved.operation) { pending.current = null; edit(saved.connection ?? saved.operation.connection); setIssue('The original save is confirmed.'); }
      else { setIssue('The original configuration save is absent. You can edit and save again.'); }
      pending.current = null; await read()
    } catch (error) { setIssue(`The original save is still unconfirmed. ${presentError(error)}`) }
    finally { writing.current = false; setBusy(false) }
  }
  const test = async (record: ConnectionRecord) => {
    if (writing.current) return
    writing.current = true; setBusy(true)
    const epoch = generation.current
    try { const updated = await api.connections.call('connection.test', { connectionId: record.config.connectionId }); if (epoch === generation.current) { setRecords(current => current.map(item => item.config.connectionId === updated.config.connectionId ? updated : item)); setIssue('Connection check finished. Receiving and sending are reported separately below.') } }
    catch (error) { if (epoch === generation.current) setIssue(presentError(error)) }
    finally { writing.current = false; setBusy(false) }
  }
  if (!active) return null
  return <div className="settings-pane-stack" data-connector-settings>
    <section className="settings-group">
      <div className="settings-pane-toolbar"><h3>Chat connections</h3><button className="small-button" onClick={() => { void read() }}>Refresh</button><button className="small-button" onClick={() => edit(null)}>Add connection</button></div>
      <p className="settings-group-note">Connect an application on this environment, then link a Region conversation to its group. Application secrets stay in this environment’s secure storage.</p>
      {!records.length && <p className="settings-group-note">No chat connections saved.</p>}
      {records.map(record => <article className="settings-group" key={record.config.connectionId} data-connection={record.config.connectionId}>
        <div className="settings-pane-toolbar"><strong>{record.config.label}</strong><button className="small-button" onClick={() => edit(record)}>Edit</button><button className="small-button" disabled={busy} onClick={() => { void test(record) }}>Check connection</button></div>
        <p className="settings-group-note">{record.config.application.domain} · {record.config.application.appId}</p>
        <dl className="connector-stage-list">{(['authentication', 'transport', 'intake', 'delivery'] as const).map(key => <div key={key}><dt>{key === 'intake' ? 'Durable receiving' : key === 'delivery' ? 'Group delivery' : key === 'transport' ? 'Connection' : 'Authentication'}</dt><dd>{stage(record.observation[key])}{record.observation[key].reason && ` · ${record.observation[key].reason!.replaceAll('-', ' ')}`}</dd></div>)}</dl>
      </article>)}
    </section>
    <section className="settings-group agent-settings-fields" data-connection-editor>
      <h3>{selected ? `Edit ${selected.config.label}` : 'Add a chat connection'}</h3>
      <label className="settings-field"><span>Name</span><TextInput aria-label="Connection name" value={label} disabled={!!pending.current} onChange={event => setLabel(event.target.value)} /></label>
      <label className="settings-field"><span>Platform</span><select aria-label="Connection platform" value={domain} disabled={!!selected || !!pending.current} onChange={event => setDomain(event.target.value)}><option value="open.feishu.cn">Feishu</option><option value="open.larksuite.com">Lark</option></select></label>
      <label className="settings-field"><span>App ID</span><TextInput aria-label="Connection app ID" value={appId} disabled={!!selected || !!pending.current} onChange={event => setAppId(event.target.value)} /></label>
      <label className="settings-field"><span>{selected ? 'New app secret (optional)' : 'App secret'}</span><TextInput type="password" aria-label="Connection app secret" autoComplete="new-password" value={secret} disabled={!!pending.current} onChange={event => setSecret(event.target.value)} /></label>
      <label className="settings-field"><span>Enabled</span><input type="checkbox" aria-label="Connection enabled" checked={enabled} disabled={!!pending.current} onChange={event => setEnabled(event.target.checked)} /></label>
      <button className="primary-button" disabled={busy || !label.trim() || !appId.trim() || !selected && !secret && !pending.current} onClick={() => { void save() }}>{busy ? 'Saving…' : pending.current ? 'Check pending save' : 'Save connection'}</button>
      {pending.current && <button className="small-button" disabled={busy} onClick={() => { void reviewSave() }}>Review original save</button>}
    </section>
    {issue && <p role="status" className="settings-group-note">{issue}</p>}
  </div>
}
