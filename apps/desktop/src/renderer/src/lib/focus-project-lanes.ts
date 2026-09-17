import type { FocusContext } from './focus-context'
export type FocusProjectLane = { workspaceId: string; name: string; path: string; activeAgentIds: string[] }
/** Keep every retained context reachable, including results, terminals and recovery. */
export function deriveFocusProjectLanes(rows: readonly FocusContext[]): FocusProjectLane[] {
  const projects = new Map<string, FocusProjectLane>()
  for (const row of rows) {
    const lane = projects.get(row.workspaceId) ?? { workspaceId: row.workspaceId, name: row.workspaceName, path: row.workspacePath, activeAgentIds: [] }
    if (row.liveAgent) lane.activeAgentIds.push(row.id)
    projects.set(row.workspaceId, lane)
  }
  return [...projects.values()]
}
