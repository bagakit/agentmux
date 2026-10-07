import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionConfigureInput, ConnectionObservation, ConnectionRecord, ConnectionStage } from '@agentmux/core/connections'
import { api } from '../../lib/api'

const stage = (value: ConnectionStage): string => value.state === 'ready' ? 'Ready' : value.state === 'disabled' ? 'Disabled' : value.state === 'unavailable' ? 'Unavailable' : 'Not confirmed'
const stageLabels = { authentication: 'Authentication', transport: 'Connection', intake: 'Durable receiving', delivery: 'Group delivery' } as const
function checkSummary(observation: ConnectionObservation): string {
  const labels = (state: ConnectionStage['state']) => (Object.keys(stageLabels) as Array<keyof ConnectionObservation>).filter(key => observation[key].state === state).map(key => stageLabels[key].toLowerCase()).join(', ')
  return ['Check finished.', labels('unknown') && `Not confirmed: ${labels('unknown')}.`, labels('unavailable') && `Unavailable: ${labels('unavailable')}.`].filter(Boolean).join(' ')
}
const platform = (domain: string) => domain === 'open.feishu.cn' ? 'Feishu' : domain === 'open.larksuite.com' ? 'Lark' : domain
export function ExternalConnectionsSettings({ active }: { active: boolean }) {
  const [records, setRecords] = useState<ConnectionRecord[]>([]), [issue, setIssue] = useState(''), [busy, setBusy] = useState(false)
  const [saveNotice, setSaveNotice] = useState(''), [checking, setChecking] = useState<string | null>(null), [checks, setChecks] = useState<Record<string, { revision: number; text: string }>>({})
  const [selected, setSelected] = useState<ConnectionRecord | null>(null), [label, setLabel] = useState(''), [appId, setAppId] = useState(''), [domain, setDomain] = useState('open.feishu.cn'), [secret, setSecret] = useState(''), [enabled, setEnabled] = useState(true)
  const pending = useRef<ConnectionConfigureInput | null>(null), generation = useRef(0), writing = useRef(false)
  const read = async (epoch = generation.current) => {
    try { const result = await api.connections.call('connection.ls', {}); if (epoch === generation.current) setRecords(result.connections) }
    catch (error) { if (epoch === generation.current) setIssue(presentError(error)) }
  }
  useEffect(() => { const epoch = ++generation.current; if (active) void read(epoch); return () => { generation.current++ } }, [active])
  const edit = (record: ConnectionRecord | null) => {
    if (pending.current) { setIssue('Check the pending save before editing another connection.'); return }
    setSelected(record); setLabel(record?.config.label ?? ''); setAppId(record?.config.application.appId ?? ''); setDomain(record?.config.application.domain ?? 'open.feishu.cn'); setEnabled(record?.config.enabled ?? true); setSecret(''); setIssue(''); setSaveNotice('')
  }
  const save = async () => {
    if (writing.current) return
    writing.current = true; setBusy(true); setIssue(''); setSaveNotice('')
    const epoch = generation.current
    try {
      if (!pending.current) {
        const operationId = crypto.randomUUID(), connectionId = selected?.config.connectionId ?? crypto.randomUUID()
        pending.current = { operationId, expectedRevision: selected?.revision ?? null, connection: { connectionId, adapterId: selected?.config.adapterId ?? 'feishu', application: { domain, appId }, label, enabled, credentialRef: selected?.config.credentialRef ?? '' } }
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
      if (epoch === generation.current) { setSaveNotice('Connection saved.'); await read(epoch) }
    } catch (error) { if (epoch === generation.current) setIssue(`Save is unconfirmed. Check this same save before changing its input. ${presentError(error)}`) }
    finally { writing.current = false; setBusy(false) }
  }
  const reviewSave = async () => {
    if (!pending.current || writing.current) return
    writing.current = true; setBusy(true)
    try {
      const input = pending.current, saved = await api.connections.call('connection.inspect', { operationId: input.operationId })
      if (saved.operation) { pending.current = null; edit(saved.connection ?? saved.operation.connection); setSaveNotice('The original save is confirmed.'); }
      else { setIssue('The original configuration save is absent. You can edit and save again.'); }
      pending.current = null; await read()
    } catch (error) { setIssue(`The original save is still unconfirmed. ${presentError(error)}`) }
    finally { writing.current = false; setBusy(false) }
  }
  const test = async (record: ConnectionRecord) => {
    if (writing.current) return
    writing.current = true; setBusy(true); setChecking(record.config.connectionId)
    const epoch = generation.current
    setChecks(current => ({ ...current, [record.config.connectionId]: { revision: record.revision, text: 'Checking connection…' } }))
    try {
      const updated = await api.connections.call('connection.test', { connectionId: record.config.connectionId })
      if (epoch === generation.current) {
        setRecords(current => current.map(item => item.config.connectionId === updated.config.connectionId ? updated : item))
        setChecks(current => ({ ...current, [updated.config.connectionId]: { revision: updated.revision, text: checkSummary(updated.observation) } }))
      }
    } catch (error) { if (epoch === generation.current) setChecks(current => ({ ...current, [record.config.connectionId]: { revision: record.revision, text: `Check is unconfirmed. ${presentError(error)}` } })) }
    finally { writing.current = false; setBusy(false); setChecking(null) }
  }
  const dirty = !selected || label !== selected.config.label || enabled !== selected.config.enabled || !!secret
  const savePrimary = dirty || !!pending.current
  if (!active) return null
  return <div className="settings-pane-stack" data-connector-settings>
    <section className="settings-group connector-list" aria-label="Saved chat applications">
      <div className="settings-pane-toolbar"><span className="connector-section-label">Saved applications · {records.length}</span><button className="small-button" onClick={() => { void read() }}>Refresh</button><button className="small-button" onClick={() => edit(null)}>Add connection</button></div>
      <p className="settings-group-note">Application secrets stay in this environment’s secure storage. Link a Region after checking the saved application.</p>
      {!records.length && <p className="settings-group-note">No chat connections saved.</p>}
      {records.map(record => <article className="settings-group connector-record" key={record.config.connectionId} data-connection={record.config.connectionId}>
        <div className="settings-pane-toolbar"><strong className="connector-record__name">{record.config.label}</strong><button className="small-button" onClick={() => edit(record)}>Edit</button><button className="small-button" disabled={busy} onClick={() => { void test(record) }}>{checking === record.config.connectionId ? 'Checking…' : 'Check connection'}</button></div>
        <p className="settings-group-note">{record.config.application.domain} · {record.config.application.appId}</p>
        <dl className="connector-stage-list">{(['authentication', 'transport', 'intake', 'delivery'] as const).map(key => <div key={key}><dt>{stageLabels[key]}</dt><dd>{stage(record.observation[key])}{record.observation[key].reason && ` · ${record.observation[key].reason!.replaceAll('-', ' ')}`}</dd></div>)}</dl>
        {checks[record.config.connectionId]?.revision === record.revision && <p role="status" className="settings-group-note connector-check-feedback">{checks[record.config.connectionId]!.text}</p>}
      </article>)}
    </section>
    <section className="settings-group agent-settings-fields" data-connection-editor>
      <h3 className="connector-editor-title">{selected ? 'Connection settings' : 'New application'}</h3>
      <label className="settings-field"><span>Name</span><TextInput aria-label="Connection name" value={label} disabled={!!pending.current} onChange={event => setLabel(event.target.value)} /></label>
      {selected ? <dl className="connector-identity" aria-label="Saved application identity">
        <div><dt>Platform</dt><dd>{platform(selected.config.application.domain)}</dd></div>
        <div><dt>App ID</dt><dd><code>{selected.config.application.appId}</code></dd></div>
      </dl> : <>
        <label className="settings-field"><span>Platform</span><select aria-label="Connection platform" value={domain} disabled={!!pending.current} onChange={event => setDomain(event.target.value)}><option value="open.feishu.cn">Feishu</option><option value="open.larksuite.com">Lark</option></select></label>
        <label className="settings-field"><span>App ID</span><TextInput aria-label="Connection app ID" value={appId} disabled={!!pending.current} onChange={event => setAppId(event.target.value)} /></label>
      </>}
      <label className="settings-field"><span>{selected ? 'New app secret (optional)' : 'App secret'}</span><TextInput type="password" aria-label="Connection app secret" autoComplete="new-password" value={secret} disabled={!!pending.current} onChange={event => setSecret(event.target.value)} /></label>
      <label className="connector-enabled"><input type="checkbox" aria-label="Connection enabled" checked={enabled} disabled={!!pending.current} onChange={event => setEnabled(event.target.checked)} /><span>Enabled</span></label>
      <div className="connector-editor-actions">
        {selected && !pending.current && <button className={savePrimary ? 'small-button' : 'primary-button'} disabled={busy} onClick={() => { void test(selected) }}>{checking === selected.config.connectionId ? 'Checking…' : dirty ? 'Check saved connection' : 'Check connection'}</button>}
        <button data-connection-save className={savePrimary ? 'primary-button' : 'small-button'} disabled={busy || !label.trim() || !appId.trim() || !selected && !secret && !pending.current} onClick={() => { void save() }}>{busy && !checking ? 'Saving…' : pending.current ? 'Check pending save' : selected ? 'Save changes' : 'Save connection'}</button>
        {pending.current && <button className="small-button" disabled={busy} onClick={() => { void reviewSave() }}>Review original save</button>}
      </div>
      {saveNotice && !dirty && <p role="status" className="settings-group-note connector-save-feedback">{saveNotice}</p>}
    </section>
    {issue && <p role="status" className="settings-group-note">{issue}</p>}
  </div>
}
