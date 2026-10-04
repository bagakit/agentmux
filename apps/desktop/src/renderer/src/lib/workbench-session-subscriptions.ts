import { useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentRegionExecution, useAppStore } from '../store'
import { sessionNamesForReferences } from './session-name-metadata'
import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { sessionPresentationById, sessionPresentationsAtPath } from './session-presentation'
import type { WorkbenchTab } from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'

function tabSessionIds(tab: WorkbenchTab | undefined): string[] {
  return tab ? [...new Set(Object.values(tab.regions).flatMap((surface) => isSessionSurface(surface) ? [surface.sessionId] : []))] : []
}

/** A Tab consumes only its Regions' Session references, never another Tab's runtime updates. */
export function useWorkbenchTabSessions(tab: WorkbenchTab | undefined) {
  const ids = useMemo(() => tabSessionIds(tab), [tab?.regions])
  return useAppStore(useShallow((state) => {
    if (ids.length === 0) return []
    const byId = sessionPresentationById(state.sessions)
    return ids.flatMap((id) => {
      const session = byId.get(id)
      return session ? [session] : []
    })
  }))
}

/** Names read exact durable execution bindings; they never grant Session or Run capabilities. */
export function useWorkbenchTabNameMetadata(tab: WorkbenchTab | undefined) {
  return useAppStore(useShallow(state => sessionNamesForReferences(state.sessionNameMetadata, tab ? Object.values(tab.regions).flatMap(region => {
    if (region.kind !== 'agent') return []
    const session = sessionPresentationById(state.sessions).get(region.sessionId)
    return [{agentSessionId: region.sessionId, hosts: [
      agentRegionExecution({tabId: tab.id, regionId: region.regionId, agentSessionId: region.sessionId})?.hostId,
      session?.hostId,
      state.pendingAgentLaunches[region.sessionId]?.request?.hostId
    ]}]
  }) : [])))
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
