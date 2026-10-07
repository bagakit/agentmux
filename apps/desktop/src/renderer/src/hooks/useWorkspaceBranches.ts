import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import {
  visibleWorkspaceBranchesState,
  type WorkspaceBranchesRequestState
} from '../lib/workspace-branches-state'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useWorkspaceBranches(workspaceId: string | null, active = true) {
  const [state, setState] = useState<WorkspaceBranchesRequestState | null>(null)
  const requestId = useRef(0)
  const autoRead = useRef<object | null>(null)
  const scope = useRef<object>({})

  const refresh = useCallback(async () => {
    autoRead.current = scope.current
    if (!workspaceId) {
      setState(null)
      return false
    }
    const id = ++requestId.current
    setState((current) => ({
      workspaceId,
      snapshot: current?.workspaceId === workspaceId ? current.snapshot : null,
      loading: true,
      error: null
    }))
    try {
      const next = await api.workspaces.listBranches(workspaceId)
      if (requestId.current !== id) return false
      setState({ workspaceId, snapshot: next, loading: false, error: null })
      return true
    } catch (cause) {
      if (requestId.current !== id) return false
      setState((current) => ({
        workspaceId,
        snapshot: current?.workspaceId === workspaceId ? current.snapshot : null,
        loading: false,
        error: message(cause)
      }))
      return false
    }
  }, [workspaceId])

  useEffect(() => {
    scope.current = {}
    autoRead.current = null
    return () => { requestId.current += 1 }
  }, [refresh])
  useEffect(() => {
    if (active && autoRead.current !== scope.current) void refresh()
    if (!active) autoRead.current = null
  }, [active, refresh])

  return { ...visibleWorkspaceBranchesState(workspaceId, state), refresh }
}
