import { mintObjectId } from '@agentmux/core/object-id'
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionConfigureInput, ConnectionRecord, ConnectionSetupEnrollmentSource } from '@agentmux/core/connections'
import { SettingsNavigation, type SettingsNavigationRequest, type MoteLarkSettingsOrigin } from '../SettingsNavigation'
import { setBotTaskSelection, useAppStore } from '../../store'
import { isSessionSurface } from '../../lib/workbench-surface-kinds'
import { sessionPresentationById } from '../../lib/session-presentation'
import { api } from '../../lib/api'
import { BotEnrollmentPane, useBotEnrollment } from './BotEnrollmentPane'
import { ChannelMetadataPanel } from './ChannelMetadataPanel'
import { ConnectionProfilePanel } from './ConnectionProfilePanel'
import { ConnectionSetupResult, connectionSummary } from './ConnectionSetupResult'
import { ConnectionIdentityFacts } from './ConnectionIdentityFacts'
import { ConnectionIdentityRemoval, RetainedIdentityRemovals } from './ConnectionIdentityRemoval'
import { ConnectionRequestTrace } from './ConnectionRequestTrace'
import { ConnectionManagementSetup } from './ConnectionManagementSetup'
import { MoteConnectionPanel } from '../MoteConnectionIdentity'
import { botTaskSelectionKey, managementTaskScope, restoredManagementTask } from '../../lib/bot-task-selection'
import { MoteIdentityCards, useMoteIdentityReadings } from './MoteIdentityCards'
import '../../styles/connector-identity-cards.css'
import '../../styles/connector-experience.css'
import { useConnectionManagementSetup } from './useConnectionManagementSetup'

const LinkIcon = semanticIconComponent('action.open-external')
const LoadingIcon = semanticIconComponent('status.loading')
const GroupIcon = semanticIconComponent('object.conversations')
const BackIcon = semanticIconComponent('navigation.back')
const RefreshIcon = semanticIconComponent('action.refresh')
const EditIcon = semanticIconComponent('action.edit')
const platform = (domain: string) => domain === 'open.feishu.cn' ? 'Feishu' : domain === 'open.larksuite.com' ? 'Lark' : domain === 'discord.com' ? 'Discord' : domain

