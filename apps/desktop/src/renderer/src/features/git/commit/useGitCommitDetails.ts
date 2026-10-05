import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceRecord } from '../../../../../shared/contracts'
import type { GitCommitDetailsResult } from '../../../../../shared/git-contracts'
import type { GitWorkbenchSurface } from '../../../lib/workbench-tabs'
import { gitBridge } from '../../../lib/git-bridge'

type ReadState = { key: string; result: GitCommitDetailsResult | null; loading: boolean; error: string | null }
/** Immutable object reader; navigation and surrounding layout belong to its consumer. */
export function useGitCommitDetails(workspace: WorkspaceRecord, scope: GitWorkbenchSurface['scope'], selection: GitWorkbenchSurface['selection'], visible: boolean) {
  const key = JSON.stringify([workspace.id, workspace.hostId, workspace.path, scope, selection])
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<ReadState | null>(null)
  const latest = useRef(read); latest.current = read
  useEffect(() => {
    if (!visible || !selection) return
    let current = true
    const previous = latest.current?.key === key ? latest.current : null
    const publish = (value: ReadState) => { if (current) setRead(value) }
    const lookup = gitBridge()
    if (!lookup.available) {
      publish({ key, result: previous?.result ?? null, loading: false, error: lookup.reason }); return
    }
    publish({ key, result: previous?.result ?? null, loading: true, error: null })
    void lookup.bridge.commitDetails(workspace.id, { oid: selection.commitOid,
      ...(selection.parentOid ? { parentOid: selection.parentOid } : {}) }).then(result => {
      if (result.kind !== 'ready') throw new Error('The original workspace is no longer a Git repository.')
      const fixed = result.snapshot
      if (fixed.hostId !== scope.hostId || fixed.repoPath !== scope.repoPath || fixed.commitOid !== selection.commitOid || fixed.parentOid !== selection.parentOid) {
        throw new Error('The repository or comparison parent changed. This fixed selection is retained.')
      }
      publish({ key, result, loading: false, error: null })
    }).catch(error => publish({ key, result: previous?.result ?? null, loading: false, error: error instanceof Error ? error.message : String(error) }))
    return () => { current = false }
  }, [key, visible, attempt])
  const reload = useCallback(() => setAttempt(value => value + 1), [])
  return { read: read?.key === key ? read : null, reload }
}
