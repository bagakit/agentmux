import { useWorkbenchDocument } from '../lib/workbench-document'
import { sessionPresentationById } from '../lib/session-presentation'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useShallow } from 'zustand/react/shallow'
import { DEFAULT_MOTE_PRESENCE } from '@agentmux/core/mote-preferences'
import { MOTE_QUICK_MODE_PATH, type MoteQuickDefaults } from '../../../shared/mote-quick-mode'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { readMoteQuickDefaults, saveMoteQuickDefaults, type SavedMoteQuickMode } from '../lib/mote-quick-mode'
import { moteConversationChoices, moteConversationLabel, useMoteDefaultConversation } from '../lib/mote-quick-preferences'
import { spatialCatalog } from '../lib/space-agent-control'
import { executorsForHost } from '../lib/executors'
import { fileNavigationSelection, useAppStore } from '../store'
import { MoteBehaviorAction } from './MoteBehaviorDialog'
import { SelectionField } from './SelectionField'
import { AgentExecutorPicker } from './AgentExecutorPicker'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import '../styles/mote-quick-mode.css'
import { api } from '../lib/api'
import { moteConnectionTarget } from '../lib/mote-connection-default'

const ThemeActionQuickModeIcon = semanticIconComponent('action.quick-mode')
const ThemeActionEditIcon = semanticIconComponent('action.edit')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')
const ThemeActionPinIcon = semanticIconComponent('action.pin')
const HeartbeatIcon = semanticIconComponent('action.configure-reconnect')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeFileTextIcon = semanticIconComponent('file.text')


type ResumeRequest = { ownerHostId: string; scheduleId: string; expectedRevision: number; operationId: string }
// User drafts only: no current-role, delivery or schedule facts are authored here.
const retainedQuickDrafts = new Map<string, { draft: MoteQuickDefaults; minutes: string; saved: SavedMoteQuickMode | null; resume: ResumeRequest | null }>()

export function MoteQuickMode({ scope, reference, onOpenPath, active }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined; active: boolean
  onOpenPath(path: string): Promise<unknown>
}) {
  const ownerDocument = useWorkbenchDocument()
  const [editing, setEditing] = useState(false), invoker = useRef<HTMLElement | null>(null)
  const saved = scope.topic.quickMode, defaults = saved?.status === 'saved' ? saved.defaults : {}
  const presence = defaults.presence ?? DEFAULT_MOTE_PRESENCE
  const resolved = useMoteDefaultConversation(scope.topic, scope.workspace.id, active)
  const executorFacts = useAppStore(useShallow(state => ({ config: state.config, detections: state.executorDetections, inventory: state.hostExecutorInventories[scope.workspace.hostId] })))
  const executorLabel = useMemo(() => executorsForHost(executorFacts.config, scope.workspace.hostId, executorFacts.detections, executorFacts.inventory)
    .find(item => item.id === defaults.executorId)?.label ?? defaults.executorId, [executorFacts, scope.workspace.hostId, defaults.executorId])
  const conversationLabel = useAppStore(state => defaults.conversation ? moteConversationLabel(state, defaults.conversation) : undefined)
  const edit = () => { invoker.current = ownerDocument.activeElement as HTMLElement; setEditing(true) }
  return <section className="mote-quick-mode" aria-label="Quick mode">
    <div className="mote-details__section-actions"><span><ThemeActionQuickModeIcon size={13} />Quick mode</span><MoteBehaviorAction label="Edit quick mode" onClick={edit}><ThemeActionEditIcon size={14} /></MoteBehaviorAction></div>
    <button className="mote-quick-mode__row" type="button" onClick={edit}><ThemeObjectAgentIcon size={14} /><span>Executor for new chat</span><strong title={defaults.executorId}>{executorLabel ?? 'Choose Executor'}</strong></button>
    <button className="mote-quick-mode__row" type="button" onClick={edit}><ThemeObjectConversationIcon size={14} /><span>Main Agent</span><strong title={defaults.conversation?.sessionId}>{conversationLabel ?? (defaults.conversation ? 'Saved main Agent' : 'Choose main Agent')}</strong>{defaults.conversation ? <ThemeActionPinIcon size={12} aria-label="Kept open" /> : null}</button>
    <button className="mote-quick-mode__row" type="button" onClick={edit}><HeartbeatIcon size={14} /><span>Automatic heartbeat</span><strong>{presence.enabled ? `Every ${presence.intervalMs / 60000} min` : 'Disabled'}</strong></button>
    {resolved.issue ? <p role="status" className="mote-details__issue">{resolved.issue}</p> : null}
    {editing ? <MoteQuickModeDialog key={scope.workspace.hostId + scope.topic.id + scope.rootPath} scope={scope} reference={reference} onOpenPath={onOpenPath}
      onClose={() => setEditing(false)} returnFocus={() => invoker.current?.isConnected ? invoker.current : null} /> : null}
  </section>
}

