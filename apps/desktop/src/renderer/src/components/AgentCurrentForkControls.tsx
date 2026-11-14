import { mintObjectId } from '@agentmux/core/object-id'
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { Button } from '@agentmux/client-ui/components/Button'
import { useAppStore } from '../store'
import { type OpenDestination, type OpenHttpLinkOrigin } from '../lib/open-destination'
import { CURRENT_FORK_DESTINATIONS, currentForkRequest, currentForkSourceMatches, currentForkUnavailableReason,
  retainedCurrentForkOperation, reviewCurrentFork, type CurrentForkReview, type CurrentForkSession } from '../lib/agent-current-fork'
import { OpenDestinationBar } from './OpenDestinationBar'
import { WorkbenchMenuScope, WorkbenchMenuSubmit } from './WorkbenchMenuScope'
import { agentOperationKey, beginAgentOperation, settleAgentCreation, updateAgentOperation, type AgentOperationFeedback } from '../lib/agent-operation-feedback'
import { SelectionField } from './SelectionField'
import { agentNewTabDestinations, requireAgentNewTabDestination, type AgentNewTabDestination } from '../lib/agent-new-tab-destination'
import { spatialCatalog } from '../lib/space-agent-control'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'

const ConversationForkIcon = semanticIconComponent('action.fork-conversation')
const DerivedActionIcon = semanticIconComponent('action.derived-action')
const ThemeActionCancelIcon = semanticIconComponent('action.cancel')
const ThemeActionSearchIcon = semanticIconComponent('action.search')


type ForkState = { review: CurrentForkReview | null; operationId: string | null; busy: boolean; dispatching: boolean;
  report: AgentMuxSpaceMutationReport | null; notice: string | null; operation: AgentOperationFeedback | null; destinations?: ReturnType<typeof agentNewTabDestinations> }
const emptyState = (): ForkState => ({ review: null, operationId: null, busy: false, dispatching: false, report: null, notice: null, operation: null })
const creationSettled = (report: AgentMuxSpaceMutationReport | null | undefined) => report?.outcome === 'opened' || report?.outcome === 'retired'
type Controls = { reason: string | null; readOnly: boolean; unsettled: boolean; state: ForkState; derived?: CurrentForkReview['derived'] | undefined; begin(): void; cancel(): void;
  select(destination: OpenDestination, newTab: AgentNewTabDestination | undefined, submitted: () => void): void; inspect(): void }

function forkControlsCleanup(mounted: { current: boolean }): () => void {
  return () => { mounted.current = false }
}

