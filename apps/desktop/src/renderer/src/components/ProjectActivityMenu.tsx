import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useShallow } from 'zustand/react/shallow'
import type { AgentMuxSpaceLocation } from '@agentmux/core'
import { groupIds } from '@agentmux/layout'
import { agentRegionExecution, useAppStore } from '../store'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { buildActivitySpaces, type AgentSession, type ActivityZone } from '../lib/project-activity-spaces'
import { agentContextForSession, type FocusContext } from '../lib/focus-context'
import { createFocusContextIdentitySelector, focusContextIdentityKey, type FocusContextIdentity } from '../lib/focus-context-identity'
import { workspaceForSession } from '../lib/workbench-tabs'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { projectActivityRow } from '../lib/project-activity-row'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { useWorkbenchDocument } from '../lib/workbench-document'
import * as Menu from './HoverDropdownMenu'
import { activityMetrics } from './ProjectActivityMetrics'
import { AgentContextContent } from './AgentContextContent'
import { useAgentInformationPreview } from './AgentInformationPreview'

const Disclosure = semanticIconComponent('navigation.disclosure')
const NO_ITEMS = [] as const
type ActivityGroup = { key: string; label: string; title: string; sessions: AgentSession[]; zone: ActivityZone | null }
type ReadingFocus = { source: Element | null; position?: string; group?: string; first?: boolean; back?: boolean; scrollTop: number }

/** This is an explicit existing occurrence, never the first location of a Session. */
function openActivityAgent(session: AgentSession, location?: AgentMuxSpaceLocation) {
  const state = useAppStore.getState()
  if (!location) {
    const subjects = state.sessions.filter(candidate => candidate.id === session.id)
    const surfaces = Object.values(state.tabs).flatMap(tab => Object.values(tab.regions).flatMap(surface =>
      surface.kind === 'agent' && surface.sessionId === session.id ? [{ tabId: tab.id, regionId: surface.regionId, agentSessionId: session.id }] : []))
    if (subjects.length !== 1 || subjects[0]?.hostId !== session.hostId || surfaces.some(surface => agentRegionExecution(surface)?.hostId !== session.hostId)) {
      state.reportError(new Error('The original Agent or its display identity is not uniquely confirmed. Its Session and readable activity are kept; choose a confirmed position when available.'), { kind: 'indeterminate' })
      return false
    }
    return state.selectSession(session.id)
  }
  const surface = state.tabs[location.tabId]?.regions[location.regionId]
  const execution = agentRegionExecution({ ...location, agentSessionId: session.id })
  const exists = workbenchSelectionCatalog(state).locations.some(candidate => candidate.displayWorkspaceId === location.displayWorkspaceId &&
    candidate.groupId === location.groupId && candidate.tabId === location.tabId && candidate.regionId === location.regionId)
  if (!exists || surface?.kind !== 'agent' || surface.sessionId !== session.id || execution?.hostId !== session.hostId) {
    state.reportError(new Error('This Agent position changed. Its original Session and workface are kept; reopen Activity to choose its current position.'), { kind: 'indeterminate' })
    return false
  }
  state.setMainSurface('workbench')
  state.focusRegion(location.displayWorkspaceId, location.tabId, location.regionId, 'navigation', location.groupId)
  return true
}

