import { useEffect, useRef, useState, type ReactNode } from 'react'
import { GitFork, Search, X } from 'lucide-react'
import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { type OpenDestination, type OpenHttpLinkOrigin } from '../lib/open-destination'
import { CURRENT_FORK_DESTINATIONS, currentForkRequest, currentForkSourceMatches, currentForkUnavailableReason,
  retainedCurrentForkOperation, reviewCurrentFork, type CurrentForkReview, type CurrentForkSession } from '../lib/agent-current-fork'
import { OpenDestinationBar } from './OpenDestinationBar'
import * as DropdownMenu from './HoverDropdownMenu'
import '../styles/agent-current-fork.css'

type ForkState = { review: CurrentForkReview | null; operationId: string | null; busy: boolean;
  report: AgentMuxSpaceMutationReport | null; notice: string | null }
const emptyState = (): ForkState => ({ review: null, operationId: null, busy: false, report: null, notice: null })
type Controls = { reason: string | null; readOnly: boolean; state: ForkState; begin(): void; cancel(): void;
  select(destination: OpenDestination): void; inspect(): void }

/** Lives with SessionPane, outside the dismissible menu, so an unknown operation is retained. */
export function useAgentCurrentForkControls({ session, linkOrigin, readOnly }: {
  session: CurrentForkSession | null; linkOrigin: OpenHttpLinkOrigin; readOnly: boolean
}): ReactNode {
  function restoredState(): ForkState {
    const current = useAppStore.getState()
    const operationId = retainedCurrentForkOperation(session, current.spatialRequests ?? {})
    return { ...emptyState(), operationId, notice: operationId ? 'Earlier fork operation retained. Check its receipt without repeating creation.' : null }
  }
  const [state, setState] = useState<ForkState>(restoredState)
  const stateRef = useRef(state)
  const mounted = useRef(true)
  const owner = useRef(session?.id)
  stateRef.current = state
  function update(next: ForkState) { stateRef.current = next; if (mounted.current) setState(next) }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (owner.current !== session?.id) { owner.current = session?.id; update(restoredState()) }
  }, [session?.id])
  const reason = currentForkUnavailableReason(session, linkOrigin, readOnly)
  function currentSession(review: CurrentForkReview) {
    const current = useAppStore.getState().sessions.find(value => value.id === review.source.agentSessionId)
    return current?.kind === 'agent' ? current : null
  }
  function requireOriginalRegion(review: CurrentForkReview) {
    const surface = useAppStore.getState().tabs[review.origin.tabId]?.regions[review.origin.regionId]
    if (surface?.kind !== 'agent' || surface.sessionId !== review.source.agentSessionId) {
      throw new Error('The original Region no longer contains the reviewed Agent Session.')
    }
    if (!currentForkSourceMatches(review, currentSession(review))) throw new Error('The reviewed source conversation changed. Review its current identity before this fork.')
  }
  function publish(operationId: string, patch: Partial<ForkState>) {
    if (stateRef.current.operationId === operationId) update({ ...stateRef.current, ...patch })
  }
  async function select(destination: OpenDestination) {
    const review = stateRef.current.review
    if (!review || stateRef.current.busy || readOnly) return
    // Lock this operation synchronously, before the first await or another click.
    update({ ...stateRef.current, busy: true, notice: null })
    let dispatched = false
    try {
      requireOriginalRegion(review)
      const inspected = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: `fork-location:${crypto.randomUUID()}`,
        operation: 'space.inspect', target: { tabId: review.origin.tabId, regionId: review.origin.regionId,
          displayWorkspaceId: review.origin.workspaceId, groupId: review.origin.tabGroupId } })
      if (inspected.operation !== 'space.inspect') throw new Error('The original location inspection returned an unrelated result.')
      requireOriginalRegion(review)
      const current = useAppStore.getState(), layout = current.layouts[review.origin.workspaceId]
      const group = layout?.groups.find(value => value.id === review.origin.tabGroupId)
      const focus = current.mainSurface === 'workbench' && current.activeWorkspaceId === review.origin.workspaceId &&
        layout?.activeGroupId === review.origin.tabGroupId && group?.activeTabId === review.origin.tabId &&
        current.tabs[review.origin.tabId]?.layout.activeRegionId === review.origin.regionId
      const request = currentForkRequest(review, currentSession(review), inspected.catalog, destination, focus)
      dispatched = true
      publish(review.operationId, { review: null })
      const result = await current.executeControl(request)
      if (result.operation !== 'agent.open') throw new Error('Fork returned an unrelated receipt. Inspect its original operation.')
      publish(review.operationId, { report: result, notice: null })
    } catch (cause) {
      publish(review.operationId, { review: null, notice: `${presentError(cause)}${dispatched ? ' Inspect this operation; do not repeat creation.' : ' Fork was not dispatched.'}`,
        ...(!dispatched ? { operationId: null, busy: false } : {}) })
    } finally { publish(review.operationId, { busy: false }) }
  }
  async function inspect() {
    const operationId = stateRef.current.operationId
    if (!operationId || stateRef.current.busy || readOnly) return
    update({ ...stateRef.current, busy: true, notice: null })
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: `fork-check:${crypto.randomUUID()}`,
        operation: 'space.inspect', target: { requestId: operationId } })
      if (result.operation !== 'space.inspect') throw new Error('Operation inspection returned an unrelated result.')
      publish(operationId, { report: result.request?.report ?? null, notice: result.request?.known
        ? result.request.report ? null : 'The original operation is known; its result remains unconfirmed.'
        : 'The original operation has not been observed. Creation has not been repeated.' })
    } catch (cause) { publish(operationId, { notice: presentError(cause) }) }
    finally { publish(operationId, { busy: false }) }
  }
  if (!session) return null
  return <AgentCurrentForkControls reason={reason} readOnly={readOnly} state={state} begin={() => {
    if (reason || stateRef.current.busy || stateRef.current.operationId && stateRef.current.report?.outcome !== 'opened') return
    const review = reviewCurrentFork(session, linkOrigin, crypto.randomUUID())
    update({ ...emptyState(), operationId: review.operationId, review })
  }} cancel={() => { if (!stateRef.current.busy && stateRef.current.review) update(emptyState()) }}
    select={destination => { void select(destination) }} inspect={() => { void inspect() }} />
}

