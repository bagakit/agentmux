import { useContext, useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MOTE_CHAT_DEFAULT_VALUES, type MoteChatConfiguration, type MoteChatOperation, type MoteChatValues } from '@agentmux/core/mote-chat'
import type { ConnectionRecord, ConnectionServiceState } from '@agentmux/core/connections'
import { sameMotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { moteDefaultExecutor } from '../lib/mote-quick-preferences'
import { connectionInitialSetupLabel, connectionNeedsInitialSetup, moteConnectionTarget } from '../lib/mote-connection-default'
import { submitMoteChatIntent } from '../lib/mote-chat-request'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { SelectionField } from './SelectionField'
import { SettingsNavigation } from './SettingsNavigation'
import { MoteChatPeople } from './MoteChatPeople'
import { MoteChatRequests } from './MoteChatRequests'
import { MoteQuickModeDialog } from './MoteQuickMode'
import '../styles/mote-private-chat.css'

const ChatIcon = semanticIconComponent('object.conversation'), LoadingIcon = semanticIconComponent('status.loading')
const choice = (record: ConnectionRecord) => JSON.stringify([record.config.connectionId, record.config.application.domain, record.config.application.appId])
const refChoice = (ref: MoteChatValues['connection']) => ref ? JSON.stringify([ref.connectionId, ref.application.domain, ref.application.appId]) : ''

/** Profile configures a durable Mote route; opening or saving never creates an Agent. */
export function MotePrivateChat({ scope, active, reference, onOpenPath }: { scope: MoteWorkfaceScope; active: boolean; reference?: WorkbenchProjectionSelection | null | undefined; onOpenPath(path: string): Promise<unknown> }) {
  const bindings = useAppStore(state => state.spaceZoneBindings), target = moteConnectionTarget(scope, bindings)
  return <MotePrivateChatPanel key={JSON.stringify(target)} scope={scope} target={target} active={active} reference={reference} onOpenPath={onOpenPath} />
}

function MotePrivateChatPanel({ scope, target, active, reference, onOpenPath }: { scope: MoteWorkfaceScope; target: ReturnType<typeof moteConnectionTarget>; active: boolean; reference?: WorkbenchProjectionSelection | null | undefined; onOpenPath(path: string): Promise<unknown> }) {
  const settings = useContext(SettingsNavigation)
  const retainedDraft = useRef(target ? Object.values(useAppStore.getState().moteChatIntents).find(intent => intent.method === 'space.mote.chat.configure' && sameMotePreferencesTarget(intent.input.target, target)) : undefined).current
  const openingValues = retainedDraft?.method === 'space.mote.chat.configure' ? retainedDraft.input.values : MOTE_CHAT_DEFAULT_VALUES
  const [configuration, setConfiguration] = useState<MoteChatConfiguration | null>(null), [ready, setReady] = useState(false)
  const [records, setRecords] = useState<ConnectionRecord[]>([]), [service, setService] = useState<ConnectionServiceState | null>(null)
  const [draft, setDraft] = useState<MoteChatValues>(() => structuredClone(openingValues))
  const [minutes, setMinutes] = useState(String(openingValues.conversationIdleMs / 60000)), [strangers, setStrangers] = useState(String(openingValues.strangerMessageLimit))
  const [reading, setReading] = useState(false), [saving, setSaving] = useState(false), [issue, setIssue] = useState(''), [notice, setNotice] = useState(''), [peopleOpen, setPeopleOpen] = useState(false)
  const [executorOpen, setExecutorOpen] = useState(false), executorInvoker = useRef<HTMLButtonElement | null>(null)
  const [audienceRevision, setAudienceRevision] = useState(0)
  const executorId = useAppStore(state => moteDefaultExecutor(state, scope.workspace.id, scope.topic.id))
  const edited = useRef(retainedDraft ? 1 : 0), lifetime = useRef(0), writing = useRef(false)
  const intents = useAppStore(state => state.moteChatIntents)
  const pending = target ? Object.values(intents).some(intent => intent.method === 'space.mote.chat.configure' && sameMotePreferencesTarget(intent.input.target, target)) : false
  const selected = records.find(record => choice(record) === refChoice(draft.connection))
  const baseline = configuration?.values ?? MOTE_CHAT_DEFAULT_VALUES
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || minutes !== String(baseline.conversationIdleMs / 60000) || strangers !== String(baseline.strangerMessageLimit)
  function useValues(values: MoteChatValues) { setDraft(structuredClone(values)); setMinutes(String(values.conversationIdleMs / 60000)); setStrangers(String(values.strangerMessageLimit)) }
  async function read() {
    const epoch = ++lifetime.current
    if (!target) { setIssue('The original Mote home is not confirmed. Its current conversations are kept.'); return }
    setReading(true)
    const [chat, connections, policy] = await Promise.allSettled([api.moteChat.call('space.mote.chat.inspect', { target }), api.connections.call('connection.ls', {}), api.connections.call('connection.service.get', {})])
    if (lifetime.current !== epoch) return
    if (chat.status === 'fulfilled') { setConfiguration(current => current && (!chat.value.configuration || current.revision > chat.value.configuration.revision) ? current : chat.value.configuration); setReady(true); if (!edited.current) useValues(chat.value.configuration?.values ?? MOTE_CHAT_DEFAULT_VALUES) }
    if (connections.status === 'fulfilled') setRecords(connections.value.connections)
    if (policy.status === 'fulfilled') setService(policy.value)
    setIssue([chat, connections, policy].flatMap(result => result.status === 'rejected' ? [presentError(result.reason)] : []).join(' ')); setReading(false)
  }
  useEffect(() => { if (active) void read(); return () => { lifetime.current++ } }, [active])
  const confirmed = (operation: MoteChatOperation) => {
    setConfiguration(current => current && current.revision > operation.configuration.revision ? current : operation.configuration)
    if (operation.action === 'allocate') setAudienceRevision(value => value + 1)
    setNotice(operation.action === 'configure' ? 'Original chat settings save confirmed.' : 'Original allowance save confirmed.')
  }
  async function save() {
    if (writing.current || !target) return
    const idle = Number(minutes) * 60000, limit = Number(strangers)
    if (!ready) { setIssue('Read this Mote’s current chat settings before saving. Your draft is kept.'); return }
    if (!minutes.trim() || !Number.isSafeInteger(idle) || idle <= 0 || !strangers.trim() || !Number.isSafeInteger(limit) || limit < 0) { setIssue('Enter a positive conversation interval and a whole message allowance of zero or more.'); return }
    if (draft.enabled && (!selected || !selected.config.enabled || connectionNeedsInitialSetup(selected))) { setIssue('Choose an enabled bot and finish any incomplete original setup before enabling private chat.'); return }
    if (draft.connection && !selected) { setIssue('The selected saved identity is unavailable. Choose another bot or clear the selection before saving.'); return }
    const revision = edited.current, epoch = ++lifetime.current
    setReading(false)
    writing.current = true; setSaving(true); setIssue(''); setNotice('')
    try {
      const operation = await submitMoteChatIntent({ method: 'space.mote.chat.configure', phase: 'not-dispatched', input: {
        operationId: crypto.randomUUID(), target, expectedRevision: configuration?.revision ?? null, expectedConnectionRevision: selected?.revision ?? null,
        values: { ...draft, conversationIdleMs: idle, strangerMessageLimit: limit } } })
      if (lifetime.current !== epoch) return
      confirmed(operation)
      if (edited.current === revision) { useValues(operation.configuration.values); edited.current = 0 }
      else setNotice('Original settings saved. Your newer draft is kept.')
    } catch (error) { if (lifetime.current === epoch) setIssue('Chat settings were not confirmed. Your draft and original request are kept. ' + presentError(error)) }
    finally { writing.current = false; setSaving(false) }
  }
  const openSettings = () => settings?.openMoteLark({ target, topicId: scope.topic.id, moteName: scope.topic.title })
  const update = (values: MoteChatValues) => { edited.current++; setDraft(values); setNotice('') }
  return <section className="mote-private-chat" aria-label="Feishu private chat" data-mote-private-chat={scope.topic.id}>
    <header><div><h3><ChatIcon size={15} />Feishu chat</h3><p>Talk to this Mote directly in Feishu.</p></div><span role="status" data-mote-chat-saved={ready ? configuration?.values.enabled ? 'on' : 'off' : 'unknown'}>{ready ? configuration?.values.enabled ? 'On' : 'Off' : 'Not confirmed'}</span></header>
    <label className="mote-private-chat__toggle"><span>Allow private messages<small>Save to apply. A conversation starts with an incoming message.</small></span><input type="checkbox" role="switch" aria-label="Enable Feishu private chat" checked={draft.enabled} disabled={saving} onChange={event => update({ ...draft, enabled: event.target.checked })} /></label>
    <div className="mote-private-chat__executor"><span>Executor for new chat<strong>{executorId ?? 'Choose an Executor'}</strong></span><button ref={executorInvoker} type="button" className="small-button" onClick={() => setExecutorOpen(true)}>{executorId ? 'Change' : 'Choose Executor'}</button></div>
    {!executorId ? <p className="mote-details__hint">Choose an Executor before enabling Feishu chat. This uses the same new-chat preference as the rest of this Mote.</p> : null}
    <div className="mote-private-chat__fields">
      <label><span>Bot identity</span><SelectionField label="Private chat bot" value={refChoice(draft.connection)} disabled={saving} searchable options={[
        { value: '', label: 'Choose a bot' }, ...records.map(record => ({ value: choice(record), label: record.config.label,
          disabled: !record.config.enabled || connectionNeedsInitialSetup(record), description: `${record.config.application.appId} · ${connectionInitialSetupLabel(record)}${record.config.enabled ? '' : ' · Application paused'}` }))
      ]} onValueChange={value => { const record = records.find(record => choice(record) === value); update({ ...draft, connection: record ? { connectionId: record.config.connectionId, application: structuredClone(record.config.application) } : null }) }} /></label>
      {draft.connection ? <code className="mote-private-chat__app">{draft.connection.application.appId}</code> : null}
      <label><span>Conversation update interval<small>Reuse this person’s conversation while it stays active. After this much inactivity, the next message starts a new Agent.</small></span><span className="mote-private-chat__number"><TextInput type="number" min="0" step="any" aria-label="Conversation update interval in minutes" value={minutes} disabled={saving} onChange={event => { edited.current++; setMinutes(event.target.value); setNotice('') }} /><span>minutes</span></span></label>
      <label><span>New guest allowance<small>Total messages for each new person. Zero allows only the confirmed bot creator until you grant an allowance.</small></span><TextInput type="number" min="0" step="1" aria-label="New guest message allowance" value={strangers} disabled={saving} onChange={event => { edited.current++; setStrangers(event.target.value); setNotice('') }} /></label>
    </div>
    <p className="mote-details__hint">A new Agent receives references to the three most recent conversations and can look up older conversations.</p>
    {service?.enabled === false ? <p role="status" className="mote-private-chat__service">Automatic chat sync is off. This Mote’s setting is kept; resume sync in Lark settings to receive and reply.</p> : !service && ready ? <p role="status" className="mote-details__hint">The automatic sync policy is not confirmed. This saved choice does not prove messages are flowing.</p> : null}
    {reading ? <p role="status" className="mote-private-chat__activity"><LoadingIcon size={13} animation="spin" />{ready ? 'Refreshing chat settings…' : 'Reading chat settings…'}</p> : null}
    {issue ? <p role="status" className="mote-details__issue">{issue}</p> : notice ? <p role="status" className="mote-private-chat__notice">{notice}</p> : null}
    <div className="mote-chat-actions">{dirty ? <button type="button" className="primary-button" disabled={saving || pending} onClick={() => void save()}>{saving ? 'Saving…' : 'Save chat settings'}</button> : null}<button type="button" className="small-button" disabled={reading || saving} onClick={() => void read()}>Refresh</button>{settings ? <button type="button" className="small-button" onClick={openSettings}>Manage bot identities</button> : null}</div>
    {configuration ? <details className="mote-private-chat__people" onToggle={event => setPeopleOpen(event.currentTarget.open)}><summary>People &amp; message allowances</summary>{peopleOpen ? <MoteChatPeople configuration={configuration} active={active} refreshRevision={audienceRevision} onSaved={() => setNotice('Message allowance saved. Messages already used are kept.')} /> : null}</details> : null}
    {target ? <MoteChatRequests target={target} onConfirmed={confirmed} /> : null}
    {executorOpen ? <MoteQuickModeDialog scope={scope} reference={reference} onOpenPath={onOpenPath} onClose={() => setExecutorOpen(false)} returnFocus={() => executorInvoker.current?.isConnected ? executorInvoker.current : null} /> : null}
  </section>
}
