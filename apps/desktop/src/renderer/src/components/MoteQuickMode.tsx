import { useWorkbenchDocument } from '../lib/workbench-document'
import { sessionPresentationById } from '../lib/session-presentation'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useShallow } from 'zustand/react/shallow'
import { DEFAULT_MOTE_PRESENCE, mergeMoteQuickChoices, moteMinutesToMs, parseMotePreferencesSaveParams, sameMotePreferencesTarget, type MoteQuickChoices, type MotePresenceReading } from '@agentmux/core/mote-preferences'
import { MOTE_QUICK_MODE_PATH, type MoteQuickDefaults } from '@agentmux/host/mote-model'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { readMoteQuickDefaults, saveMoteQuickDefaults, adoptMoteHeartbeatGuidance, type SavedMoteQuickMode } from '../lib/mote-quick-mode'
import { checkpointLauncherState, useLauncherState } from '../lib/launcher-state'
import { restoredMoteQuickDraft } from '../lib/mote-quick-draft'
import type { MoteQuickPreferencesSaveParams } from '@agentmux/core/mote-preferences'
import { moteConversationChoices, moteConversationLabel, useMoteDefaultConversation } from '../lib/mote-quick-preferences'
import { spatialCatalog } from '../lib/space-agent-control'
import { executorsForHost } from '../lib/executors'
import { fileNavigationSelection, useAppStore } from '../store'
import { MoteBehaviorAction } from './MoteBehaviorDialog'
import { SelectionField } from './SelectionField'
import { AgentExecutorPicker } from './AgentExecutorPicker'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { api } from '../lib/api'
import { moteConnectionTarget } from '../lib/mote-connection-default'
import { useMoteSpace } from './MoteSpaceFrame'
import { MoteHeartbeatStatus } from './MoteHeartbeatStatus'
import { useMoteHeartbeatReading } from '../lib/mote-heartbeat-reading'
import { moteHeartbeatReadingMatchesSource } from '../lib/mote-heartbeat-presentation'
import { OriginalInputWaitingControl } from './OriginalInputWaitingControl'
import { originalInputExplanation } from '../lib/original-input-presentation'
import type { AgentInputSubmissionReceipt, AgentPromptSubmissionRecord } from '@agentmux/core'
import { agentPromptSubmissionOutcome } from '@agentmux/core/mote-dialogue'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import { sameMoteHeartbeatReference } from '../lib/mote-heartbeat-report'

const ThemeActionQuickModeIcon = semanticIconComponent('action.quick-mode')
const ThemeActionEditIcon = semanticIconComponent('action.edit')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')
const ThemeActionPinIcon = semanticIconComponent('action.pin')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeFileTextIcon = semanticIconComponent('file.text')


type ResumeRequest = { ownerHostId: string; scheduleId: string; expectedRevision: number; operationId: string }

export function MoteQuickMode({ scope, reference, onOpenPath, active }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined; active: boolean
  onOpenPath(path: string): Promise<unknown>
}) {
  const ownerDocument = useWorkbenchDocument()
  const [editing, setEditing] = useState(false), invoker = useRef<HTMLElement | null>(null)
  const saved = scope.topic.quickMode, defaults = saved?.status === 'saved' ? saved.defaults : {}
  const resolved = useMoteDefaultConversation(scope.topic, scope.workspace.id, active)
  const executorFacts = useAppStore(useShallow(state => ({ config: state.config, detections: state.executorDetections, inventory: state.hostExecutorInventories[scope.workspace.hostId] })))
  const executorLabel = useMemo(() => executorsForHost(executorFacts.config, scope.workspace.hostId, executorFacts.detections, executorFacts.inventory)
    .find(item => item.id === defaults.executorId)?.label ?? defaults.executorId, [executorFacts, scope.workspace.hostId, defaults.executorId])
  const conversationLabel = useAppStore(state => defaults.conversation ? moteConversationLabel(state, defaults.conversation) : undefined)
  const heartbeat = useMoteHeartbeatReading(scope, active)
  const edit = () => { invoker.current = ownerDocument.activeElement as HTMLElement; setEditing(true) }
  return <section className="mote-quick-mode" aria-label="Quick mode">
    <div className="mote-details__section-actions"><span><ThemeActionQuickModeIcon size={13} />Quick mode</span><MoteBehaviorAction label="Edit quick mode" onClick={edit}><ThemeActionEditIcon size={14} /></MoteBehaviorAction></div>
    <button className="mote-quick-mode__row" type="button" onClick={edit}><ThemeObjectAgentIcon size={14} /><span>Executor for new chat</span><strong title={defaults.executorId}>{executorLabel ?? 'Choose Executor'}</strong></button>
    <button className="mote-quick-mode__row" type="button" onClick={edit}><ThemeObjectConversationIcon size={14} /><span>Main Agent</span><strong title={defaults.conversation?.sessionId}>{conversationLabel ?? (defaults.conversation ? 'Saved main Agent' : 'Choose main Agent')}</strong>{defaults.conversation ? <ThemeActionPinIcon size={12} aria-label="Kept open" /> : null}</button>
    <MoteHeartbeatStatus scope={scope} reading={heartbeat.saved?.maintenance} reports={heartbeat.saved?.reports} onOpenPath={onOpenPath} loading={heartbeat.loading} unavailable={heartbeat.unavailable} issue={heartbeat.issue} visible={active} onRefresh={heartbeat.refresh}
      actions={<button type="button" className="small-button" onClick={edit}>Configure heartbeat</button>} />
    <button className="mote-quick-mode__row" type="button" onClick={edit}><ThemeObjectConversationIcon size={14} /><span>Conversation rollover</span><strong>{saved?.status !== 'saved' ? 'Unconfirmed' : defaults.conversationRollover?.kind === 'idle' ? `After ${defaults.conversationRollover.idleMs / 60000} min idle` : defaults.conversationRollover ? 'Keep current conversation' : 'Not configured'}</strong></button>
    {resolved.issue ? <p role="status" className="mote-details__issue">{resolved.issue}</p> : null}
    {editing ? <MoteQuickModeDialog key={scope.workspace.hostId + scope.topic.id + scope.rootPath} scope={scope} reference={reference} onOpenPath={onOpenPath}
      onClose={() => { setEditing(false); heartbeat.refresh() }} returnFocus={() => invoker.current?.isConnected ? invoker.current : null} /> : null}
  </section>
}

