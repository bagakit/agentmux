import type { AppConfig, WorkspaceRecord } from '../../../shared/contracts'

/** Apply a main-process path rebind without changing Workspace identity or siblings. */
export function applyWorkspacePathRebind(
  config: AppConfig,
  updated: WorkspaceRecord
): AppConfig {
  if (!config.workspaces.some((workspace) => workspace.id === updated.id)) {
    throw new Error(`Unknown workspace: ${updated.id}`)
  }
  return {
    ...config,
    workspaces: config.workspaces.map((workspace) => workspace.id === updated.id ? updated : workspace)
  }
}
