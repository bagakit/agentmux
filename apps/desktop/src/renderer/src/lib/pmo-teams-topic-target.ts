import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { createPmoTeamsTopicTargetSelector, pmoTeamsTopicFloatingTargetTopicId, type PmoTeamsTopicFloatingState } from './pmo-teams-topic-floating'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { sessionStatusLabel } from './session-presentation'
import { recordForWorkbenchTab, useWorkbenchTabSessions } from './workbench-session-subscriptions'
import { workbenchTabDisplayName } from './workbench-tab-presentation'
import { assertUnreachableSurface } from './workbench-surface-kinds'
import type { WorkbenchSurface } from './workbench-tabs'
import type { WorkbenchTab } from './workbench-tabs'
import type { SessionSnapshot } from '../../../shared/contracts'

function nonAgentStatus(region: WorkbenchSurface | undefined): string {
  if (!region) return 'Restoring Region'
  switch (region.kind) {
    case 'agent': return region.phase === 'launching' ? 'Starting Agent' : 'Restoring Agent'
    case 'launcher': return 'No Agent yet'
    case 'terminal': return 'Terminal region'
    case 'file': return 'File region'
    case 'git-diff': return 'Diff region'
    case 'browser': return 'Browser region'
    default: return assertUnreachableSurface(region)
  }
}

export function moteTargetStatus(tab: WorkbenchTab | undefined, session: SessionSnapshot | undefined, tabId: string | undefined): string {
  const region = tab?.regions[tab.layout.activeRegionId]
  return session ? sessionStatusLabel(session)
    : !tabId ? 'No Agent yet' : !tab ? 'Restoring context' : nonAgentStatus(region)
}

/** The shortcut and workface consume one exact target, never PMO-wide status. */
export function usePmoTeamsTopicTarget(floating: PmoTeamsTopicFloatingState) {
  const topicId = useAppStore(state => pmoTeamsTopicFloatingTargetTopicId(floating, state.tabs))
  const selectTab = useMemo(() => createPmoTeamsTopicTargetSelector(floating), [floating.targetTopicId, floating.targetTabId])
  const tabId = useAppStore(selectTab)
  const tab = useAppStore((state) => {
    const candidate = tabId ? state.tabs[tabId] : undefined
    return candidate?.workspaceId === SCRATCH_WORKSPACE_ID && candidate.topicId === topicId ? candidate : undefined
  })
  const sessions = useWorkbenchTabSessions(tab)
  const names = useAppStore(useShallow((state) => recordForWorkbenchTab(state.agentNames, tab)))
  const timelines = useAppStore(useShallow((state) => recordForWorkbenchTab(state.timelines, tab)))
  const name = useMemo(() => tab
    ? workbenchTabDisplayName(tab, sessions, names, timelines)
    : tabId ? 'Saved context' : PMO_TEAMS_TOPIC_TITLE, [tab, tabId, sessions, names, timelines])
  // Unlike activeWorkbenchSurface, a missing active Region must stay unknown;
  // it cannot borrow the title Region's Agent status.
  const region = tab?.regions[tab.layout.activeRegionId]
  const session = region?.kind === 'agent'
    ? sessions.find((session) => session.id === region.sessionId && session.kind === 'agent')
    : undefined
  const topics = useAppStore(state => scratchTopicsForWorkspace(state.scratchTopicSnapshots,
    state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)))
  const moteName = useMemo(() => topics?.find(topic => topic.id === topicId)?.title ??
    (topicId === PMO_TEAMS_TOPIC_ID ? PMO_TEAMS_TOPIC_TITLE : 'Saved Mote'), [topics, topicId])
  const statusText = moteTargetStatus(tab, session, tabId)
  const label = name === moteName ? moteName : `${moteName} · ${name}`
  return { topicId, tabId, tab, region, session, name, moteName, label, statusText }
}

export type PmoTeamsTopicTarget = ReturnType<typeof usePmoTeamsTopicTarget>