function ActivityAgent({ session, context: base, identity, location, positionHint, onNavigate }: {
  session: AgentSession; context: FocusContext; identity?: FocusContextIdentity | undefined
  location?: AgentMuxSpaceLocation; positionHint?: string; onNavigate(): void
}) {
  const document = useWorkbenchDocument()
  const timeline = useAppStore(state => state.timelines[session.id])
  const name = useAppStore(state => state.agentNames[session.id])
  const [now, tick] = useState(Date.now)
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    function update() {
      clearInterval(timer)
      if (document.visibilityState === 'visible') { tick(Date.now()); timer = setInterval(() => tick(Date.now()), 1000) }
    }
    update(); document.addEventListener('visibilitychange', update)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [document])
  const context = useMemo(() => ({ ...agentContextForSession(session, timeline, name, base.workspace, base.topicId),
    ...(base.originAddress ? { originAddress: base.originAddress } : {}) }), [session, timeline, name, base, now])
  const age = projectActivityRow(session, timeline?.items ?? NO_ITEMS, now).meta
  const branch = Menu.useHoverMenuBranch()
  // A new menu level can place this row beneath a stationary pointer; wait for actual movement.
  const hoverStarted = useRef(false)
  const selected = useAppStore(state => location ? state.workbenchSpaceSelection?.tabId === location.tabId &&
    state.workbenchSpaceSelection?.regionId === location.regionId && state.workbenchSpaceSelection?.workspaceId === location.displayWorkspaceId &&
    state.workbenchSpaceSelection?.groupId === location.groupId : state.agentFocus.execution.sessionId === session.id)
  function open() { if (openActivityAgent(session, location)) onNavigate() }
  const hover = useAgentInformationPreview(context, true, identity, undefined, open, { readingKey: 'ArrowRight', readingBranch: branch })
  return <Menu.Item asChild onSelect={event => { event.preventDefault(); open() }}>
    <button ref={hover.anchor} type="button" className={`focus-context focus-context--card project-activity-agent${selected ? ' is-selected' : ''}`}
      data-session-id={session.id} data-region-id={location?.regionId}
      data-activity-position={location ? JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId]) : focusContextIdentityKey(session.hostId, session.id)} data-state={context.state} data-bucket={context.bucket} data-activity={context.activitySemantic}
      aria-label={`${context.name} · ${context.stateLabel} · ${context.detail}${age ? ` · ${age}` : ''}`}
      aria-description={[context.originAddress ?? 'No confirmed display position. Open the original Agent.', identity && identity.occurrenceCount > 1 ? `Same Agent · ${identity.occurrenceCount} positions` : null].filter(Boolean).join(' · ')}
      aria-describedby={hover.describedBy} title={age ?? undefined} {...hover.triggerEvents}
      onPointerEnter={() => { hoverStarted.current = false }}
      onPointerMove={event => {
        if (!hoverStarted.current && event.buttons === 0) { hoverStarted.current = true; hover.triggerEvents.onPointerEnter() }
      }}
      onPointerLeave={() => { hoverStarted.current = false; hover.triggerEvents.onPointerLeave() }}
      onKeyDown={event => {
        hover.triggerEvents.onKeyDown(event)
        if (event.key === 'ArrowRight' && event.defaultPrevented) branch.enterKeyboard()
      }}>
      <AgentContextContent context={context} presentation="card" />
      {identity && identity.occurrenceCount > 1 ? <span className="project-activity-agent__occurrence">Same Agent · {identity.occurrenceCount} positions{positionHint ? ` · ${positionHint}` : ''}</span> : null}
    </button>
  </Menu.Item>
}