/** Lives with SessionPane, outside the dismissible menu, so an unknown operation is retained. */
export function useAgentCurrentForkControls({ session, linkOrigin, readOnly, sessionSource = false }: {
  session: CurrentForkSession | null; linkOrigin: Partial<OpenHttpLinkOrigin>; readOnly: boolean; sessionSource?: boolean
}): (origin?: Partial<OpenHttpLinkOrigin>, derived?: CurrentForkReview['derived']) => ReactNode {
  function restoredState(): ForkState {
    const current = useAppStore.getState()
    const operationId = retainedCurrentForkOperation(session, current.spatialRequests ?? {})
    const operation: AgentOperationFeedback | null = operationId && session ? { kind: 'fork', operationId, phase: 'unconfirmed', startedAt: Date.now(),
      subject: { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId, regionId: linkOrigin.regionId } } : null
    return { ...emptyState(), operationId, operation, notice: operationId ? 'Earlier fork operation retained. Check its receipt without repeating creation.' : null }
  }
  const [state, setState] = useState<ForkState>(restoredState)
  const operationKey = state.operation ? agentOperationKey(state.operation) : null
  const sharedOperation = useAppStore(current => operationKey ? current.agentOperations[operationKey] : undefined)
  const stateRef = useRef(state)
  const mounted = useRef(true)
  const ownerKey = JSON.stringify([session?.id, session?.control.hostId, session?.control.agentSessionId, session?.control.run.runId])
  const owner = useRef(ownerKey)
  const receiptRevision = useRef(0)
  stateRef.current = state
  function update(next: ForkState) { stateRef.current = next; if (mounted.current) setState(next) }
  useEffect(() => { mounted.current = true; return forkControlsCleanup(mounted) }, [])
  useEffect(() => {
    if (owner.current !== ownerKey) { owner.current = ownerKey; update(restoredState()) }
  }, [ownerKey])
  useEffect(() => { if (state.operation && !state.review) beginAgentOperation(state.operation) }, [state.operation, state.review])
  useEffect(() => {
    if (sharedOperation?.report && stateRef.current.operationId === sharedOperation.operationId && stateRef.current.report !== sharedOperation.report) {
      receiptRevision.current += 1
      update({ ...stateRef.current, report: sharedOperation.report, notice: sharedOperation.message ?? null })
    }
  }, [sharedOperation])
  function currentSession(review: CurrentForkReview) {
    const matches = useAppStore.getState().sessions.filter((value): value is CurrentForkSession => value.kind === 'agent' && value.id === review.origin.sessionId &&
      value.control.agentSessionId === review.source.agentSessionId && value.control.hostId === review.hostId)
    return matches.length === 1 ? matches[0]! : null
  }
  function requireOriginalRegion(review: CurrentForkReview) {
    const surface = review.origin.tabId && review.origin.regionId ? useAppStore.getState().tabs[review.origin.tabId]?.regions[review.origin.regionId] : undefined
    if (review.placement === 'region' && (surface?.kind !== 'agent' || surface.sessionId !== review.origin.sessionId)) {
      throw new Error('The original Region no longer contains the reviewed Agent Session.')
    }
    if (!currentForkSourceMatches(review, currentSession(review))) throw new Error('The reviewed source conversation changed. Review its current identity before this fork.')
  }
  function publish(operationId: string, patch: Partial<ForkState>) {
    if (stateRef.current.operationId === operationId) {
      if ('report' in patch) receiptRevision.current += 1
      update({ ...stateRef.current, ...patch })
    }
  }
  function observedOperation(operation: AgentOperationFeedback) {
    return useAppStore.getState().agentOperations[agentOperationKey(operation)]
  }
  function acceptReport(operation: AgentOperationFeedback, report: AgentMuxSpaceMutationReport) {
    const held = observedOperation(operation)
    const previous = held?.report ?? (stateRef.current.operationId === operation.operationId ? stateRef.current.report : null)
    // Successful decoration may already be dismissed. Its original receipt still
    // fences an older unknown reply and a retired child never becomes live again.
    if (previous?.outcome === 'retired' || previous?.agent &&
      (previous.outcome === 'opened' || previous.outcome === 'partial') && report.outcome !== 'opened' && report.outcome !== 'retired') {
      if (held) settleAgentCreation(operation, previous)
      return previous
    }
    settleAgentCreation(operation, report)
    return observedOperation(operation)?.report ?? null
  }
  async function select(destination: OpenDestination, newTab: AgentNewTabDestination | undefined, submitted: () => void) {
    const review = stateRef.current.review
    if (!review || stateRef.current.busy || stateRef.current.dispatching || readOnly) return
    const operation: AgentOperationFeedback = { kind: 'fork', operationId: review.operationId,
      subject: { hostId: review.hostId, agentSessionId: review.source.agentSessionId, regionId: review.origin.regionId },
      phase: 'pending', startedAt: Date.now() }
    // Freeze and retain the submitted intent before yielding the menu or awaiting preparation.
    beginAgentOperation(operation)
    update({ ...stateRef.current, review: null, operation, busy: true, notice: null })
    submitted()
    let dispatched = false
    try {
      requireOriginalRegion(review)
      const target = review.placement === 'session'
        ? newTab ? { zoneId: newTab.zoneId, ...(newTab.spaceId ? { spaceId: newTab.spaceId } : {}), displayWorkspaceId: newTab.displayWorkspaceId, groupId: newTab.groupId } : null
        : { tabId: review.origin.tabId!, regionId: review.origin.regionId!, displayWorkspaceId: review.origin.workspaceId!, groupId: review.origin.tabGroupId! }
      if (!target) throw new Error('Choose an existing destination for this new Tab.')
      const inspected = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: `fork-location:${mintObjectId()}`,
        operation: 'space.inspect', target })
      if (inspected.operation !== 'space.inspect') throw new Error('The original location inspection returned an unrelated result.')
      requireOriginalRegion(review)
      const current = useAppStore.getState(), layout = review.origin.workspaceId ? current.layouts[review.origin.workspaceId] : undefined
      const group = layout?.groups.find(value => value.id === review.origin.tabGroupId)
      const focus = current.mainSurface === 'workbench' && current.activeWorkspaceId === review.origin.workspaceId &&
        layout?.activeGroupId === review.origin.tabGroupId && group?.activeTabId === review.origin.tabId &&
        Boolean(review.origin.tabId && current.tabs[review.origin.tabId]?.layout.activeRegionId === review.origin.regionId)
      const confirmedDestination = review.placement === 'session' && newTab ? requireAgentNewTabDestination(newTab, inspected.catalog, current.layouts, { hostId: review.hostId }) : undefined
      const request = currentForkRequest(review, currentSession(review), inspected.catalog, destination, focus, confirmedDestination)
      dispatched = true
      publish(review.operationId, { busy: false, dispatching: true })
      const result = await current.executeControl(request)
      if (result.operation !== 'agent.open') throw new Error('Fork returned an unrelated receipt. Inspect its original operation.')
      const report = acceptReport(operation, result)
      publish(review.operationId, { report, notice: observedOperation(operation)?.message ?? null })
    } catch (cause) {
      const notice = `${presentError(cause)}${dispatched ? ' Inspect this operation; do not repeat creation.' : ' Fork was not dispatched.'}`
      const held = observedOperation(operation)
      updateAgentOperation(operation, { phase: held?.report?.agent ? held.phase : dispatched ? 'unconfirmed' : 'failed', message: notice })
      publish(review.operationId, { notice, ...(!dispatched ? { operationId: null, busy: false } : {}) })
    } finally { publish(review.operationId, dispatched ? { dispatching: false } : { busy: false }) }
  }
  async function inspect() {
    const { operationId, operation } = stateRef.current
    if (!operationId || !operation || stateRef.current.busy || readOnly) return
    beginAgentOperation({ ...operation, phase: 'unconfirmed', ...(stateRef.current.report ? { report: stateRef.current.report } : {}) })
    const revision = receiptRevision.current, observed = observedOperation(operation)
    update({ ...stateRef.current, busy: true, notice: null })
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: `fork-check:${mintObjectId()}`,
        operation: 'space.inspect', target: { requestId: operationId } })
      if (result.operation !== 'space.inspect') throw new Error('Operation inspection returned an unrelated result.')
      // Both menu and card inspections are fenced behind a newer original-operation receipt.
      if (receiptRevision.current !== revision || observedOperation(operation) !== observed) return
      const report = result.request?.report ? acceptReport(operation, result.request.report) : null
      const notice = result.request?.known ? report ? null : 'The original operation is known; its result remains unconfirmed.'
        : 'The original operation has not been observed. Creation has not been repeated.'
      if (!report) updateAgentOperation(operation, { phase: observed?.report?.agent ? observed.phase : 'unconfirmed', message: notice ?? undefined })
      publish(operationId, { report: report ?? observed?.report ?? null, notice })
    } catch (cause) {
      if (receiptRevision.current === revision && observedOperation(operation) === observed) {
        updateAgentOperation(operation, { phase: observed?.report?.agent ? observed.phase : 'unconfirmed', message: presentError(cause) })
        publish(operationId, { notice: presentError(cause) })
      }
    } finally { publish(operationId, { busy: false }) }
  }
  return (origin = linkOrigin, derived) => {
    if (!session) return null
    const reason = currentForkUnavailableReason(session, origin, readOnly, sessionSource)
    // One controller per Session: the official Fork and each fork-based action share its operation and receipt.
    const mine = (state.review?.derived?.id ?? null) === (derived?.id ?? null)
    const presented = sharedOperation?.report ? { ...state, report: sharedOperation.report } : state
    return <AgentCurrentForkControls reason={reason} readOnly={readOnly} unsettled={Boolean(state.operationId && !state.review && !creationSettled(presented.report))}
      state={mine ? presented : { ...emptyState(), busy: state.busy, dispatching: state.dispatching }} derived={derived} begin={() => {
      const operationState = stateRef.current, report = operationState.operation ? observedOperation(operationState.operation)?.report ?? operationState.report : operationState.report
      if (reason || operationState.review && operationState.busy || operationState.operationId && !creationSettled(report)) return
      const review = reviewCurrentFork(session, origin, mintObjectId(), sessionSource, derived)
      const current = useAppStore.getState()
      update({ ...emptyState(), operationId: review.operationId, review, ...(sessionSource ? { destinations: agentNewTabDestinations(spatialCatalog(current, scratchTopicsForConfig(current.config, current.scratchTopicSnapshots) ?? []), current.layouts, { hostId: session.control.hostId }) } : {}) })
    }} cancel={() => { if (!stateRef.current.busy && stateRef.current.review) update(emptyState()) }}
      select={(destination, newTab, submitted) => { void select(destination, newTab, submitted) }} inspect={() => { void inspect() }} />
  }
}

