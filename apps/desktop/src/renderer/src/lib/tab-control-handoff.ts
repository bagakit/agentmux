import { workbenchSurfaces, type WorkbenchTab } from './workbench-tabs'

export function copyableAgentSessionIdForTab(tab: WorkbenchTab): string | null {
  const agentSessionIds = new Set(workbenchSurfaces(tab).flatMap((surface) =>
    surface.kind === 'agent' ? [surface.sessionId] : []
  ))
  return agentSessionIds.size === 1 ? (agentSessionIds.values().next().value ?? null) : null
}