/** Mounted only for the open activity menu. Content and spatial observations stay scoped. */
export function ProjectActivityMenu({ sessions, onNavigate }: { sessions: AgentSession[]; onNavigate(): void }) {
  const document = useWorkbenchDocument(), ownerWindow = document.defaultView!
  const [narrow, setNarrow] = useState(() => ownerWindow.innerWidth < 640)
  const [wideGroup, setWideGroup] = useState<string | null>(null)
  const [drilldownGroup, setDrilldownGroup] = useState<string | null>(null)
  const wideGroupRef = useRef(wideGroup), narrowRef = useRef(narrow)
  wideGroupRef.current = wideGroup
  const content = useRef<HTMLDivElement | null>(null), submenu = useRef<HTMLDivElement | null>(null)
  const pendingFocus = useRef<ReadingFocus | null>(null)
  const listScroll = useRef(0)
  const branch = Menu.useHoverMenuBranch()
  useEffect(() => {
    function resize() {
      const next = ownerWindow.innerWidth < 640
      if (next === narrowRef.current) return
      narrowRef.current = next
      if (next && wideGroupRef.current) {
        listScroll.current = content.current?.scrollTop ?? 0
        const focused = document.activeElement as HTMLElement | null
        const position = focused && submenu.current?.contains(focused) ? focused.dataset.activityPosition : undefined
        pendingFocus.current = { source: position ? focused : null, ...(position ? { position } : {}), scrollTop: submenu.current?.scrollTop ?? 0 }
        // Keep the reading scope separate from Radix Sub's unmount/close lifecycle.
        setDrilldownGroup(wideGroupRef.current)
      }
      setNarrow(next)
    }
    ownerWindow.addEventListener('resize', resize)
    return () => ownerWindow.removeEventListener('resize', resize)
  }, [document, ownerWindow])
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    pendingFocus.current = null
    if (!pending || !content.current) return
    content.current.scrollTop = pending.scrollTop
    // A later deliberate focus wins over the menu's own restoration.
    if (!pending.first && !pending.back && !pending.position && !pending.group) return
    if (document.activeElement !== pending.source && document.activeElement !== document.body) return
    const target = pending.back ? content.current.querySelector<HTMLElement>('[data-activity-back]')
      : pending.first ? content.current.querySelector<HTMLElement>('.project-activity-agent')
      : [...content.current.querySelectorAll<HTMLElement>('[data-activity-position], [data-activity-group]')].find(row =>
        pending.position ? row.dataset.activityPosition === pending.position : row.dataset.activityGroup === pending.group)
    target?.focus({ preventScroll: true })
  }, [drilldownGroup, narrow, document])
  const displayPath = usePathDisplay()
  const catalog = useAppStore(workbenchSelectionCatalog)
  const config = useAppStore(state => state.config)
  const topics = useAppStore(state => scratchTopicsForConfig(state.config, state.scratchTopicSnapshots))
  const tabs = useAppStore(state => workbenchNavigationTabs(state.tabs))
  const layouts = useAppStore(state => state.layouts)
  const names = useAppStore(useShallow(state => Object.fromEntries(sessions.map(session => [session.id, state.agentNames[session.id]]))))
  const contexts = useMemo(() => sessions.map(session => agentContextForSession(session, undefined, names[session.id],
    workspaceForSession(config, session, topics), null)), [sessions, names, config, topics])
  const byId = new Map(contexts.map(context => [focusContextIdentityKey(context.hostId, context.id), context]))
  const spaces = useMemo(() => buildActivitySpaces(sessions, catalog, tabs, agentRegionExecution), [sessions, catalog, tabs])
  const identitySelector = useMemo(createFocusContextIdentitySelector, [])
  const identities = useMemo(() => identitySelector(catalog, tabs, contexts, config, layouts, agentRegionExecution), [identitySelector, catalog, tabs, contexts, config, layouts])
  const readingHint = config?.focus?.previewTrigger === 'keyboard' ? 'Select an Agent · → to read · Enter to open' : 'Hover an Agent to read · Click to open'
  const metricLabel = activityMetrics(sessions).map(metric => `${metric.count} ${metric.label}`).join(' · ')
  function row(session: AgentSession, location?: AgentMuxSpaceLocation, showRegion = false) {
    const key = focusContextIdentityKey(session.hostId, session.id), context = byId.get(key)!
    const original = location ? { ...context, originAddress: `${positionLabel(location)} · Region ${Object.keys(tabs[location.tabId]!.regions).indexOf(location.regionId) + 1}` } : context
    return <ActivityAgent key={location?.regionId ?? key} session={session} context={original} identity={identities.get(key)}
      {...(location ? { location } : {})} {...(showRegion && location ? { positionHint: `Region ${Object.keys(tabs[location.tabId]!.regions).indexOf(location.regionId) + 1}` } : {})} onNavigate={onNavigate} />
  }
  function positionLabel(location: AgentMuxSpaceLocation) {
    const workspace = config?.workspaces.find(workspace => workspace.id === location.displayWorkspaceId)
    const layout = layouts[location.displayWorkspaceId]
    const index = layout ? groupIds(layout.root).indexOf(location.groupId) : -1
    return `${workspace?.name ?? 'Display workspace'} · ${index >= 0 ? `Group ${index + 1}` : 'Group unconfirmed'}`
  }
  function zoneTitle(zone: ActivityZone) {
    return [zone.path ? displayPath(zone.path, zone.hostId ?? undefined) : null, zone.hostId].filter(Boolean).join(' · ')
  }
  function zoneContents(zone: ActivityZone) {
    return zone.tabs.map(tab => <Menu.Group key={tab.key}>
      <Menu.Label className="project-activity-tab" data-tab-id={tab.location.tabId}
        title={`${tab.label} · ${positionLabel(tab.location)}`}>
        <span>{tab.label}</span>{zone.tabs.filter(candidate => candidate.label === tab.label).length > 1 ? <small>{positionLabel(tab.location)}</small> : null}
      </Menu.Label>
      {tab.agents.map(agent => row(agent.session, agent.location, tab.agents.filter(candidate => candidate.session.id === agent.session.id && candidate.session.hostId === agent.session.hostId).length > 1))}
    </Menu.Group>)
  }
  const groups: ActivityGroup[] = spaces.zones.map(zone => ({ key: zone.key, label: zone.label, title: zoneTitle(zone), sessions: zone.sessions, zone }))
  if (spaces.unplaced.length) groups.push({ key: 'unplaced', label: 'No confirmed position', title: 'Original Agents remain available', sessions: spaces.unplaced, zone: null })
  const direct = spaces.zones.length + (spaces.unplaced.length ? 1 : 0) === 1
  const activeGroup = !direct ? groups.find(group => group.key === drilldownGroup) : undefined
  // Widening keeps an entered reading page; Back returns to the wider cascade choices.
  const singlePanel = narrow || Boolean(activeGroup)
  function groupContents(group: ActivityGroup) {
    return group.zone ? zoneContents(group.zone) : group.sessions.map(session => row(session))
  }
  function enterGroup(key: string, keyboard: boolean) {
    listScroll.current = content.current?.scrollTop ?? 0
    pendingFocus.current = { source: document.activeElement, ...(keyboard ? { first: true } : { back: true }), scrollTop: 0 }
    branch.enterKeyboard()
    setDrilldownGroup(key)
  }
  function back() {
    const focused = document.activeElement
    pendingFocus.current = { source: content.current?.contains(focused) ? focused : null,
      ...(content.current?.contains(focused) && drilldownGroup ? { group: drilldownGroup } : {}), scrollTop: listScroll.current }
    setDrilldownGroup(null)
  }
  function groupChoice(group: ActivityGroup) {
    const label = activityMetrics(group.sessions).map(metric => `${metric.count} ${metric.label}`).join(' · ')
    const props = { className: 'project-activity-zone', 'data-activity-group': group.key,
      'data-zone-id': group.zone?.zoneId ?? undefined, 'data-unplaced': group.zone ? undefined : true,
      'aria-label': `${group.label} · ${label}`, title: group.title }
    const identity = <><span className="project-activity-zone__identity"><strong>{group.label}</strong><small title={label}>{label}</small></span><Disclosure size={13} aria-hidden="true" /></>
    if (singlePanel) return <Menu.Item key={group.key} asChild onSelect={event => event.preventDefault()}>
      <button type="button" {...props} aria-haspopup="menu" onClick={event => enterGroup(group.key, event.detail === 0)}
        onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); enterGroup(group.key, true) } }}>{identity}</button>
    </Menu.Item>
    return <Menu.Sub key={group.key} open={wideGroup === group.key} onOpenChange={open => setWideGroup(current => open ? group.key : current === group.key ? null : current)}>
      <Menu.SubTrigger {...props}>{identity}</Menu.SubTrigger>
      <Menu.Portal><Menu.SubContent ref={submenu} className="tab-context-menu project-activity-submenu" sideOffset={4} collisionPadding={8}>
        <Menu.Label className="project-activity-submenu__heading" title={group.title}>{group.label}</Menu.Label>
        {groupContents(group)}
        <Menu.Label className="project-activity-menu__hint">{readingHint}</Menu.Label>
      </Menu.SubContent></Menu.Portal>
    </Menu.Sub>
  }
  return <Menu.Portal><Menu.Content ref={content} className="tab-context-menu project-activity-menu"
    data-direct={direct || undefined} data-drilldown={Boolean(activeGroup) || undefined} data-single-panel={singlePanel || undefined}
    side="bottom" align="end" sideOffset={4} collisionPadding={8}
    onEscapeKeyDown={event => {
      if (event.defaultPrevented || !activeGroup) return
      event.preventDefault(); back()
    }}
    onKeyDown={event => {
      if (!event.defaultPrevented && activeGroup && event.key === 'ArrowLeft') { event.preventDefault(); back() }
    }}>
    {activeGroup ? <>
      <div className="project-activity-drilldown-heading">
        <Menu.Item className="project-activity-back" data-activity-back aria-label="Back to Agent activity"
          onSelect={event => { event.preventDefault(); back() }}><Disclosure size={13} aria-hidden="true" /><span>Back</span></Menu.Item>
        <Menu.Label title={activeGroup.title}>{activeGroup.label}</Menu.Label>
      </div>
      {groupContents(activeGroup)}
    </> : <>
      <Menu.Label className="project-activity-menu__heading"><strong>Agent activity</strong><span>{sessions.length} {sessions.length === 1 ? 'Agent' : 'Agents'}</span></Menu.Label>
      <Menu.Label className="project-activity-menu__summary">{metricLabel}</Menu.Label>
      {direct ? groups.map(group => <Menu.Group key={group.key}>
        <Menu.Label className="project-activity-submenu__heading" title={group.title}>{group.label}</Menu.Label>{groupContents(group)}
      </Menu.Group>) : groups.map(groupChoice)}
    </>}
    <Menu.Label className="project-activity-menu__hint">{direct || activeGroup ? readingHint : singlePanel ? 'Select a group to see its Agents' : 'Hover a group to see its Agents'}</Menu.Label>
  </Menu.Content></Menu.Portal>
}
