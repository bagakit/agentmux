import { Notice } from '@agentmux/client-ui/components/Notice'
import { mintObjectId } from '@agentmux/core/object-id'
import { useContext, useEffect, useRef, useState } from 'react'
import { Switch, TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MOTE_CHAT_DEFAULT_VALUES, type MoteChatConfiguration, type MoteChatValues } from '@agentmux/core/mote-chat'
import type { MoteChatIntentOperation } from '../lib/mote-chat-intent'
import type { MoteChatIntent } from '../lib/mote-chat-intent'
import type { ConnectionRecord, ConnectionServiceState } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
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
import { checkpointLauncherState, useLauncherState } from '../lib/launcher-state'
import { moteChatDraftKey, restoredMoteChatDraft, type MoteChatDraft } from '../lib/mote-chat-draft'
import { MoteChatActivity } from './MoteChatActivity'
import { MoteChatRequests } from './MoteChatRequests'
import { MoteQuickModeDialog } from './MoteQuickMode'

const ChatIcon = semanticIconComponent('object.conversation'), LoadingIcon = semanticIconComponent('status.loading')
const choice = (record: ConnectionRecord) => JSON.stringify([record.config.connectionId, record.config.application.domain, record.config.application.appId, record.config.application.issuer ?? null])
const refChoice = (ref: MoteChatValues['connection']) => ref ? JSON.stringify([ref.connectionId, ref.application.domain, ref.application.appId, ref.application.issuer ?? null]) : ''
const hostingKey = (owner: ConnectionHostingTarget | null | undefined) => owner ? JSON.stringify([owner.hostId, owner.runtimeId]) : null
type PolicyDraft = Extract<MoteChatDraft, { kind: 'policy' }>

/** Profile configures a durable Mote route; opening or saving never creates an Agent. */
export function MotePrivateChat({ scope, active, reference, onOpenPath }: { scope: MoteWorkfaceScope; active: boolean; reference?: WorkbenchProjectionSelection | null | undefined; onOpenPath(path: string): Promise<unknown> }) {
  const bindings = useAppStore(state => state.spaceZoneBindings), target = moteConnectionTarget(scope, bindings)
  return <MotePrivateChatPanel key={JSON.stringify(target)} scope={scope} target={target} active={active} reference={reference} onOpenPath={onOpenPath} />
}

