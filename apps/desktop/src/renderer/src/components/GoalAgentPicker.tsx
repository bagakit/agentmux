import type { GoalRelationAccess } from '@agentmux/core/control'
import { Button } from '@agentmux/client-ui/components/Button'
import { GoalRelationAccessFields } from './GoalRelationAccessFields'
import { demandAgentReferenceKey, mergeDemandAgentReferences, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import { mintObjectId } from '@agentmux/core/object-id'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SearchInput } from '@agentmux/client-ui/input'
import { MoteIcon } from '@agentmux/client-ui/components/MoteIcon'
import { SegmentedControl } from '@agentmux/client-ui/components/SegmentedControl'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { clearGoalAgentCreationDraft, clearGoalAgentSelectionDraft, retainGoalAgentCreationDraft, retainGoalAgentSelectionDraft, useAppStore } from '../store'
import type { LauncherSourceExecution } from '../lib/launcher-source'
import type { DemandRecord } from '../lib/global-demand-board'
import { addedGoalSourceReferences, goalAgentRows, goalAgentRowReference, goalAgentSelectionKey, goalCreationDraftKey, readGoalAgentCreationDraft, readGoalAgentSelectionDraft, type GoalAgentCreationDraft, type GoalAgentSelectionDraft, type GoalAgentRole, type GoalAgentRow } from '../lib/goal-agent-selection'
import { moteDefaultExecutor } from '../lib/mote-quick-preferences'
import { scratchTopicKind, scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { scratchTopicIdentityPath } from '@agentmux/host/mote-model'
import { directoryIdentity, homeZoneId } from '../../../shared/space-addresses'
import { AgentAvatar } from './AgentAvatar'
import { GoalSourceCreation } from './GoalSourceCreation'
import type { GoalSourceCreationDraft } from '../lib/goal-source-creation-draft'
import { AgentWorkModeBadge } from './AgentWorkModeBadge'
import { SelectionField } from './SelectionField'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useWorkbenchDocument } from '../lib/workbench-document'

const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeActionCreateAgentIcon = semanticIconComponent('action.create-agent')


export type GoalRelationSave = (patch: Parameters<ReturnType<typeof useAppStore.getState>['updateDemand']>[1], expectedUpdatedAt: number, relationAccess?: GoalRelationAccess[]) => Promise<boolean>
const labels = { assignees: 'Assignees', related: 'Related sessions', supervisor: 'Supervisor' }
const agentSources = [
  { value: 'existing', label: 'Existing Agents' },
  { value: 'mote', label: 'Mote · new Session' },
  { value: 'agent', label: 'New Agent' }
] as const
export function GoalAgentFace({ row }: { row: GoalAgentRow }) {
  const avatar = useAppStore(state => row.session?.executorId ? state.config?.executors[row.session.executorId]?.avatar ?? state.config?.appearance.agentAvatars?.[row.session.executorId] : undefined)
  return <span inert aria-hidden="true" className="goal-agent-face"><AgentAvatar size={22} label={row.name} providerId={row.session?.providerId} state={row.session?.status.state} executorId={row.session?.executorId} appearance={avatar} visible={false} /></span>
}

