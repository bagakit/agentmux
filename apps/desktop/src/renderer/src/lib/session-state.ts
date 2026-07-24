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
      tab.phase === 'attached' &&
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
