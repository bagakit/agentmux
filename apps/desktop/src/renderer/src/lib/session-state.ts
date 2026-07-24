import type {
  AgentActivity,
  RuntimeEvent,
  SessionSnapshot
} from '../../../shared/contracts'
import type { WorkspaceLayout } from './workbench-layout'
import {
  removeTabsFromLayouts,
  type WorkbenchTab
} from './workbench-tabs'
import type { LauncherView } from './surface-tool-dock'

export type SessionViewMode = 'terminal' | 'conversation'

export type SessionProjectionState = {
  sessions: SessionSnapshot[]
  activities: Record<string, AgentActivity[]>
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
  viewModes: Record<string, SessionViewMode>
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

export function ownsSessionLaunch(
  tab: WorkbenchTab | undefined,
  kind: 'agent' | 'terminal',
  sessionId: string
): boolean {
  return tab?.kind === kind && tab.phase === 'launching' && tab.sessionId === sessionId
}

export function reduceSessionLaunchAttached(
  state: SessionProjectionState,
  tabId: string,
  session: SessionSnapshot
): SessionProjectionState {
  if (!ownsSessionLaunch(state.tabs[tabId], session.kind, session.id)) return state
  const projected = reduceRuntimeEvent(state, { type: 'session', session })
  const tab = projected.tabs[tabId]
  return {
    ...projected,
    tabs: tab && (tab.kind === 'agent' || tab.kind === 'terminal')
      ? { ...projected.tabs, [tabId]: { ...tab, phase: 'attached' } }
      : projected.tabs,
    ...(session.kind === 'agent'
      ? { viewModes: { ...projected.viewModes, [session.id]: 'terminal' as const } }
      : {})
  }
}

export function reduceSessionLaunchFailed(
  state: SessionProjectionState,
  tabId: string,
  kind: 'agent' | 'terminal',
  sessionId: string,
  view: LauncherView
): SessionProjectionState {
  const tab = state.tabs[tabId]
  if (!ownsSessionLaunch(tab, kind, sessionId)) return state
  return {
    ...state,
    tabs: {
      ...state.tabs,
      [tabId]: { id: tabId, kind: 'launcher', workspaceId: tab!.workspaceId, view }
    }
  }
}

export function reduceRuntimeEvent(
  state: SessionProjectionState,
  event: RuntimeEvent
): SessionProjectionState {
  if (event.type === 'session') {
    return {
      ...state,
      sessions: [...state.sessions.filter((item) => item.id !== event.session.id), event.session]
    }
  }
  if (event.type === 'status') {
    return {
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === event.sessionId
          ? { ...item, status: event.status, updatedAt: event.status.observedAt }
          : item
      )
    }
  }
  if (event.type === 'terminal') {
    return {
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === event.sessionId
          ? { ...item, terminalSnapshot: event.snapshot, updatedAt: event.observedAt }
          : item
      )
    }
  }
  if (event.type === 'activity') {
    return {
      ...state,
      activities: {
        ...state.activities,
        [event.sessionId]: [...(state.activities[event.sessionId] ?? []), event.activity]
      }
    }
  }
  const removedTabIds = Object.values(state.tabs).flatMap((tab) =>
    (tab.kind === 'agent' || tab.kind === 'terminal') &&
      tab.sessionId === event.sessionId
      ? [tab.id]
      : []
  )
  const tabs = { ...state.tabs }
  for (const tabId of removedTabIds) delete tabs[tabId]
  return {
    sessions: state.sessions.filter((item) => item.id !== event.sessionId),
    activities: withoutKey(state.activities, event.sessionId),
    tabs,
    layouts: removeTabsFromLayouts(state.layouts, removedTabIds),
    viewModes: withoutKey(state.viewModes, event.sessionId)
  }
}
