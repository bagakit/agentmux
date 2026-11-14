import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MoteIcon } from '@agentmux/client-ui/components/MoteIcon'
import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { hostExecutorInventoryMatches, executorsForHost } from '../lib/executors'
import { focusTakeoverResult, inspectTakeover, inspectTakeoverClub, prepareTakeoverClub, retainsTakeoverRequest, takeoverOperationSubject, takeOverSession, type TakeoverSource } from '../lib/session-takeover'
import { agentOperationsForSubject, type AgentOperationFeedback } from '../lib/agent-operation'
import { useAppStore } from '../store'
import { AgentExecutorPicker } from './AgentExecutorPicker'
import { AgentAvatar } from './AgentAvatar'
import { SelectionField } from './SelectionField'
import { agentNewTabDestinations } from '../lib/agent-new-tab-destination'
import { spatialCatalog } from '../lib/space-agent-control'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { topicSpatialAddress } from '../../../shared/space-addresses'
import { AgentPromotionRecovery } from './AgentPromotionRecovery'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { homeZoneId } from '../../../shared/space-addresses'

const ThemeNavigationForwardIcon = semanticIconComponent('navigation.forward')
const ThemeActionCancelIcon = semanticIconComponent('action.cancel')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeDerivedActionIcon = semanticIconComponent('action.derived-action')


