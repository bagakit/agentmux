import { useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { regionIds } from '@agentmux/layout'
import { agentRegionExecution, useAppStore } from '../store'
import { sessionNamesForReferences } from './session-name-metadata'
import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { createSessionViewModeSelector, sessionPresentationById, sessionPresentationsAtPath } from './session-presentation'
import { agentDisplayName, type WorkbenchTab } from './workbench-tabs'
import { workbenchAgentFactsFor } from './workbench-tab-presentation'
import { regionSurfaceLabel } from './region-display-name'
import { isSessionSurface } from './workbench-surface-kinds'
import { useObservedAppStore } from './use-observed-app-store'

function tabSessionIds(tab: WorkbenchTab | undefined): string[] {
  return tab ? [...new Set(Object.values(tab.regions).flatMap((surface) => isSessionSurface(surface) ? [surface.sessionId] : []))] : []
}

function useWorkbenchTabScope(tab: WorkbenchTab | undefined) {
  return useMemo(() => ({ sessionIds: tabSessionIds(tab), navigation: false }), [tab?.regions])
}

/** A Tab consumes only its Regions' Session references, never another Tab's runtime updates. */
export function useWorkbenchTabSessions(tab: WorkbenchTab | undefined) {
  const scope = useWorkbenchTabScope(tab)
  const ids = scope.sessionIds
  return useObservedAppStore('workbenchTab', true, scope, useShallow((state) => {
    if (ids.length === 0) return []
    const byId = sessionPresentationById(state.sessions)
    return ids.flatMap((id) => {
      const session = byId.get(id)
      return session ? [session] : []
    })
  }))
}

function nameMetadataForTab(state: Pick<ReturnType<typeof useAppStore.getState>, 'sessions' | 'sessionNameMetadata' | 'pendingAgentLaunches'>, tab: WorkbenchTab | undefined) {
  return sessionNamesForReferences(state.sessionNameMetadata, tab ? Object.values(tab.regions).flatMap(region => {
    if (region.kind !== 'agent') return []
    const session = sessionPresentationById(state.sessions).get(region.sessionId)
    return [{agentSessionId: region.sessionId, hosts: [
      agentRegionExecution({tabId: tab.id, regionId: region.regionId, agentSessionId: region.sessionId})?.hostId,
      session?.hostId,
      state.pendingAgentLaunches[region.sessionId]?.request?.hostId
    ]}]
  }) : [])
}

/** Names read exact durable execution bindings; they never grant Session or Run capabilities. */
export function useWorkbenchTabNameMetadata(tab: WorkbenchTab | undefined) {
  const scope = useWorkbenchTabScope(tab)
  return useObservedAppStore('workbenchTab', true, scope, useShallow(state => nameMetadataForTab(state, tab)))
}

/** Runtime changes only refresh the Region menu when its displayed labels change. */
export function useWorkbenchRegionLabels(tab: WorkbenchTab) {
  const scope = useWorkbenchTabScope(tab)
  return useObservedAppStore('workbenchTab', true, scope, useShallow(state => {
    const byId = sessionPresentationById(state.sessions)
    const sessions = scope.sessionIds.flatMap(id => byId.get(id) ? [byId.get(id)!] : [])
    const metadata = nameMetadataForTab(state, tab)
    const agentFactsFor = workbenchAgentFactsFor(sessions, state.agentNames, state.timelines, metadata)
    return Object.fromEntries(regionIds(tab.layout.root).flatMap(regionId => {
      const region = tab.regions[regionId]
      if (!region) return []
      const facts = region.kind === 'agent' ? agentFactsFor(region.sessionId) : null
      return [[regionId, facts ? agentDisplayName(facts) : regionSurfaceLabel(region, sessions, metadata)]]
    }))
  }))
}

/** The original per-Session records share the same admission as the Tab's identity. */
type WorkbenchRecords = Pick<ReturnType<typeof useAppStore.getState>, 'agentNames' | 'timelines'>
export function useWorkbenchTabRecord(key: 'agentNames', tab: WorkbenchTab | undefined): WorkbenchRecords['agentNames']
export function useWorkbenchTabRecord(key: 'timelines', tab: WorkbenchTab | undefined): WorkbenchRecords['timelines']
export function useWorkbenchTabRecord(key: keyof WorkbenchRecords, tab: WorkbenchTab | undefined) {
  const scope = useWorkbenchTabScope(tab)
  return useObservedAppStore('workbenchTab', true, scope, useShallow(state =>
    recordForSessionIds<WorkbenchRecords[typeof key][string]>(state[key], scope.sessionIds)))
}

/** A retained workspace derives modes only when its own Session or preference facts change. */
export function useWorkbenchActivityPresentation(sessionIds: readonly string[]) {
  const scope = useMemo(() => ({ sessionIds, navigation: false }), [sessionIds])
  const modes = useMemo(() => sessionIds.map(id => [id, createSessionViewModeSelector(id)] as const), [sessionIds])
  return useObservedAppStore('workbenchTab', true, scope, useShallow(state => {
    return Object.fromEntries(modes.map(([id, mode]) =>
      [id, sessionPresentationById(state.sessions).get(id)?.kind === 'agent' && mode(state) !== 'terminal']))
  }))
}

/** Keep naming/timeline subscriptions on the same spatial consumers as the Session lookup. */
export function recordForWorkbenchTab<T>(record: Readonly<Record<string, T>>, tab: WorkbenchTab | undefined): Record<string, T> {
  return recordForSessionIds(record, tabSessionIds(tab))
}

/** Name and timeline records follow the same exact consumers as their Session facts. */
export function recordForSessionIds<T>(record: Readonly<Record<string, T>>, ids: readonly string[]): Record<string, T> {
  return Object.fromEntries(ids.flatMap(id => Object.hasOwn(record, id) ? [[id, record[id]!]] : []))
}

/** Exact registered directories consume the original shared Host/path projection, including worktrees. */
export function useDirectorySessions(directories: readonly Pick<WorkspaceRecord, 'hostId' | 'path'>[], active = true) {
  const scope = useMemo(() => JSON.stringify([...new Set(directories.map(directory => JSON.stringify([directory.hostId, directory.path])))].sort()), [directories])
  const current = useAppStore(useShallow(state => {
    if (!active) return null
    if (directories.length === 0) return []
    const owned = directories.flatMap(directory => sessionPresentationsAtPath(state.sessions, directory.hostId, directory.path))
    return [...new Map(owned.map(session => [session.id, session])).values()]
  }))
  return useRetainedSessionPresentation(scope, current)
}

/** Hidden presentation keeps its own confirmed members; it never borrows a previous scope. */
export function useRetainedSessionPresentation(scope: string, current: SessionSnapshot[] | null): SessionSnapshot[] {
  const retained = useRef({ scope, sessions: current ?? [] })
  if (current !== null) retained.current = { scope, sessions: current }
  else if (retained.current.scope !== scope) retained.current = { scope, sessions: [] }
  return retained.current.sessions
}
