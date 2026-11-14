import { mintObjectId } from '@agentmux/core/object-id'
import { useWorkbenchWindowDocument } from '../lib/workbench-document'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { TextInput } from '@agentmux/client-ui/input'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { clearGoalAgentCreationDraft, clearGoalAgentSelectionDraft, retainGoalAgentCreationDraft, retainGoalAgentSelectionDraft, useAppStore, type LauncherExecutionSelection } from '../store'
import { api } from '../lib/api'
import type { DemandRecord } from '../lib/global-demand-board'
import { goalAgentRows, goalCreationDraftKey, type GoalAgentCreationDraft, type GoalAgentSelectionDraft, type GoalAgentRole, type GoalAgentRow } from '../lib/goal-agent-selection'
import { projectWorkspaces, workspaceProjectId } from '../lib/workspace-projects'
import { moteDefaultExecutor } from '../lib/mote-quick-preferences'
import { executorsForHost, hostExecutorInventoryMatches } from '../lib/executors'
import { agentWorkModeLabel, launcherWorkPlacement, workHostLabel, workReferenceHostId } from '../lib/agent-work-mode'
import { scratchTopicKind, scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { scratchTopicIdentityPath } from '@agentmux/host/mote-model'
import { directoryIdentity, homeZoneId, workspaceZoneId } from '../../../shared/space-addresses'
import { AgentAvatar } from './AgentAvatar'
import { AgentWorkModeSetup } from './AgentWorkModeSetup'
import { AgentWorkModeBadge } from './AgentWorkModeBadge'
import { SelectionField } from './SelectionField'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useWorkbenchDocument } from '../lib/workbench-document'

const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeActionCreateAgentIcon = semanticIconComponent('action.create-agent')


export type GoalRelationSave = (patch: Parameters<ReturnType<typeof useAppStore.getState>['updateDemand']>[1], expectedUpdatedAt: number) => Promise<boolean>
const labels = { assignees: 'Assignees', related: 'Related sessions', supervisor: 'Supervisor' }
export function GoalAgentFace({ row }: { row: GoalAgentRow }) {
  const avatar = useAppStore(state => row.session?.executorId ? state.config?.executors[row.session.executorId]?.avatar ?? state.config?.appearance.agentAvatars?.[row.session.executorId] : undefined)
  return <span inert aria-hidden="true" className="goal-agent-face"><AgentAvatar size={22} label={row.name} providerId={row.session?.providerId} state={row.session?.status.state} executorId={row.session?.executorId} appearance={avatar} visible={false} /></span>
}

