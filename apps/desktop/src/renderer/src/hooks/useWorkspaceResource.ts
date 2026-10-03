import { useMemo } from 'react'
import type { AppConfig, WorkspaceRecord } from '../../../shared/contracts'
import { useAppStore } from '../store'

/** Unrelated Session updates do not rescan the Workspace catalog for each retained File. */
export function createWorkspaceResourceSelector(workspaceId: string | null) {
  let workspaces: AppConfig['workspaces'] | undefined
  let resource: WorkspaceRecord | undefined
  return (state: { config: AppConfig | null }) => {
    if (state.config?.workspaces !== workspaces) {
      workspaces = state.config?.workspaces
      resource = workspaces?.find(workspace => workspace.id === workspaceId)
    }
    return resource
  }
}

export function useWorkspaceResource(workspaceId: string | null) {
  return useAppStore(useMemo(() => createWorkspaceResourceSelector(workspaceId), [workspaceId]))
}