/** A local workface transition. The underlying Session and editor stay mounted. */
export function SessionTakeoverSurface({ source, active, onClose, onOpened, onSubmitted, returnTrigger }: {
  source: TakeoverSource
  returnTrigger?: HTMLButtonElement | null
  active: boolean
  onClose(): void
  onOpened?(): void
  onSubmitted?(): void
}) {
  const config = useAppStore(state => state.config)
  const icons = useAppStore(state => state.spaceObjectIcons)
  const [workingSource, setWorkingSource] = useState(source)
  const subject = takeoverOperationSubject(source)
  const operations = useAppStore(useShallow(state => source.derived || !source.hostId ? [] : agentOperationsForSubject(state.agentOperations, subject)
    .filter((operation): operation is Extract<AgentOperationFeedback, { kind: 'takeover' }> => operation.kind === 'takeover' &&
      operation.phase !== 'succeeded' && operation.phase !== 'cancelled' && Boolean(operation.takeoverSource.clubPreparation || operation.takeoverSource.coreRequest))))
  const facts = useAppStore(useShallow(state => ({ tabs: state.tabs, layouts: state.layouts, spaceZoneBindings: state.spaceZoneBindings,
    scratchTopicSnapshots: state.scratchTopicSnapshots, topicCategories: state.topicCategories, projectGroups: state.projectGroups })))
  const catalog = useMemo(() => {
    const state = useAppStore.getState()
    return spatialCatalog(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? [])
  }, [config, facts])
  const placements = useMemo(() => Object.entries(facts.layouts).flatMap(([displayWorkspaceId, layout]) => layout.groups.map((group, index) => ({
    value: JSON.stringify([displayWorkspaceId, group.id]), displayWorkspaceId, groupId: group.id,
    label: `${config?.workspaces.find(workspace => workspace.id === displayWorkspaceId)?.name ?? 'Workspace'} · Group ${index + 1}`
  }))), [facts.layouts, config?.workspaces])
  const initialPlacement = { displayWorkspaceId: source.destination?.displayWorkspaceId ?? source.origin.workspaceId, groupId: source.destination?.groupId ?? source.origin.tabGroupId }
  const [placementKey, setPlacementKey] = useState(JSON.stringify([initialPlacement.displayWorkspaceId, initialPlacement.groupId]))
  const placement = placements.find(item => item.value === placementKey)
  // Resource and display choices remain independent: mounting a menu never creates
  // every Zone × display Group combination in this window.
  const destinations = useMemo(() => (placement ? agentNewTabDestinations(catalog, facts.layouts, undefined, placement) : [])
    .filter(item => source.destinationKind !== 'club' || catalog.spaces.some(space => space.spaceId === item.destination.spaceId && space.kind === 'mote'))
    .sort((a, b) => Number(catalog.spaces.find(space => space.spaceId === b.destination.spaceId)?.kind === 'mote') -
      Number(catalog.spaces.find(space => space.spaceId === a.destination.spaceId)?.kind === 'mote'))
    .map(item => {
      const space = catalog.spaces.find(space => space.spaceId === item.destination.spaceId)
      const workspace = config?.workspaces.find(workspace => workspace.id === item.destination.displayWorkspaceId)
      const group = facts.layouts[item.destination.displayWorkspaceId]?.groups.findIndex(group => group.id === item.destination.groupId)
      const home = space ? catalog.zones.find(zone => zone.zoneId === homeZoneId(space.spaceId)) : undefined
      return { ...item, label: `${space?.name ?? 'Unbound Zone'} · ${workspace?.name ?? 'Workspace'}${group === undefined ? '' : ` · Group ${group + 1}`}`,
        ...(space?.kind === 'mote' ? { icon: <SpaceObjectIcon kind="mote" name={space.name} manualIcon={icons[space.spaceId] ?? null}
          avatarObjectKey={space.spaceId} avatarWorkspaceId={home?.workspaceId ?? undefined} avatarTopicId={space.topicId ?? undefined} visible={false} /> } : {}) }
    }), [catalog, facts.layouts, config?.workspaces, source.destinationKind, icons, placement])
  const initialDestination = source.destination ?? (source.destinationKind !== 'club' && placement ? (() => {
    const locations = catalog.locations.filter(item => item.tabId === source.origin.tabId && item.regionId === source.origin.regionId &&
      item.displayWorkspaceId === source.origin.workspaceId && item.groupId === source.origin.tabGroupId)
    const exact = locations.length ? destinations.filter(item => locations.some(location =>
      item.destination.zoneId === location.zoneId && item.destination.spaceId === location.spaceId)) : source.origin.workspaceId ? destinations.filter(item =>
      catalog.zones.some(zone => zone.zoneId === item.destination.zoneId && zone.workspaceId === source.origin.workspaceId)) : []
    return exact.length === 1 ? exact[0]!.destination : undefined
  })() : undefined)
  const resourceKey = (value: { zoneId: string; spaceId?: string }) => JSON.stringify([value.zoneId, value.spaceId ?? null])
  const [chosenResource, setChosenResource] = useState<string | null>(null)
  const selectedResource = chosenResource ?? (initialDestination ? resourceKey(initialDestination) : '')
  const destination = destinations.find(item => resourceKey(item.destination) === selectedResource)?.destination
  const destinationKey = destination ? JSON.stringify(destination) : selectedResource && placement ? (() => {
    const [zoneId, spaceId] = JSON.parse(selectedResource) as [string, string | null]
    return JSON.stringify({ zoneId, ...(spaceId ? { spaceId } : {}), displayWorkspaceId: placement.displayWorkspaceId, groupId: placement.groupId, newTab: true })
  })() : ''
  function setDestinationKey(value: string) {
    if (!value) { setChosenResource(''); return }
    const next = JSON.parse(value) as NonNullable<typeof destination>
    setPlacementKey(JSON.stringify([next.displayWorkspaceId, next.groupId]))
    setChosenResource(resourceKey(next))
  }
  const targetHostId = source.derived ? source.hostId : destination ? catalog.zones.find(zone => zone.zoneId === destination.zoneId)?.hostId ?? undefined : undefined
  const detections = useAppStore(state => state.executorDetections)
  const inventory = useAppStore(state => targetHostId ? state.hostExecutorInventories[targetHostId] : undefined)
  const detect = useAppStore(state => state.detectExecutors)
  const host = config?.hosts.find(item => item.id === targetHostId)
  // A derived action's default Agent comes first and takes the initial focus; choosing still submits once.
  const preferred = source.derived ? (useAppStore.getState().config?.agentDerivedActions?.actions ?? []).find(action => action.id === source.derived!.id)?.executorId : undefined
  const executors = useMemo(() => targetHostId ? executorsForHost(config, targetHostId, detections, inventory) : [], [config?.executors, detections, inventory, host, targetHostId])
  const surface = useRef<HTMLElement>(null)
  const admitted = useRef(false)
  const submitted = useRef(false)
  const mounted = useRef(true)
  const activeRef = useRef(active)
  const visibleRef = useRef(active)
  visibleRef.current = active
  const returnFocus = useRef<HTMLElement | null>(null)
  const cancelled = useRef(false)
  activeRef.current = active
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [closedRequest, setClosedRequest] = useState<string | null>(null)
  const [previousRequest, setPreviousRequest] = useState<string | undefined>()
  // A source taken over before keeps its deterministic request. A retirement Core confirms
  // before this choice is presented makes the choice itself the explicit successor.
  const earlierRetirement = useRef<Promise<string | undefined> | null>(null)
  const [closing, setClosing] = useState(false)
  const [creatingClub, setCreatingClub] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  activeRef.current = active && !closing
  function restoreFocus(node: HTMLElement, target: HTMLElement | null | undefined) {
    const document = node.ownerDocument
    const focused = document.activeElement
    if (visibleRef.current && target?.isConnected && target.ownerDocument === document &&
      !target.closest('[hidden], [inert], [aria-hidden="true"]') && !target.matches(':disabled, [aria-disabled="true"]') &&
      (focused === document.body || node.contains(focused))) target.focus({ preventScroll: true })
  }
  function close(cancel = true) {
    cancelled.current = cancel
    activeRef.current = false
    setClosing(true)
  }
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => {
      const node = surface.current
      onCloseRef.current()
      // Removing an inert local stage may leave focus on BODY. Return explicit
      // cancellation to its exact original trigger after the exit completes.
      if (cancelled.current && node) restoreFocus(node, returnFocus.current)
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140)
    return () => clearTimeout(timer)
  }, [closing])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!active || earlierRetirement.current) return
    // A failed read leaves the choice to the normal path, which re-inspects and reports it.
    const read = earlierRetirement.current = retainsTakeoverRequest(source)
      .then(retained => retained ? inspectTakeover(source) : null)
      .then(report => report?.outcome === 'retired' ? report.requestId : undefined, () => undefined)
    void read.then(requestId => { if (requestId && mounted.current && !admitted.current) setPreviousRequest(current => current ?? requestId) })
  }, [active, source])
  useEffect(() => {
    if (active && targetHostId && (host?.kind === 'ssh' ? !hostExecutorInventoryMatches(inventory, host) : executors.some(item => !item.detection))) void detect(targetHostId)
  }, [active, targetHostId, host, inventory, executors, detect])
  useLayoutEffect(() => {
    if (!active || closing || !surface.current) return
    const node = surface.current, parent = node.parentElement
    const originalHeader = [...document.querySelectorAll<HTMLElement>('.agent-region-header')].find(item =>
      item.dataset.agentSessionId === source.agentSessionId && item.dataset.ownerRegionId === source.origin.regionId)
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const recoveryTrigger = focused?.isConnected && focused.dataset.takeoverSessionId === source.agentSessionId &&
      focused.dataset.takeoverRegionId === source.origin.regionId ? focused : null
    const previous = returnTrigger ?? recoveryTrigger ?? originalHeader?.querySelector<HTMLElement>('.agent-region-header__more') ?? focused
    returnFocus.current = previous
    const held = Array.from(parent?.children ?? []).filter((item): item is HTMLElement => item instanceof HTMLElement && item !== node)
      .map(item => ({ item, inert: item.inert }))
    held.forEach(({ item }) => { item.inert = true })
    // The Region menu yields its close focus; the local surface owns entry focus,
    // including when the original Header is portalled into the Focus bar.
    const frame = requestAnimationFrame(() => (node.querySelector<HTMLButtonElement>('.selection-field:not(:disabled)') ?? node.querySelector<HTMLButtonElement>('.agent-pick:not(:disabled)') ??
      node.querySelector<HTMLButtonElement>('[aria-label="Cancel takeover"]'))?.focus({ preventScroll: true }))
    return () => {
      cancelAnimationFrame(frame)
      held.forEach(({ item, inert }) => { item.inert = inert })
      const target = previous?.isConnected ? previous : parent?.querySelector<HTMLElement>('.agent-region-header__more')
      restoreFocus(node, target)
    }
  }, [active, closing])
  async function accept(report: AgentMuxSpaceMutationReport) {
    if (!mounted.current || submitted.current) return
    if (report.outcome === 'opened') {
      const current = activeRef.current
      if (current) focusTakeoverResult(workingSource, report)
      close(false)
      if (current) onOpened?.()
      return
    }
    if (report.outcome === 'retired') {
      setClosedRequest(report.requestId)
      setUnconfirmed(false)
      setIssue('The takeover Agent was created and later closed. Your original session and work are kept. Choose another Agent to start a new takeover.')
      return
    }
    setClosedRequest(null)
    setUnconfirmed(true)
    setIssue(report.issues.map(item => item.message).join('\n') || 'The creation result is unconfirmed. Your original work is kept.')
  }
  async function choose(id: string) {
    if (admitted.current || !activeRef.current) return
    admitted.current = true
    // A focused choice becomes disabled while submitting. Keep keyboard cancel
    // inside the workface rather than letting Chromium drop focus to BODY.
    surface.current?.querySelector<HTMLButtonElement>('[aria-label="Cancel takeover"]')?.focus({ preventScroll: true })
    setSelected(id); setBusy(true); setIssue(null)
    try { await accept(await takeOverSession(destination ? { ...workingSource, destination } : workingSource, id,
      () => submitted.current || mounted.current && activeRef.current, previousRequest, operation => {
        // A public Takeover keeps its local progress and exact continuation visible until its receipt.
        // Custom derived actions retain their established background presentation.
        if (workingSource.derived) { submitted.current = true; close(false); onSubmitted?.() }
        else if (operation.kind === 'takeover') setWorkingSource(operation.takeoverSource)
      })) }
    catch (error) {
      if (mounted.current && !submitted.current) {
        setIssue(presentError(error))
        // A retained spatial intent may already have launched. Re-read it rather
        // than resubmitting after a transport/projection failure.
        setUnconfirmed(true)
      }
    } finally { if (mounted.current) setBusy(false) }
  }
  async function createClub() {
    if (creatingClub || busy || admitted.current || !activeRef.current) return
    setCreatingClub(true); setIssue(null)
    try {
      const result = await prepareTakeoverClub(workingSource, operation => { if (mounted.current) setWorkingSource(operation.takeoverSource) })
      if (!mounted.current || !activeRef.current) return
      const { topic } = result, state = useAppStore.getState(), address = result.address
      const existing = address && placement ? agentNewTabDestinations(spatialCatalog(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? []), state.layouts, undefined, placement)
        .filter(item => item.destination.spaceId === address.spaceId && item.destination.zoneId === address.zoneId) : []
      // Only the chosen confirmed Group can receive the newly prepared Club.
      setDestinationKey(existing.length === 1 ? existing[0]!.value : '')
      setUnconfirmed(false)
      setNotice('Club created. Choose its destination and an Agent to complete the second step. No Agent has been started.')
    } catch (cause) { if (mounted.current) { setUnconfirmed(true); setIssue(presentError(cause)) } }
    finally { if (mounted.current) setCreatingClub(false) }
  }
  async function check() {
    if (busy || !activeRef.current) return
    surface.current?.querySelector<HTMLButtonElement>('[aria-label="Cancel takeover"]')?.focus({ preventScroll: true })
    setBusy(true)
    try {
      if (workingSource.clubPreparation && !workingSource.coreRequest) {
        const topic = await inspectTakeoverClub(workingSource)
        setUnconfirmed(!topic)
        setIssue(topic ? null : 'The original Club is not yet confirmed. Continue this same preparation to establish it.')
        setNotice(topic ? 'The original Club is confirmed. Choose its destination and an Agent to take over.' : null)
        return
      }
      const report = await inspectTakeover(workingSource)
      if (report) await accept(report)
      else { admitted.current = false; setUnconfirmed(false); setSelected(null); setIssue(null); setClosedRequest(null); setPreviousRequest(undefined) }
    } catch (error) { if (mounted.current) setIssue(presentError(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  function chooseAnother() {
    if (busy || !activeRef.current || !closedRequest) return
    setPreviousRequest(closedRequest)
    const { coreRequest: _original, ...next } = workingSource
    setWorkingSource(next)
    setClosedRequest(null)
    admitted.current = false
    setUnconfirmed(false); setSelected(null); setIssue(null)
    requestAnimationFrame(() => { if (mounted.current && activeRef.current) surface.current?.querySelector<HTMLButtonElement>('.agent-pick:not(:disabled)')?.focus({ preventScroll: true }) })
  }
  async function resume(operation: Extract<AgentOperationFeedback, { kind: 'takeover' }>) {
    if (busy || !activeRef.current) return
    const held = operation.takeoverSource
    setWorkingSource(held); setNotice(null); setIssue(null); setPreviousRequest(undefined)
    admitted.current = false
    if (held.coreRequest) {
      setDestinationKey(JSON.stringify(held.coreRequest.destination))
      if (held.coreRequest.content.kind === 'takeover-agent') setSelected(held.coreRequest.content.executorId)
      setBusy(true)
      try { const report = await inspectTakeover(held); if (report) await accept(report) }
      catch (cause) { setUnconfirmed(true); setIssue(presentError(cause)) }
      finally { if (mounted.current) setBusy(false) }
    } else if (held.clubPreparation) {
      setUnconfirmed(true)
      setIssue('This original Club preparation is retained. Check its result or explicitly continue this same preparation.')
    }
  }
  const sourceExecutor = source.executorId ? config?.executors[source.executorId] : undefined
  const currentReport = workingSource.coreRequest ? operations.find(operation => operation.operationId === workingSource.coreRequest!.operationId)?.report : null
  function operationDestination(operation: Extract<AgentOperationFeedback, { kind: 'takeover' }>) {
    const held = operation.takeoverSource, request = held.coreRequest, prepared = held.clubPreparation
    if (request) {
      const space = catalog.spaces.find(space => space.spaceId === request.destination.spaceId)
      return space?.name ?? request.destination.spaceId ?? request.destination.zoneId ?? 'Original destination'
    }
    if (!prepared) return 'Original work'
    const workspace = config?.workspaces.find(workspace => workspace.id === prepared.expectedResource.workspaceId &&
      workspace.hostId === prepared.expectedResource.hostId && workspace.path === prepared.expectedResource.workspacePath)
    const topic = workspace ? scratchTopicsForConfig(config, facts.scratchTopicSnapshots)?.find(topic => topic.id === prepared.topicId) : undefined
    return topic?.title ?? prepared.topicId
  }
  const actionLabel = source.derived?.label ?? 'Next Agent'
  return <section ref={surface} className="session-takeover" aria-label={source.derived ? `${source.derived.label}: choose an Agent` : 'Take over this work'} data-derived-action={source.derived?.id} hidden={!active} inert={closing || !active}
    data-motion-active={active} data-state={closing ? 'closing' : 'open'} aria-busy={busy || creatingClub}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }}>
    <div className="session-takeover__content">
      <div className="session-takeover__origin">
        <AgentAvatar executorId={source.executorId} providerId={sourceExecutor?.providerId} label={source.label} size={22} />
        <span title={source.label}>{source.label}</span><ThemeNavigationForwardIcon size={14} aria-hidden="true" />
        <span className="session-takeover__destination">{source.derived ? <ThemeDerivedActionIcon size={13} aria-hidden="true" /> : null}<span>{destination ? destinations.find(item => item.value === destinationKey)?.label : actionLabel}</span></span>
      </div>
      <header className="session-takeover__heading">
        <div><h2>{source.derived ? source.derived.label : source.destinationKind === 'club' ? 'Continue in a Club.' : 'Keep the work moving.'}</h2><p>{source.derived ? 'Choose an Agent to start this from the original work.' : previousRequest ? 'The earlier takeover Agent was closed. Choose an Agent to take over again.' : source.destinationKind === 'club' ? 'Choose an existing team, then an Agent to take over there.' : 'Choose where the next Agent takes over.'}</p></div>
        <button type="button" className="icon-button session-takeover__cancel" aria-label="Cancel takeover" title="Cancel · Esc" onClick={() => close()}><ThemeActionCancelIcon size={16} /></button>
      </header>
      {source.derived ? <details className="session-takeover__instruction" open={source.derived.instruction.trim().length <= 220}>
        <summary><span>Instruction</span><small>Sent to the new Agent with the original work</small></summary>
        <p>{source.derived.instruction.trim()}</p>
      </details> : null}
      {operations.length ? <details className="session-takeover__retained"><summary>Unfinished Takeovers · {operations.length}</summary>
        {operations.map(operation => <button type="button" key={operation.operationId} className="small-button" disabled={busy || creatingClub} onClick={() => { void resume(operation) }}>
          <span>{operation.takeoverSource.coreRequest ? 'Review original Takeover' : 'Review Club preparation'} · {operationDestination(operation)}</span>
          <code title={operation.operationId}>{operation.operationId}</code></button>)}
      </details> : null}
      {!source.derived && subject.hostId && subject.agentSessionId ? <AgentPromotionRecovery target={{ hostId: subject.hostId, agentSessionId: subject.agentSessionId }} /> : null}
      {!source.derived ? <>
        <SelectionField label="Takeover destination" value={destinationKey} missingOptionLabel="Selected destination unavailable" missingOptionDescription="The original resource choice is retained. Choose another destination or return after its observation recovers." onValueChange={value => { setDestinationKey(value); setSelected(null) }} disabled={busy || creatingClub || unconfirmed || closedRequest !== null}
          options={[{ value: '', label: source.destinationKind === 'club' ? 'Choose an existing Club' : 'Choose a destination' }, ...destinations]} />
        <details className="session-takeover__placement"><summary>Show in · {placement?.label ?? 'Choose a display location'}</summary>
          <SelectionField label="Takeover display location" value={placementKey} missingOptionLabel="Selected display location unavailable" onValueChange={value => { setPlacementKey(value); setSelected(null) }}
            disabled={busy || creatingClub || unconfirmed || closedRequest !== null} options={placements} />
        </details>
        {!destinations.length ? <p>No destination is confirmed yet. Open its existing Project or Club, then return to this work.</p> : null}
        {source.destinationKind === 'club' ? <div className="session-takeover__club-create"><button type="button" className="small-button" disabled={busy || creatingClub || unconfirmed || Boolean(workingSource.clubPreparation) || operations.some(operation => operation.takeoverSource.clubPreparation && !operation.takeoverSource.coreRequest) || closedRequest !== null || config?.promotion?.enabled === false} onClick={() => { void createClub() }}><MoteIcon size={14} />{creatingClub ? 'Creating Club…' : 'Create a Club first'}</button><small>Two steps: create the team, then choose its Agent.</small></div> : null}
      </> : null}
      {notice ? <p className="session-takeover__notice" role="status">{notice}</p> : null}
      {source.derived || destination || workingSource.coreRequest ? <AgentExecutorPicker executors={executors} selected={selected} preferred={preferred} active={active && !closing} disabled={busy || creatingClub || unconfirmed || closedRequest !== null || !source.derived && !destination}
        onSelect={id => { void choose(id) }} /> : <p className="session-takeover__notice">{source.destinationKind === 'club' ? 'Choose a Club to see available Agents.' : 'Choose a destination to see available Agents.'}</p>}
      <div className="session-takeover__footer" aria-live="polite">
        {busy ? <span><ThemeStatusLoadingIcon size={13} animation="spin" />{unconfirmed || closedRequest ? 'Checking the original request…' : 'Passing the work to your Agent…'}</span>
          : <span>{source.derived ? 'The original work is read automatically. Your original session stays here.' : 'Context follows automatically. Your original session stays here.'}</span>}
        <button type="button" className="session-takeover__back" onClick={() => close()}>Back<span aria-hidden="true">Esc</span></button>
      </div>
      {issue ? <div className="session-takeover__issue" role="status">
        <strong>{closedRequest ? 'Takeover Agent was closed' : unconfirmed ? 'Takeover is not confirmed' : 'Could not take over'}</strong><p>{issue}</p>
        <div className="session-takeover__issue-actions">
          {closedRequest ? <button type="button" className="small-button" disabled={busy} onClick={chooseAnother}>Choose another Agent</button> : null}
          {currentReport?.agent && currentReport.to && currentReport.outcome === 'partial' ? <button type="button" className="small-button" onClick={() => { focusTakeoverResult(workingSource, currentReport); close(false) }}>Open created Agent</button> : null}
          {workingSource.clubPreparation && !workingSource.coreRequest ? <button type="button" className="small-button" disabled={busy || creatingClub} onClick={() => { void createClub() }}>Continue original Club preparation</button> : null}
          {workingSource.coreRequest && !closedRequest ? <button type="button" className="small-button" disabled={busy} onClick={() => { const request = workingSource.coreRequest!; if (request.content.kind === 'takeover-agent') { admitted.current = false; void choose(request.content.executorId) } }}>Continue original Takeover</button> : null}
          <button type="button" className="small-button" disabled={busy} onClick={() => { void check() }}><ThemeActionRefreshIcon size={12} /> Check again</button>
        </div>
      </div> : null}
    </div>
  </section>
}