export function MoteQuickModeDialog({ scope, reference, onOpenPath, onClose, returnFocus }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
  onOpenPath(path: string): Promise<unknown>; onClose(): void; returnFocus(): HTMLElement | null
}) {
  const ownerDocument = useWorkbenchDocument()
  const draftKey = JSON.stringify(moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings) ?? [scope.workspace.hostId, scope.workspace.path, scope.topic.id])
  const restored = useRef(retainedQuickDrafts.get(draftKey))
  const [saved, setSaved] = useState<SavedMoteQuickMode | null>(restored.current?.saved ?? null), [draft, setDraft] = useState<MoteQuickDefaults>(() => restored.current?.draft ?? (scope.topic.quickMode?.status === 'saved' ? scope.topic.quickMode.defaults : {}))
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null), [attempt, setAttempt] = useState(0)
  const [minutes, setMinutes] = useState(restored.current?.minutes ?? String((draft.presence ?? DEFAULT_MOTE_PRESENCE).intervalMs / 60000))
  const presence = draft.presence ?? DEFAULT_MOTE_PRESENCE
  const maintenance = saved?.maintenance
  const resumeRequest = useRef<ResumeRequest | null>(restored.current?.resume ?? null)
  const [resuming, setResuming] = useState(false)
  const maintenanceLabel = maintenance?.schedule?.status === 'stopped' ? 'Original heartbeat stopped' : maintenance ? { active: 'Automatic heartbeat scheduled', paused: 'Original heartbeat paused', disabled: 'Automatic maintenance disabled', unbound: 'Choose a main Agent to maintain', unconfirmed: 'Actual schedule unconfirmed' }[maintenance.status] : 'Actual schedule not yet read'
  const form = useRef(draft); form.current = draft
  const edited = useRef(Boolean(restored.current)), lifetime = useRef<object>({}), content = useRef<HTMLDivElement>(null), id = useId()
  const latestDraft = useRef({ draft, minutes, saved, accepted: false })
  latestDraft.current = { ...latestDraft.current, draft, minutes, saved }
  useLayoutEffect(() => () => { const current = latestDraft.current
    if (!current.accepted && (edited.current || current.saved?.pending || resumeRequest.current)) retainedQuickDrafts.set(draftKey, { draft: current.draft, minutes: current.minutes, saved: current.saved, resume: resumeRequest.current })
  }, [draftKey])
  const facts = useAppStore(useShallow(state => ({ tabs: state.tabs, layouts: state.layouts, config: state.config, snapshots: state.scratchTopicSnapshots,
    bindings: state.spaceZoneBindings, categories: state.topicCategories, detections: state.executorDetections, inventory: state.hostExecutorInventories[scope.workspace.hostId] })))
  const ownAgentIds = useMemo(() => [...new Set(Object.values(facts.tabs).filter(tab => tab.workspaceId === scope.workspace.id)
    .flatMap(tab => Object.values(tab.regions).flatMap(region => region.kind === 'agent' ? [region.sessionId] : [])))], [facts.tabs, scope.workspace.id])
  const execution = useAppStore(useShallow(state => Object.fromEntries(ownAgentIds.map(id => {
    const session = sessionPresentationById(state.sessions).get(id)
    return [id, session ? JSON.stringify([session.hostId, session.control.hostId, session.control.kind === 'agent' ? session.control.agentSessionId : null]) : null]
  }))))
  const choices = useMemo(() => moteConversationChoices(useAppStore.getState(), scope.topic, scope.workspace.id,
    spatialCatalog(useAppStore.getState(), [scope.topic])), [facts.tabs, facts.layouts, facts.config, facts.snapshots, facts.bindings, facts.categories, execution, scope.topic, scope.workspace.id])
  const executors = executorsForHost(facts.config, scope.workspace.hostId, facts.detections, facts.inventory)
  const conversationLabels = useAppStore(useShallow(state => Object.fromEntries(choices.map(choice => [choice.sessionId,
    moteConversationLabel(state, choice) ?? choice.sessionId]))))
  useLayoutEffect(() => {
    const epoch = {}; lifetime.current = epoch
    const navigation = fileNavigationSelection(useAppStore.getState()); let moved = false
    const unsubscribe = useAppStore.subscribe(state => { if (fileNavigationSelection(state) !== navigation) moved = true })
    setLoading(true); setIssue(null)
    void readMoteQuickDefaults(scope).then(source => {
      if (lifetime.current !== epoch) return
      setSaved(previous => previous?.pending ? { ...source, pending: previous.pending } : source)
      if (moved) throw new Error('Your selection changed during the read. Your choices are kept; reread the settings.')
      if (source.issue) setIssue(source.issue)
      else if (!edited.current) { form.current = source.defaults; setDraft(source.defaults); setMinutes(String((source.defaults.presence ?? DEFAULT_MOTE_PRESENCE).intervalMs / 60000)) }
    }).catch(cause => { if (lifetime.current === epoch) { setSaved(previous => previous?.pending ? previous : null); setIssue(presentError(cause)) } })
      .finally(() => { unsubscribe(); if (lifetime.current === epoch) setLoading(false) })
    return () => { lifetime.current = {}; unsubscribe() }
  }, [attempt])
  const update = (next: MoteQuickDefaults) => { edited.current = true; form.current = next; setDraft(next) }
  const selected = draft.conversation ? JSON.stringify(draft.conversation) : ''
  const hasSelected = choices.some(choice => JSON.stringify(choice) === selected)
  async function resumeHeartbeat() {
    if (resuming) return
    const schedule = saved?.maintenance?.schedule, ownerHostId = saved?.source?.resource?.hostId
    if (!resumeRequest.current && (!schedule || !ownerHostId || !Number.isSafeInteger(schedule.revision))) return
    const existing = resumeRequest.current
    const original = existing ?? { ownerHostId: ownerHostId!, scheduleId: schedule!.loopId, expectedRevision: schedule!.revision!, operationId: crypto.randomUUID() }
    resumeRequest.current = original
    const epoch = lifetime.current
    setResuming(true); setIssue(null)
    try {
      const { ownerHostId, ...input } = original
      const result = existing ? await api.schedule.inspect({ operationId: input.operationId }, ownerHostId) : await api.schedule.resume(input, ownerHostId)
      if (lifetime.current !== epoch) return
      if (!result.schedule || result.schedule.loopId !== original.scheduleId) throw new Error('The original resume is unconfirmed. Its request is kept; inspect it again.')
      resumeRequest.current = null
      setSaved(previous => previous ? { ...previous, maintenance: { status: result.schedule!.status === 'active' ? 'active' : 'paused', schedule: result.schedule, issue: null } } : previous)
    } catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
    finally { if (lifetime.current === epoch) setResuming(false) }
  }
  async function save() {
    if (busy || !saved) return
    if (!minutes.trim() || !Number.isSafeInteger(Number(minutes)) || Number(minutes) < 1 || !Number.isSafeInteger(Number(minutes) * 60000)) {
      setIssue('Enter a whole number of minutes, at least 1. Your choices and original settings are kept.'); return
    }
    const submitted = form.current, epoch = lifetime.current
    const current = () => lifetime.current === epoch && form.current === submitted
    setBusy(true); setIssue(null)
    try { await saveMoteQuickDefaults(scope, submitted, saved, onOpenPath, current, reference); if (current()) { latestDraft.current.accepted = true; retainedQuickDrafts.delete(draftKey); onClose() } }
    catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
    finally { if (lifetime.current === epoch) setBusy(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><DocumentOverlayPortal component={Dialog.Portal}>
    <Dialog.Overlay className="dialog-scrim mote-behavior-overlay" />
    <Dialog.Content ref={content} className="dialog-surface mote-quick-mode-dialog" aria-busy={busy}
      onOpenAutoFocus={event => { event.preventDefault(); content.current?.querySelector<HTMLButtonElement>('.selection-field')?.focus() }}
      onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus(), active = ownerDocument.activeElement
        if (node?.isConnected && (active === ownerDocument.body || active === node || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}>
      <header className="mote-behavior-header"><div><Dialog.Title>Quick mode</Dialog.Title><Dialog.Description>{scope.topic.title} · ready to continue</Dialog.Description></div><MoteBehaviorAction label="Close quick mode" onClick={onClose}><ThemeActionCloseIcon size={16} /></MoteBehaviorAction></header>
      <div className="mote-quick-mode-dialog__body">
        <label htmlFor={id + '-agent'}><ThemeObjectAgentIcon size={16} /><span>Executor for new chat<small>Preselected for new conversations.</small></span></label>
        <AgentExecutorPicker presentation="field" id={id + '-agent'} label="Executor for new chat"
          selected={draft.executorId ?? null} executors={executors} unsetLabel="Use normal Launcher choice"
          onSelect={value => { const { executorId: _, ...rest } = form.current; update(value ? { ...rest, executorId: value } : rest) }} />
        <label htmlFor={id + '-conversation'}><ThemeActionPinIcon size={16} /><span>Main Agent<small>Your usual contact. Coordinates work with the other Agents.</small></span></label>
        <SelectionField id={id + '-conversation'} label="Main Agent" value={selected}
          onValueChange={value => { const { conversation: _, ...rest } = form.current; const choice = choices.find(choice => JSON.stringify(choice) === value); if (value && !choice) { setIssue('The chosen conversation is no longer confirmed. Your choices are kept.'); return } update(choice ? { ...rest, conversation: choice } : rest) }}
          options={[{ value: '', label: 'No main Agent yet' }, ...(selected && !hasSelected ? [{ value: selected, label: 'Saved location · unconfirmed' }] : []),
            ...choices.map(choice => ({ value: JSON.stringify(choice), label: facts.tabs[choice.tabId]?.name?.trim() || conversationLabels[choice.sessionId] || choice.sessionId, description: `${conversationLabels[choice.sessionId]} · ${choice.hostId} / ${choice.sessionId} · ${facts.config?.workspaces.find(item => item.id === choice.displayWorkspaceId)?.name ?? 'Workspace'} / ${1 + (facts.layouts[choice.displayWorkspaceId]?.groups.findIndex(group => group.id === choice.groupId) ?? -1)}` }))]} />
        <fieldset className="mote-quick-mode__presence"><legend>Main Agent & heartbeat</legend>
          <label><input type="checkbox" aria-label="Enable automatic Mote maintenance" checked={presence.enabled}
            onChange={event => update({ ...form.current, presence: { ...presence, enabled: event.target.checked } })} />Keep the main Agent available</label>
          <label htmlFor={id + '-interval'}>Heartbeat interval <small>Minutes · default 30</small></label>
          <input id={id + '-interval'} aria-label="Heartbeat interval (minutes)" type="number" inputMode="numeric" min="1" step="1" value={minutes}
            onChange={event => { const value = event.target.value; setMinutes(value); edited.current = true
              if (value.trim() && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number.isSafeInteger(Number(value) * 60000)) {
                update({ ...form.current, presence: { ...presence, intervalMs: Number(value) * 60000 } })
              }
            }} />
          <p className="mote-details__hint">Mote checks goals, work threads and unfinished commitments. It can stay quiet when nothing needs attention. Changing the interval keeps a paused schedule paused.</p>
          <p className="mote-details__hint" data-mote-maintenance-status={maintenance?.status ?? 'unread'}>{maintenanceLabel}</p>
          {maintenance?.issue ? <p role="status" className="mote-details__issue">{maintenance.issue}</p> : null}
          {maintenance?.schedule ? <details><summary>Original heartbeat schedule</summary>
            <p>{maintenance.schedule.everyMs ? `Every ${maintenance.schedule.everyMs / 60000} min. ` : ''}{maintenance.schedule.lastOutcome === 'unknown' ? 'Last delivery unconfirmed; its original request is retained.' : maintenance.schedule.lastOutcome === 'sent' ? 'Last delivery confirmed; task completion is tracked separately.' : maintenance.schedule.lastOutcome === 'skipped' ? 'Last check sent no input.' : 'No confirmed delivery yet.'}</p>
            <pre>{JSON.stringify(maintenance.schedule, null, 2)}</pre></details> : null}
          <button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Refresh actual schedule</button>
          {resumeRequest.current || maintenance?.schedule?.status === 'paused' && presence.enabled ? <button type="button" className="small-button" disabled={resuming}
            onClick={() => void resumeHeartbeat()}>{resuming ? 'Checking original schedule…' : resumeRequest.current ? 'Inspect original resume' : 'Resume saved heartbeat'}</button> : null}
        </fieldset>
        {!choices.length ? <p className="mote-details__hint">Start an original conversation in this Mote, then choose it here.</p> : null}
        {loading ? <p role="status" className="mote-details__hint">Reading MOTE.md…</p> : null}
        {issue ? <div role="status" className="mote-details__issue">{issue}<button className="small-button" type="button" onClick={() => setAttempt(value => value + 1)}>Reread</button></div> : null}
      </div>
      <footer className="mote-quick-mode-dialog__footer"><button className="icon-button" type="button" title="Inspect MOTE.md" aria-label="Inspect MOTE.md" onClick={() => void onOpenPath(scope.rootPath + '/' + MOTE_QUICK_MODE_PATH).then(opened => { if (opened) onClose() }).catch(cause => setIssue(presentError(cause)))}><ThemeFileTextIcon size={15} /></button><span>Saving sends no message.</span><button type="button" className="small-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={loading || busy || !saved || Boolean(saved.issue)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></footer>
    </Dialog.Content>
  </DocumentOverlayPortal></Dialog.Root>
}