/** Menu presentation only. Closing/Escape unmounts this view, not its operation controller. */
export function AgentCurrentForkControls({ reason, readOnly, state, begin, cancel, select, inspect }: Controls) {
  const reviewRef = useRef<HTMLDivElement>(null)
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
  const pending = state.operationId && !state.review && state.report?.outcome !== 'opened'
  return <>
    <DropdownMenu.Item className="tab-context-menu__item" data-current-fork-action=""
      disabled={Boolean(reason || state.busy || pending)} onSelect={event => { event.preventDefault(); begin() }}>
      <GitFork size={14} /><span>Fork current conversation…</span>
    </DropdownMenu.Item>
    {reason ? <DropdownMenu.Label className="agent-region-menu__context agent-current-fork"><span>{reason}</span></DropdownMenu.Label> : null}
    {state.review ? <div className="agent-current-fork agent-current-fork__review" data-current-fork-review="" ref={reviewRef}
      onKeyDown={event => { if (event.key === 'Escape' && !state.busy) { cancelReview(); event.preventDefault(); event.stopPropagation() } }}>
      <strong>Fork current conversation</strong>
      <span>Source: {state.review.source.expectedNativeHandle.sessionId}</span>
      <span>Run: {state.review.source.expectedRun.runId}</span>
      <span>Choose a new Tab or split. The original Agent stays here.</span>
      {state.busy || readOnly ? <span>{state.busy ? 'Checking the exact source and location…' : 'This view is read-only.'}</span>
        : <OpenDestinationBar canSplit allowedDestinations={CURRENT_FORK_DESTINATIONS}
          accessibleContext="Choose where to fork the current conversation" onSelect={select} />}
      <button type="button" className="agent-current-fork__cancel" disabled={state.busy} onClick={cancelReview}><X size={13} />Cancel fork</button>
    </div> : null}
    {state.operationId && !state.review ? <DropdownMenu.Label className="agent-region-menu__context agent-current-fork" data-current-fork-operation={state.operationId}>
      <strong>{state.busy ? 'Checking fork…' : state.report?.outcome === 'opened' ? 'Fork opened' : 'Fork needs review'}</strong>
      <span>Operation: {state.operationId}</span>
      {state.report?.agent ? <span>New Session: {state.report.agent.agentSessionId}{state.report.agent.runId ? ` · Run: ${state.report.agent.runId}` : ' · Run unknown'}</span> : null}
      {state.report?.to ? <span>Region: {state.report.to.regionId}</span> : null}
      {state.report?.issues.map((issue, index) => <span key={`${issue.step}:${index}`}>{issue.step}: {issue.message} {issue.recovery}</span>)}
      {state.report?.outcome !== 'opened' ? <span>The original Agent remains available. Check this operation without repeating creation.</span> : null}
    </DropdownMenu.Label> : null}
    {state.notice ? <DropdownMenu.Label className="agent-region-menu__context agent-current-fork"><span role="status">{state.notice}</span></DropdownMenu.Label> : null}
    {state.operationId && !state.review ? <DropdownMenu.Item className="tab-context-menu__item" disabled={state.busy || readOnly}
      onSelect={event => { event.preventDefault(); inspect() }}><Search size={14} /><span>Check fork operation</span></DropdownMenu.Item> : null}
    <DropdownMenu.Separator className="tab-context-menu__separator" />
  </>
}
