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
  const projected = {
    ...state,
    sessions: [...state.sessions.filter((item) => item.id !== session.id), session]
  }
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
  const core = event.event
  if (core.type === 'terminal-output') {
    const sessionId = core.semanticSessionId ?? core.daemonSession.sessionId
    return {
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === sessionId
          ? { ...item, latestSequence: core.evidence.outputSequence?.end ?? item.latestSequence }
          : item
      )
    }
  }
  if (core.type === 'process-state') {
    const sessionId = core.semanticSessionId ?? core.daemonSession.sessionId
    const displayState = core.state === 'lost' ? 'error' : core.state
    return {
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === sessionId
          ? {
              ...item,
              processState: core.state,
              updatedAt: core.evidence.observedAt,
              status: {
                state: displayState,
                source: core.evidence.source,
                observedAt: core.evidence.observedAt,
                ...(core.state === 'lost' ? { detail: 'The daemon no longer owns this PTY.' } : {}),
                ...(core.exitCode === undefined ? {} : { exitCode: core.exitCode })
              }
            }
          : item
      )
    }
  }
  if (core.type === 'semantic-status') {
    return {
      ...state,
      sessions: state.sessions.map((item) => item.id === core.semanticSessionId
        ? {
            ...item,
            updatedAt: core.evidence.observedAt,
            status: {
              state: core.state === 'unknown' ? 'running' : core.state,
              source: core.evidence.source,
              observedAt: core.evidence.observedAt,
              ...(core.detail === undefined ? {} : { detail: core.detail })
            }
          }
        : item)
    }
  }
  if (core.type === 'semantic-session') {
    return {
      ...state,
      sessions: state.sessions.map((item) => item.kind === 'agent' && item.id === core.session.semanticSessionId
        ? {
            ...item,
            agentId: core.session.agentId,
            hostId: core.session.hostId,
            workspacePath: core.session.workspacePath,
            updatedAt: core.session.updatedAt,
            control: {
              kind: 'agent' as const,
              hostId: core.session.hostId,
              semanticSessionId: core.session.semanticSessionId,
              daemonSession: { ...core.session.daemonSession }
            }
          }
        : item)
    }
  }
  if (core.type === 'semantic-activity') {
    const items = [
      ...(state.activities[core.semanticSessionId] ?? []),
      {
        ...core.activity,
        sessionId: core.semanticSessionId,
        source: core.evidence.source
      }
    ]
    return {
      ...state,
      activities: {
        ...state.activities,
        [core.semanticSessionId]: items.slice(-200)
      }
    }
  }
  if (core.type === 'permission') {
    const request = core.request
    const items = [
      ...(state.activities[request.semanticSessionId] ?? []),
      {
        id: request.id,
        sessionId: request.semanticSessionId,
        kind: 'permission' as const,
        source: request.evidence.source,
        createdAt: request.evidence.observedAt,
        title: request.title,
        ...(request.toolName === undefined ? {} : { toolName: request.toolName }),
        ...(request.toolInput === undefined ? {} : { toolInput: request.toolInput })
      }
    ]
    return {
      ...state,
      activities: { ...state.activities, [request.semanticSessionId]: items.slice(-200) }
    }
  }
  if (core.type === 'semantic-error') {
    if (!core.semanticSessionId) return state
    return {
      ...state,
      sessions: state.sessions.map((item) => item.id === core.semanticSessionId
        ? {
            ...item,
            updatedAt: core.evidence.observedAt,
            status: {
              state: 'error',
              source: core.evidence.source,
              observedAt: core.evidence.observedAt,
              detail: core.message
            }
          }
        : item)
    }
  }
  if (core.type !== 'session-removed') return state
  const sessionId = core.semanticSessionId ?? core.daemonSession.sessionId
  const removedTabIds = Object.values(state.tabs).flatMap((tab) =>
    (tab.kind === 'agent' || tab.kind === 'terminal') &&
      tab.sessionId === sessionId
      ? [tab.id]
      : []
  )
  const tabs = { ...state.tabs }
  for (const tabId of removedTabIds) delete tabs[tabId]
  return {
    sessions: state.sessions.filter((item) => item.id !== sessionId),
    activities: withoutKey(state.activities, sessionId),
    tabs,
    layouts: removeTabsFromLayouts(state.layouts, removedTabIds),
    viewModes: withoutKey(state.viewModes, sessionId)
  }
}