export function ExternalConnectionsSettings({ active, onClose, navigationRequest, channel = 'lark' }: { active: boolean; onClose?: (() => void) | undefined; navigationRequest?: SettingsNavigationRequest | undefined; channel?: 'lark' | 'discord' }) {
  const discord = channel === 'discord'
  const navigation = useContext(SettingsNavigation), origin = navigationRequest?.channelOrigin
  const [routeIssue, setRouteIssue] = useState('')
  const originalAgent = useAppStore(state => {
    if (!active || !origin) return undefined
    const session = sessionPresentationById(state.sessions).get(origin.sessionId)
    return session?.kind === 'agent' && session.control.hostId === origin.hostId && session.control.agentSessionId === origin.agentSessionId ? session : undefined
  })
  const pane = useRef<HTMLDivElement>(null), returnMote = useRef<string | null>(null)
  const appliedRoute = useRef<SettingsNavigationRequest | undefined>(undefined)
  const returnToAgent = () => {
    const current = origin && useAppStore.getState().sessions.find(session => session.kind === 'agent' && session.id === origin.sessionId && session.control.hostId === origin.hostId && session.control.agentSessionId === origin.agentSessionId)
    if (current) {
      useAppStore.getState().selectSession(current.id)
      const state = useAppStore.getState(), selection = state.workbenchSpaceSelection
      const region = selection?.tabId && selection.regionId ? state.tabs[selection.tabId]?.regions[selection.regionId] : undefined
      if (state.mainSurface === 'workbench' && region && isSessionSurface(region) && region.sessionId === current.id) { onClose?.(); return }
    }
    navigation?.chooseAgent()
  }
  const [records, setRecords] = useState<ConnectionRecord[]>([]), [issue, setIssue] = useState(''), [busy, setBusy] = useState(false)
  const [listIssue, setListIssue] = useState('')
  const [restoration, setRestoration] = useState(() => !discord && !navigationRequest?.moteLarkOrigin && !origin ? restoredManagementTask(useAppStore.getState().botTaskSelections) : null)
  const [restoreReading, setRestoreReading] = useState({ pending: !!restoration, issue: '' }), [restoreAttempt, setRestoreAttempt] = useState(0)
  const [view, setView] = useState<'loading' | 'library' | 'enrollment' | 'new' | 'saved' | 'edit' | 'management' | 'mote'>(() =>
    restoration ? 'management' : !discord && !navigationRequest?.moteLarkOrigin && !origin && useAppStore.getState().botTaskSelections[botTaskSelectionKey({ kind: 'enrollment' })] ? 'enrollment' : 'loading')
  const [moteSelection, setMoteSelection] = useState<{ origin: MoteLarkSettingsOrigin; create: boolean } | null>(null)
  useEffect(() => { if (!active) setMoteSelection(current => current?.create ? { ...current, create: false } : current) }, [active])
  const [libraryRevision, setLibraryRevision] = useState(0)
  const identities = useMoteIdentityReadings(active && !discord, libraryRevision)
  const [saveNotice, setSaveNotice] = useState('')
  const [selected, setSelected] = useState<ConnectionRecord | null>(null), [label, setLabel] = useState(''), [appId, setAppId] = useState(''), [domain, setDomain] = useState(discord ? 'discord.com' : 'open.feishu.cn'), [secret, setSecret] = useState(''), [enabled, setEnabled] = useState(true)
  const [saveAbsent, setSaveAbsent] = useState(false)
  const [continuation, setContinuation] = useState<{ connectionId: string; source: ConnectionSetupEnrollmentSource } | null>(null)
  const enrollment = useBotEnrollment(active && view === 'enrollment')
  const pending = useRef<ConnectionConfigureInput | null>(null), generation = useRef(0), reading = useRef(0), writing = useRef(false)
  const read = async (epoch = generation.current) => {
    const request = ++reading.current
    try {
      const result = await api.connections.call('connection.ls', {})
      if (epoch === generation.current && request === reading.current) { setRecords(result.connections.filter(record => discord ? record.config.adapterId === 'discord' : record.config.adapterId !== 'discord')); setListIssue(''); setView(current => current === 'loading' ? 'library' : current) }
    } catch (error) {
      if (epoch === generation.current && request === reading.current) {
        setListIssue(presentError(error))
        setView(current => current === 'loading' ? 'library' : current)
      }
    }
  }
  useEffect(() => { const epoch = ++generation.current; if (active) void read(epoch); return () => { generation.current++ } }, [active])
  const enrolled = enrollment.operation?.configured
  useEffect(() => { if (active && enrolled) void read() }, [active, enrolled])
  const connectionSource = api.connections.call
  const clearManagementRoute = () => { setRestoration(null); setBotTaskSelection({ kind: 'management-route' }, null) }
  useEffect(() => {
    if (!active || !restoration || selected) return
    let cancelled = false
    const source = connectionSource, target = restoration.scope
    setRestoreReading({ pending: true, issue: '' })
    void source('connection.inspect', { connectionId: target.connectionId }).then(result => {
      if (cancelled || api.connections.call !== source) return
      const record = result.connection
      if (!record) { setRestoreReading({ pending: false, issue: 'This saved application is not visible. The original request is kept.' }); return }
      if (botTaskSelectionKey(managementTaskScope(record)) !== botTaskSelectionKey(target)) { setRestoreReading({ pending: false, issue: 'The saved application no longer matches this original target. The original request is kept.' }); return }
      setSelected(record); setLabel(record.config.label); setAppId(record.config.application.appId); setDomain(record.config.application.domain); setEnabled(record.config.enabled); setSecret('')
      setRestoreReading({ pending: false, issue: '' })
    }).catch(error => { if (!cancelled && api.connections.call === source) setRestoreReading({ pending: false, issue: presentError(error) }) })
    return () => { cancelled = true }
  }, [active, restoration, selected, restoreAttempt, connectionSource])
  const edit = (record: ConnectionRecord | null) => {
    appliedRoute.current = navigationRequest
    if (pending.current) { setIssue('Check this save before changing the application.'); return }
    setRouteIssue('')
    clearManagementRoute()
    setSelected(record); setLabel(record?.config.label ?? ''); setAppId(record?.config.application.appId ?? ''); setDomain(record?.config.application.domain ?? (discord ? 'discord.com' : 'open.feishu.cn')); setEnabled(record?.config.enabled ?? true); setSecret(''); setIssue(''); setSaveNotice(''); setView(record ? 'edit' : 'new')
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
    if (!pending.current && (!appId.trim() || !selected && !secret)) { setIssue(discord ? 'Paste the Application ID and Bot token from the Discord Developer Portal.' : 'Paste the App ID and App Secret from your application’s Credentials & Basic Info page.'); return }
    writing.current = true; setBusy(true); setIssue(''); setSaveNotice(''); setSaveAbsent(false)
    const epoch = generation.current
    try {
      if (!pending.current) {
        const operationId = mintObjectId(), connectionId = selected?.config.connectionId ?? mintObjectId()
        pending.current = { operationId, expectedRevision: selected?.revision ?? null, connection: { connectionId, adapterId: selected?.config.adapterId ?? (discord ? 'discord' : 'feishu'), application: { domain, appId: appId.trim() }, label: label.trim() || `${platform(domain)} bot`, enabled, credentialRef: selected?.config.credentialRef ?? '' } }
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
  const openConsole = async (applicationDomain = domain) => {
    try { await api.ui.openExternal(applicationDomain === 'discord.com' ? 'https://discord.com/developers/applications' : `https://${applicationDomain}/app`) }
    catch (error) { setIssue(presentError(error)) }
  }
  const existing = () => { clearManagementRoute(); setContinuation(null); appliedRoute.current = navigationRequest; if (selected && !pending.current) edit(null); else setView('new') }
  const startEnrollment = () => { clearManagementRoute(); setContinuation(null); appliedRoute.current = navigationRequest; setMoteSelection(null); enrollment.startAnother(); setView('enrollment') }
  const openMote = (origin: MoteLarkSettingsOrigin, create = false) => { clearManagementRoute(); setContinuation(null); appliedRoute.current = navigationRequest; setMoteSelection({ origin, create }); setView('mote'); setIssue('') }
  const library = () => { clearManagementRoute(); setContinuation(null); returnMote.current = moteSelection?.origin.topicId ?? null; appliedRoute.current = navigationRequest; setRouteIssue(''); setView('library'); setMoteSelection(null); setIssue(''); setLibraryRevision(value => value + 1) }
  useLayoutEffect(() => {
    const scroll = pane.current?.closest<HTMLElement>('.settings-content__scroll')
    if (!scroll) return
    const card = view === 'library' && returnMote.current
      ? [...scroll.querySelectorAll<HTMLElement>('[data-mote-identity]')].find(card => card.dataset.moteIdentity === returnMote.current) : null
    scroll.scrollTop = card ? scroll.scrollTop + card.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16 : 0
  }, [active, view])
  useEffect(() => {
    if (view !== 'library' || !returnMote.current || !pane.current) return
    const topicId = returnMote.current; returnMote.current = null
    const document = pane.current.ownerDocument, focused = document.activeElement
    if (focused && focused !== document.body && focused.isConnected) return
    const card = [...pane.current.querySelectorAll<HTMLElement>('[data-mote-identity]')].find(card => card.dataset.moteIdentity === topicId)
    card?.querySelector<HTMLButtonElement>('.connector-mote-card__identity')?.focus({ preventScroll: true })
  }, [view])
  const current = view === 'enrollment' ? enrolled?.connection ?? null : selected && (records.find(record => record.config.connectionId === selected.config.connectionId) ?? selected)
  const management = useConnectionManagementSetup(current, !discord && active && (view === 'saved' || view === 'management' || view === 'enrollment' && !!enrolled || view === 'mote' && !!continuation), view === 'management')
  const continuationSupport = management.catalog?.value?.support
  const canContinueEnrollment = !!current && continuationSupport?.connectionRevision === current.revision && continuationSupport.capabilities.includes('enrollment-continuation')
  useEffect(() => {
    if (!active || !continuation || current?.config.connectionId !== continuation.connectionId || !canContinueEnrollment) return
    management.handoff(continuation.source)
    setContinuation(null)
    setView('management')
  }, [active, continuation, current, canContinueEnrollment])
  const continueMoteSetup = (record: ConnectionRecord, source: ConnectionSetupEnrollmentSource) => {
    setSelected(record)
    setRecords(previous => [...previous.filter(item => item.config.connectionId !== record.config.connectionId), record])
    setContinuation({ connectionId: record.config.connectionId, source })
  }
  useEffect(() => {
    if (active && navigationRequest?.moteLarkOrigin && appliedRoute.current !== navigationRequest) openMote(navigationRequest.moteLarkOrigin)
  }, [active, navigationRequest])
  const appliedContinuation = useRef<SettingsNavigationRequest | undefined>(undefined)
  useEffect(() => {
    const setup = navigationRequest?.moteLarkOrigin?.setup
    if (!active || !setup || appliedContinuation.current === navigationRequest) return
    const record = records.find(item => item.config.connectionId === setup.connectionId)
    if (!record) return
    appliedContinuation.current = navigationRequest
    continueMoteSetup(record, setup.source)
  }, [active, navigationRequest, records])
  useEffect(() => {
    if (!active || appliedRoute.current === navigationRequest || !origin) return
    if (pending.current) { setRouteIssue('Check the current original save before opening another application. Your draft and original request are kept.'); return }
    const record = records.find(record => record.config.connectionId === origin.connection.connectionId && record.config.adapterId === origin.connection.adapterId &&
      record.config.application.domain === origin.connection.application.domain && record.config.application.appId === origin.connection.application.appId)
    if (!record) {
      if (view !== 'loading') setRouteIssue(`The requested application is not confirmed here: ${origin.connection.application.domain} · ${origin.connection.application.appId} · ${origin.connection.connectionId}. Refresh the bot list to read this exact identity again. Your existing draft and results are kept.`)
      return
    }
    appliedRoute.current = navigationRequest; edit(record); setView('saved')
  }, [active, navigationRequest, records, view])
  const editing = view === 'new' || view === 'edit', dirty = !selected || label !== selected.config.label || enabled !== selected.config.enabled || !!secret
  if (!active) return null
  const listFeedback = listIssue ? <div className="connector-list-feedback" data-connection-list-issue>
    <p role="status" className="connector-check-feedback">Saved bots could not be refreshed. Existing bots and setup results are kept.</p>
    <button type="button" className="small-button" onClick={() => void read()}><RefreshIcon size={14} />Refresh bot list</button>
    <details className="connector-diagnostics"><summary>List error details</summary><p className="connector-enrollment__technical">{listIssue}</p></details>
  </div> : null
  return <div ref={pane} className="settings-pane-stack connector-onboarding" data-connector-settings>
    {routeIssue ? <div className="connector-list-feedback" data-channel-target-issue><p role="status" className="connector-issue">{routeIssue}</p>
      <button className="small-button" onClick={() => void read()}>Read requested application again</button></div> : null}
    {view === 'loading' ? <section className="connector-setup">
      <p className="settings-group-note" role="status">Reading saved bots…</p>
      <div className="connector-editor-actions"><button type="button" className="primary-button" onClick={discord ? existing : startEnrollment}>{discord ? 'Connect a bot' : 'Set up a bot'}</button><button type="button" className="small-button" onClick={existing}>Connect an existing bot</button></div>
    </section> : null}
    {view === 'mote' && moteSelection ? <section className="connector-mote-detail" data-connector-mote-detail>
      <button type="button" className="connector-back small-button" onClick={library}><BackIcon size={14} />Back to bots</button>
      <header><h3>Bot for {moteSelection.origin.moteName}</h3><p>This bot represents your Mote in group conversations.</p></header>
      <MoteConnectionPanel key={JSON.stringify([moteSelection.origin.target, moteSelection.origin.topicId])} {...moteSelection.origin} createOnOpen={moteSelection.create} inSettings onContinueSetup={continueMoteSetup}
        onRead={() => {}} onCreateIntentConsumed={() => setMoteSelection(current => current?.origin === moteSelection.origin ? { ...current, create: false } : current)} onManageConnection={record => { edit(record); setView('saved') }} />
      {continuation ? <p role="status" className="connector-check-feedback">{management.catalog?.issue || (management.catalog?.value && !canContinueEnrollment ? 'The saved sign-in cannot be handed off here. Open this bot’s management to continue; the original setup is kept.' : 'Reading this bot’s setup options…')}</p> : null}
    </section> : null}
    {view === 'enrollment' ? <><button type="button" className="connector-back small-button" onClick={library}><BackIcon size={14} />Back to bots</button><div className="connector-generic-context"><strong>Create a bot</strong><p className="settings-group-note">Use it with any Agent or choose it for a Mote.</p></div><BotEnrollmentPane enrollment={enrollment} onExisting={existing} onSaved={record => saved(record, 'Application saved.')} onContinue={canContinueEnrollment ? record => {
      const operation = enrollment.operation
      if (!operation?.configured || operation.configured.connection.config.connectionId !== record.config.connectionId) return
      management.handoff({ kind: 'enrollment', operationId: operation.operationId, expectedRevision: operation.revision })
      setSelected(record); setView('management')
    } : undefined} /></> : null}
    {view === 'library' ? <section className="connector-library" aria-label="Bots">
      <header className="connector-identities-heading"><div><h3>Your bots</h3><p>{discord ? 'Connect a bot you already manage.' : 'Connect Agents and Motes to Feishu or Lark conversations.'}</p></div><div className="connector-identities-heading__actions">{discord ? <><button data-enrollment-existing className="primary-button" onClick={existing}>Connect a bot</button><button className="small-button" onClick={() => void openConsole()}>Developer Portal <LinkIcon size={12} /></button></> : <><button data-enrollment-new className="primary-button" onClick={startEnrollment}>Create bot</button><button data-enrollment-existing className="small-button" onClick={existing}>Connect existing bot</button></>}</div></header>
      {!discord ? <MoteIdentityCards readings={identities} records={records} recordsIssue={listIssue} onOpen={openMote} /> : null}
      <section className="connector-saved-identities" aria-label="Saved bots"><header><h3>Saved bots</h3><button className="small-button" onClick={() => { void read(); setLibraryRevision(value => value + 1) }}><RefreshIcon size={14} />Refresh</button></header>
        {saveNotice ? <p className="settings-group-note" role="status">{saveNotice}</p> : null}
        {records.length ? records.map(record => <article className="connector-record" key={record.config.connectionId} data-connection={record.config.connectionId}>
          <button className="connector-record__open" onClick={() => { setMoteSelection(null); edit(record); setView('saved') }}><span className="connector-record__mark"><GroupIcon size={18} /></span><span><strong className="connector-record__name">{record.config.label}</strong><small>{platform(record.config.application.domain)}</small>{discord ? <span className="connector-record__facts"><span className="connector-record__app"><code>{record.config.application.appId}</code></span><span>{connectionSummary(record)}</span></span> : <ConnectionIdentityFacts record={record} readings={identities} compact />}</span><span className="connector-record__action">Manage</span></button>
        </article>) : !listIssue ? <p className="settings-group-note">{discord ? 'No Discord bots saved. Connect a bot above to get started.' : 'No saved bots. Create one or connect an existing bot above.'}</p> : null}
        {listFeedback}
      </section>
      {!discord ? <RetainedIdentityRemovals readings={identities} active={active} onDeleted={receipt => {
        setRecords(records => records.filter(record => record.config.connectionId !== receipt.connectionId)); setSaveNotice('The original identity removal is confirmed. The remote application and original history are kept.'); setLibraryRevision(value => value + 1)
      }} /> : null}
    </section> : null}
    {view === 'management' && !current && restoration ? <section className="connector-setup" data-management-restoring>
      <button type="button" className="connector-back small-button" onClick={library}><BackIcon size={14} />Back to bots</button>
      <header><h3>Original bot setup</h3><p>Read the saved application and its selected original request.</p></header>
      <dl className="connector-identity"><div><dt>App ID</dt><dd><code>{restoration.scope.appId}</code></dd></div><div><dt>Original request</dt><dd><code>{restoration.operationId}</code></dd></div></dl>
      {restoreReading.pending ? <p role="status" data-management-activity aria-busy="true"><LoadingIcon size={14} animation="spin" /> Reading the original saved application…</p> : <><p role="status" className="connector-check-feedback">{restoreReading.issue}</p><button className="small-button" onClick={() => setRestoreAttempt(value => value + 1)}>Read original application again</button></>}
      <ConnectionRequestTrace source={{ kind: 'setup', operationId: restoration.operationId }} />
    </section> : null}
    {view === 'management' && current ? <ConnectionManagementSetup record={current} model={management} platformLabel={platform(current.config.application.domain)} onBack={() => { setView('saved'); setIssue('') }} onLibrary={library} onConsole={() => openConsole(current.config.application.domain)} /> : editing || view === 'saved' && current ? <section className="connector-setup" data-connection-editor>
      {!pending.current ? <button type="button" className="connector-back small-button" onClick={() => { moteSelection ? setView('mote') : library(); setIssue('') }}><BackIcon size={14} />{moteSelection ? 'Back to Mote bot' : 'Back to bots'}</button> : null}
      {editing ? <>
        <header className="connector-setup__heading"><span className="connector-setup__mark"><GroupIcon size={22} /></span><div><h3 className="connector-editor-title">{selected ? 'Edit bot connection' : 'Connect an existing bot'}</h3><p>{selected ? 'Update the local name, credential or connection preference.' : discord ? 'Save its credentials, then check the connection and choose an Agent’s channel.' : 'Save its credentials, then check the connection and choose an Agent’s group.'}</p></div></header>
        {!selected ? <div className="connector-credentials-source"><div>{discord ? <><p>Find your <strong>Application ID</strong> in General Information and <strong>Bot token</strong> on the Bot page.</p><p className="settings-group-note">Create an application and add its bot in the Developer Portal, then return here.</p></> : <><p>Find App ID and App Secret in <strong>Credentials & Basic Info</strong>.</p><details className="connector-first-bot"><summary>Don’t have a bot yet?</summary><p>Create a custom app in the developer console and add the Bot capability. Then return here with its credentials.</p></details></>}</div><button type="button" className="small-button" onClick={() => void openConsole()}>Open {platform(domain)} console <LinkIcon size={12} /></button></div> : null}
        <div className="connector-setup__fields">
          {selected ? <dl className="connector-identity" aria-label="Saved application identity"><div><dt>Platform</dt><dd>{platform(domain)}</dd></div><div><dt>App ID</dt><dd><code>{appId}</code></dd></div></dl> : discord ? null : <label className="settings-field connector-platform"><span>Platform</span><select aria-label="Connection platform" value={domain} disabled={!!pending.current} onChange={event => setDomain(event.target.value)}><option value="open.feishu.cn">Feishu · 飞书</option><option value="open.larksuite.com">Lark</option></select></label>}
          {!selected ? <label className="settings-field"><span>{discord ? 'Application ID' : 'App ID'}</span><TextInput aria-label="Connection app ID" placeholder={discord ? 'Application ID from General Information' : 'cli_…'} spellCheck={false} autoCapitalize="none" autoComplete="off" value={appId} disabled={!!pending.current} onChange={event => setAppId(event.target.value)} /></label> : null}
          <label className="settings-field"><span>{discord ? selected ? 'Replace Bot token' : 'Bot token' : selected ? 'Replace App Secret' : 'App Secret'}</span><TextInput type="password" aria-label="Connection app secret" autoComplete="new-password" placeholder={selected ? 'Leave blank to keep the saved credential' : discord ? 'Paste your bot’s token' : 'Paste your application’s secret'} value={secret} disabled={!!pending.current} onChange={event => setSecret(event.target.value)} /><small className="settings-group-note">Stored securely on this environment.</small></label>
          {selected ? <label className="settings-field"><span>Name in AgentMux</span><TextInput aria-label="Connection name" value={label} disabled={!!pending.current} onChange={event => setLabel(event.target.value)} /></label> : null}
          <details className="connector-optional"><summary>Connection options</summary>{!selected ? <label className="settings-field"><span>Name in AgentMux <small>Optional</small></span><TextInput aria-label="Connection name" placeholder={`${platform(domain)} bot`} value={label} disabled={!!pending.current} onChange={event => setLabel(event.target.value)} /></label> : null}<label className="connector-enabled"><input type="checkbox" aria-label="Connection enabled" checked={enabled} disabled={!!pending.current} onChange={event => setEnabled(event.target.checked)} /><span>Enable this application</span></label><p className="settings-group-note">Enabling starts the application connection. Choose which Agent and group to share separately.</p></details>
        </div>
        <div className="connector-editor-actions">
          {pending.current ? <><button data-connection-save className="primary-button" disabled={busy} onClick={() => void (saveAbsent ? save() : reviewSave())}>{busy ? 'Checking save…' : saveAbsent ? 'Continue this save' : 'Check this save'}</button>{saveAbsent ? <button className="small-button" disabled={busy} onClick={() => void reviewSave()}>Check again</button> : null}</> : <><button data-connection-save className="primary-button" disabled={busy || !!selected && !dirty} onClick={() => void save()}>{busy ? 'Saving…' : selected ? 'Save changes' : 'Save application'}</button>{selected ? <button className="small-button" disabled={busy} onClick={() => setView('saved')}>Cancel editing</button> : null}</>}
        </div>
      </> : current ? <>
        <header className="connector-setup__heading"><span className="connector-setup__mark"><GroupIcon size={22} /></span><div><h3 className="connector-editor-title">{current.config.label}</h3><p>{platform(current.config.application.domain)} bot application</p></div></header>
        {discord ? <dl className="connector-identity"><div><dt>Application ID</dt><dd><code>{current.config.application.appId}</code></dd></div></dl> : <ConnectionIdentityFacts record={current} readings={identities} />}
        <ChannelMetadataPanel key={JSON.stringify([current.config.connectionId, current.config.application])} connection={current} active={active} />
        {saveNotice ? <p className="settings-group-note" role="status">{saveNotice}</p> : null}
        {!discord && (management.selectedId || management.supported || management.choices.length || management.catalog?.issue) ? <div className="connector-next-step"><div><strong>Bot setup</strong><p>Account, messages, permissions and publishing.</p></div><button className="primary-button" data-management-open onClick={() => { if (management.selectedId) setBotTaskSelection(managementTaskScope(current), management.selectedId); setView('management') }}>Manage setup</button></div> : null}
        {discord ? <ConnectionSetupResult record={current} active={active} /> : <details className="connector-optional"><summary>Connection status and checks</summary><ConnectionSetupResult record={current} active={active} /></details>}
        <div className="connector-editor-actions"><button className="small-button" disabled={busy} onClick={() => edit(current)}><EditIcon size={14} />Edit connection</button>{management.catalog?.issue ? <button className="small-button" onClick={() => void management.list()}>Check setup support</button> : null}</div>
        {discord ? <details className="connector-setup-help" data-discord-setup><summary>Connect Discord channels</summary><ol><li>On the Bot page, enable Message Content Intent for ordinary channel text.</li><li>Install the bot in your server with View Channels, Send Messages and Read Message History. Attach Files is needed for files; threads also need Send Messages in Threads.</li><li>In an Agent’s menu, choose the exact channel to share. Member input grants are managed separately.</li></ol><p className="settings-group-note">Saving credentials does not confirm Gateway connection, channel access or message delivery. Check this connection and the selected channel separately.</p><button className="small-button" data-management-console onClick={() => void openConsole('discord.com')}>Open Developer Portal <LinkIcon size={12} /></button></details> : <><details className="connector-setup-help"><summary>Finish setup in {platform(current.config.application.domain)}</summary><ol><li>Enable the bot capability in your application.</li><li>In Events & Callbacks, choose persistent connection and add <code>im.message.receive_v1</code>.</li><li>Enable the messaging and group permissions required by the features you use, then publish the application.</li></ol><p className="settings-group-note">Keep this application enabled here while finishing event setup.</p><button className="small-button" data-management-console onClick={() => void openConsole(current.config.application.domain)}>Open {platform(current.config.application.domain)} console <LinkIcon size={12} /></button></details><ConnectionProfilePanel key={JSON.stringify([current.config.connectionId, current.config.application, current.revision])} record={current} /></>}
        <ConnectionIdentityRemoval key={JSON.stringify([current.config.connectionId, current.config.application])} record={current} readings={identities} active={active} onDeleted={receipt => {
          generation.current++; setRecords(records => records.filter(record => record.config.connectionId !== receipt.connectionId)); setSelected(null); setMoteSelection(null); setView('library'); setIssue(''); setSaveNotice('Identity removed from AgentMux. The remote bot application, Motes and original history are kept.'); setLibraryRevision(value => value + 1)
        }} />
      </> : null}
    </section> : null}
    {current && navigation ? <div className="connector-editor-actions"><button className="small-button" data-connector-return-agent onClick={returnToAgent}>{originalAgent ? 'Return to Agent' : 'Choose an Agent'}</button><span className="settings-group-note">Connect a group from the Agent’s menu.</span></div> : null}
    {view !== 'library' ? listFeedback : null}
    {issue ? <p role="status" className="connector-issue">{issue}</p> : null}
  </div>
}