/** Menu presentation only. Closing/Escape unmounts this view, not its operation controller. */
export function AgentCurrentForkControls({ reason, readOnly, unsettled, state, derived, begin, cancel, select, inspect }: Controls) {
  const DropdownMenu = useContext(WorkbenchMenuScope)
  const submitted = useContext(WorkbenchMenuSubmit)
  const reviewRef = useRef<HTMLDivElement>(null)
  const [destinationKey, setDestinationKey] = useState('')
  const selectedDestination = state.destinations?.find(item => item.value === destinationKey)?.destination
  useEffect(() => {
    // Radix owns menu focus; enter the existing toolbar when it becomes the reviewed action.
    if (state.review) reviewRef.current?.querySelector<HTMLButtonElement>('button[data-destination]:not([disabled])')?.focus()
  }, [state.review?.operationId])
  useEffect(() => {
    if (!state.review) return
    // The menu's document Escape listener dismisses before a React bubble handler can run.
    // Cancel the reviewed intent first; Radix still owns dismissal and returning focus.
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !state.busy && reviewRef.current?.contains(document.activeElement)) cancel()
    }
    window.addEventListener('keydown', cancelOnEscape, true)
    return () => window.removeEventListener('keydown', cancelOnEscape, true)
  }, [state.review?.operationId, state.busy, cancel])
  function cancelReview() {
    reviewRef.current?.closest('[role=menu]')?.querySelector<HTMLElement>('[data-current-fork-action]')?.focus()
    cancel()
  }
  return <>
    <DropdownMenu.Item className="tab-context-menu__item" data-current-fork-action={derived ? undefined : ''} data-derived-action={derived?.id}
      disabled={Boolean(reason || state.review && state.busy || unsettled)} onSelect={event => { event.preventDefault(); begin() }}>
      {derived ? <DerivedActionIcon size={14} /> : <ConversationForkIcon size={14} />}<span>{derived ? `${derived.label}…` : 'Fork current conversation…'}</span>
    </DropdownMenu.Item>
    {reason && !derived ? <DropdownMenu.Label className="agent-region-menu__context agent-current-fork"><span>{reason}</span></DropdownMenu.Label> : null}
    {state.review ? <div className="agent-current-fork agent-current-fork__review" data-current-fork-review="" ref={reviewRef}
      onKeyDown={event => { if (event.key === 'Escape' && !state.busy) { cancelReview(); event.preventDefault(); event.stopPropagation() } }}>
      <strong>{state.review.derived ? state.review.derived.label : 'Fork current conversation'}</strong>
      {state.review.derived ? <span className="agent-current-fork__instruction">{state.review.derived.instruction.trim()}</span> : null}
      <span>Source: {state.review.source.expectedNativeHandle.sessionId}</span>
      <span>Run: {state.review.source.expectedRun.runId}</span>
      <span>{state.review.placement === 'session' ? 'Choose an existing Space, Zone and Group for a new Tab. The original Agent stays here.' : 'Choose a new Tab or split. The original Agent stays here.'}</span>
      {state.busy || readOnly ? <span>{state.busy ? 'Checking the exact source and location…' : 'This view is read-only.'}</span>
        : state.review.placement === 'session' ? <>
          <SelectionField label="Fork destination" value={destinationKey} onValueChange={setDestinationKey} options={[{ value: '', label: 'Choose an existing destination' }, ...state.destinations ?? []]} />
          {!state.destinations?.length ? <span>No existing destination is confirmed. Keep this Agent and choose an available Space first.</span> : null}
          <Button type="button" disabled={!selectedDestination} onClick={() => select('tab', selectedDestination, submitted)}>Fork in new Tab</Button>
        </> : <OpenDestinationBar canSplit allowedDestinations={CURRENT_FORK_DESTINATIONS}
          accessibleContext="Choose where to fork the current conversation" onSelect={destination => select(destination, undefined, submitted)} />}
      <button type="button" className="agent-current-fork__cancel" disabled={state.busy} onClick={cancelReview}><ThemeActionCancelIcon size={13} />Cancel fork</button>
    </div> : null}
    {state.operationId && !state.review ? <DropdownMenu.Label className="agent-region-menu__context agent-current-fork" data-current-fork-operation={state.operationId}>
      <strong>{state.busy ? 'Checking fork…' : state.report?.outcome === 'retired' ? 'Fork target closed' : state.report?.outcome === 'opened' ? 'Fork opened' : state.dispatching ? 'Fork request pending' : 'Fork needs review'}</strong>
      <span>Operation: {state.operationId}</span>
      {state.report?.agent ? <span>New Session: {state.report.agent.agentSessionId}{state.report.agent.runId ? ` · Run: ${state.report.agent.runId}` : ' · Run unknown'}</span> : null}
      {state.report?.to ? <span>Region: {state.report.to.regionId}</span> : null}
      {state.report?.issues.map((issue, index) => <span key={`${issue.step}:${index}`}>{issue.step}: {issue.message} {issue.recovery}</span>)}
      {state.report?.outcome !== 'opened' ? <span>The original Agent remains available. Check this operation without repeating creation.</span> : null}
    </DropdownMenu.Label> : null}
    {state.notice ? <DropdownMenu.Label className="agent-region-menu__context agent-current-fork"><span role="status">{state.notice}</span></DropdownMenu.Label> : null}
    {state.operationId && !state.review ? <DropdownMenu.Item className="tab-context-menu__item" disabled={state.busy || readOnly}
      onSelect={event => { event.preventDefault(); inspect() }}><ThemeActionSearchIcon size={14} /><span>Check fork operation</span></DropdownMenu.Item> : null}
  </>
}
