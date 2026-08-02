import { useCallback, useRef, useState } from 'react'
import type { PrReadiness } from '../../../shared/contracts'
import { ghBridge } from '../lib/git-bridge'

export type PrReadinessState = {
  workspaceId: string
  readiness: PrReadiness | null
  loading: boolean
  error: string | null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read "can a pull request be opened here right now?" for one workspace.
 *
 * Deliberately **not** fetched on mount, unlike {@link useGitStatus}: this costs a `gh auth status` and
 * two `git` shell-outs against the remote, and the Source Control panel is open most of the time while a
 * PR is opened rarely. So the read happens when the user reaches for it, and the panel says it is
 * checking rather than pretending to already know.
 *
 * The same monotonic request-id discipline as the git hooks: a slow readiness for one workspace can
 * never land after the user has switched to another. The stale-guard is checked before every state
 * write, not just the success one — a rejection arriving late would otherwise show an error about a
 * workspace nobody is looking at.
 */
export function usePrReadiness(workspaceId: string | null): PrReadinessState & {
  check: () => Promise<PrReadiness | null>
  reset: () => void
} {
  const [state, setState] = useState<PrReadinessState | null>(null)
  const requestId = useRef(0)

  const reset = useCallback(() => {
    // Bumping the id is what makes this a real cancel rather than just a visual clear: an in-flight
    // read for the dismissed panel must not repopulate it after the user closed it.
    requestId.current += 1
    setState(null)
  }, [])

  const check = useCallback(async () => {
    if (!workspaceId) {
      setState(null)
      return null
    }
    const lookup = ghBridge()
    if (!lookup.available) {
      setState({ workspaceId, readiness: null, loading: false, error: lookup.reason })
      return null
    }
    const id = ++requestId.current
    setState({ workspaceId, readiness: null, loading: true, error: null })
    try {
      const next = await lookup.bridge.prReadiness(workspaceId)
      if (requestId.current !== id) return null
      setState({ workspaceId, readiness: next, loading: false, error: null })
      return next
    } catch (cause) {
      if (requestId.current !== id) return null
      setState({ workspaceId, readiness: null, loading: false, error: message(cause) })
      return null
    }
  }, [workspaceId])

  return {
    workspaceId: state?.workspaceId ?? workspaceId ?? '',
    readiness: state?.workspaceId === workspaceId ? state.readiness : null,
    loading: state?.workspaceId === workspaceId ? state.loading : false,
    error: state?.workspaceId === workspaceId ? state.error : null,
    check,
    reset
  }
}
