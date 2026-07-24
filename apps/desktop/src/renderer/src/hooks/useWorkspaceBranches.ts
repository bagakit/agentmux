import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import {
  visibleWorkspaceBranchesState,
  type WorkspaceBranchesRequestState
} from '../lib/workspace-branches-state'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useWorkspaceBranches(workspaceId: string | null) {
  const [state, setState] = useState<WorkspaceBranchesRequestState | null>(null)
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
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
    void refresh()
    return () => { requestId.current += 1 }
  }, [refresh])

  return { ...visibleWorkspaceBranchesState(workspaceId, state), refresh }
}
