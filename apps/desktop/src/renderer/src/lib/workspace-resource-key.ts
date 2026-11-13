import { useMemo } from 'react'
import { useAppStore } from '../store'

type AppState = ReturnType<typeof useAppStore.getState>
type AppConfig = AppState['config']

/**
 * The exact Workspace resource a Main read or lease is admitted against: same id, Host and path.
 * A result is used only while this key is unchanged; a renamed root or a moved Host makes it stale.
 */
export function workspaceResourceKey(workspaceId: string, config: AppConfig = useAppStore.getState().config): string {
  const workspace = config?.workspaces.find(item => item.id === workspaceId)
  return JSON.stringify([workspaceId, workspace?.hostId, workspace?.path])
}

/** The current resource key, recomputed only when config changes; every other store update returns it in O(1). */
export function useWorkspaceResourceKey(workspaceId: string): string {
  const select = useMemo(() => {
    let config: AppConfig | undefined, key = ''
    return (state: AppState) => {
      if (state.config !== config) { config = state.config; key = workspaceResourceKey(workspaceId, config) }
      return key
    }
  }, [workspaceId])
  return useAppStore(select)
}