function MotePrivateChatPanel({ scope, target: initialTarget, active, reference, onOpenPath }: { scope: MoteWorkfaceScope; target: ReturnType<typeof moteConnectionTarget>; active: boolean; reference?: WorkbenchProjectionSelection | null | undefined; onOpenPath(path: string): Promise<unknown> }) {
  const target = useRef(initialTarget).current
  const settings = useContext(SettingsNavigation)
  const retainedRequests = useRef(target ? Object.values(useAppStore.getState().moteChatIntents).filter(intent => sameMotePreferencesTarget(intent.input.target, target)) : []).current
  const retainedConfiguration = retainedRequests.filter(intent => intent.method === 'space.mote.chat.configure')
  const retainedDrafts = retainedConfiguration.filter(intent => intent.method === 'space.mote.chat.configure' && !intent.input.refreshCreator)
  const retainedDraft = retainedDrafts.length === 1 ? retainedDrafts[0] : undefined
  const retainedFormDrafts = useRef(target ? Object.entries(useLauncherState.getState().drafts).flatMap(([key, entry]) => { const draft = restoredMoteChatDraft(entry.moteChat, key); return draft && sameMotePreferencesTarget(draft.target, target) ? [draft] : [] }) : []).current
  const retainedPolicyDrafts = retainedFormDrafts.filter(draft => draft.kind === 'policy')
  const openingDraft = retainedPolicyDrafts.length === 1 ? retainedPolicyDrafts[0] : undefined
  const openingValues = openingDraft?.values ?? (retainedDraft?.method === 'space.mote.chat.configure' ? retainedDraft.input.values : MOTE_CHAT_DEFAULT_VALUES)
  const [configuration, setConfiguration] = useState<MoteChatConfiguration | null>(null), [ready, setReady] = useState(false)
  const [records, setRecords] = useState<ConnectionRecord[]>([]), [service, setService] = useState<ConnectionServiceState | null>(null)
  const [draft, setDraft] = useState<MoteChatValues>(() => structuredClone(openingValues))
  const [minutes, setMinutes] = useState(openingDraft?.minutes ?? String(openingValues.conversationIdleMs / 60000)), [strangers, setStrangers] = useState(openingDraft?.strangers ?? String(openingValues.strangerMessageLimit))
  const [reading, setReading] = useState(false), [saving, setSaving] = useState(false), [issue, setIssue] = useState(''), [notice, setNotice] = useState(''), [peopleOpen, setPeopleOpen] = useState(false)
  const [identityBusy, setIdentityBusy] = useState(false)
  const [identityFeedback, setIdentityFeedback] = useState<{ kind: 'issue' | 'confirmed'; message: string } | null>(null)
  const [executorOpen, setExecutorOpen] = useState(false), executorInvoker = useRef<HTMLButtonElement | null>(null)
  const [audienceRevision, setAudienceRevision] = useState(0)
  const [hostingTarget, setHostingTarget] = useState<ConnectionHostingTarget | null>(null)
  const [readingSource, setReadingSource] = useState<string | null>(null)
  const hosts = useAppStore(state => state.config?.hosts)
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const currentDraftKey = target ? moteChatDraftKey({ kind: 'policy', target, hostingTarget }) : null
  const currentDraft = useLauncherState(state => currentDraftKey ? state.drafts[currentDraftKey]?.moteChat : undefined)
  const policyFeedback = restoredMoteChatDraft(currentDraft, currentDraftKey ?? undefined)
  const currentHosting = useRef(hostingTarget); currentHosting.current = hostingTarget
  const executorId = useAppStore(state => moteDefaultExecutor(state, scope.workspace.id, scope.topic.id))
  const executorLabel = useAppStore(state => executorId ? state.config?.executors[executorId]?.label ?? executorId : 'Choose an Executor')
  const edited = useRef(openingDraft || retainedDraft ? 1 : 0), lifetime = useRef(0), writing = useRef<string | null>(null), identityWriting = useRef<string | null>(null), mounted = useRef(true)
  const intents = useAppStore(state => state.moteChatIntents)
  const currentIntents = target ? Object.values(intents).filter(intent => intent.method === 'space.mote.chat.configure' && sameMotePreferencesTarget(intent.input.target, target) && hostingKey(intent.hostingTarget) === hostingKey(hostingTarget)) : []
  const pending = currentIntents.some(intent => intent.method === 'space.mote.chat.configure' && !intent.input.refreshCreator)
  const identityPending = currentIntents.some(intent => intent.method === 'space.mote.chat.configure' && intent.input.refreshCreator)
  const selected = records.find(record => choice(record) === refChoice(draft.connection))
  const savedConnection = records.find(record => choice(record) === refChoice(configuration?.values.connection ?? null))
  const baseline = configuration?.values ?? MOTE_CHAT_DEFAULT_VALUES
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || minutes !== String(baseline.conversationIdleMs / 60000) || strangers !== String(baseline.strangerMessageLimit)
  function useValues(values: MoteChatValues) { setDraft(structuredClone(values)); setMinutes(String(values.conversationIdleMs / 60000)); setStrangers(String(values.strangerMessageLimit)) }
  function policyDraft(owner: ConnectionHostingTarget | null): PolicyDraft | undefined {
    if (!target) return
    const key = moteChatDraftKey({ kind: 'policy', target, hostingTarget: owner }), saved = restoredMoteChatDraft(useLauncherState.getState().drafts[key]?.moteChat, key)
    return saved?.kind === 'policy' ? saved : undefined
  }
  function retainPolicy(owner: ConnectionHostingTarget | null, values: MoteChatValues, nextMinutes: string, nextStrangers: string, message = '', version = mintObjectId()) {
    if (!target) return
    const saved: PolicyDraft = { kind: 'policy', target, hostingTarget: owner, values: structuredClone(values), minutes: nextMinutes, strangers: nextStrangers, issue: message, version }
    useLauncherState.getState().setMoteChatDraft(moteChatDraftKey(saved), saved)
    return saved
  }
  const draftOwner = () => currentHosting.current ?? openingDraft?.hostingTarget ?? retainedDraft?.hostingTarget ?? null
  function usePolicyDraft(saved: PolicyDraft) { setDraft(structuredClone(saved.values)); setMinutes(saved.minutes); setStrangers(saved.strangers) }
  async function read(source?: string, originalDraft?: PolicyDraft) {
    if (!target) { setIssue('The original Mote home is not confirmed. Its current conversations are kept.'); return }
    const epoch = ++lifetime.current
    setReading(true); setReadingSource(source ?? null); setIssue(''); setNotice('')
    const originals = [...retainedRequests, ...retainedFormDrafts], editRevision = edited.current, originalOwners = new Map(originals.filter(intent => intent.hostingTarget).map(intent => [hostingKey(intent.hostingTarget), intent.hostingTarget!]))
    const retainedOwner = originals.every(intent => intent.hostingTarget) && originalOwners.size === 1 ? originalOwners.values().next().value : undefined
    const originalOwner = originalDraft?.hostingTarget ?? hostingTarget ?? openingDraft?.hostingTarget ?? retainedDraft?.hostingTarget ?? retainedOwner
    let owner: ConnectionHostingTarget
    try {
      if (!originalDraft && source === undefined && (openingDraft && !openingDraft.hostingTarget || retainedDraft && !retainedDraft.hostingTarget) && !hostingTarget) { setIssue('The original bot hosting Host is not recorded. Your draft and original request are kept. Choose a source to read its own settings separately.'); setReading(false); return }
      if (source === undefined && !originalOwner && originals.length) { setIssue('The original bot hosting Host is not recorded or is ambiguous. Original requests are kept. Choose a source to read its own settings separately.'); setReading(false); return }
      owner = source === undefined ? originalOwner ?? await api.connections.hostingTarget() : await api.connections.hostingTarget(source)
    }
    catch (error) { if (lifetime.current === epoch) { setIssue(presentError(error)); setReading(false); setReadingSource(null) }; return }
    if (lifetime.current !== epoch) return
    const ownerChanged = hostingKey(hostingTarget) !== hostingKey(owner)
    const [chat, connections, policy] = await Promise.allSettled([api.moteChat.call('space.mote.chat.inspect', { target }, owner), api.connections.call('connection.ls', {}, owner), api.connections.call('connection.service.get', {}, owner)])
    if (lifetime.current !== epoch) return
    if (ownerChanged && (hostingTarget || originals.length) && edited.current !== editRevision) { setNotice('Your newer draft stays with its original hosting Host. Choose the other source again after finishing this edit.'); setReading(false); setReadingSource(null); return }
    if (chat.status === 'fulfilled') {
      let savedDraft = policyDraft(owner)
      const unbound = policyDraft(null)
      if (!hostingTarget && !retainedPolicyDrafts.length && !retainedConfiguration.length && unbound) {
        savedDraft = retainPolicy(owner, unbound.values, unbound.minutes, unbound.strangers, unbound.issue)
        useLauncherState.getState().setMoteChatDraft(moteChatDraftKey(unbound), undefined, unbound.version)
      }
      currentHosting.current = owner; setHostingTarget(owner)
      setConfiguration(current => !ownerChanged && current && (!chat.value.configuration || current.revision > chat.value.configuration.revision) ? current : chat.value.configuration)
      setReady(true)
      if (ownerChanged) {
        const requestDrafts = Object.values(useAppStore.getState().moteChatIntents).filter(intent => intent.method === 'space.mote.chat.configure' && !intent.input.refreshCreator && sameMotePreferencesTarget(intent.input.target, target) && hostingKey(intent.hostingTarget) === hostingKey(owner))
        const original = requestDrafts.length === 1 ? requestDrafts[0] : undefined
        if (savedDraft) { usePolicyDraft(savedDraft); edited.current = 1 }
        else if (hostingTarget || originals.length || !edited.current || original) { useValues(original?.method === 'space.mote.chat.configure' ? original.input.values : chat.value.configuration?.values ?? MOTE_CHAT_DEFAULT_VALUES); edited.current = original ? 1 : 0 }
        writing.current = null; identityWriting.current = null; setSaving(false); setIdentityBusy(false); setIdentityFeedback(null); setNotice('')
      } else if (edited.current === editRevision && !dirty && !pending) { useValues(chat.value.configuration?.values ?? MOTE_CHAT_DEFAULT_VALUES); edited.current = 0 }
      if (connections.status === 'fulfilled') setRecords(connections.value.connections); else if (ownerChanged) setRecords([])
      if (policy.status === 'fulfilled') setService(policy.value); else if (ownerChanged) setService(null)
    }
    setIssue([...([chat, connections, policy].flatMap(result => result.status === 'rejected' ? [presentError(result.reason)] : [])), ...(chat.status === 'fulfilled' ? [policyDraft(owner)?.issue ?? ''] : [])].filter(Boolean).join(' ')); setReading(false); setReadingSource(null)
  }
  function reviewDraft(saved: PolicyDraft) {
    lifetime.current++; currentHosting.current = saved.hostingTarget; setHostingTarget(saved.hostingTarget); setConfiguration(null); setReady(false); setRecords([]); setService(null)
    writing.current = null; identityWriting.current = null; setSaving(false); setIdentityBusy(false); setIdentityFeedback(null); usePolicyDraft(saved); edited.current = 1
    if (saved.hostingTarget) void read(undefined, saved)
    else { setReading(false); setReadingSource(null); setIssue('The original bot hosting Host is not recorded. Your saved draft is kept; choose a source to read its own settings separately.') }
  }
  const inspected = useRef(false)
  useEffect(() => { if (active && !inspected.current) { inspected.current = true; void read() } }, [active])
  // A local page switch retains the original read/save lifecycle. The explicit
  // Refresh action reads newer settings; only removing this owner retires it.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lifetime.current++; inspected.current = false } }, [])
  const confirmed = (operation: MoteChatIntentOperation, owner: ConnectionHostingTarget | null | undefined, intent?: MoteChatIntent) => {
    if (owner && intent && !(intent.method === 'space.mote.chat.configure' && intent.input.refreshCreator)) {
      const original = intent.method === 'space.mote.chat.configure' ? { kind: 'policy' as const, target: intent.input.target, hostingTarget: owner }
        : { kind: 'allowance' as const, target: intent.input.target, hostingTarget: owner, connection: operation.configuration.values.connection, actor: intent.input.actor }
      useLauncherState.getState().setMoteChatDraft(moteChatDraftKey(original), undefined, intent.input.operationId)
    }
    if (!owner || hostingKey(owner) !== hostingKey(currentHosting.current)) { setNotice('The original request was confirmed on its own hosting Host. Current settings are kept.'); return }
    setConfiguration(current => current && current.revision > operation.configuration.revision ? current : operation.configuration)
    if (operation.action === 'allocate') setAudienceRevision(value => value + 1)
    if (intent?.method === 'space.mote.chat.configure' && intent.input.refreshCreator) setIdentityFeedback({ kind: 'confirmed', message: 'Original Main identity confirmation recorded for ' + operation.configuration.values.connection?.application.appId + '.' })
    else setNotice(operation.action === 'configure' ? 'Original chat settings save confirmed.' : 'Original allowance save confirmed.')
  }
  async function refreshCreator() {
    if (identityWriting.current || identityPending) return
    if (!target || !configuration?.values.connection || !hostingTarget || !savedConnection) { setIdentityFeedback({ kind: 'issue', message: 'Read the saved connection and its original hosting owner before checking Main identity. Your guest settings are kept.' }); return }
    const original = structuredClone(configuration), owner = structuredClone(hostingTarget), operationId = mintObjectId()
    identityWriting.current = operationId; setIdentityBusy(true); setIdentityFeedback(null)
    try {
      const operation = await submitMoteChatIntent({ method: 'space.mote.chat.configure', phase: 'not-dispatched', hostingTarget: owner, input: {
        operationId, target, expectedRevision: original.revision, expectedConnectionRevision: savedConnection.revision,
        values: original.values, refreshCreator: true } })
      if (!mounted.current || hostingKey(currentHosting.current) !== hostingKey(owner)) return
      setConfiguration(current => current && current.revision > operation.configuration.revision ? current : operation.configuration)
      setIdentityFeedback({ kind: 'confirmed', message: 'Main identity confirmed for ' + original.values.connection!.application.appId + '. Guest settings drafts are kept.' })
    } catch (error) {
      if (mounted.current && hostingKey(currentHosting.current) === hostingKey(owner)) setIdentityFeedback({ kind: 'issue', message: 'The original Main identity check was not confirmed. Saved identity, policy and your guest draft are kept. ' + presentError(error) })
    } finally { if (identityWriting.current === operationId) { identityWriting.current = null; if (mounted.current) setIdentityBusy(false) } }
  }
  async function save() {
    if (writing.current || !target) return
    const idle = Number(minutes) * 60000, limit = Number(strangers)
    if (!ready) { setIssue('Read this Mote’s current chat settings before saving. Your draft is kept.'); return }
    if (!minutes.trim() || !Number.isSafeInteger(idle) || idle <= 0 || !strangers.trim() || !Number.isSafeInteger(limit) || limit < 0) { setIssue('Enter a positive conversation interval and a whole message allowance of zero or more.'); return }
    if (draft.enabled && (!selected || !selected.config.enabled || connectionNeedsInitialSetup(selected))) { setIssue('Choose an enabled bot and finish any incomplete original setup before enabling private chat.'); return }
    if (draft.connection && !selected) { setIssue('The selected saved identity is unavailable. Choose another bot or clear the selection before saving.'); return }
    const operationId = mintObjectId(), revision = edited.current, epoch = ++lifetime.current, owner = hostingTarget
    setReading(false); setReadingSource(null)
    const submittedDraft = retainPolicy(owner, draft, minutes, strangers, '', operationId)
    writing.current = operationId; setSaving(true); setIssue(''); setNotice('')
    try {
      await checkpointLauncherState()
      const operation = await submitMoteChatIntent({ method: 'space.mote.chat.configure', phase: 'not-dispatched', ...(hostingTarget ? { hostingTarget } : {}), input: {
        operationId, target, expectedRevision: configuration?.revision ?? null, expectedConnectionRevision: selected?.revision ?? null,
        values: { ...draft, conversationIdleMs: idle, strangerMessageLimit: limit } } })
      if (submittedDraft) useLauncherState.getState().setMoteChatDraft(moteChatDraftKey(submittedDraft), undefined, submittedDraft.version)
      if (lifetime.current !== epoch) return
      confirmed(operation, owner)
      if (edited.current === revision) { useValues(operation.configuration.values); edited.current = 0 }
      else setNotice('Original settings saved. Your newer draft is kept.')
    } catch (error) {
      const message = (useAppStore.getState().moteChatIntents[operationId] ? 'Chat settings were not confirmed. Your draft and original request are kept. ' : 'Chat settings were not saved. Your draft is kept. ') + presentError(error)
      const current = policyDraft(owner); if (current && current.version === submittedDraft?.version) retainPolicy(owner, current.values, current.minutes, current.strangers, message, current.version)
      if (mounted.current && (lifetime.current === epoch || hostingKey(owner) === hostingKey(currentHosting.current))) setIssue(message)
    }
    finally { if (writing.current === operationId) { writing.current = null; if (mounted.current) setSaving(false) } }
  }
  const settingsOrigin = { target, hostingTarget, topicId: scope.topic.id, moteName: scope.topic.title }
  const openSettings = () => {
    if (!selected || !settings?.channelPresentation(selected.config.application, selected.config.adapterId)) { setIssue('The original selected connection is not confirmed. Its settings and your draft are kept.'); return }
    const { connectionId, adapterId, application } = selected.config
    settings.openMoteConnection({ ...settingsOrigin, connection: { connectionId, adapterId, application } })
  }
  const update = (values: MoteChatValues) => { edited.current++; retainPolicy(draftOwner(), values, minutes, strangers); setDraft(values); setNotice('') }
  const savedPolicyDrafts = target ? Object.entries(useLauncherState.getState().drafts).flatMap(([key, entry]) => { const saved = restoredMoteChatDraft(entry.moteChat, key); return saved?.kind === 'policy' && sameMotePreferencesTarget(saved.target, target) ? [saved] : [] }) : []
  return <section className="mote-private-chat" aria-label="External private chat" data-mote-private-chat={scope.topic.id}>
    <header><div><h3><ChatIcon size={15} />External private chat</h3><p>Receive private messages through a saved connection.</p></div><span role="status" data-mote-chat-saved={ready ? configuration?.values.enabled ? 'on' : 'off' : 'unknown'}>{ready ? configuration?.values.enabled ? 'On' : 'Off' : 'Not confirmed'}</span></header>
    <div className="channel-hosting">
      <label className="channel-hosting__selection"><span>Bot hosting source</span><select aria-label="Bot hosting source" value={readingSource === null ? hostingTarget ? 'original' : 'unconfirmed' : 'host:' + readingSource} onChange={event => { if (event.target.value.startsWith('host:')) void read(event.target.value.slice(5)); else if (event.target.value.startsWith('draft:')) { const saved = savedPolicyDrafts.find(saved => 'draft:' + moteChatDraftKey(saved) === event.target.value); if (saved) reviewDraft(saved) } }}>
        {hostingTarget ? <option value="original">{hosts?.find(host => host.id === hostingTarget.hostId)?.label ?? hostingTarget.hostId}</option> : <option value="unconfirmed">Hosting source not confirmed</option>}
        <option value="host:local">Background Host on this device</option>
        {hosts?.filter(host => host.id !== 'local').map(host => <option key={host.id} value={'host:' + host.id}>{host.label}</option>)}
        {savedPolicyDrafts.filter(saved => hostingKey(saved.hostingTarget) !== hostingKey(hostingTarget)).map(saved => <option key={moteChatDraftKey(saved)} value={'draft:' + moteChatDraftKey(saved)}>Saved guest draft · {saved.hostingTarget ? hosts?.find(host => host.id === saved.hostingTarget!.hostId)?.label ?? saved.hostingTarget.hostId : 'Original Host unknown'}</option>)}
      </select></label>
      {hostingTarget ? <details className="connector-diagnostics"><summary>Hosting details</summary><p className="settings-group-note">This Host stores bot credentials and private-chat policy. Agents can run elsewhere.</p><p><code>{hostingTarget.hostId}</code> · <code>{hostingTarget.runtimeId}</code></p></details> : null}
    </div>
    {target && hostingTarget ? <MoteChatActivity key={JSON.stringify(hostingTarget)} target={target} hostingTarget={hostingTarget} active={active} revision={configuration?.revision ?? null} /> : null}
    <label className="mote-private-chat__toggle"><span>Allow private messages<small>Save to apply. A conversation starts with an incoming message.</small></span><Switch aria-label="Enable external private chat" checked={draft.enabled} disabled={saving} onChange={event => update({ ...draft, enabled: event.target.checked })} /></label>
    <div className="mote-private-chat__executor"><span>Shared Mote Executor<strong title={executorId}>{executorLabel}</strong></span><button ref={executorInvoker} type="button" className="small-button" onClick={() => setExecutorOpen(true)}>Mote preferences</button></div>
    {!executorId ? <p className="mote-details__hint">Choose the shared Executor in Mote preferences before enabling private chat.</p> : null}
    {configuration?.values.connection ? <section aria-label="Main identity"><div className="mote-private-chat__executor"><span>Main identity<strong>{configuration.creator ? 'Confirmed bot creator' : 'Native creator not confirmed'}</strong></span><button type="button" className="small-button" disabled={identityBusy || identityPending || !savedConnection || !hostingTarget} onClick={() => void refreshCreator()}>{identityBusy ? 'Checking identity…' : configuration.creator ? 'Refresh Main identity' : 'Confirm Main identity'}</button></div>
      <p className="mote-details__hint">{configuration.creator ? 'Confirmed creator messages go to Main; guests use separate conversations and their own allowance.' : 'Authorized guests use separate conversations and their own allowance; this connection does not identify your own Main.'} Checking uses saved connection {savedConnection?.config.label ?? configuration.values.connection.application.appId}, keeping your guest draft.</p>
      {identityPending ? <p role="status" className="mote-details__hint">The original identity request is kept below. Guest settings can still be edited and saved.</p> : null}
      {identityFeedback ? <p role="status" className={identityFeedback.kind === 'issue' ? 'mote-details__issue' : 'mote-private-chat__notice'}>{identityFeedback.message}</p> : null}
    </section> : null}
    <div className="mote-private-chat__fields">
      <label><span>Bot identity</span><SelectionField label="Private chat bot" value={refChoice(draft.connection)} disabled={saving} searchable options={[
        { value: '', label: 'Choose a bot' }, ...records.map(record => ({ value: choice(record), label: record.config.label,
          disabled: !record.config.enabled || connectionNeedsInitialSetup(record), description: `${record.config.application.domain} · ${record.config.application.appId} · ${connectionInitialSetupLabel(record)}${record.config.enabled ? '' : ' · Application paused'}` }))
      ]} onValueChange={value => { const record = records.find(record => choice(record) === value); update({ ...draft, connection: record ? { connectionId: record.config.connectionId, application: structuredClone(record.config.application) } : null }) }} /></label>
      {draft.connection ? <code className="mote-private-chat__app">{draft.connection.application.domain} · {draft.connection.application.appId}</code> : null}
      <label><span>Guest conversation inactivity<small>After this much inactivity, a guest’s next message starts a new conversation. Confirmed creator messages use Main. This is separate from its heartbeat.</small></span><span className="mote-private-chat__number"><TextInput type="number" min="0" step="any" aria-label="Guest conversation inactivity in minutes" value={minutes} disabled={saving} onChange={event => { edited.current++; retainPolicy(draftOwner(), draft, event.target.value, strangers); setMinutes(event.target.value); setNotice('') }} /><span>minutes</span></span></label>
      <label><span>New guest allowance<small>Total messages for each new guest. Zero blocks new guests until you explicitly grant an allowance.</small></span><TextInput type="number" min="0" step="1" aria-label="New guest message allowance" value={strangers} disabled={saving} onChange={event => { edited.current++; retainPolicy(draftOwner(), draft, minutes, event.target.value); setStrangers(event.target.value); setNotice('') }} /></label>
    </div>
    <p className="mote-details__hint">A new Agent receives references to the three most recent conversations and can look up older conversations.</p>
    {service?.enabled === false ? <Notice role="status" tone="info" density="compact" heading="Automatic chat sync is off"><p>Resume sync in the original connector settings to receive and reply.</p></Notice> : !service && ready ? <p role="status" className="mote-details__hint">The automatic sync policy is not confirmed. This saved choice does not prove messages are flowing.</p> : null}
    {reading ? <p role="status" className="mote-private-chat__activity"><LoadingIcon size={13} animation="spin" />{ready ? 'Refreshing chat settings…' : 'Reading chat settings…'}</p> : null}
    {persistenceIssue ? <p role="status" className="mote-details__issue">{persistenceIssue}</p> : null}
    {issue || policyFeedback?.issue ? <p role="status" className="mote-details__issue">{issue || policyFeedback?.issue}</p> : notice ? <p role="status" className="mote-private-chat__notice">{notice}</p> : null}
    <div className="mote-chat-actions">{dirty ? <button type="button" className="primary-button" disabled={saving || pending} onClick={() => void save()}>{saving ? 'Saving…' : 'Save chat settings'}</button> : null}<button type="button" className="small-button" disabled={reading || saving} onClick={() => void read()}>Refresh</button>{settings && draft.connection ? <button type="button" className="small-button" onClick={openSettings}>Manage bot identity</button> : null}</div>
    {settings && !draft.connection ? <SelectionField label="Manage connector" value="" options={[{ value: '', label: 'Manage a connector…' }, ...settings.channelEntries.map(entry => ({ value: entry.section, label: entry.title, icon: <entry.icon size={14} /> }))]} onValueChange={value => { const entry = settings.channelEntries.find(entry => entry.section === value); if (entry) settings.openMoteConnection({ ...settingsOrigin, section: entry.section }) }} /> : null}
    {configuration && hostingTarget ? <details className="mote-private-chat__people" onToggle={event => setPeopleOpen(event.currentTarget.open)}><summary>People &amp; conversations</summary><MoteChatPeople key={hostingKey(hostingTarget)} configuration={configuration} hostingTarget={hostingTarget} active={active && peopleOpen} refreshRevision={audienceRevision} onSaved={() => { if (hostingKey(hostingTarget) === hostingKey(currentHosting.current)) setNotice('Message allowance saved. Messages already used are kept.') }} /></details> : null}
    {target ? <MoteChatRequests target={target} onConfirmed={confirmed} /> : null}
    {executorOpen ? <MoteQuickModeDialog scope={scope} reference={reference} onOpenPath={onOpenPath} onClose={() => setExecutorOpen(false)} returnFocus={() => executorInvoker.current?.isConnected ? executorInvoker.current : null} /> : null}
  </section>
}