/** One editor for explicit business relationships; creation uses the original spatial/Core owner. */
export function GoalAgentPicker({ demand, role, onSave, onClose }: { demand: DemandRecord; role: GoalAgentRole; onSave: GoalRelationSave; onClose(): void }) {
  const raw = useAppStore(state => state.goalAgentSelectionDrafts[goalCreationDraftKey(demand.id, role)])
  const saved = useMemo(() => readGoalAgentSelectionDraft(raw, demand.id, role), [raw, demand.id, role])
  if (raw !== undefined && !saved) return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" /><Dialog.Content className="confirmation-dialog dialog-surface goal-agent-picker"><Dialog.Title className="confirmation-dialog__title">Original selection retained</Dialog.Title><Dialog.Description>This version cannot read the original selection. Its saved bytes and other drafts remain intact; no relationship or Agent action was submitted.</Dialog.Description><details className="goal-team__identity-details"><summary>Original selection details</summary><code>{JSON.stringify(raw)}</code></details><footer><Button type="button" onClick={onClose}>Close</Button></footer></Dialog.Content></DocumentOverlayPortal></Dialog.Root>
  return <GoalAgentPickerEditor key={goalCreationDraftKey(demand.id, role)} demand={demand} role={role} saved={saved} onSave={onSave} onClose={onClose} />
}
function GoalAgentPickerEditor({ demand, role, saved, onSave, onClose }: { demand: DemandRecord; role: GoalAgentRole; saved: GoalAgentSelectionDraft | undefined; onSave: GoalRelationSave; onClose(): void }) {
  const document = useWorkbenchDocument()
  const state = useAppStore(useShallow(state => ({ sessions: state.sessions, config: state.config, agentNames: state.agentNames,
    timelines: state.timelines, scratchTopicSnapshots: state.scratchTopicSnapshots, hostExecutorInventories: state.hostExecutorInventories,
    executorDetections: state.executorDetections })))
  const creationRaw = useAppStore(state => state.goalAgentCreationDrafts[goalCreationDraftKey(demand.id, role)])
  const draft = readGoalAgentCreationDraft(creationRaw, demand.id, role)
  const initialSelection = useRef<GoalAgentSelectionDraft>(saved ?? {
    goalId: demand.id, role, selected: role === 'assignees' ? demand.assigneeSessionIds ?? [] : role === 'related' ? demand.sessionIds : demand.supervisorSessionId ? [demand.supervisorSessionId] : [], expectedUpdatedAt: demand.updatedAt })
  const [selection, setSelection] = useState(initialSelection.current)
  const { selected, expectedUpdatedAt, replacement } = selection
  const selectionRef = useRef(selection)
  function changeSelection(patch: Partial<GoalAgentSelectionDraft>) {
    const next = { ...selectionRef.current, ...patch }; selectionRef.current = next; setSelection(next)
    void retainGoalAgentSelectionDraft(next)
  }
  function addCreatedSession(id: string) { changeSelection({ selected: mergeDemandAgentReferences(selectionRef.current.selected, [id]) }); setMode('existing') }
  useEffect(() => { void retainGoalAgentSelectionDraft(initialSelection.current) }, [])
  const [query, setQuery] = useState(''), [mode, setMode] = useState<'existing' | 'mote' | 'agent'>(creationRaw !== undefined && !draft ? 'agent' : 'existing')
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const [report, setReport] = useState<AgentMuxSpaceMutationReport | null>(null)
  const previousFocus = useRef<HTMLElement | null>(null), openedContent = useRef<Element | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const creating = useRef<string | null>(null)
  const [moteId, setMoteId] = useState(''), [executorId, setExecutorId] = useState('')
  const [sourceSelection, setSourceSelection] = useState<LauncherSourceExecution>()
  const [completedSourceCreation, setCompletedSourceCreation] = useState<{ original: GoalSourceCreationDraft; reference: DemandSpaceMemberReference }>()
  const scratch = state.config?.workspaces.find(workspace => workspace.id === '__scratch__')
  const observed = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch)
  const motes = observed?.filter(topic => !topic.readError && scratchTopicKind(topic.id, observed) === 'mote') ?? []
  const rows = useMemo(() => goalAgentRows(state, demand, [...selected, ...(role === 'supervisor' ? demand.assigneeSessionIds ?? [] : [])]), [state, demand, selected, role])
    .filter(row => role !== 'supervisor' || (demand.assigneeSessionIds ?? []).some(ref => demandAgentReferenceKey(ref) === demandAgentReferenceKey(goalAgentRowReference(row))))
  const filtered = rows.filter(row => `${row.name} ${row.context} ${row.status} ${row.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const removingSupervisor = role === 'assignees' && demand.supervisorSessionId && !selected.some(ref => demandAgentReferenceKey(ref) === demandAgentReferenceKey(demand.supervisorSessionId!))
  const changed = expectedUpdatedAt !== demand.updatedAt

  function observe(result: AgentMuxSpaceMutationReport) {
    setReport(result)
    if (result.agent && result.agent.createOperationId === draft?.operationId) {
      const id = result.agent.agentSessionId
      addCreatedSession(id)
    }
  }
  async function inspectOriginal(original: GoalAgentCreationDraft) {
    setBusy(true); setIssue(null)
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: `goal-agent-inspect-${mintObjectId()}`, operation: 'space.inspect', target: { requestId: original.operationId } })
      if (result.operation !== 'space.inspect' || !result.request?.report) { setIssue('The original creation is not yet observed. Its operation is retained; check it again.'); return }
      observe(result.request.report)
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  useEffect(() => { if (draft?.phase === 'may-have-dispatched' && creating.current !== draft.operationId) void inspectOriginal(draft) }, [draft?.operationId, draft?.phase])

  async function createSession() {
    if (creating.current) return
    if (draft) { if (draft.phase === 'not-dispatched') await dispatchOriginal(draft); else await inspectOriginal(draft); return }
    const config = useAppStore.getState().config
    const mote = motes.find(topic => topic.id === moteId), selectedExecutorId = executorId
    if (!selectedExecutorId || !config?.executors[selectedExecutorId]) { setIssue('Choose a saved Mote configuration.'); return }
    if (!scratch || !mote) { setIssue('Choose a Mote from its original directory observation. Existing Agents remain available.'); return }
    const spaceId = directoryIdentity(scratch.hostId, scratchTopicIdentityPath(scratch, mote))
    const operationId = `goal-agent-create-${mintObjectId()}`
    const original: GoalAgentCreationDraft = { goalId: demand.id, role: role as 'assignees' | 'related', operationId, phase: 'not-dispatched',
      request: { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: operationId, operation: 'agent.open', focus: false,
        content: { kind: 'new-agent', executorId: selectedExecutorId },
        destination: { spaceId, zoneId: homeZoneId(spaceId), newTab: true } } }
    await dispatchOriginal(original)
  }
  async function dispatchOriginal(original: GoalAgentCreationDraft) {
    if (creating.current) return
    creating.current = original.operationId; setBusy(true); setIssue(null)
    try {
      const retained = await retainGoalAgentCreationDraft(original, creationRaw)
      if (!retained.clientStateWritten) { setIssue(`Creation has not been dispatched. Save the retained selection and create once: ${retained.reason ?? 'Save acknowledgement unavailable'}.`); return }
      // Persist the uncertainty boundary before the first and only dispatch. Restoring this phase only inspects.
      const dispatching = { ...original, phase: 'may-have-dispatched' as const }
      const dispatchSaved = await retainGoalAgentCreationDraft(dispatching, original)
      if (!dispatchSaved.clientStateWritten) {
        await retainGoalAgentCreationDraft({ ...original, phase: 'not-dispatched' }, dispatching)
        setIssue('Creation has not been dispatched. Saving the original selection failed; retry its first creation.'); return
      }
      const result = await useAppStore.getState().executeControl(original.request)
      if (result.operation !== 'agent.open') throw new Error('The original Agent creation returned another operation. Inspect the retained request.')
      setReport(result)
      if (result.agent?.createOperationId === original.operationId) addCreatedSession(result.agent.agentSessionId)
      else setIssue('Creation is unconfirmed. Check the retained original operation; the request will not be repeated.')
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { creating.current = null; setBusy(false) }
  }
  function relationshipPatch() {
    return role === 'supervisor' ? { supervisorSessionId: selected[0] ?? null }
      : role === 'related' ? { sessionIds: selected }
      : { assigneeSessionIds: selected, ...(removingSupervisor ? { supervisorSessionId: replacement || null } : {}) }
  }
  async function save() {
    if (removingSupervisor && replacement === undefined) { setIssue('Choose a replacement Supervisor or explicitly clear it before saving.'); return }
    const patch = relationshipPatch()
    const submittedSelection = selectionRef.current
    setBusy(true); setIssue(null)
    try {
      if (!await onSave(patch, expectedUpdatedAt, submittedSelection.relationAccess)) { setIssue('Relationships are not saved. Your selected Agents and created Session are retained. Review the current Goal and retry.'); return }
      if (draft && report?.agent?.createOperationId === draft.operationId && report.agent.creationPersistence !== 'unconfirmed' && report.save.diskDurability === 'confirmed') await clearGoalAgentCreationDraft(demand.id, draft.role, draft)
      if (completedSourceCreation && submittedSelection.selected.some(reference => demandAgentReferenceKey(reference) === demandAgentReferenceKey(completedSourceCreation.reference)))
        await clearGoalAgentCreationDraft(demand.id, completedSourceCreation.original.role, completedSourceCreation.original)
      await clearGoalAgentSelectionDraft(demand.id, role, submittedSelection)
      onClose()
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const location = mode === 'mote' && scratch ? motes.find(topic => topic.id === moteId) : undefined
  const executionPath = mode === 'mote' && scratch && location ? scratchTopicIdentityPath(scratch, location) : undefined
  return <Dialog.Root recoveryCloseDisabled={busy} open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface goal-agent-picker" aria-busy={busy} onOpenAutoFocus={event => { event.preventDefault(); previousFocus.current = document.activeElement?.nodeType === 1 ? document.activeElement as HTMLElement : null; openedContent.current = (event.target as Node | null)?.nodeType === 1 ? event.target as Element : null; search.current?.focus() }} onCloseAutoFocus={event => { event.preventDefault(); const original = previousFocus.current, active = document.activeElement; if (original?.isConnected && (active === document.body || active === original || !active?.isConnected || openedContent.current?.contains(active))) original.focus({ preventScroll: true }) }} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <header className="confirmation-dialog__heading"><Dialog.Title className="confirmation-dialog__title">{labels[role]}</Dialog.Title><Dialog.Close className="icon-button" aria-label="Close Agent picker" disabled={busy}><ThemeActionCloseIcon size={15} /></Dialog.Close></header>
        <Dialog.Description className="confirmation-dialog__description">{demand.title}<br />{role === 'assignees' ? 'Choose who advances this Goal. Their related history is retained.' : role === 'related' ? 'Keep the conversations involved in this Goal. Responsibilities are edited separately.' : '从负责人中选择此 Goal 的 Supervisor；需要其他 Agent 时，先在负责人中添加。保存不会启动执行或发送巡查。'}</Dialog.Description>
        {role !== 'supervisor' ? <SegmentedControl className="goal-agent-picker__modes" aria-label="Agent source" value={mode}
          options={agentSources.map(source => ({ ...source, disabled: busy }))} onValueChange={value => {
            setMode(value)
            setIssue(null)
            if (value === 'mote' && scratch) void useAppStore.getState().refreshScratchTopics(scratch.id)
          }} /> : null}
        <form onSubmit={event => { event.preventDefault(); void save() }}>
          {mode === 'existing' ? <>
            <SearchInput className="goal-agent-picker__search" ref={search} aria-label="Search Agents" clearLabel="Clear Agent search"
              value={query} onValueChange={setQuery} placeholder="Search name, Project or Session…" />
            <div className="goal-agent-picker__rows" aria-label={`Choose ${labels[role].toLowerCase()}`}>
              {role === 'supervisor' ? <label className="goal-agent-picker__row"><input type="radio" name="goal-supervisor" checked={!selected.length} disabled={busy} onChange={() => changeSelection({ selected: [] })} /><span><strong>No Supervisor</strong><small>Explicitly clear the selection</small></span></label> : null}
              {filtered.map(row => {
                const required = role === 'related' && (demand.assigneeSessionIds ?? []).some(ref => demandAgentReferenceKey(ref) === demandAgentReferenceKey(goalAgentRowReference(row)))
                return <label key={row.id} className="goal-agent-picker__row" data-goal-agent-key={row.id} data-session-id={typeof row.reference === 'string' ? row.reference : undefined}>
                  <input type={role === 'supervisor' ? 'radio' : 'checkbox'} name={role === 'supervisor' ? 'goal-supervisor' : undefined} checked={selected.some(ref => goalAgentSelectionKey(ref) === row.id)} disabled={busy || required || !row.selectable && !selected.some(ref => goalAgentSelectionKey(ref) === row.id)}
                    onChange={event => changeSelection({ selected: role === 'supervisor' ? [goalAgentRowReference(row)] : event.target.checked ? mergeDemandAgentReferences(selected, [goalAgentRowReference(row)]) : selected.filter(ref => goalAgentSelectionKey(ref) !== row.id) })} />
                  <GoalAgentFace row={row} /><span><strong>{row.name} {typeof row.reference === 'string' ? <AgentWorkModeBadge source={row.session} hosts={state.config?.hosts} embedded /> : null}</strong><small>{row.context}</small><small>{row.status}{required ? ' · Assignee retains this relationship' : row.related ? ' · Related to this Goal' : row.participated ? ' · Participated in this Goal' : row.project ? ' · Bound Project' : ''}</small>{typeof row.reference === 'string' ? <small className="goal-agent-picker__identity">{row.reference}</small> : <details className="goal-team__identity-details"><summary>Reference details</summary><code>{JSON.stringify(row.reference)}</code></details>}</span>
                </label>
              })}
              {!filtered.length ? <p className="goals-muted">{query ? 'No matching Agents.' : role === 'supervisor' ? 'Choose an assignee first.' : 'No Agent Sessions are currently observed. Saved references remain.'}</p> : null}
            </div>
          </> : <div className="goal-agent-picker__creation">
            {mode === 'mote' ? <>
              <label>Mote<SelectionField key={JSON.stringify([demand.id, role, mode])} label="Mote for new Session" value={moteId} options={[
                { value: '', label: 'Choose a Mote…' },
                ...motes.map(topic => ({ value: topic.id, label: topic.title, description: scratchTopicIdentityPath(scratch!, topic), icon: <MoteIcon /> }))
              ]}
                onValueChange={id => { setMoteId(id); setExecutorId(scratch ? moteDefaultExecutor(useAppStore.getState(), scratch.id, id) ?? '' : '') }} disabled={busy || creationRaw !== undefined} /></label>
              {!observed ? <p className="goals-service">The original Mote directory is not yet observed. <Button type="button" onClick={() => { if (scratch) void useAppStore.getState().refreshScratchTopics(scratch.id, true) }}>Refresh Motes</Button></p> : null}
              <p className="goals-muted">A new Session uses this Mote’s original directory, Soul and Wiki.</p>
            </> : null}
            {mode === 'mote' ? <label>Agent configuration<SelectionField key={JSON.stringify([demand.id, role, mode])} label="New Session Agent configuration" value={executorId} options={[{ value: '', label: 'Choose a saved configuration…' }, ...Object.entries(state.config?.executors ?? {}).map(([id, executor]) => ({ value: id, label: executor.label, description: `${executor.providerId} · ${executor.command}` }))]} onValueChange={setExecutorId} disabled={busy || creationRaw !== undefined} /></label> : null}
            {mode === 'agent' && !draft && state.config && role !== 'supervisor' ? <GoalSourceCreation goalId={demand.id} role={role} config={state.config} selection={sourceSelection} onSelection={setSourceSelection} disabled={busy} onBusy={setBusy}
              onCreated={(reference, access, original, receipt) => {
                if (receipt.outcome === 'opened' && receipt.save.diskDurability === 'confirmed' &&
                    (original.kind === 'goal-coordinator-create' || receipt.agent?.createOperationId === original.operationId && receipt.agent.creationPersistence !== 'unconfirmed'))
                  setCompletedSourceCreation({ original, reference })
                if (useAppStore.getState().goalAgentSelectionDrafts[goalCreationDraftKey(demand.id, role)] !== selection) {
                  setIssue('The Agent was created. Your newer relationship draft is retained; check the original creation to add this Agent explicitly.'); return
                }
                changeSelection({ selected: mergeDemandAgentReferences(selected, [reference]),
                  relationAccess: [...(selection.relationAccess ?? []).filter(value => demandAgentReferenceKey(value.reference) !== demandAgentReferenceKey(reference)), access] })
                setMode('existing')
              }} /> : null}
            {executionPath ? <p className="goal-agent-picker__path">{executionPath}</p> : null}
            {(mode === 'mote' && creationRaw === undefined) || draft ? <Button type="button" variant="primary" disabled={busy} onClick={() => void createSession()}><ThemeActionCreateAgentIcon size={13} />{draft ? draft.phase === 'not-dispatched' ? 'Save selection and create once' : 'Check original creation' : 'Create Mote Session'}</Button> : null}
            {mode === 'mote' || draft ? <p className="goals-caption">Creation sends no task. Save the relationship below; Continue is a separate action.</p> : null}
          </div>}
          {removingSupervisor ? <label className="goal-agent-picker__replacement">Current Supervisor is being removed<SelectionField key={JSON.stringify([demand.id, role])} label="Replacement Supervisor" value={replacement === undefined ? '__choose__' : replacement === '' ? '' : goalAgentSelectionKey(replacement)} options={[{ value: '__choose__', label: 'Choose replacement or clear…', disabled: true }, { value: '', label: 'Clear Supervisor' }, ...rows.filter(row => selected.some(ref => goalAgentSelectionKey(ref) === row.id)).map(row => ({ value: row.id, label: row.name }))]} onValueChange={key => { const original = selected.find(ref => goalAgentSelectionKey(ref) === key); if (key === '') changeSelection({ replacement: '' }); else if (original !== undefined) changeSelection({ replacement: original }); else setIssue('The selected Supervisor reference changed. Keep the original draft and review the current selection.') }} /></label> : null}
          {draft ? <div className="goal-agent-picker__receipt" role="status"><strong>{report?.agent?.createOperationId === draft.operationId ? 'Original Session observed' : draft.phase === 'not-dispatched' ? 'Creation has not been dispatched' : 'Creation confirmation pending'}</strong>
            <span>{report?.agent?.agentSessionId ?? draft.operationId}</span><span>Creation: {report?.agent ? report.agent.creationPersistence === 'unconfirmed' ? 'Saving unconfirmed' : 'Recorded by Core' : 'Unconfirmed'} · Task: {report?.agent?.initialPrompt === 'not-requested' ? 'Not sent' : 'Not confirmed'} · Relationship: Save separately</span>
            {report?.issues.map((entry, index) => <span key={index}>{entry.message}</span>)}<Button type="button" disabled={busy} onClick={() => { if (draft.phase === 'not-dispatched') void dispatchOriginal(draft); else void inspectOriginal(draft) }}>{draft.phase === 'not-dispatched' ? 'Save selection and create once' : 'Check original operation'}</Button></div> : null}
          <GoalRelationAccessFields references={addedGoalSourceReferences(demand, relationshipPatch())} hosts={state.config?.hosts ?? []} accesses={selection.relationAccess ?? []} disabled={busy} onChange={relationAccess => changeSelection({ relationAccess })} />
          {changed ? <div className="goals-service" role="status">The Goal changed while this selection was open. Your draft is retained.<Button type="button" disabled={busy} onClick={() => { changeSelection({ expectedUpdatedAt: demand.updatedAt }); setIssue(null) }}>Use current Goal version for this draft</Button></div> : null}
          {issue ? <p className="goals-service" role="status">{issue}</p> : null}
          <footer><span>{role === 'supervisor' ? selected.length ? 'One Supervisor selected' : 'Supervisor cleared' : `${selected.length} selected`}</span><Button type="button" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Working…' : 'Save relationships'}</Button></footer>
        </form>
      </Dialog.Content></DocumentOverlayPortal>
  </Dialog.Root>
}
