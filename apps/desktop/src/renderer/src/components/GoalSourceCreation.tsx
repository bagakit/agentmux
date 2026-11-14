import { useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { compactReferenceId } from '@agentmux/client-ui/display-name'
import type { AgentMuxRpcResult } from '@agentmux/core'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { GoalRelationAccess } from '@agentmux/core/control'
import type { AgentExecutionRecoveryReference, AgentLaunchResult, AppConfig } from '../../../shared/contracts'
import { api } from '../lib/api'
import { retainGoalAgentCreationDraft, useAppStore } from '../store'
import { goalCreationDraftKey } from '../lib/goal-agent-selection'
import { readGoalSourceCreationDraft, type GoalSourceCreationDraft } from '../lib/goal-source-creation-draft'
import { goalSourceReference } from '../lib/goal-source-reference'
import type { LauncherSourceExecution } from '../lib/launcher-source'
import { useSourceLauncher } from '../hooks/useSourceLauncher'
import { SourceAgentTargetSetup } from './SourceAgentTargetSetup'
import { SelectionField } from './SelectionField'
import { useWorkbenchWindowDocument } from '../lib/workbench-document'
import { newSourceAgentInput } from '../lib/new-source-agent-input'

/** A Goal owns only its private intent. Main owns independent C; Source owns C/L
 * admission. Neither operation borrows a Launcher slot or changes navigation. */
export function GoalSourceCreation({ goalId, role, config, selection, onSelection, disabled, onBusy, onCreated }: {
  goalId: string; role: 'assignees' | 'related'; config: AppConfig; disabled: boolean
  selection: LauncherSourceExecution | undefined; onSelection(value: LauncherSourceExecution): void
  onBusy(value: boolean): void; onCreated(reference: DemandSpaceMemberReference, access: GoalRelationAccess, original: GoalSourceCreationDraft, receipt: AgentMuxRpcResult<'agent.open'>): void
}) {
  const key = goalCreationDraftKey(goalId, role), raw = useAppStore(state => state.goalAgentCreationDrafts[key])
  const draft = readGoalSourceCreationDraft(raw, goalId, role)
  const [editing, setEditing] = useState(!selection)
  const dialogDocument = useWorkbenchWindowDocument() ?? undefined
  const [chosenFolder, setChosenFolder] = useState<string>()
  const launcher = useSourceLauncher(selection, !draft && !editing && !disabled)
  const [issue, setIssue] = useState<string>(), [reading, setReading] = useState(false)
  const [observed, setObserved] = useState<AgentMuxRpcResult<'agent.open'>>()
  const [recovery, setRecovery] = useState<AgentExecutionRecoveryReference>()
  const producing = useRef(false), readGeneration = useRef(0)
  const current = () => readGoalSourceCreationDraft(useAppStore.getState().goalAgentCreationDrafts[key], goalId, role)
  async function chooseFolder() {
    try {
      const workspace = await api.workspaces.chooseLocalFolder(dialogDocument)
      if (!workspace) return
      useAppStore.setState(state => state.config && !state.config.workspaces.some(value => value.id === workspace.id)
        ? { config: { ...state.config, workspaces: [...state.config.workspaces, workspace] } } : state)
      setChosenFolder(workspace.id)
    } catch (cause) { setIssue(presentError(cause)) }
  }
  async function retain(next: GoalSourceCreationDraft, previous: unknown) {
    const saved = await retainGoalAgentCreationDraft(next, previous)
    if (!saved.clientStateWritten) throw Error(`Saving the original creation request or receipt is unconfirmed. ${saved.reason ?? 'Its complete input is retained.'}`)
    if (useAppStore.getState().goalAgentCreationDrafts[key] !== next) throw Error('The retained creation changed. No replacement request was sent.')
    return next
  }
  async function beforeDispatch(original: GoalSourceCreationDraft) {
    const dispatching = { ...original, submitted: true }
    try { return await retain(dispatching, original) }
    catch (cause) {
      // No external owner was called. Keep the same complete request eligible
      // for its first explicit send; an earlier possible send stays unknown.
      if (!original.submitted && useAppStore.getState().goalAgentCreationDrafts[key] === dispatching)
        await retainGoalAgentCreationDraft(original, dispatching)
      throw new Error(`${original.submitted ? 'This attempt was not sent; the earlier result remains unconfirmed.' : 'This creation has not been sent.'} ${presentError(cause)}`, { cause })
    }
  }
  async function locate(original: GoalSourceCreationDraft, receipt: AgentMuxRpcResult<'agent.open'>) {
    const operationId = original.kind === 'goal-source-create' ? original.operationId : original.association.operationId
    const snapshot = await api.spaceMounts.call('snapshot', { hostId: original.target.hostId, reference: original.target.reference })
    const reference = goalSourceReference(original.target, operationId, receipt, snapshot,
      original.kind === 'goal-coordinator-create' ? original.association.request : original.request)
    onCreated(reference, { reference, access: { source: { hostId: original.target.hostId }, ...(original.kind === 'goal-coordinator-create'
      ? { coordinator: { hostId: original.request.hostId } } : {}) } }, original, receipt)
  }
  async function acknowledge(original: Extract<GoalSourceCreationDraft, { kind: 'goal-coordinator-create' }>, result: AgentLaunchResult) {
    const created = result.created, request = original.request, tool = created.toolExecution
    if (created.agentSessionId !== request.agentSessionId || created.hostId !== request.hostId || created.creation?.createOperationId !== original.operationId ||
        !tool || tool.resourceHostId !== request.toolWorkspace.hostId || tool.resourceRuntimeId !== request.sourceCoordinator.resourceRuntimeId || tool.workspacePath !== request.toolWorkspace.path)
      throw Error('The original Coordinator creation and project binding are unconfirmed. The request and Agent are retained.')
    return await retain({ ...original, acknowledged: { target: { coordinator: { hostId: request.hostId, runtimeId: request.sourceCoordinator.runtimeId },
      reference: { bindingId: tool.bindingId, agentSessionId: request.agentSessionId, createOperationId: request.createOperationId } }, run: { ...created.run } } }, original)
  }
  async function link(original: Extract<GoalSourceCreationDraft, { kind: 'goal-coordinator-create' }>) {
    if (!original.acknowledged) throw Error('Check the original Coordinator request before linking this project.')
    const target = original.acknowledged.target, witness = (await api.sessions.executionBinding(target, 'association'))?.association
    if (!witness || witness.state !== 'confirmed' || witness.reference.bindingId !== target.reference.bindingId ||
        witness.reference.agentSessionId !== original.request.agentSessionId || witness.reference.createOperationId !== original.operationId ||
        witness.agentRuntimeId !== original.request.sourceCoordinator.runtimeId || witness.resourceRuntimeId !== original.target.reference.runtimeId ||
        witness.resourceWorkspacePath !== original.project.path) throw Error('The original Coordinator has not confirmed this project resource. Its Agent and link request are retained.')
    const request = original.association.request ?? { operationId: original.association.operationId,
      content: { kind: 'agent-session' as const, reference: { kind: 'coordinator-agent' as const, runtimeId: target.coordinator.runtimeId, binding: target.reference },
        expectedResource: { runtimeId: original.target.reference.runtimeId, workspaceId: original.target.workspaceId, workspacePath: original.project.path } },
      destination: { spaceId: original.target.reference.spaceId, zoneId: original.target.zoneId, newTab: true as const }, focus: false }
    const dispatching = await retain({ ...original, association: { ...original.association, request, submitted: true } }, original)
    if (dispatching.kind !== 'goal-coordinator-create') return
    const receipt = await api.spaceMounts.call('open', { hostId: original.target.hostId, reference: original.target.reference, request })
    if (receipt.operationId !== original.association.operationId) throw Error('The project link returned another operation. The original request is retained.')
    const completed = await retain({ ...dispatching, association: { ...dispatching.association, receipt } }, dispatching)
    await locate(completed, receipt)
  }
  async function send(original: GoalSourceCreationDraft, continuing = false) {
    if (producing.current || disabled) return
    producing.current = true; onBusy(true); ++readGeneration.current; setIssue(undefined)
    try {
      if (original.submitted && !continuing) throw Error('Check the original request before explicitly continuing it. No new Agent was requested.')
      let frozen = original
      if (current() !== original) frozen = await retain(original, undefined)
      if (frozen.kind === 'goal-source-create') {
        const dispatching = await beforeDispatch(frozen)
        if (dispatching.kind !== 'goal-source-create') return
        const receipt = await api.spaceMounts.call('open', { hostId: frozen.target.hostId, reference: frozen.target.reference, request: frozen.request })
        if (receipt.operationId !== frozen.operationId) throw Error('The creation returned another operation. The original request is retained.')
        const confirmed = { ...dispatching, receipt }
        if (receipt.agent && (receipt.outcome === 'opened' || receipt.outcome === 'partial')) delete confirmed.issue
        const completed = await retain(confirmed, dispatching)
        await locate(completed, receipt)
      } else {
        if (!frozen.acknowledged) {
          const dispatching = await beforeDispatch(frozen)
          if (dispatching.kind !== 'goal-coordinator-create') return
          const result = continuing ? recovery ? await api.sessions.continueExecution(recovery)
            : (() => { throw Error('Check the original Coordinator to obtain its retained reference. No new creation was sent.') })()
            : await api.sessions.launchAgent(dispatching.request)
          const acknowledged = await acknowledge(dispatching, result)
          if (acknowledged.kind !== 'goal-coordinator-create') return
          frozen = acknowledged
        }
        await link(frozen)
      }
    } catch (cause) {
      const message = presentError(cause), retained = current()
      if (retained?.request === original.request) await retainGoalAgentCreationDraft({ ...retained, issue: message }, retained)
      setIssue(message)
    }
    finally { producing.current = false; onBusy(false) }
  }
  async function check(original: GoalSourceCreationDraft) {
    const generation = ++readGeneration.current; setReading(true); setIssue(undefined)
    try {
      if (original.kind === 'goal-coordinator-create' && !original.acknowledged) {
        const found = await api.sessions.resolveExecutionBinding({ hostId: original.request.hostId, agentSessionId: original.request.agentSessionId,
          createOperationId: original.operationId, toolWorkspace: original.request.toolWorkspace })
        if (found && (found.target.coordinator.hostId !== original.request.hostId || found.target.coordinator.runtimeId !== original.request.sourceCoordinator.runtimeId ||
            found.target.reference.agentSessionId !== original.request.agentSessionId || found.target.reference.createOperationId !== original.operationId))
          throw Error('The observation belongs to another original Coordinator request.')
        if (generation === readGeneration.current) setRecovery(found?.target)
        if (!found) throw Error('The original Coordinator request is currently unconfirmed. This read created no Agent and sent no task.')
      }
      const operationId = original.kind === 'goal-source-create' ? original.operationId : original.association.operationId
      const result = await api.spaceMounts.call('inspect', { hostId: original.target.hostId, reference: original.target.reference, requestId: operationId })
      if (!result.request?.known || !result.request.report) throw Error('The original project occurrence is currently unconfirmed. Its request is retained.')
      if (generation !== readGeneration.current) return
      await locate(original, result.request.report); setObserved(result.request.report)
    } catch (cause) { if (generation === readGeneration.current) setIssue(presentError(cause)) }
    finally { if (generation === readGeneration.current) setReading(false) }
  }
  async function create() {
    if (producing.current || disabled || !selection || !launcher.ready || !launcher.selected) return
    producing.current = true; onBusy(true)
    try {
      const inputEpoch = selection.kind === 'source-coordinator' ? await api.sessions.readInputEpoch(selection.coordinator.hostId) ?? undefined : undefined
      const sourceInput = selection.kind !== 'source-coordinator' ? await newSourceAgentInput(selection.target, selection.agentTarget) : undefined
      const operationId = `goal-agent-create-${mintObjectId()}`, executorId = launcher.selected.executorId, executorRevision = launcher.selected.configRevision
      const scope = { goalId, role, operationId, submitted: false, project: selection.project, target: selection.target }
      producing.current = false
      await send(selection.kind === 'source-coordinator' ? { ...scope, kind: 'goal-coordinator-create',
        request: { executorId, executorRevision, hostId: selection.coordinator.hostId, workspacePath: selection.coordinator.homeDirectory,
          inputRuntimeId: selection.coordinator.runtimeId, ...(inputEpoch === undefined ? {} : { inputEpoch }),
          agentSessionId: mintObjectId(), createOperationId: operationId, toolWorkspace: { id: selection.project.id, hostId: selection.project.hostId, path: selection.project.path },
          sourceCoordinator: { hostId: selection.coordinator.hostId, runtimeId: selection.coordinator.runtimeId,
            resourceRuntimeId: selection.target.reference.runtimeId, workingDirectory: 'device-home' } },
        association: { operationId: `goal-agent-link-${mintObjectId()}`, submitted: false } }
        : { ...scope, ...(sourceInput?.issue ? { issue: sourceInput.issue } : {}), kind: 'goal-source-create', request: { operationId, content: { kind: 'new-agent', executorId, agentTarget: selection.agentTarget, ...sourceInput?.fields },
          destination: { spaceId: selection.target.reference.spaceId, zoneId: selection.target.zoneId, newTab: true }, focus: false } })
    } catch (cause) { setIssue(presentError(cause)) }
    finally { producing.current = false; onBusy(false) }
  }
  const receipt = draft?.kind === 'goal-source-create' ? draft.receipt : draft?.association.receipt
  const outcome = (observed ?? receipt)?.outcome, complete = outcome === 'opened' || outcome === 'retired'
  return <div className="goal-agent-picker__creation">
    {raw !== undefined ? draft ? <div className="goal-agent-picker__receipt" role="status">
      <strong>{outcome === 'retired' ? 'Original Agent retired; reference retained' : complete ? observed ? 'Original project occurrence observed' : 'Original creation receipt retained' : 'Original Agent request retained'}</strong><span>{draft.project.path}</span>
      {draft.issue ? <p role="status">{draft.issue}</p> : null}
      <button type="button" className="small-button" disabled={disabled || reading} onClick={() => void check(draft)}>{reading ? 'Checking…' : 'Check original creation'}</button>
      {!complete ? <button type="button" className="small-button" disabled={disabled || draft.kind === 'goal-coordinator-create' && draft.submitted && !draft.acknowledged && !recovery}
        onClick={() => void send(draft, draft.submitted)}>{draft.submitted ? 'Continue original creation' : 'Save request and create once'}</button> : null}
      <details><summary>Original request details</summary><pre>{JSON.stringify({ draft, observation: observed }, null, 2)}</pre></details>
    </div> : <p className="goals-service" role="status">The original creation uses an unreadable format. Its complete input is retained; no replacement Agent was requested.</p>
      : editing ? <><button type="button" className="small-button" disabled={disabled} onClick={() => void chooseFolder()}>Choose local folder…</button>
        <SourceAgentTargetSetup key={chosenFolder} config={config} active={!disabled} actionLabel="Use project and Agent device" preparationNote="Create the Agent next. Creation sends no task." disabled={disabled}
          initialSelection={chosenFolder ? { resourceWorkspaceId: chosenFolder, agentWorkspaceId: null }
            : selection ? { resourceWorkspaceId: selection.project.id, agentWorkspaceId: null, source: selection } : undefined}
          onApply={value => { if (!value.source) return false; onSelection(value.source); setEditing(false) }} /></>
      : <><div className="goal-agent-picker__locations"><strong>{selection?.project.path}</strong>
        <span>{selection?.kind === 'source-coordinator' ? `Reach · ${config.hosts.find(host => host.id === selection.coordinator.hostId)?.label ?? selection.coordinator.hostId}; files on the project device`
          : selection?.agentTarget.runtimeId === selection?.target.reference.runtimeId ? 'Agent runs on the project device'
            : `Agent target · ${selection?.agentTarget.hostId ?? 'Unconfirmed'}${selection?.agentTarget.adoptedRoute ? ` · ${selection.agentTarget.adoptedRoute.hops.length} hops` : ''} · Runtime ${compactReferenceId(selection?.agentTarget.runtimeId ?? '')}`}</span>
        <details className="goal-team__identity-details"><summary>Project and Agent references</summary><code>{JSON.stringify(selection)}</code></details>
        <button type="button" className="small-button" disabled={disabled} onClick={() => setEditing(true)}>Edit project and Agent device</button></div>
        <SelectionField label="New Goal Agent configuration" value={launcher.executorId ?? ''} disabled={disabled}
          options={launcher.executors.map(value => ({ value: value.id, label: value.label, description: value.providerId }))}
          onValueChange={executorId => { if (selection) onSelection({ ...selection, executorId }) }} />
        <button type="button" className="small-button" disabled={disabled} onClick={launcher.refresh}>Refresh configurations</button>
        <button type="button" className="primary-button" disabled={disabled || !launcher.ready} onClick={create}>Create Agent</button>
        {launcher.issue ? <p className="goals-service" role="status">{launcher.issue}</p> : null}</>}
    {raw === undefined || draft ? <p className="goals-caption">Creation sends no task. Save this Agent’s relationship separately.</p> : null}
    {issue ? <p className="goals-service" role="status">{issue}</p> : null}
  </div>
}