export function MoteQuickModeDialog({ scope, reference, onOpenPath, onClose, returnFocus, onContinue, focusHeartbeat = false, originalHeartbeat }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
  onOpenPath(path: string): Promise<unknown>; onClose(): void; returnFocus(): HTMLElement | null
  onContinue?: (() => void) | undefined
  focusHeartbeat?: boolean
  originalHeartbeat?: { ownerHostId: string; schedule: ContinuousProgressLoop } | undefined
}) {
  const ownerDocument = useWorkbenchDocument()
  const space = useMoteSpace()
  const liveHeartbeat = useMoteHeartbeatReading(scope, true)
  const draftKey = 'mote-quick:' + JSON.stringify(moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings) ?? [scope.workspace.hostId, scope.workspace.path, scope.topic.id])
  const pendingRequest = useLauncherState(state => state.drafts[draftKey]?.moteQuick?.pending)
  const retained = originalHeartbeat ? undefined : useLauncherState.getState().drafts[draftKey]?.moteQuick
  const restored = useRef(restoredMoteQuickDraft(retained))
  const draftRestoreIssue = useRef(Boolean(retained && !restored.current)).current
  const [saved, setSaved] = useState<SavedMoteQuickMode | null>(null), [draft, setDraft] = useState<MoteQuickDefaults>(() => restored.current?.draft ?? (scope.topic.quickMode?.status === 'saved' ? scope.topic.quickMode.defaults : {}))
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null), [attempt, setAttempt] = useState(0)
  const [minutes, setMinutes] = useState(restored.current?.minutes ?? String((draft.presence ?? DEFAULT_MOTE_PRESENCE).intervalMs / 60000))
  const [rolloverKind, setRolloverKind] = useState<'keep-current' | 'idle'>(restored.current?.rolloverKind ?? draft.conversationRollover?.kind ?? 'keep-current')
  const [rolloverMinutes, setRolloverMinutes] = useState(restored.current?.rolloverMinutes ?? (draft.conversationRollover?.kind === 'idle' ? String(draft.conversationRollover.idleMs / 60000) : ''))
  const presence = draft.presence ?? DEFAULT_MOTE_PRESENCE
  const [originalSchedule, setOriginalSchedule] = useState(originalHeartbeat?.schedule)
  const [originalSafeInput, setOriginalSafeInput] = useState<MotePresenceReading['input']>()
  const liveMaintenance = liveHeartbeat.saved?.maintenance
  const maintenance: MotePresenceReading | undefined = originalSchedule ? { status: originalSchedule.status === 'active' ? 'active' : 'paused', schedule: originalSchedule, issue: null, ...(originalSafeInput ? { input: originalSafeInput } : {}) }
    : saved?.maintenance?.schedule?.loopId === liveMaintenance?.schedule?.loopId && !liveHeartbeat.unavailable ? liveMaintenance : saved?.maintenance
  const resumeRequest = useRef<ResumeRequest | null>(restored.current?.resume ?? null)
  const [resuming, setResuming] = useState(false)
  const [inputReading, setInputReading] = useState<{ identity: string; hostId: string; input: AgentInputSubmissionReceipt | null; record: AgentPromptSubmissionRecord | null }>()
  const inputIdentity = (schedule: NonNullable<MotePresenceReading['schedule']>) => JSON.stringify([schedule.loopId, schedule.hostId, schedule.agentSessionId,
    schedule.providerId, schedule.workspacePath, schedule.revision, schedule.managedSource?.sourceId, schedule.managedSource?.revision, schedule.pause?.episodeId, schedule.lastTickId,
    schedule.pendingCompletion?.operationId ?? null, schedule.pendingCompletion?.condition?.expectedRun.runId ?? null, schedule.lastInputRef ?? null])
  const originalInput = maintenance?.schedule && inputReading?.identity === inputIdentity(maintenance.schedule) ? inputReading : undefined
  const checkedMissingKey = !originalHeartbeat && originalInput !== undefined && maintenance?.schedule?.status === 'paused' &&
    maintenance.schedule.lastOutcome === 'unknown' && !maintenance.schedule.pendingCompletion && !maintenance.schedule.lastInputRef && moteHeartbeatReadingMatchesSource(saved)
  const form = useRef(draft); form.current = draft
  const edited = useRef(Boolean(restored.current)), lifetime = useRef<object>({}), content = useRef<HTMLDivElement>(null), id = useId()
  const latestDraft = useRef({ draft, minutes, rolloverKind, rolloverMinutes, saved, accepted: false })
  latestDraft.current = { ...latestDraft.current, draft, minutes, rolloverKind, rolloverMinutes, saved }
  function retainDraft(input?: MoteQuickPreferencesSaveParams, phase: 'not-dispatched' | 'may-have-dispatched' = 'may-have-dispatched') {
    if (originalHeartbeat || draftRestoreIssue) return
    const current = latestDraft.current
    const held = useLauncherState.getState().drafts[draftKey]?.moteQuick?.pending
    const requested = input && parseMotePreferencesSaveParams(input) as MoteQuickPreferencesSaveParams | undefined
    if (requested && held && JSON.stringify(requested) !== JSON.stringify(held.input) ||
      requested && phase === 'may-have-dispatched' && !held)
      throw Error('The original settings request changed. Its complete input and your later draft are kept.')
    const pending = requested ? { input: requested, phase } : held
    if (!useLauncherState.getState().setMoteQuickDraft(draftKey, { draft: current.draft, minutes: current.minutes,
      rolloverKind: current.rolloverKind, rolloverMinutes: current.rolloverMinutes, ...(pending ? { pending } : {}),
      ...(resumeRequest.current ? { resume: resumeRequest.current } : {}) })) throw Error('Your original settings input could not be retained. No new request was sent.')
  }
  function syncRequest() {
    const pending = useLauncherState.getState().drafts[draftKey]?.moteQuick?.pending?.input
    const target = moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings)
    if (pending && (!target || !sameMotePreferencesTarget(pending.target, target))) throw Error('The retained request belongs to another original Mote resource. Its input and your draft are kept.')
    if (saved) { if (pending) saved.pending = pending; else delete saved.pending }
    return pending
  }
  async function settleRequest(operationId: string | undefined, clearDraft = false) {
    const held = useLauncherState.getState().drafts[draftKey]?.moteQuick
    if (!operationId || held?.pending?.input.operationId !== operationId) return
    const { pending: _pending, ...draft } = held
    useLauncherState.getState().setMoteQuickDraft(draftKey, clearDraft && !draft.resume ? undefined : draft)
    await checkpointLauncherState()
  }
  async function retainRequest(input: MoteQuickPreferencesSaveParams, epoch: object) {
    if (lifetime.current !== epoch) throw Error('The original view changed. Its retained request and later draft are kept.')
    retainDraft(input, 'not-dispatched'); await checkpointLauncherState()
    if (lifetime.current !== epoch) throw Error('The original view changed. Its retained request and later draft are kept.')
    retainDraft(input, 'may-have-dispatched'); await checkpointLauncherState()
    if (lifetime.current !== epoch) throw Error('The original view changed. Its retained request and later draft are kept.')
  }
  useLayoutEffect(() => {
    if (!originalHeartbeat && !latestDraft.current.accepted && (edited.current || saved?.pending || resumeRequest.current)) {
      try { retainDraft() } catch (error) { setIssue(presentError(error)) }
    }
  }, [draftKey, draft, minutes, rolloverKind, rolloverMinutes, saved, busy])
  const facts = useAppStore(useShallow(state => ({ tabs: state.tabs, layouts: state.layouts, config: state.config, snapshots: state.scratchTopicSnapshots,
    bindings: state.spaceZoneBindings, categories: state.topicCategories })))
  const ownAgentIds = useMemo(() => [...new Set(Object.values(facts.tabs).filter(tab => tab.workspaceId === scope.workspace.id)
    .flatMap(tab => Object.values(tab.regions).flatMap(region => region.kind === 'agent' ? [region.sessionId] : [])))], [facts.tabs, scope.workspace.id])
  const execution = useAppStore(useShallow(state => Object.fromEntries(ownAgentIds.map(id => {
    const session = sessionPresentationById(state.sessions).get(id)
    return [id, session ? JSON.stringify([session.hostId, session.control.hostId, session.control.kind === 'agent' ? session.control.agentSessionId : null]) : null]
  }))))
  const choices = useMemo(() => moteConversationChoices(useAppStore.getState(), scope.topic, scope.workspace.id,
    spatialCatalog(useAppStore.getState(), [scope.topic])), [facts.tabs, facts.layouts, facts.config, facts.snapshots, facts.bindings, facts.categories, execution, scope.topic, scope.workspace.id])
  const executors = (saved?.choices?.executors ?? []).map(executor => ({ id: executor.id, label: executor.name, providerId: executor.providerId }))
  const conversationLabels = useAppStore(useShallow(state => Object.fromEntries(choices.map(choice => [choice.sessionId,
    moteConversationLabel(state, choice) ?? choice.sessionId]))))
  useLayoutEffect(() => {
    const epoch = {}; lifetime.current = epoch
    const navigation = fileNavigationSelection(useAppStore.getState()); let moved = false
    const unsubscribe = useAppStore.subscribe(state => { if (fileNavigationSelection(state) !== navigation) moved = true })
    setLoading(true); setIssue(null)
    if (originalHeartbeat) {
      void api.schedule.inspect({ scheduleId: originalHeartbeat.schedule.loopId }, originalHeartbeat.ownerHostId).then(result => {
        if (lifetime.current !== epoch) return
        if (!result.schedule || result.schedule.loopId !== originalHeartbeat.schedule.loopId) throw Error('The original reminder’s arrangement is unconfirmed. Its identity and retained input are kept.')
        if (originalInspectionChanged(result.schedule)) setIssue('The owner now reports a different pause or input. This reminder keeps its original input for inspection; your current heartbeat is separate.')
        else { setOriginalSchedule(result.schedule); if (sameMoteHeartbeatReference(result.input?.reference, originalHeartbeat.schedule.lastInputRef)) setOriginalSafeInput(result.input) }
      }).catch(cause => { if (lifetime.current === epoch) setIssue(presentError(cause)) })
        .finally(() => { unsubscribe(); if (lifetime.current === epoch) setLoading(false) })
      return () => { lifetime.current = {}; unsubscribe() }
    }
    void readMoteQuickDefaults(scope, false).then(source => {
      if (lifetime.current !== epoch) return
      setSaved(previous => { const pending = previous?.pending ?? restored.current?.pending?.input; return pending ? { ...source, pending } : source })
      if (moved) throw new Error('Your selection changed during the read. Your choices are kept; reread the settings.')
      if (source.issue) setIssue(source.issue)
      else if (!edited.current) {
        form.current = source.defaults; setDraft(source.defaults); setMinutes(String((source.defaults.presence ?? DEFAULT_MOTE_PRESENCE).intervalMs / 60000))
        setRolloverKind(source.defaults.conversationRollover?.kind ?? 'keep-current')
        setRolloverMinutes(source.defaults.conversationRollover?.kind === 'idle' ? String(source.defaults.conversationRollover.idleMs / 60000) : '')
      }
      if (!source.issue) for (const selected of ['executors', 'locations'] as const) void readMoteQuickDefaults(scope, selected).then(discovery => {
        if (lifetime.current !== epoch) return
        if (discovery.issue || !discovery.choices) throw new Error(discovery.issue ?? 'The original choices are unconfirmed. Reread this Mote’s settings.')
        setSaved(previous => previous && previous.source?.resource && source.source?.resource &&
          JSON.stringify(previous.source.resource) === JSON.stringify(source.source.resource)
          ? { ...previous, choices: mergeMoteQuickChoices(previous.choices, discovery.choices!) } : previous)
      }).catch(cause => {
        const failure: MoteQuickChoices = { executors: selected === 'executors' ? [] : null, conversations: selected === 'locations' ? [] : null,
          destinations: selected === 'locations' ? [] : null, issues: { [selected]: presentError(cause) } }
        if (lifetime.current === epoch) setSaved(previous => previous ? { ...previous, choices: mergeMoteQuickChoices(previous.choices, failure) } : previous)
      })
    }).catch(cause => { if (lifetime.current === epoch) { setSaved(previous => previous?.pending ? previous : null); setIssue(presentError(cause)) } })
      .finally(() => { unsubscribe(); if (lifetime.current === epoch) setLoading(false) })
    return () => { lifetime.current = {}; unsubscribe() }
  }, [attempt])
  const update = (next: MoteQuickDefaults) => { edited.current = true; form.current = next; setDraft(next) }
  function editRollover(kind: 'keep-current' | 'idle', value: string) {
    edited.current = true; setRolloverKind(kind); setRolloverMinutes(value); setIssue(null)
    if (kind === 'keep-current') update({ ...form.current, conversationRollover: { kind } })
    else if (moteMinutesToMs(value) !== null) update({ ...form.current, conversationRollover: { kind, idleMs: moteMinutesToMs(value)! } })
    else update({ ...form.current }) // Raw edits also fence a late save from closing this later draft.
  }
  const selected = draft.conversation ? JSON.stringify(draft.conversation) : ''
  const hasSelected = choices.some(choice => JSON.stringify(choice) === selected)
  function originalInspectionChanged(record: ContinuousProgressLoop) {
    const original = originalHeartbeat!.schedule
    if (record.loopId !== original.loopId || (['hostId', 'agentSessionId', 'providerId', 'workspacePath'] as const).some(field => record[field] !== original[field]))
      throw Error('The original heartbeat target is unconfirmed. Its reminder and original input are kept.')
    return record.pause?.episodeId !== original.pause?.episodeId || record.pendingCompletion?.operationId !== original.pendingCompletion?.operationId ||
      record.pendingCompletion?.condition?.expectedRun.runId !== original.pendingCompletion?.condition?.expectedRun.runId ||
      record.managedSource?.sourceId !== original.managedSource?.sourceId || record.managedSource?.revision !== original.managedSource?.revision || !sameMoteHeartbeatReference(record.lastInputRef, original.lastInputRef)
  }
  async function confirmCurrentHeartbeat(schedule: ContinuousProgressLoop, ownerHostId: string) {
    const current = await readMoteQuickDefaults(scope, false), record = current.maintenance?.schedule
    const resource = current.source?.resource, originalResource = saved?.source?.resource
    if (current.issue || !record || !moteHeartbeatReadingMatchesSource(current) || inputIdentity(record) !== inputIdentity(schedule) ||
        !resource || !originalResource || resource.hostId !== ownerHostId ||
        (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path'] as const).some(field => resource[field] !== originalResource[field]))
      throw Error('This Mote’s main role or original heartbeat changed. Your original input is kept. Refresh the current settings before resuming.')
  }
  async function resumeHeartbeat() {
    if (resuming) return
    const schedule = saved?.maintenance?.schedule, ownerHostId = saved?.source?.resource?.hostId
    if (!resumeRequest.current && (!schedule || !ownerHostId || !Number.isSafeInteger(schedule.revision))) return
    const existing = resumeRequest.current
    const original = existing ?? { ownerHostId: ownerHostId!, scheduleId: schedule!.loopId, expectedRevision: schedule!.revision!, operationId: crypto.randomUUID() }
    const epoch = lifetime.current
    let dispatched = Boolean(existing)
    setResuming(true); setIssue(null)
    try {
      if (!existing) await confirmCurrentHeartbeat(schedule!, original.ownerHostId)
      if (lifetime.current !== epoch) return
      const { ownerHostId, ...input } = original
      resumeRequest.current = original
      retainDraft(); await checkpointLauncherState()
      if (lifetime.current !== epoch) return
      dispatched = true
      const result = existing ? await api.schedule.inspect({ operationId: input.operationId }, ownerHostId) : await api.schedule.resume(input, ownerHostId)
      if (lifetime.current !== epoch) return
      if (!result.schedule || result.schedule.loopId !== original.scheduleId) throw new Error('The original resume is unconfirmed. Its request is kept; inspect it again.')
      resumeRequest.current = null
      retainDraft()
      setSaved(previous => previous ? { ...previous, maintenance: { status: result.schedule!.status === 'active' ? 'active' : 'paused', schedule: result.schedule, issue: null } } : previous)
    } catch (cause) {
      if (!dispatched && lifetime.current === epoch) setInputReading(undefined)
      if (lifetime.current === epoch) setIssue(presentError(cause))
    }
    finally { if (lifetime.current === epoch) setResuming(false) }
  }
  async function inspectHeartbeat() {
    const schedule = maintenance?.schedule, ownerHostId = originalHeartbeat?.ownerHostId ?? saved?.source?.resource?.hostId, epoch = lifetime.current
    if (!schedule || !ownerHostId || resuming) return
    if (!originalHeartbeat) setInputReading(undefined)
    setResuming(true); setIssue(null)
    try {
      if (!originalHeartbeat) await confirmCurrentHeartbeat(schedule, ownerHostId)
      if (lifetime.current !== epoch) return
      const result = await api.schedule.inspect({ scheduleId: schedule.loopId }, ownerHostId)
      if (!result.schedule || result.schedule.loopId !== schedule.loopId) throw Error('The original schedule is unconfirmed. Its identity and input are kept.')
      if (!originalHeartbeat && inputIdentity(result.schedule) !== inputIdentity(schedule)) throw Error('The original heartbeat changed during inspection. Refresh its current settings; the earlier input remains kept.')
      const changed = originalHeartbeat ? originalInspectionChanged(result.schedule) : false
      const pending = originalHeartbeat ? originalHeartbeat.schedule.pendingCompletion : result.schedule.pendingCompletion
      const control = pending?.condition ? { kind: 'agent' as const, hostId: schedule.hostId, agentSessionId: schedule.agentSessionId, run: pending.condition.expectedRun } : null
      const key = pending?.condition ? { kind: 'prompt' as const, agentSessionId: schedule.agentSessionId, expectedRun: pending.condition.expectedRun, submissionId: pending.operationId } : null
      const [input, record] = control && key && !schedule.lastInputRef ? await Promise.all([api.sessions.inspectInput(control, key), api.sessions.inspectSubmission(control, key)]) : [null, null]
      if (lifetime.current !== epoch) return
      setInputReading({ identity: inputIdentity(originalHeartbeat?.schedule ?? result.schedule), hostId: schedule.hostId, input, record })
      if (originalHeartbeat && changed) setIssue('The owner now reports a different pause or input. This reminder keeps its original input for inspection; your current heartbeat is separate.')
      else if (originalHeartbeat) { setOriginalSchedule(result.schedule); if (sameMoteHeartbeatReference(result.input?.reference, originalHeartbeat.schedule.lastInputRef)) setOriginalSafeInput(result.input) }
      else setSaved(previous => previous ? { ...previous, maintenance: { status: result.schedule!.status === 'active' ? 'active' : 'paused', schedule: result.schedule!, ...(result.input ? { input: result.input } : {}), issue: previous.maintenance?.issue ?? null } } : previous)
    } catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
    finally { if (lifetime.current === epoch) setResuming(false) }
  }
  const continueToConversation = onContinue ?? (space?.topicId === scope.topic.id ? () => space.select('discussion') : undefined)
  const firstConversation = !draft.conversation && Boolean(draft.executorId) && Boolean(continueToConversation)
  async function save() {
    if (busy || !saved || draftRestoreIssue) return
    const checking = useLauncherState.getState().drafts[draftKey]?.moteQuick?.pending
    if (!checking && moteMinutesToMs(minutes, { wholeMinutes: true }) === null) {
      setIssue('Enter a whole number of minutes, at least 1. Your choices and original settings are kept.'); return
    }
    if (!checking && rolloverKind === 'idle' && moteMinutesToMs(rolloverMinutes) === null) {
      setIssue('Enter a positive number of minutes for inactivity, such as 20 or 1.5. Your draft and original settings are kept.'); return
    }
    const submitted = form.current, epoch = lifetime.current
    const current = () => lifetime.current === epoch && form.current === submitted
    let operationId: string | undefined, preserveDraft = false
    setBusy(true); setIssue(null)
    try {
      const pending = syncRequest(); operationId = pending?.operationId
      preserveDraft = Boolean(pending && (JSON.stringify(pending.values) !== JSON.stringify(submitted) ||
        minutes !== String((pending.values.presence ?? DEFAULT_MOTE_PRESENCE).intervalMs / 60000) ||
        rolloverKind !== (pending.values.conversationRollover?.kind ?? 'keep-current') ||
        rolloverMinutes !== (pending.values.conversationRollover?.kind === 'idle' ? String(pending.values.conversationRollover.idleMs / 60000) : '')))
      const write = await saveMoteQuickDefaults(scope, pending?.values ?? submitted, saved, onOpenPath, current, reference, undefined, async input => { operationId = input.operationId; await retainRequest(input, epoch) })
      await settleRequest(operationId, current() && !preserveDraft)
      if (current() && !preserveDraft) { latestDraft.current.accepted = true; onClose(); if (firstConversation) continueToConversation?.() }
      else if (lifetime.current === epoch) setSaved({ ...saved, document: write.source.document, defaults: write.source.defaults,
        source: { resource: write.source.resource, result: write.source.document ? { status: 'read', document: write.source.document } : { status: 'deleted' } } })
    }
    catch (cause) { if (!saved.pending) restored.current = undefined; if (lifetime.current === epoch) setIssue(presentError(cause)) }
    finally {
      try { if (!saved.pending) await settleRequest(operationId) }
      catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
      finally { if (lifetime.current === epoch) setBusy(false) }
    }
  }
  async function adopt() {
    if (!saved || busy || originalHeartbeat || draftRestoreIssue) return
    const epoch = lifetime.current
    let operationId: string | undefined
    setBusy(true); setIssue(null)
    try {
      operationId = syncRequest()?.operationId
      await adoptMoteHeartbeatGuidance(scope, saved, () => lifetime.current === epoch, async input => { operationId = input.operationId; await retainRequest(input, epoch) })
      await settleRequest(operationId)
      if (lifetime.current !== epoch) return
      restored.current = undefined
      retainDraft(); await checkpointLauncherState()
      if (lifetime.current === epoch) setAttempt(value => value + 1)
    } catch (error) { if (lifetime.current === epoch) { if (!saved.pending) restored.current = undefined; retainDraft(); setIssue(presentError(error)) } }
    finally {
      try { if (!saved.pending) await settleRequest(operationId) }
      catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
      finally { if (lifetime.current === epoch) setBusy(false) }
    }
  }
  const guidance = saved?.maintenance?.guidance
  const heartbeat = (
        <fieldset tabIndex={-1} className="mote-quick-mode__presence mote-quick-mode__heartbeat"><legend hidden>Heartbeat</legend>
          <MoteHeartbeatStatus scope={scope} reading={maintenance} reports={liveHeartbeat.saved?.reports} onOpenPath={onOpenPath} unavailable={originalHeartbeat ? loading || Boolean(issue) : !moteHeartbeatReadingMatchesSource(saved)} loading={loading} onRefresh={() => { liveHeartbeat.refresh(); setAttempt(value => value + 1) }} controlsAfterStatus={focusHeartbeat}
            actions={<>{!originalHeartbeat && pendingRequest?.input.action ? <button type="button" className="primary-button" disabled={busy || loading} onClick={() => void adopt()}>Check original adoption</button> : null}{!originalHeartbeat && resumeRequest.current ? <button type="button" className="small-button" disabled={resuming} onClick={() => void resumeHeartbeat()}>{resuming ? 'Checking original schedule…' : 'Inspect original resume'}</button>
              : maintenance?.schedule?.lastOutcome === 'unknown' ? <>{!checkedMissingKey ? <button type="button" className="primary-button" disabled={resuming} onClick={() => void inspectHeartbeat()}>{resuming ? 'Checking…' : 'Check original delivery'}</button> : null}
                {checkedMissingKey ? <div className="mote-heartbeat__issue" role="status"><p>Its earlier delivery remains unknown. Resuming can send a due check immediately.</p>
                  {presence.enabled ? <button type="button" className="primary-button" disabled={resuming} onClick={() => void resumeHeartbeat()}>Resume future checks</button> : null}</div> : null}</>
              : originalHeartbeat ? <button type="button" className="small-button" disabled={resuming} onClick={() => void inspectHeartbeat()}>Inspect original arrangement</button>
              : resumeRequest.current || maintenance?.schedule?.status === 'paused' && presence.enabled ? <button type="button" className="small-button" disabled={resuming}
                onClick={() => void resumeHeartbeat()}>{resuming ? 'Checking original schedule…' : resumeRequest.current ? 'Inspect original resume' : 'Resume saved heartbeat'}</button> : null}</>}
            detailsActions={<>{originalInput && !originalInput.input && !originalInput.record ? <p>The original input was not observed in this read. That does not prove it was never sent.</p> : originalInput?.input ? <><p>{originalInputExplanation(originalInput.input.status, originalInput.input.control.waiting).title}</p>{!originalHeartbeat ? <OriginalInputWaitingControl hostId={originalInput.hostId} receipt={originalInput.input} onRefresh={inspectHeartbeat} /> : null}</> : originalInput?.record ? <p>{originalInputExplanation(agentPromptSubmissionOutcome(originalInput.record)).title}</p> : null}
              {originalInput?.record ? <p>{originalInput.record.semanticIdle ? 'The original input returned idle. This does not confirm completed work.' : 'Native processing is not confirmed by this receipt.'}</p> : null}
              {!originalHeartbeat && !pendingRequest?.input.action && guidance?.adoptedRevision !== guidance?.availableRevision && guidance ? <div className="mote-heartbeat__guidance"><p>Updated care guidance is available for future checks. Your interval, paused choice and retained input stay as they are.</p><button type="button" className="small-button" disabled={busy || loading} onClick={() => void adopt()}>Use updated guidance</button></div> : null}
              {!originalHeartbeat && !checkedMissingKey && maintenance?.schedule?.lastOutcome === 'unknown' && presence.enabled ? <><p>Resuming can send a due check immediately. It preserves any retained original input and does not confirm whether an earlier unknown delivery was sent.</p><button type="button" className="small-button" disabled={resuming} onClick={() => void resumeHeartbeat()}>{resumeRequest.current ? 'Inspect original resume' : 'Resume saved heartbeat'}</button></> : null}</>}
            controls={originalHeartbeat ? undefined : <><div className="mote-quick-mode__care-settings"><label><input type="checkbox" aria-label="Enable automatic Mote maintenance" checked={presence.enabled}
            onChange={event => update({ ...form.current, presence: { ...presence, enabled: event.target.checked } })} />Automatic care</label>
          <label className="mote-quick-mode__interval" htmlFor={id + '-interval'}>Every
          <input id={id + '-interval'} aria-label="Heartbeat interval (minutes)" type="number" inputMode="numeric" min="1" step="1" value={minutes}
            onChange={event => { const value = event.target.value; setMinutes(value); edited.current = true
              const intervalMs = moteMinutesToMs(value, { wholeMinutes: true })
              if (intervalMs !== null) update({ ...form.current, presence: { ...presence, intervalMs } })
              else update({ ...form.current })
            }} /> min</label></div><p className="mote-details__hint">Default 30 min · applies after Save. A paused heartbeat stays paused.</p></>} />
        </fieldset>
  )
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><DocumentOverlayPortal component={Dialog.Portal}>
    <Dialog.Overlay className="dialog-scrim mote-behavior-overlay" />
    <Dialog.Content ref={content} className="dialog-surface mote-quick-mode-dialog" aria-busy={busy}
      onOpenAutoFocus={event => { event.preventDefault(); content.current?.querySelector<HTMLElement>(focusHeartbeat ? '.mote-quick-mode__heartbeat' : '.selection-field')?.focus() }}
      onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus(), active = ownerDocument.activeElement
        if (node?.isConnected && (active === ownerDocument.body || active === node || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}>
      <header className="mote-behavior-header"><div><Dialog.Title>{originalHeartbeat ? 'Original heartbeat' : focusHeartbeat ? 'Automatic care' : 'Quick mode'}</Dialog.Title><Dialog.Description>{scope.topic.title} · {originalHeartbeat ? 'The exact arrangement from this reminder' : loading ? 'Reading saved settings' : !saved ? 'Saved settings unconfirmed' : 'Saved settings loaded'}</Dialog.Description></div><MoteBehaviorAction label="Close quick mode" onClick={onClose}><ThemeActionCloseIcon size={16} /></MoteBehaviorAction></header>
      <div className="mote-quick-mode-dialog__body">
        {focusHeartbeat || originalHeartbeat ? heartbeat : null}
        {!originalHeartbeat ? <>
        <label htmlFor={id + '-agent'}><ThemeObjectAgentIcon size={16} /><span>Executor for new chat<small>Preselected for new conversations.</small></span></label>
        <AgentExecutorPicker presentation="field" id={id + '-agent'} label="Executor for new chat"
          selected={draft.executorId ?? null} executors={executors} unsetLabel="Use normal Launcher choice"
          onSelect={value => { const { executorId: _, ...rest } = form.current; update(value ? { ...rest, executorId: value } : rest) }} />
        {!choices.length && !selected ? <p className="mote-quick-mode__welcome">Choose an Executor, then save and continue. Your first message will create the main Agent for this Mote.</p> : <>
        <label htmlFor={id + '-conversation'}><ThemeActionPinIcon size={16} /><span>Main Agent<small>Your usual contact. Coordinates work with the other Agents.</small></span></label>
        <SelectionField id={id + '-conversation'} label="Main Agent" value={selected}
          onValueChange={value => { const { conversation: _, ...rest } = form.current; const choice = choices.find(choice => JSON.stringify(choice) === value); if (value && !choice) { setIssue('The chosen conversation is no longer confirmed. Your choices are kept.'); return } update(choice ? { ...rest, conversation: choice } : rest) }}
          options={[{ value: '', label: 'No main Agent yet' }, ...(selected && !hasSelected ? [{ value: selected, label: 'Saved location · unconfirmed' }] : []),
            ...choices.map(choice => ({ value: JSON.stringify(choice), label: facts.tabs[choice.tabId]?.name?.trim() || conversationLabels[choice.sessionId] || choice.sessionId, description: `${conversationLabels[choice.sessionId]} · ${choice.hostId} / ${choice.sessionId} · ${facts.config?.workspaces.find(item => item.id === choice.displayWorkspaceId)?.name ?? 'Workspace'} / ${1 + (facts.layouts[choice.displayWorkspaceId]?.groups.findIndex(group => group.id === choice.groupId) ?? -1)}` }))]} />
        </>}
        {!focusHeartbeat ? heartbeat : null}
        <details className="mote-quick-mode__advanced"><summary>Conversation settings</summary>
        <fieldset className="mote-quick-mode__presence"><legend>Conversation rollover</legend>
          <label htmlFor={id + '-rollover'}>Automatic rollover policy</label>
          <SelectionField id={id + '-rollover'} label="Automatic rollover policy" value={rolloverKind}
            onValueChange={value => editRollover(value as 'keep-current' | 'idle', rolloverMinutes)}
            options={[{ value: 'keep-current', label: 'Keep current conversation' }, { value: 'idle', label: 'After conversation inactivity' }]} />
          {rolloverKind === 'idle' ? <><label htmlFor={id + '-rollover-duration'}>Conversation inactivity <small>Minutes</small></label>
            <input id={id + '-rollover-duration'} aria-label="Conversation inactivity (minutes)" type="number" inputMode="decimal" min="0" step="any" value={rolloverMinutes}
              onChange={event => editRollover('idle', event.target.value)} /></> : null}
          <p className="mote-details__hint">Changes take effect only after Save. Once the conversation has been idle long enough, your next new question starts a new round. Previous conversations stay available. Saving sends no message and does not switch the main Agent now.</p>
          {loading || !saved || saved.issue ? <p className="mote-details__hint">The saved rollover policy is unconfirmed. Your choices are kept.</p> : !saved.defaults.conversationRollover ? <p className="mote-details__hint">No rollover policy is configured. Editing other settings keeps the existing handoff behavior.</p> : null}
        </fieldset>
        </details>
        </> : null}
        {loading ? <p role="status" className="mote-details__hint">{originalHeartbeat ? 'Reading the original arrangement…' : 'Reading MOTE.md…'}</p> : null}
        {!loading && saved && !saved.issue && (!saved.choices || saved.choices.executors === null || saved.choices.destinations === null) ? <p role="status" className="mote-details__hint">Reading the remaining choices. Your saved settings can still be edited.</p> : null}
        {saved?.choices?.issues ? <div role="status" className="mote-details__issue">{Object.values(saved.choices.issues).join(' ')}<button className="small-button" type="button" onClick={() => setAttempt(value => value + 1)}>Reread choices</button></div> : null}
        {draftRestoreIssue ? <p role="status" className="mote-details__issue">The saved original request could not be decoded. Its stored input and your Agent are kept; no replacement request will be sent.</p> : null}
        {issue ? <div role="status" className="mote-details__issue">{issue}<button className="small-button" type="button" onClick={() => setAttempt(value => value + 1)}>Reread</button></div> : null}
      </div>
      <footer className="mote-quick-mode-dialog__footer">{originalHeartbeat ? <><span>Reviewing this original heartbeat keeps your current chat.</span><button type="button" className="small-button" onClick={onClose}>Close</button></> : <><button className="icon-button" type="button" title="Inspect MOTE.md" aria-label="Inspect MOTE.md" onClick={() => void onOpenPath(scope.rootPath + '/' + MOTE_QUICK_MODE_PATH).then(opened => { if (opened) onClose() }).catch(cause => setIssue(presentError(cause)))}><ThemeFileTextIcon size={15} /></button><span>Saving sends no message.</span><button type="button" className="small-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={loading || busy || !saved || Boolean(saved.issue) || Boolean(pendingRequest?.input.action) || draftRestoreIssue} onClick={() => void save()}>{busy ? 'Saving…' : pendingRequest ? 'Check original save' : firstConversation ? 'Save and continue' : 'Save'}</button></>}</footer>
    </Dialog.Content>
  </DocumentOverlayPortal></Dialog.Root>
}
