import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PMO_TEAMS_TOPIC_TITLE, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { pmoFocusSessionId } from './agent-focus'
import { pmoTeamsTopicFloatingTargetTabId, type PmoTeamsTopicFloatingState } from './pmo-teams-topic-floating'
import { sessionStatusLabel } from './session-presentation'
import { recordForWorkbenchTab, useWorkbenchTabSessions } from './workbench-session-subscriptions'
import { workbenchTabDisplayName } from './workbench-tab-presentation'
import { assertUnreachableSurface } from './workbench-surface-kinds'
import type { WorkbenchSurface } from './workbench-tabs'

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

/** The shortcut, tooltip and floating window consume one target, never PMO-wide status. */
export function usePmoTeamsTopicTarget(floating: PmoTeamsTopicFloatingState) {
  const tabId = useAppStore((state) => pmoTeamsTopicFloatingTargetTabId(
    floating, state.tabs, state.layouts[SCRATCH_WORKSPACE_ID], pmoFocusSessionId(state.agentFocus)
  ))
  const tab = useAppStore((state) => tabId ? state.tabs[tabId] : undefined)
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
  const statusText = session ? sessionStatusLabel(session)
    : !tabId ? 'No Agent yet' : !tab ? 'Restoring context' : nonAgentStatus(region)
  const label = name === PMO_TEAMS_TOPIC_TITLE ? PMO_TEAMS_TOPIC_TITLE : `${PMO_TEAMS_TOPIC_TITLE} · ${name}`
  return { tabId, tab, region, session, name, label, statusText }
}

export type PmoTeamsTopicTarget = ReturnType<typeof usePmoTeamsTopicTarget>
