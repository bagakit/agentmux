import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionConfigureInput, ConnectionRecord } from '@agentmux/core/connections'
import { api } from '../../lib/api'
import { BotEnrollmentPane, useBotEnrollment } from './BotEnrollmentPane'
import { ConnectionProfilePanel } from './ConnectionProfilePanel'
import { ConnectionSetupResult, connectionSummary } from './ConnectionSetupResult'

const LinkIcon = semanticIconComponent('action.open-external')
const GroupIcon = semanticIconComponent('object.conversations')
const platform = (domain: string) => domain === 'open.feishu.cn' ? 'Feishu' : domain === 'open.larksuite.com' ? 'Lark' : domain

export function ExternalConnectionsSettings({ active }: { active: boolean }) {
  const [records, setRecords] = useState<ConnectionRecord[]>([]), [issue, setIssue] = useState(''), [busy, setBusy] = useState(false)
  const [listIssue, setListIssue] = useState('')
  const [view, setView] = useState<'loading' | 'library' | 'enrollment' | 'new' | 'saved' | 'edit'>('loading')
  const [saveNotice, setSaveNotice] = useState('')
  const [selected, setSelected] = useState<ConnectionRecord | null>(null), [label, setLabel] = useState(''), [appId, setAppId] = useState(''), [domain, setDomain] = useState('open.feishu.cn'), [secret, setSecret] = useState(''), [enabled, setEnabled] = useState(true)
  const [saveAbsent, setSaveAbsent] = useState(false)
  const enrollment = useBotEnrollment(active)
  const pending = useRef<ConnectionConfigureInput | null>(null), generation = useRef(0), reading = useRef(0), writing = useRef(false)
  const read = async (epoch = generation.current) => {
    const request = ++reading.current
    try {
      const result = await api.connections.call('connection.ls', {})
      if (epoch === generation.current && request === reading.current) { setRecords(result.connections); setListIssue(''); setView(current => current === 'loading' ? result.connections.length ? 'library' : 'enrollment' : current) }
    } catch (error) { if (epoch === generation.current && request === reading.current) setListIssue(presentError(error)) }
  }
  useEffect(() => { const epoch = ++generation.current; if (active) void read(epoch); return () => { generation.current++ } }, [active])
  const enrolled = enrollment.operation?.configured
  useEffect(() => { if (active && enrolled) void read() }, [active, enrolled])
  const edit = (record: ConnectionRecord | null) => {
    if (pending.current) { setIssue('Check this save before changing the application.'); return }
    setSelected(record); setLabel(record?.config.label ?? ''); setAppId(record?.config.application.appId ?? ''); setDomain(record?.config.application.domain ?? 'open.feishu.cn'); setEnabled(record?.config.enabled ?? true); setSecret(''); setIssue(''); setSaveNotice(''); setView(record ? 'edit' : 'new')
  }
  const saved = (record: ConnectionRecord, notice: string) => {
    generation.current++
    setRecords(current => current.some(item => item.config.connectionId === record.config.connectionId)
      ? current.map(item => item.config.connectionId === record.config.connectionId && item.revision <= record.revision ? record : item)
      : [...current, record])
    pending.current = null; setSaveAbsent(false); setSelected(record); setLabel(record.config.label); setAppId(record.config.application.appId); setDomain(record.config.application.domain); setEnabled(record.config.enabled); setSecret(''); setSaveNotice(notice); setIssue(''); setView('saved')
  }
  const save = async () => {
    if (writing.current) return
    if (!pending.current && (!appId.trim() || !selected && !secret)) { setIssue('Paste the App ID and App Secret from your application’s Credentials & Basic Info page.'); return }
    writing.current = true; setBusy(true); setIssue(''); setSaveNotice(''); setSaveAbsent(false)
    const epoch = generation.current
    try {
      if (!pending.current) {
        const operationId = crypto.randomUUID(), connectionId = selected?.config.connectionId ?? crypto.randomUUID()
        pending.current = { operationId, expectedRevision: selected?.revision ?? null, connection: { connectionId, adapterId: selected?.config.adapterId ?? 'feishu', application: { domain, appId: appId.trim() }, label: label.trim() || `${platform(domain)} bot`, enabled, credentialRef: selected?.config.credentialRef ?? '' } }
      }
      const input = pending.current
      // Inspect the original intent before any explicit continuation. Never replace an unconfirmed save.
      const existing = await api.connections.call('connection.inspect', { operationId: input.operationId })
      let record: ConnectionRecord
      if (existing.operation) record = existing.connection ?? existing.operation.connection
      else {
        if (secret) {
          const credentialOperation = input.operationId + ':credential'
          const credential = await api.connections.inspectCredential(credentialOperation) ?? await api.connections.storeCredential({ operationId: credentialOperation, secret })
          input.connection.credentialRef = credential.credentialRef
          setSecret('')
        }
        if (!input.connection.credentialRef) throw new Error('The application credential is not confirmed. Check this save before continuing.')
        record = (await api.connections.call('connection.configure', input)).connection
      }
      if (epoch === generation.current) { saved(record, 'Application saved.'); await read() }
    } catch (error) { if (epoch === generation.current) setIssue(`Save result not confirmed. Check this same save before continuing. ${presentError(error)}`) }
    finally { writing.current = false; setBusy(false) }
  }
  const reviewSave = async () => {
    if (!pending.current || writing.current) return
    writing.current = true; setBusy(true); setIssue('')
    const epoch = generation.current
    try {
      const result = await api.connections.call('connection.inspect', { operationId: pending.current.operationId })
      if (epoch === generation.current) {
        if (result.operation) { saved(result.connection ?? result.operation.connection, 'The original application save is confirmed.'); await read() }
        else { setSaveAbsent(true); setIssue('This save is not recorded yet. Continue the same save when you are ready.'); }
      }
    } catch (error) { if (epoch === generation.current) setIssue(`The original save is still not confirmed. ${presentError(error)}`) }
    finally { writing.current = false; setBusy(false) }
  }
  const openConsole = async () => {
    try { await api.ui.openExternal(`https://${domain}/app`) }
    catch (error) { setIssue(presentError(error)) }
  }
  const existing = () => { if (selected && !pending.current) edit(null); else setView('new') }
  const current = selected && (records.find(record => record.config.connectionId === selected.config.connectionId) ?? selected)
  const editing = view === 'new' || view === 'edit', dirty = !selected || label !== selected.config.label || enabled !== selected.config.enabled || !!secret
  if (!active) return null
  return <div className="settings-pane-stack connector-onboarding" data-connector-settings>
    {view === 'loading' ? <p className="settings-group-note" role="status">{listIssue ? 'Your bot list could not be loaded.' : 'Reading saved applications…'} <button type="button" className="small-button" onClick={() => void read()}>Refresh</button></p> : null}
    {view === 'enrollment' ? <BotEnrollmentPane enrollment={enrollment} onExisting={existing} onSaved={record => saved(record, 'Application saved.')} /> : null}
    {view === 'library' ? <section className="connector-library" aria-label="Saved chat applications">
      <div className="settings-pane-toolbar"><strong>Bot applications</strong><button className="small-button" onClick={() => void read()}>Refresh</button><button data-enrollment-new className="primary-button" onClick={() => setView('enrollment')}>Add a bot</button><button data-enrollment-existing className="small-button" onClick={existing}>Connect an existing bot</button></div>
      <p className="settings-group-note">Choose an application to check or change its connection. Groups are connected from each Agent’s menu.</p>
      {records.map(record => <article className="connector-record" key={record.config.connectionId} data-connection={record.config.connectionId}>
        <button className="connector-record__open" onClick={() => { edit(record); setView('saved') }}><span className="connector-record__mark"><GroupIcon size={18} /></span><span><strong className="connector-record__name">{record.config.label}</strong><small>{platform(record.config.application.domain)} · {connectionSummary(record)}</small></span><span className="connector-record__action">View connection</span></button>
      </article>)}
    </section> : null}
    {editing || view === 'saved' && current ? <section className="connector-setup" data-connection-editor>
      {!pending.current ? <button type="button" className="connector-back small-button" onClick={() => { setView(records.length ? 'library' : 'enrollment'); setIssue('') }}>{records.length ? 'All applications' : 'Bot setup'}</button> : null}
      {editing ? <>
        <header className="connector-setup__heading"><span className="connector-setup__mark"><GroupIcon size={22} /></span><div><h3 className="connector-editor-title">{selected ? 'Edit application' : 'Connect an existing bot'}</h3><p>{selected ? 'Changes apply to this saved application.' : 'Use a Feishu or Lark bot for your Agents’ group conversations.'}</p></div></header>
        {!selected ? <ol className="connector-steps" aria-label="Application setup"><li aria-current="step"><span>1</span>App credentials</li><li><span>2</span>Check connection</li><li><span>3</span>Connect a group</li></ol> : null}
        {!selected ? <div className="connector-credentials-source"><div><strong>Get these from your bot application</strong><p>Open the developer console → Credentials & Basic Info.<br />Copy the App ID and App Secret into the fields below.</p><details className="connector-first-bot"><summary>Don’t have a bot yet?</summary><p>Create a custom app in the console and add the Bot capability. Then return here with its credentials.</p></details></div><button type="button" className="small-button" onClick={() => void openConsole()}>Open {platform(domain)} console <LinkIcon size={12} /></button></div> : null}
        <div className="connector-setup__fields">
          {selected ? <dl className="connector-identity" aria-label="Saved application identity"><div><dt>Platform</dt><dd>{platform(domain)}</dd></div><div><dt>App ID</dt><dd><code>{appId}</code></dd></div></dl> : <label className="settings-field connector-platform"><span>Platform</span><select aria-label="Connection platform" value={domain} disabled={!!pending.current} onChange={event => setDomain(event.target.value)}><option value="open.feishu.cn">Feishu · 飞书</option><option value="open.larksuite.com">Lark</option></select></label>}
          {!selected ? <label className="settings-field"><span>App ID</span><TextInput aria-label="Connection app ID" placeholder="cli_…" spellCheck={false} autoCapitalize="none" autoComplete="off" value={appId} disabled={!!pending.current} onChange={event => setAppId(event.target.value)} /></label> : null}
          <label className="settings-field"><span>{selected ? 'Replace App Secret' : 'App Secret'}</span><TextInput type="password" aria-label="Connection app secret" autoComplete="new-password" placeholder={selected ? 'Leave blank to keep the saved secret' : 'Paste your application’s secret'} value={secret} disabled={!!pending.current} onChange={event => setSecret(event.target.value)} /><small className="settings-group-note">Stored securely on this environment.</small></label>
          {selected ? <label className="settings-field"><span>Application name</span><TextInput aria-label="Connection name" value={label} disabled={!!pending.current} onChange={event => setLabel(event.target.value)} /></label> : null}
          <details className="connector-optional"><summary>Connection options</summary>{!selected ? <label className="settings-field"><span>Name in AgentMux <small>Optional</small></span><TextInput aria-label="Connection name" placeholder={`${platform(domain)} bot`} value={label} disabled={!!pending.current} onChange={event => setLabel(event.target.value)} /></label> : null}<label className="connector-enabled"><input type="checkbox" aria-label="Connection enabled" checked={enabled} disabled={!!pending.current} onChange={event => setEnabled(event.target.checked)} /><span>Enable this application</span></label><p className="settings-group-note">Enabling starts the application connection. Choose which Agent and group to share separately.</p></details>
        </div>
        <div className="connector-editor-actions">
          {pending.current ? <><button data-connection-save className="primary-button" disabled={busy} onClick={() => void (saveAbsent ? save() : reviewSave())}>{busy ? 'Checking save…' : saveAbsent ? 'Continue this save' : 'Check this save'}</button>{saveAbsent ? <button className="small-button" disabled={busy} onClick={() => void reviewSave()}>Check again</button> : null}</> : <><button data-connection-save className="primary-button" disabled={busy || !!selected && !dirty} onClick={() => void save()}>{busy ? 'Saving…' : selected ? 'Save changes' : 'Save application'}</button>{selected ? <button className="small-button" disabled={busy} onClick={() => setView('saved')}>Cancel editing</button> : null}</>}
        </div>
      </> : current ? <>
        <header className="connector-setup__heading"><span className="connector-setup__mark"><GroupIcon size={22} /></span><div><h3 className="connector-editor-title">{current.config.label}</h3><p>{platform(current.config.application.domain)} bot application</p></div></header>
        {saveNotice ? <p className="settings-group-note" role="status">{saveNotice}</p> : null}
        <ConnectionSetupResult record={current} active={active} />
        <div className="connector-editor-actions"><button className="small-button" disabled={busy} onClick={() => edit(current)}>Edit application</button></div>
        <details className="connector-setup-help"><summary>Finish setup in {platform(current.config.application.domain)}</summary><ol><li>Enable the bot capability in your application.</li><li>In Events & Callbacks, choose persistent connection and add <code>im.message.receive_v1</code>.</li><li>Enable the messaging and group permissions required by the features you use, then publish the application.</li></ol><p className="settings-group-note">Keep this application enabled here while finishing event setup.</p><button className="small-button" onClick={() => void openConsole()}>Open {platform(current.config.application.domain)} console <LinkIcon size={12} /></button></details>
        <div className="connector-next-step"><GroupIcon size={18} /><div><strong>Next, choose an Agent and a group</strong><p>Open an Agent’s menu → Create group or Connect existing group. You choose the audience and what to share there.</p></div></div>
        <ConnectionProfilePanel key={JSON.stringify([current.config.connectionId, current.config.application, current.revision])} record={current} />
      </> : null}
    </section> : null}
    {listIssue ? <div className="connector-list-feedback" data-connection-list-issue><p role="status" className="connector-check-feedback">Could not refresh your saved bots. This does not change any bot’s creation or connection result.</p>{view !== 'loading' ? <button type="button" className="small-button" onClick={() => void read()}>Refresh bot list</button> : null}<details className="connector-diagnostics"><summary>List error details</summary><p className="connector-enrollment__technical">{listIssue}</p></details></div> : null}
    {issue ? <p role="status" className="connector-issue">{issue}</p> : null}
  </div>
}
