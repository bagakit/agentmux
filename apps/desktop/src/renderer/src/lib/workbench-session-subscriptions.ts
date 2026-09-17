import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { sessionPresentationById } from './session-presentation'
import type { WorkbenchTab } from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'

function tabSessionIds(tab: WorkbenchTab): string[] {
  return [...new Set(Object.values(tab.regions).flatMap((surface) => isSessionSurface(surface) ? [surface.sessionId] : []))]
}

/** A Tab consumes only its Regions' Session references, never another Tab's runtime updates. */
export function useWorkbenchTabSessions(tab: WorkbenchTab) {
  const ids = useMemo(() => tabSessionIds(tab), [tab.regions])
  return useAppStore(useShallow((state) => {
    if (ids.length === 0) return []
    const byId = sessionPresentationById(state.sessions)
    return ids.flatMap((id) => {
      const session = byId.get(id)
      return session ? [session] : []
    })
  }))
}

/** Keep naming/timeline subscriptions on the same spatial consumers as the Session lookup. */
export function recordForWorkbenchTab<T>(record: Readonly<Record<string, T>>, tab: WorkbenchTab): Record<string, T> {
  return Object.fromEntries(tabSessionIds(tab).flatMap((id) => Object.hasOwn(record, id) ? [[id, record[id]!]] : []))
}
