import { useMemo } from 'react'
import type { AppConfig } from '../../../shared/contracts'
import { currentCoreSpatialGraph, useAppStore } from '../store'
import { originalSpaceWorkspace } from '../lib/original-space-navigation'

/** Unrelated Session updates do not rescan the Workspace catalog for each retained File. */
export function createWorkspaceResourceSelector(workspaceId: string | null) {
  let workspaces: AppConfig['workspaces'] | undefined
  let resource: ReturnType<typeof originalSpaceWorkspace> | undefined
  return (state: { config: AppConfig | null }) => {
    if (state.config?.workspaces !== workspaces) {
      workspaces = state.config?.workspaces
      resource = workspaces?.find(workspace => workspace.id === workspaceId)
    }
    return resource
  }
}

export function useWorkspaceResource(workspaceId: string | null) {
  const config = useAppStore(state => state.config)
  const inputs = useAppStore(state => state.mountedSpaceInputs)
  const observations = useAppStore(state => state.mountedSpaceObservations)
  const selection = useAppStore(state => state.workbenchSpaceSelection)
  return useMemo(() => originalSpaceWorkspace(useAppStore.getState(), workspaceId, currentCoreSpatialGraph()), [workspaceId, config, inputs, observations, selection])
}
