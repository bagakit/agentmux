import { memo, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { useTopicSessions } from '../lib/topic-session-subscriptions'
import { recordForSessionIds } from '../lib/workbench-session-subscriptions'
import { topicAgentPresentation, topicsWithAgents } from '../lib/surface-tool-dock'
import { firstPromptFromTimeline, tabDisplayName } from '../lib/workbench-tabs'
import { resolveAgentName } from '../lib/display-name'
import { sessionRecentActivity } from '../lib/session-recency'
import { assertUnreachableSurface } from '../lib/workbench-surface-kinds'
import { topicTabRegionCells, type TopicTabSurface } from '../lib/scratch-topic-layout'
import { TopicPresence, type TopicTabDetail } from './TopicPresence'

/** Live facts stay on their displayed row; directory ordering never consumes Runtime updates. */
export const TopicRowPresence = memo(function TopicRowPresence({ workspace, topic, paths, surfaces, active,
  onSelectTab }: { workspace: WorkspaceRecord; topic: ScratchTopicSnapshot; paths: readonly string[];
  surfaces: readonly TopicTabSurface[]; active: boolean; onSelectTab(topicId: string, tabId: string): Promise<void> }) {
  const tabs = useAppStore(useShallow(state => active ? surfaces.map(entry => state.tabs[entry.tabId]) : []))
  const regionIds = useMemo(() => tabs.flatMap(tab => tab ? Object.values(tab.regions).flatMap(surface =>
    'sessionId' in surface ? [surface.sessionId] : []) : []), [tabs])
  const sessions = useTopicSessions(workspace.hostId, paths, regionIds, active)
  const ids = useMemo(() => sessions.map(session => session.id), [sessions])
  const names = useAppStore(useShallow(state => recordForSessionIds(state.agentNames, ids)))
  const timelines = useAppStore(useShallow(state => recordForSessionIds(state.timelines, ids)))
  const executors = useAppStore(state => state.config?.executors)
  const selectSession = useAppStore(state => state.selectSession)
  // Geometry and activity facts are independent from active-tab selection. Selecting another
  // Topic may update the highlight, but does not scan unchanged timelines or Region trees.
  const details = useMemo(() => {
    const byId = new Map(sessions.map(session => [session.id, session]))
    return tabs.map((tab, index) => tab ? ({ tabId: tab.id,
      title: tabDisplayName({ tab, fallback: `Tab ${index + 1}`, agentFactsFor: id => {
        const session = byId.get(id)
        if (!session || session.kind !== 'agent') return null
        return { userName: names[id], firstPrompt: firstPromptFromTimeline(timelines[id]), fallbackLabel: session.label,
          providerLabel: executors?.[session.executorId]?.label ?? session.executorId ?? session.providerId }
      } }),
      regions: topicTabRegionCells(tab).map(cell => {
        const surface = tab.regions[cell.regionId]
        const session = surface && 'sessionId' in surface ? byId.get(surface.sessionId) : undefined
        let executorLabel: string
        switch (surface?.kind) {
          case 'agent': executorLabel = session?.kind === 'agent' ? executors?.[session.executorId]?.label ?? session.executorId : 'Agent'; break
          case 'terminal': executorLabel = 'Terminal'; break
          case 'browser': executorLabel = 'Browser'; break
          case 'file': executorLabel = 'File'; break
          case 'git-diff': executorLabel = 'Git diff'; break
          case 'launcher': executorLabel = 'Launcher'; break
          case undefined: executorLabel = 'Launcher'; break
          default: return assertUnreachableSurface(surface)
        }
        const activity = session?.kind === 'agent'
          ? timelines[session.id]?.items.length || session.pendingInteraction || session.status.detail
            ? sessionRecentActivity(session, timelines[session.id]?.items ?? [], workspace.path) : 'No recent activity'
          : surface?.kind === 'terminal' ? 'Terminal session' : 'No recent activity'
        const agent = surface?.kind === 'agent' && session?.kind === 'agent' ? { providerId: session.providerId,
          executorId: session.executorId, sessionId: session.id, appearance: executors?.[session.executorId]?.avatar,
          state: session.status.state, label: resolveAgentName({ userName: names[session.id],
            firstPrompt: firstPromptFromTimeline(timelines[session.id]), fallback: session.label }).name } : undefined
        return { ...cell, executorLabel, activity, ...(agent ? { agent } : {}) }
      }) }) : null)
  }, [tabs, sessions, names, timelines, executors, workspace.path])
  const presentedTabs = useMemo(() => details.flatMap((detail, index) => detail ? [{ ...detail,
    active: surfaces[index]?.active ?? false } satisfies TopicTabDetail] : []), [details, surfaces])
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
