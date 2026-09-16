import { useEffect, useRef, useState } from 'react'
import type { WorkspaceBranchRecord } from '../../../shared/contracts'
import type { GitBranchCompareMode, GitBranchComparisonResult } from '../../../shared/git-contracts'
import { gitBridge } from '../lib/git-bridge'
import { useAppStore } from '../store'

export function BranchComparisonPanel({ workspaceId, branches }: {
  workspaceId: string
  branches: WorkspaceBranchRecord[]
}) {
  const [baseBranch, setBaseBranch] = useState('')
  const [targetBranch, setTargetBranch] = useState(() => branches.find((branch) => branch.isCurrent)?.name ?? '')
  const [mode, setMode] = useState<GitBranchCompareMode>('merge-base')
  const [result, setResult] = useState<GitBranchComparisonResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const requestId = useRef(0)
  const open = useAppStore((state) => state.openBranchDiff)
  useEffect(() => () => { requestId.current += 1 }, [])
  function changeSelection(update: () => void): void {
    requestId.current += 1
    setLoading(false)
    setError(null)
    update()
  }
  async function compare(): Promise<void> {
    const id = ++requestId.current
    const lookup = gitBridge()
    if (!lookup.available) { setError(lookup.reason); return }
    setLoading(true)
    setError(null)
    try {
      const next = await lookup.bridge.compareBranches(workspaceId, { baseBranch, targetBranch, mode })
      if (requestId.current !== id) return
      setResult(next)
    } catch (cause) {
      if (requestId.current !== id) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestId.current === id) setLoading(false)
    }
  }
  const branchesExist = [baseBranch, targetBranch].every((name) => branches.some((branch) => branch.name === name))
  const selectionMatches = result?.kind === 'ready' && result.snapshot.baseBranch === baseBranch && result.snapshot.targetBranch === targetBranch && result.snapshot.mode === mode
  return (
    <section className="branch-comparison" aria-label="Branch comparison">
      <form onSubmit={(event) => { event.preventDefault(); if (branchesExist) void compare() }}>
        <label>Base branch A
          <select aria-label="Base branch A" value={baseBranch} onChange={(event) => changeSelection(() => setBaseBranch(event.target.value))}>
            <option value="">Choose a local branch</option>
            {branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
          </select>
        </label>
        <label>Target branch B
          <select aria-label="Target branch B" value={targetBranch} onChange={(event) => changeSelection(() => setTargetBranch(event.target.value))}>
            <option value="">Choose a local branch</option>
            {branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
          </select>
        </label>
        <label>Compare
          <select aria-label="Comparison mode" value={mode} onChange={(event) => changeSelection(() => setMode(event.target.value as GitBranchCompareMode))}>
            <option value="merge-base">Changes in B since the common ancestor</option>
            <option value="two-point">Commit A → commit B</option>
          </select>
        </label>
        <button className="small-button" type="submit" disabled={!branchesExist || loading}>
          {loading ? 'Comparing…' : selectionMatches ? 'Refresh comparison' : 'Compare branches'}
        </button>
      </form>
      {error ? <div className="branches-inline-error" role="alert">{error}</div> : null}
      {result?.kind === 'not-a-git-repository' ? <p>Not a Git repository.</p> : null}
      {result?.kind === 'ready' ? <>
        <div className="branch-comparison__summary">
          <strong>{result.snapshot.baseBranch} {result.snapshot.mode === 'merge-base' ? '…' : '→'} {result.snapshot.targetBranch}</strong>
          <span title={`${result.snapshot.comparisonBaseOid} → ${result.snapshot.targetOid}`}>
            {result.snapshot.comparisonBaseOid.slice(0, 8)} → {result.snapshot.targetOid.slice(0, 8)} · {result.entries.length} files
          </span>
          {!selectionMatches ? <span>Showing the previous fixed comparison. Compare to update.</span> : null}
        </div>
        {result.warnings.map((warning, index) => <p key={index} role="status">{warning}</p>)}
        {result.entries.length === 0 ? <p>No changed files between these commits.</p> : <div className="branch-comparison__files">
          {result.entries.map((file) => <button
            key={JSON.stringify([file.path, file.origPath])}
            className="branch-comparison__file"
            title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
            onClick={() => open(workspaceId, { snapshot: result.snapshot, file: { path: file.path, origPath: file.origPath } })}
          ><span>{file.origPath ? `${file.origPath} → ${file.path}` : file.path}</span><small>{file.change}</small></button>)}
        </div>}
      </> : null}
    </section>
  )
}
