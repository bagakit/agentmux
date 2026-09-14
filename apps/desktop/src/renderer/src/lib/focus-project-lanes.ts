import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { workspaceForSession } from './workbench-tabs'

export type FocusProjectLane = {
  workspaceId: string
  name: string
  path: string
  activeAgentIds: string[]
}

/** A Focus project is visible only while it owns at least one live Agent Run. */
export function isActiveFocusAgent(session: SessionSnapshot): boolean {
  return session.kind === 'agent' && session.processState === 'running'
}

export function deriveFocusProjectLanes(
  config: AppConfig | null,
  sessions: readonly SessionSnapshot[]
): FocusProjectLane[] {
  if (!config) return []
  const activeByWorkspace = new Map<string, string[]>()
  for (const session of sessions) {
    if (!isActiveFocusAgent(session)) continue
    const workspace = workspaceForSession(config, session)
    if (!workspace) continue
    const ids = activeByWorkspace.get(workspace.id) ?? []
    ids.push(session.id)
    activeByWorkspace.set(workspace.id, ids)
  }
  return config.workspaces.flatMap((workspace: WorkspaceRecord) => {
    const activeAgentIds = activeByWorkspace.get(workspace.id)
    return activeAgentIds && activeAgentIds.length > 0
      ? [{ workspaceId: workspace.id, name: workspace.name, path: workspace.path, activeAgentIds }]
      : []
  })
}
