import { memo, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ScratchTopicSnapshot, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { agentRegionExecution, useAppStore } from '../store'
import { useTopicSessions } from '../lib/topic-session-subscriptions'
import { recordForSessionIds } from '../lib/workbench-session-subscriptions'
import { topicAgentPresentation, topicsWithAgents } from '../lib/surface-tool-dock'
import { firstPromptFromTimeline, tabDisplayName, type WorkbenchTab } from '../lib/workbench-tabs'
import { resolveAgentName } from '../lib/display-name'
import { sessionRecentActivity } from '../lib/session-recency'
import { assertUnreachableSurface } from '../lib/workbench-surface-kinds'
import { topicTabRegionCells, type TopicTabSurface } from '../lib/scratch-topic-layout'
import { TopicPresence } from './TopicPresence'
import type { WorkbenchTabDetail } from './WorkbenchTopology'

/** Live facts stay on their displayed row; directory ordering never consumes Runtime updates. */
export const TopicRowPresence = memo(function TopicRowPresence({ workspace, topic, paths, surfaces, active,
  onSelectTab }: { workspace: WorkspaceRecord; topic: ScratchTopicSnapshot; paths: readonly string[];
  surfaces: readonly TopicTabSurface[]; active: boolean; onSelectTab(topicId: string, tabId: string): Promise<void> }) {
  const subject = useAppStore(useShallow(state => {
    const execution = state.agentFocus?.execution, reference = execution?.reference
    if (!active || !reference || reference.displayWorkspaceId !== workspace.id || !surfaces.some(tab => tab.tabId === reference.tabId && tab.groupId === reference.groupId)) return null
    const group = state.layouts[workspace.id]?.groups.find(group => group.id === reference.groupId)
    const surface = state.tabs[reference.tabId]?.regions[reference.regionId]
    const binding = surface?.kind === 'agent' ? agentRegionExecution({ tabId: reference.tabId, regionId: reference.regionId, agentSessionId: surface.sessionId }) : null
    return group?.tabOrder.includes(reference.tabId) && surface?.kind === 'agent' && surface.sessionId === execution.sessionId && binding
      ? { tabId: reference.tabId, groupId: reference.groupId, regionId: reference.regionId, sessionId: execution.sessionId, hostId: binding.hostId } : null
  }))
  const tabs = useAppStore(useShallow(state => active ? surfaces.map(entry => state.tabs[entry.tabId]) : []))
  const regionIds = useMemo(() => tabs.flatMap(tab => tab ? Object.values(tab.regions).flatMap(surface =>
    'sessionId' in surface ? [surface.sessionId] : []) : []), [tabs])
  const sessions = useTopicSessions(workspace.hostId, paths, regionIds, active)
  const ids = useMemo(() => sessions.map(session => session.id), [sessions])
  const names = useAppStore(useShallow(state => recordForSessionIds(state.agentNames, ids)))
  const timelines = useAppStore(useShallow(state => recordForSessionIds(state.timelines, ids)))
  const executors = useAppStore(state => state.config?.executors)
  const retainedAvatars = useAppStore(state => state.config?.appearance.agentAvatars)
  const selectSession = useAppStore(state => state.selectSession)
  // Geometry and activity facts are independent from active-tab selection. Selecting another
  // Topic may update the highlight, but does not scan unchanged timelines or Region trees.
  const details = useMemo(() => {
    const byId = new Map(sessions.map(session => [session.id, session]))
    const agentsById = new Map<string, Extract<SessionSnapshot, { kind: 'agent' }>[]>()
    for (const session of sessions) if (session.kind === 'agent') {
      for (const id of new Set([session.id, session.control.agentSessionId])) {
        const candidates = agentsById.get(id) ?? []
        candidates.push(session); agentsById.set(id, candidates)
      }
    }
    // Legacy naming and timeline records are SID-keyed. Ambiguous Hosts cannot
    // lend those optional facts to an otherwise exact Region identity.
    const unambiguous = new Set([...agentsById].filter(([, candidates]) => new Set(candidates.map(session => session.hostId)).size === 1).map(([id]) => id))
    const nameFor = (id: string) => unambiguous.has(id) ? names[id] : undefined
    const timelineFor = (id: string) => unambiguous.has(id) ? timelines[id] : undefined
    const sessionForRegion = (tabId: string, surface: WorkbenchTab['regions'][string] | undefined) => {
      if (!surface || !('sessionId' in surface)) return undefined
      if (surface.kind !== 'agent') return byId.get(surface.sessionId)
      const binding = agentRegionExecution({ tabId, regionId: surface.regionId, agentSessionId: surface.sessionId })
      const candidates = agentsById.get(surface.sessionId) ?? []
      return binding ? candidates.find(session => session.hostId === binding.hostId)
        : candidates.length === 1 ? candidates[0] : undefined
    }
    return tabs.map((tab, index) => tab ? ({ tabId: tab.id,
      title: tabDisplayName({ tab, fallback: `Tab ${index + 1}`, agentFactsFor: id => {
        const candidates = Object.values(tab.regions).filter(surface => surface.kind === 'agent' && surface.sessionId === id)
          .map(surface => sessionForRegion(tab.id, surface))
        const session = candidates[0]
        if (!session || session.kind !== 'agent') return null
        if (!candidates.every(candidate => candidate?.hostId === session.hostId)) return null
        return { userName: nameFor(id), firstPrompt: firstPromptFromTimeline(timelineFor(id)), fallbackLabel: session.label,
          providerLabel: executors?.[session.executorId]?.label ?? session.executorId ?? session.providerId }
      } }),
      regions: topicTabRegionCells(tab).map(cell => {
        const surface = tab.regions[cell.regionId]
        const session = sessionForRegion(tab.id, surface)
        let executorLabel: string
        switch (surface?.kind) {
          case 'agent': executorLabel = session?.kind === 'agent' ? executors?.[session.executorId]?.label ?? session.executorId : 'Agent'; break
          case 'terminal': executorLabel = 'Terminal'; break
          case 'browser': executorLabel = 'Browser'; break
          case 'file': executorLabel = 'File'; break
          case 'git': executorLabel = 'Git history'; break
          case 'git-diff': executorLabel = 'Git diff'; break
          case 'launcher': executorLabel = 'Launcher'; break
          case undefined: executorLabel = 'Launcher'; break
          default: return assertUnreachableSurface(surface)
        }
        const activity = session?.kind === 'agent'
          ? timelineFor(session.id)?.items.length || session.pendingInteraction || session.status.detail
            ? sessionRecentActivity(session, timelineFor(session.id)?.items ?? [], workspace.path) : 'No recent activity'
          : surface?.kind === 'terminal' ? 'Terminal session' : 'No recent activity'
        const agent = surface?.kind === 'agent' && session?.kind === 'agent' ? { providerId: session.providerId, hostId: session.hostId,
          executorId: session.executorId, sessionId: session.id, appearance: executors?.[session.executorId]?.avatar ?? retainedAvatars?.[session.executorId],
          state: session.status.state, label: resolveAgentName({ userName: nameFor(session.id),
            firstPrompt: firstPromptFromTimeline(timelineFor(session.id)), fallback: session.label }).name } : undefined
        return { ...cell, executorLabel, activity, ...(agent ? { agent } : {}) }
      }) }) : null)
  }, [tabs, sessions, names, timelines, executors, retainedAvatars, workspace.path])
  const presentedTabs = useMemo(() => details.flatMap((detail, index) => detail ? [{ ...detail,
    occurrenceKey: JSON.stringify([workspace.id, surfaces[index]?.groupId, detail.tabId]),
    active: surfaces[index]?.active ?? false,
    ...(subject?.tabId === detail.tabId && subject.groupId === surfaces[index]?.groupId && detail.regions.some(region => region.regionId === subject.regionId && region.agent?.sessionId === subject.sessionId && region.agent.hostId === subject.hostId)
      ? { highlightedRegionIds: [subject.regionId] } : {}) } satisfies WorkbenchTabDetail] : []), [details, surfaces, subject, workspace.id])
  const agents = useMemo(() => {
    const rank = new Map<string, number>()
    tabs.forEach((tab, index) => {
      if (!tab) return
      const surface = Object.values(tab.regions).find(region => region.kind === 'agent')
      if (surface?.kind === 'agent') rank.set(surface.sessionId, index)
    })
    return topicsWithAgents([topic], sessions, workspace)[0]!.agents
      .filter(agent => agent.live?.processState === 'running')
      .sort((left, right) => (rank.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER))
      .map(agent => ({ key: agent.sessionId, providerId: agent.providerId, executorId: agent.live!.executorId,
        sessionId: agent.live!.id, appearance: executors?.[agent.live!.executorId]?.avatar,
        label: resolveAgentName({ userName: names[agent.sessionId], firstPrompt: firstPromptFromTimeline(timelines[agent.sessionId]),
          fallback: agent.live!.label }).name, state: topicAgentPresentation(agent).state, onOpen: () => selectSession(agent.sessionId) }))
  }, [tabs, topic, sessions, workspace, executors, names, timelines, selectSession])
  return <TopicPresence tabs={presentedTabs} agents={agents} onSelectTab={tabId => { void onSelectTab(topic.id, tabId) }} />
})
