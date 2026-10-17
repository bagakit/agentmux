import { useEffect, useMemo, useState } from 'react'
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
import { activityMetrics, ActivityMetrics } from './ProjectActivityMetrics'
import { AgentContextContent } from './AgentContextContent'
import { useAgentInformationPreview } from './AgentInformationPreview'

const Disclosure = semanticIconComponent('navigation.disclosure')
const NO_ITEMS = [] as const

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
    state.selectSession(session.id)
    return true
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

function ActivityAgent({ session, context: base, identity, location, onNavigate }: {
  session: AgentSession; context: FocusContext; identity?: FocusContextIdentity | undefined
  location?: AgentMuxSpaceLocation; onNavigate(): void
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
  const selected = useAppStore(state => location ? state.workbenchSpaceSelection?.tabId === location.tabId &&
    state.workbenchSpaceSelection?.regionId === location.regionId && state.workbenchSpaceSelection?.workspaceId === location.displayWorkspaceId &&
    state.workbenchSpaceSelection?.groupId === location.groupId : state.agentFocus.execution.sessionId === session.id)
  function open() { if (openActivityAgent(session, location)) onNavigate() }
  const hover = useAgentInformationPreview(context, true, identity, undefined, open, { readingKey: 'ArrowRight', readingBranch: branch })
  return <Menu.Item asChild onSelect={event => { event.preventDefault(); open() }}>
    <button ref={hover.anchor} type="button" className={`focus-context focus-context--card project-activity-agent${selected ? ' is-selected' : ''}`}
      data-session-id={session.id} data-region-id={location?.regionId} data-state={context.state} data-bucket={context.bucket} data-activity={context.activitySemantic}
      aria-label={`${context.name} · ${context.stateLabel} · ${context.detail}${age ? ` · ${age}` : ''}`}
      aria-description={context.originAddress ?? 'No confirmed display position. Open the original Agent.'}
      aria-describedby={hover.describedBy} title={age ?? undefined} {...hover.triggerEvents}
      onKeyDown={event => {
        hover.triggerEvents.onKeyDown(event)
        if (event.key === 'ArrowRight' && event.defaultPrevented) branch.enterKeyboard()
      }}>
      <AgentContextContent context={context} identity={hover.position} presentation="card" />
    </button>
  </Menu.Item>
}

/** Mounted only for the open activity menu. Content and spatial observations stay scoped. */
export function ProjectActivityMenu({ sessions, onNavigate }: { sessions: AgentSession[]; onNavigate(): void }) {
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
  const metricLabel = activityMetrics(sessions).map(metric => `${metric.count} ${metric.label}`).join(' · ')
  function row(session: AgentSession, location?: AgentMuxSpaceLocation) {
    const key = focusContextIdentityKey(session.hostId, session.id), context = byId.get(key)!
    const original = location ? { ...context, originAddress: `${positionLabel(location)} · Region ${Object.keys(tabs[location.tabId]!.regions).indexOf(location.regionId) + 1}` } : context
    return <ActivityAgent key={location?.regionId ?? key} session={session} context={original} identity={identities.get(key)}
      {...(location ? { location } : {})} onNavigate={onNavigate} />
  }
  function positionLabel(location: AgentMuxSpaceLocation) {
    const workspace = config?.workspaces.find(workspace => workspace.id === location.displayWorkspaceId)
    const layout = layouts[location.displayWorkspaceId]
    const index = layout ? groupIds(layout.root).indexOf(location.groupId) : -1
    return `${workspace?.name ?? 'Display workspace'} · ${index >= 0 ? `Group ${index + 1}` : 'Group unconfirmed'}`
  }
  function zoneMenu(zone: ActivityZone) {
    const label = activityMetrics(zone.sessions).map(metric => `${metric.count} ${metric.label}`).join(' · ')
    const path = zone.path ? displayPath(zone.path, zone.hostId ?? undefined) : null
    return <Menu.Sub key={zone.key}>
      <Menu.SubTrigger className="project-activity-zone" data-zone-id={zone.zoneId ?? undefined} aria-label={`${zone.label} · ${label}`} title={[path, zone.hostId].filter(Boolean).join(' · ')}>
        <span className="project-activity-zone__identity"><strong>{zone.label}</strong><small>{zone.sessions.length} {zone.sessions.length === 1 ? 'Agent' : 'Agents'} · {zone.zoneId ? 'Zone' : 'Unbound workfaces'}</small>{path ? <em>{path}</em> : null}</span>
        <ActivityMetrics sessions={zone.sessions} /><Disclosure size={13} aria-hidden="true" />
      </Menu.SubTrigger>
      <Menu.Portal><Menu.SubContent className="tab-context-menu project-activity-submenu" sideOffset={4} collisionPadding={8}>
        <Menu.Label className="project-activity-submenu__heading">{zone.label}<ActivityMetrics sessions={zone.sessions} /></Menu.Label>
        {zone.tabs.map(tab => <Menu.Group key={tab.key}>
          <Menu.Label className="project-activity-tab" data-tab-id={tab.location.tabId}
            title={`${tab.label} · ${positionLabel(tab.location)}`}>
            <span>{tab.label}</span>{zone.tabs.filter(candidate => candidate.label === tab.label).length > 1 ? <small>{positionLabel(tab.location)}</small> : null}
          </Menu.Label>
          {tab.agents.map(agent => row(agent.session, agent.location))}
        </Menu.Group>)}
      </Menu.SubContent></Menu.Portal>
    </Menu.Sub>
  }
  return <Menu.Portal><Menu.Content className="tab-context-menu project-activity-menu" side="bottom" align="end" sideOffset={4} collisionPadding={8}>
    <Menu.Label className="project-activity-menu__heading"><strong>Agent activity</strong><ActivityMetrics sessions={sessions} /></Menu.Label>
    <Menu.Label className="composer-menu__hint">{metricLabel}</Menu.Label>
    {spaces.zones.map(zoneMenu)}
    {spaces.unplaced.length ? <Menu.Sub>
      <Menu.SubTrigger className="project-activity-zone" data-unplaced>
        <span className="project-activity-zone__identity"><strong>No confirmed position</strong><small>{spaces.unplaced.length} {spaces.unplaced.length === 1 ? 'Agent' : 'Agents'} · Original sessions remain available</small></span>
        <ActivityMetrics sessions={spaces.unplaced} /><Disclosure size={13} aria-hidden="true" />
      </Menu.SubTrigger>
      <Menu.Portal><Menu.SubContent className="tab-context-menu project-activity-submenu" sideOffset={4} collisionPadding={8}>
        <Menu.Label className="project-activity-tab">No confirmed display position</Menu.Label>{spaces.unplaced.map(session => row(session))}
      </Menu.SubContent></Menu.Portal>
    </Menu.Sub> : null}
  </Menu.Content></Menu.Portal>
}
