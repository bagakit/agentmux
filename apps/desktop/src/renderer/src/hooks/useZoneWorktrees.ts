import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { GitWorktreesResult } from '../../../shared/git-contracts'
import { api } from '../lib/api'

type Snapshot = Exclude<GitWorktreesResult, { kind: 'unavailable' }>
type Observation = { key: string; snapshot: Snapshot | null; loading: boolean; stale: boolean; issue: string | null }

/** One current Space read, shared by all its Zone rows. Navigation never depends on this observation. */
export function useZoneWorktrees(spaceId: string, workspace: WorkspaceRecord, visible: boolean) {
  const { id, hostId, path } = workspace
  const key = JSON.stringify([spaceId, id, hostId, path])
  const [state, setState] = useState<Observation | null>(null)
  const generation = useRef(0)
  const current = useRef({ key, visible })
  current.current = { key, visible }
  const refresh = useCallback(async () => {
    if (!current.current.visible || current.current.key !== key) return
    const request = ++generation.current
    setState(previous => ({ key, snapshot: previous?.key === key ? previous.snapshot : null, loading: true, stale: true, issue: null }))
    try {
      const result = await api.git.worktrees({ workspaceId: id, expectedResource: { hostId, workspacePath: path } })
      if (generation.current !== request || current.current.key !== key || !current.current.visible) return
      if (result.hostId !== hostId || result.workspacePath !== path) throw new Error('Git observation belongs to another Host or directory. Refresh the original resource.')
      if (result.kind === 'unavailable') throw new Error(result.reason)
      setState({ key, snapshot: result, loading: false, stale: false, issue: null })
    } catch (error) {
      if (generation.current !== request || current.current.key !== key || !current.current.visible) return
      setState(previous => ({ key, snapshot: previous?.key === key ? previous.snapshot : null, loading: false, stale: true,
        issue: error instanceof Error ? error.message : String(error) }))
    }
  }, [key, id, hostId, path])
  useEffect(() => {
    if (visible) void refresh()
    else setState(previous => previous?.key === key ? { ...previous, loading: false, stale: true } : null)
    return () => { generation.current++ }
  }, [key, visible, refresh])
  const observed = state?.key === key ? state : null
  return { snapshot: observed?.snapshot ?? null, loading: observed?.loading ?? false,
    stale: observed?.stale ?? true, issue: observed?.issue ?? null, refresh }
}
