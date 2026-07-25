import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatusResult } from '../../../shared/contracts'

export type GitStatusRequestState = {
  workspaceId: string
  status: GitStatusResult | null
  loading: boolean
  error: string | null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read source-control status for a workspace, guarded against stale results.
 *
 * Git is a Desktop-main capability reached through `window.agentmux.git` — not the shared mock `api`,
 * which is why this hook does not import `lib/api`. A monotonic request id is captured per fetch and
 * checked before any state write, so a slow status for one workspace can never overwrite a newer one
 * after the user switches workspaces (the same request-id discipline the branches hook uses).
 */
export function useGitStatus(workspaceId: string | null): GitStatusRequestState & {
  refresh: () => Promise<boolean>
} {
  const [state, setState] = useState<GitStatusRequestState | null>(null)
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setState(null)
      return false
    }
    const bridge = window.agentmux?.git
    if (!bridge) {
      setState({ workspaceId, status: null, loading: false, error: 'Git is unavailable in this build.' })
      return false
    }
    const id = ++requestId.current
    setState((current) => ({
      workspaceId,
      status: current?.workspaceId === workspaceId ? current.status : null,
      loading: true,
      error: null
    }))
    try {
      const next = await bridge.status(workspaceId)
      if (requestId.current !== id) return false
      setState({ workspaceId, status: next, loading: false, error: null })
      return true
    } catch (cause) {
      if (requestId.current !== id) return false
      setState((current) => ({
        workspaceId,
        status: current?.workspaceId === workspaceId ? current.status : null,
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

  const visible = state?.workspaceId === workspaceId
    ? state
    : { workspaceId: workspaceId ?? '', status: null, loading: workspaceId !== null, error: null }
  return { ...visible, refresh }
}