/** One editor for explicit business relationships; creation uses the original spatial/Core owner. */
export function GoalAgentPicker({ demand, role, onSave, onClose }: { demand: DemandRecord; role: GoalAgentRole; onSave: GoalRelationSave; onClose(): void }) {
  const document = useWorkbenchDocument()
  const state = useAppStore(useShallow(state => ({ sessions: state.sessions, config: state.config, agentNames: state.agentNames,
    timelines: state.timelines, scratchTopicSnapshots: state.scratchTopicSnapshots, hostExecutorInventories: state.hostExecutorInventories,
    executorDetections: state.executorDetections })))
  const draft = useAppStore(state => state.goalAgentCreationDrafts[goalCreationDraftKey(demand.id, role)])
  const initialSelection = useRef<GoalAgentSelectionDraft>(useAppStore.getState().goalAgentSelectionDrafts[goalCreationDraftKey(demand.id, role)] ?? {
    goalId: demand.id, role, selected: role === 'assignees' ? demand.assigneeSessionIds ?? [] : role === 'related' ? demand.sessionIds : demand.supervisorSessionId ? [demand.supervisorSessionId] : [], expectedUpdatedAt: demand.updatedAt })
  const [selection, setSelection] = useState(initialSelection.current)
  const { selected, expectedUpdatedAt, replacement } = selection
  const selectionRef = useRef(selection)
  function changeSelection(patch: Partial<GoalAgentSelectionDraft>) {
    const next = { ...selectionRef.current, ...patch }; selectionRef.current = next; setSelection(next)
    void retainGoalAgentSelectionDraft(next)
  }
  function addCreatedSession(id: string) { changeSelection({ selected: [...new Set([...selectionRef.current.selected, id])] }); setMode('existing') }
  useEffect(() => { void retainGoalAgentSelectionDraft(initialSelection.current) }, [])
  const [query, setQuery] = useState(''), [mode, setMode] = useState<'existing' | 'mote' | 'agent'>('existing')
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const [report, setReport] = useState<AgentMuxSpaceMutationReport | null>(null)
  const previousFocus = useRef<HTMLElement | null>(null), openedContent = useRef<Element | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const creating = useRef<string | null>(null)
  const projects = projectWorkspaces(state.config?.workspaces.filter(workspace => workspace.id !== '__scratch__') ?? [])
  const [workspaceId, setWorkspaceId] = useState(projects.find(project => project.id === demand.projectId)?.preferredWorkspaceId ?? '')
  const [arrangement, setArrangement] = useState<LauncherExecutionSelection | null>(null)
  const [editingLocations, setEditingLocations] = useState(true), [folderSelection, setFolderSelection] = useState(0)
  const [moteId, setMoteId] = useState(''), [executorId, setExecutorId] = useState('')
  const project = state.config?.workspaces.find(item => item.id === arrangement?.resourceWorkspaceId)
  const agent = state.config?.workspaces.find(item => item.id === (arrangement?.agentWorkspaceId ?? arrangement?.resourceWorkspaceId))
  const agentHost = state.config?.hosts.find(item => item.id === agent?.hostId)
  const split = Boolean(arrangement?.agentWorkspaceId)
  const usesHostInventory = split || agentHost?.kind === 'ssh'
  const inventory = agent ? state.hostExecutorInventories[agent.hostId] : undefined
  const choices = executorsForHost(state.config, agent?.hostId, state.executorDetections, inventory, split ? 'host' : undefined)
  const configurationUnknown = usesHostInventory && (!hostExecutorInventoryMatches(inventory, agentHost) || inventory.state !== 'ready')
  const placement = launcherWorkPlacement(project, agent, workReferenceHostId(state.config?.hosts ?? []))
  function checkConfigurations() { if (agent) void useAppStore.getState().detectExecutors(agent.hostId, split ? { source: 'host' } : undefined) }
  useEffect(() => {
    if (mode === 'agent' && !draft && !editingLocations && agentHost) checkConfigurations()
  }, [mode, Boolean(draft), editingLocations, agentHost, split])
  const scratch = state.config?.workspaces.find(workspace => workspace.id === '__scratch__')
  const observed = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch)
  const motes = observed?.filter(topic => !topic.readError && scratchTopicKind(topic.id, observed) === 'mote') ?? []
  const rows = useMemo(() => goalAgentRows(state, demand, [...selected, ...(role === 'supervisor' ? demand.assigneeSessionIds ?? [] : [])]), [state, demand, selected, role])
    .filter(row => role !== 'supervisor' || (demand.assigneeSessionIds ?? []).includes(row.id))
  const filtered = rows.filter(row => `${row.name} ${row.context} ${row.status} ${row.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const removingSupervisor = role === 'assignees' && demand.supervisorSessionId && !selected.includes(demand.supervisorSessionId)
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
    const selectedArrangement = arrangement
    const workspace = config?.workspaces.find(workspace => workspace.id === selectedArrangement?.resourceWorkspaceId)
    const execution = config?.workspaces.find(workspace => workspace.id === (selectedArrangement?.agentWorkspaceId ?? selectedArrangement?.resourceWorkspaceId))
    const mote = motes.find(topic => topic.id === moteId)
    const selectedExecutorId = executorId
    const current = useAppStore.getState()
    const selectedChoice = mode === 'agent' && execution ? executorsForHost(config, execution.hostId, current.executorDetections,
      current.hostExecutorInventories[execution.hostId], selectedArrangement?.agentWorkspaceId ? 'host' : undefined).find(item => item.id === selectedExecutorId && item.detection?.state !== 'missing') : undefined
    if (!selectedExecutorId || (mode === 'mote' ? !config?.executors[selectedExecutorId] : !selectedChoice)) { setIssue('Choose the configuration on this Agent’s exact Host.'); return }
    if (mode === 'mote' && (!scratch || !mote)) { setIssue('Choose a Mote from its original directory observation. Existing Agents remain available.'); return }
    if (mode === 'agent' && (!workspace || !execution)) { setIssue('Choose the exact project and Agent startup directory for this new Agent.'); return }
    const spaceId = mode === 'mote' ? directoryIdentity(scratch!.hostId, scratchTopicIdentityPath(scratch!, mote!)) : workspaceProjectId(workspace!)
    const operationId = `goal-agent-create-${mintObjectId()}`
    const original: GoalAgentCreationDraft = { goalId: demand.id, role: role as 'assignees' | 'related', operationId, phase: 'not-dispatched',
      request: { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: operationId, operation: 'agent.open', focus: false,
        content: { kind: 'new-agent', executorId: selectedExecutorId, ...(mode === 'agent' ? { executionWorkspaceId: execution!.id,
          ...(selectedArrangement!.agentWorkspaceId ? { toolWorkspaceId: workspace!.id } : {}) } : {}) },
        destination: { spaceId, zoneId: mode === 'mote' ? homeZoneId(spaceId) : workspaceZoneId(spaceId, workspace!.id), newTab: true } } }
    await dispatchOriginal(original)
  }
  async function dispatchOriginal(original: GoalAgentCreationDraft) {
    if (creating.current) return
    creating.current = original.operationId; setBusy(true); setIssue(null)
    try {
      const retained = await retainGoalAgentCreationDraft(original)
      if (!retained.clientStateWritten) { setIssue(`Creation has not been dispatched. Save the retained selection and create once: ${retained.reason ?? 'Save acknowledgement unavailable'}.`); return }
      // Persist the uncertainty boundary before the first and only dispatch. Restoring this phase only inspects.
      const dispatching = { ...original, phase: 'may-have-dispatched' as const }
      const dispatchSaved = await retainGoalAgentCreationDraft(dispatching)
      if (!dispatchSaved.clientStateWritten) {
        await retainGoalAgentCreationDraft({ ...original, phase: 'not-dispatched' })
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
  async function save() {
    if (removingSupervisor && replacement === undefined) { setIssue('Choose a replacement Supervisor or explicitly clear it before saving.'); return }
    const patch = role === 'supervisor' ? { supervisorSessionId: selected[0] ?? null }
      : role === 'related' ? { sessionIds: selected }
      : { assigneeSessionIds: selected, ...(removingSupervisor ? { supervisorSessionId: replacement || null } : {}) }
    setBusy(true); setIssue(null)
    try {
      if (!await onSave(patch, expectedUpdatedAt)) { setIssue('Relationships are not saved. Your selected Agents and created Session are retained. Review the current Goal and retry.'); return }
      if (draft && report?.agent?.createOperationId === draft.operationId && report.agent.creationPersistence !== 'unconfirmed' && report.save.diskDurability === 'confirmed') await clearGoalAgentCreationDraft(demand.id, draft.role, draft.operationId)
      await clearGoalAgentSelectionDraft(demand.id, role)
      onClose()
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const dialogDocument = useWorkbenchWindowDocument() ?? undefined
  async function chooseFolder() {
    setBusy(true); setIssue(null)
    try {
      const workspace = await api.workspaces.chooseLocalFolder(dialogDocument)
      if (workspace) {
        // The native chooser returns its registered Workspace, not an inferred path.
        useAppStore.setState(current => current.config && !current.config.workspaces.some(item => item.id === workspace.id)
          ? { config: { ...current.config, workspaces: [...current.config.workspaces, workspace] } } : current)
        setWorkspaceId(workspace.id)
        setArrangement({ resourceWorkspaceId: workspace.id, agentWorkspaceId: null }); setEditingLocations(true); setFolderSelection(value => value + 1); setExecutorId('')
      }
    }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const location = mode === 'mote' && scratch ? motes.find(topic => topic.id === moteId) : undefined
  const executionPath = mode === 'mote' && scratch && location ? scratchTopicIdentityPath(scratch, location) : undefined
  return <Dialog.Root recoveryCloseDisabled={busy} open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface goal-agent-picker" aria-busy={busy} onOpenAutoFocus={event => { event.preventDefault(); previousFocus.current = document.activeElement?.nodeType === 1 ? document.activeElement as HTMLElement : null; openedContent.current = (event.target as Node | null)?.nodeType === 1 ? event.target as Element : null; search.current?.focus() }} onCloseAutoFocus={event => { event.preventDefault(); const original = previousFocus.current, active = document.activeElement; if (original?.isConnected && (active === document.body || active === original || !active?.isConnected || openedContent.current?.contains(active))) original.focus({ preventScroll: true }) }} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <header className="confirmation-dialog__heading"><Dialog.Title className="confirmation-dialog__title">{labels[role]}</Dialog.Title><Dialog.Close className="icon-button" aria-label="Close Agent picker" disabled={busy}><ThemeActionCloseIcon size={15} /></Dialog.Close></header>
        <Dialog.Description className="confirmation-dialog__description">{demand.title}<br />{role === 'assignees' ? 'Choose who advances this Goal. Their related history is retained.' : role === 'related' ? 'Keep the conversations involved in this Goal. Responsibilities are edited separately.' : '从负责人中选择此 Goal 的 Supervisor；需要其他 Agent 时，先在负责人中添加。保存不会启动执行或发送巡查。'}</Dialog.Description>
        {role !== 'supervisor' ? <div className="goal-agent-picker__modes">{(['existing', 'mote', 'agent'] as const).map(value => <button key={value} type="button" className={`small-button${mode === value ? ' small-button--active' : ''}`} aria-pressed={mode === value} disabled={busy} onClick={() => { setMode(value); setIssue(null); if (value === 'mote' && scratch) void useAppStore.getState().refreshScratchTopics(scratch.id) }}>{value === 'existing' ? 'Existing Agents' : value === 'mote' ? 'Mote · new Session' : 'New Agent'}</button>)}</div> : null}
        <form onSubmit={event => { event.preventDefault(); void save() }}>
          {mode === 'existing' ? <>
            <label className="goal-agent-picker__search"><ThemeActionSearchIcon size={14} /><TextInput ref={search} aria-label="Search Agents" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name, Project or Session…" /></label>
            <div className="goal-agent-picker__rows" aria-label={`Choose ${labels[role].toLowerCase()}`}>
              {role === 'supervisor' ? <label className="goal-agent-picker__row"><input type="radio" name="goal-supervisor" checked={!selected.length} disabled={busy} onChange={() => changeSelection({ selected: [] })} /><span><strong>No Supervisor</strong><small>Explicitly clear the selection</small></span></label> : null}
              {filtered.map(row => {
                const required = role === 'related' && (demand.assigneeSessionIds ?? []).includes(row.id)
                return <label key={row.id} className="goal-agent-picker__row" data-session-id={row.id}>
                  <input type={role === 'supervisor' ? 'radio' : 'checkbox'} name={role === 'supervisor' ? 'goal-supervisor' : undefined} checked={selected.includes(row.id)} disabled={busy || required || !row.selectable && !selected.includes(row.id)}
                    onChange={event => changeSelection({ selected: role === 'supervisor' ? [row.id] : event.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id) })} />
                  <GoalAgentFace row={row} /><span><strong>{row.name} <AgentWorkModeBadge source={row.session} hosts={state.config?.hosts} embedded /></strong><small>{row.context}</small><small>{row.status}{required ? ' · Assignee retains this relationship' : row.related ? ' · Related to this Goal' : row.participated ? ' · Participated in this Goal' : row.project ? ' · Bound Project' : ''}</small><small className="goal-agent-picker__identity">{row.id}</small></span>
                </label>
              })}
              {!filtered.length ? <p className="goals-muted">{query ? 'No matching Agents.' : role === 'supervisor' ? 'Choose an assignee first.' : 'No Agent Sessions are currently observed. Saved references remain.'}</p> : null}
            </div>
          </> : <div className="goal-agent-picker__creation">
            {mode === 'mote' ? <>
              <label>Mote<SelectionField key={JSON.stringify([demand.id, role, mode])} label="Mote for new Session" value={moteId} options={[{ value: '', label: 'Choose a Mote…' }, ...motes.map(topic => ({ value: topic.id, label: topic.title, description: scratchTopicIdentityPath(scratch!, topic) }))]}
                onValueChange={id => { setMoteId(id); setExecutorId(scratch ? moteDefaultExecutor(useAppStore.getState(), scratch.id, id) ?? '' : '') }} disabled={busy || Boolean(draft)} /></label>
              {!observed ? <p className="goals-service">The original Mote directory is not yet observed. <button type="button" className="small-button" onClick={() => { if (scratch) void useAppStore.getState().refreshScratchTopics(scratch.id, true) }}>Refresh Motes</button></p> : null}
              <p className="goals-muted">A new Session uses this Mote’s original directory, Soul and Wiki.</p>
            </> : null}
            {mode === 'mote' ? <label>Agent configuration<SelectionField key={JSON.stringify([demand.id, role, mode])} label="New Session Agent configuration" value={executorId} options={[{ value: '', label: 'Choose a saved configuration…' }, ...Object.entries(state.config?.executors ?? {}).map(([id, executor]) => ({ value: id, label: executor.label, description: `${executor.providerId} · ${executor.command}` }))]} onValueChange={setExecutorId} disabled={busy || Boolean(draft)} /></label> : null}
            {mode === 'agent' && !draft && state.config ? <>
              {editingLocations ? <>
                <button type="button" className="small-button" disabled={busy} onClick={() => void chooseFolder()}>Choose local folder…</button>
                <AgentWorkModeSetup key={JSON.stringify([workspaceId, folderSelection])} config={state.config} active={!busy} allowLocal
                  initialSelection={arrangement ?? (workspaceId ? { resourceWorkspaceId: workspaceId, agentWorkspaceId: null } : undefined)}
                  actionLabel="Prepare locations" preparationNote="Preparing locations starts no Agent." onApply={selection => { setArrangement(selection); setEditingLocations(false); setExecutorId('') }} />
              </> : <>
                <div className="goal-agent-picker__locations"><strong>{agentWorkModeLabel(placement.mode)}</strong><span>Project · {workHostLabel(state.config.hosts, project?.hostId ?? null)} · {project?.path ?? 'Directory unobserved'}</span><span>Agent · {workHostLabel(state.config.hosts, agent?.hostId ?? null)} · {agent?.path ?? 'Directory unobserved'}</span><button type="button" className="small-button" disabled={busy} onClick={() => { setEditingLocations(true); setIssue(null) }}>Edit locations</button></div>
                <label>Agent configuration on {workHostLabel(state.config.hosts, agent?.hostId ?? null)}<SelectionField label="New Session Agent configuration" value={executorId} options={[{ value: '', label: 'Choose a configuration on this Host…' }, ...choices.map(item => ({ value: item.id, label: item.label, description: `${item.providerId} · ${item.command}`, disabled: item.detection?.state === 'missing' }))]} onValueChange={setExecutorId} disabled={busy} /></label>
                <div className="goal-agent-picker__configurations"><span role="status">{configurationUnknown ? 'Agent configurations are unconfirmed. Existing work is kept; check this Host again.' : !choices.length ? 'No Agent is configured on this Host.' : 'Configuration belongs to the Agent Host above.'}</span><button type="button" className="small-button" disabled={busy || !agent || inventory?.state === 'checking'} onClick={checkConfigurations}>Refresh configurations</button></div>
                <button type="button" className="primary-button" disabled={busy || !choices.some(item => item.id === executorId && item.detection?.state !== 'missing')} onClick={() => void createSession()}><ThemeActionCreateAgentIcon size={13} />Create Agent</button>
              </>}
            </> : null}
            {executionPath ? <p className="goal-agent-picker__path">{executionPath}</p> : null}
            {mode === 'mote' || draft ? <button type="button" className="primary-button" disabled={busy} onClick={() => void createSession()}><ThemeActionCreateAgentIcon size={13} />{draft ? draft.phase === 'not-dispatched' ? 'Save selection and create once' : 'Check original creation' : 'Create Mote Session'}</button> : null}
            <p className="goals-caption">Creation sends no task. Save the relationship below; Continue is a separate action.</p>
          </div>}
          {removingSupervisor ? <label className="goal-agent-picker__replacement">Current Supervisor is being removed<SelectionField key={JSON.stringify([demand.id, role])} label="Replacement Supervisor" value={replacement ?? '__choose__'} options={[{ value: '__choose__', label: 'Choose replacement or clear…', disabled: true }, { value: '', label: 'Clear Supervisor' }, ...rows.filter(row => selected.includes(row.id)).map(row => ({ value: row.id, label: row.name }))]} onValueChange={replacement => changeSelection({ replacement })} /></label> : null}
          {draft ? <div className="goal-agent-picker__receipt" role="status"><strong>{report?.agent?.createOperationId === draft.operationId ? 'Original Session observed' : draft.phase === 'not-dispatched' ? 'Creation has not been dispatched' : 'Creation confirmation pending'}</strong>
            <span>{report?.agent?.agentSessionId ?? draft.operationId}</span><span>Creation: {report?.agent ? report.agent.creationPersistence === 'unconfirmed' ? 'Saving unconfirmed' : 'Recorded by Core' : 'Unconfirmed'} · Task: {report?.agent?.initialPrompt === 'not-requested' ? 'Not sent' : 'Not confirmed'} · Relationship: Save separately</span>
            {report?.issues.map((entry, index) => <span key={index}>{entry.message}</span>)}<button type="button" className="small-button" disabled={busy} onClick={() => { if (draft.phase === 'not-dispatched') void dispatchOriginal(draft); else void inspectOriginal(draft) }}>{draft.phase === 'not-dispatched' ? 'Save selection and create once' : 'Check original operation'}</button></div> : null}
          {changed ? <div className="goals-service" role="status">The Goal changed while this selection was open. Your draft is retained.<button type="button" className="small-button" disabled={busy} onClick={() => { changeSelection({ expectedUpdatedAt: demand.updatedAt }); setIssue(null) }}>Use current Goal version for this draft</button></div> : null}
          {issue ? <p className="goals-service" role="status">{issue}</p> : null}
          <footer><span>{role === 'supervisor' ? selected.length ? 'One Supervisor selected' : 'Supervisor cleared' : `${selected.length} selected`}</span><button type="button" className="small-button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? 'Working…' : 'Save relationships'}</button></footer>
        </form>
      </Dialog.Content></DocumentOverlayPortal>
  </Dialog.Root>
}
