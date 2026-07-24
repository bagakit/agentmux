import {
  Check,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  Plus,
  RefreshCw,
  Unlink
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  WorkspaceBranchesSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import { useWorkspaceBranches } from '../hooks/useWorkspaceBranches'
import { api } from '../lib/api'
import { defaultWorktreePath } from '../lib/workspace-projects'
import { useAppStore } from '../store'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function BranchesPanel({ workspace }: { workspace: WorkspaceRecord }) {
  const activateWorkspaceSelection = useAppStore((state) => state.activateWorkspaceSelection)
  const [selectedBranch, setSelectedBranch] = useState(workspace.branch ?? null)
  const [worktreePath, setWorktreePath] = useState('')
  const [busyBranch, setBusyBranch] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const { snapshot, loading, error: loadError, refresh } = useWorkspaceBranches(workspace.id)

  useEffect(() => {
    const current = snapshot?.branches.find((branch) => branch.isCurrent)
    setSelectedBranch(current?.name ?? workspace.branch ?? null)
  }, [snapshot, workspace.branch])

  const bound = useMemo(
    () => snapshot?.branches.filter((branch) => branch.worktreePath) ?? [],
    [snapshot]
  )
  const unbound = useMemo(
    () => snapshot?.branches.filter((branch) => !branch.worktreePath) ?? [],
    [snapshot]
  )
  const selected = snapshot?.branches.find((branch) => branch.name === selectedBranch) ?? null

  async function selectBranch(name: string): Promise<void> {
    const branch = snapshot?.branches.find((candidate) => candidate.name === name)
    if (!branch || busyBranch) return
    setSelectedBranch(name)
    setActionError(null)
    if (!branch.worktreePath) {
      setWorktreePath(defaultWorktreePath(snapshot!.repoPath, branch.name))
      return
    }
    setBusyBranch(name)
    try {
      activateWorkspaceSelection(await api.workspaces.openBranch(workspace.id, name))
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setBusyBranch(null)
    }
  }

  async function createWorktree(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!selected || selected.worktreePath || !worktreePath.trim() || busyBranch) return
    setBusyBranch(selected.name)
    setActionError(null)
    try {
      activateWorkspaceSelection(await api.workspaces.createWorktreeForBranch({
        workspaceId: workspace.id,
        branch: selected.name,
        path: worktreePath.trim()
      }))
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setBusyBranch(null)
    }
  }

  function branchRow(branch: NonNullable<WorkspaceBranchesSnapshot['branches'][number]>) {
    const selectedRow = selectedBranch === branch.name
    return (
      <button
        key={branch.name}
        type="button"
        className={`branch-row ${selectedRow ? 'branch-row--selected' : ''}`}
        aria-pressed={selectedRow}
        onClick={() => void selectBranch(branch.name)}
      >
        <span className="branch-row__icon">
          {busyBranch === branch.name ? <LoaderCircle className="spin" size={13} /> : <GitBranch size={13} />}
        </span>
        <span className="branch-row__identity">
          <strong>{branch.name}</strong>
          <small>{branch.worktreePath ?? 'No worktree'}</small>
        </span>
        <span className={`branch-row__state ${branch.worktreePath ? '' : 'branch-row__state--unbound'}`}>
          {branch.isCurrent ? <><Check size={10} /> Current</> : branch.worktreePath ? 'Worktree' : <><Unlink size={10} /> Branch</>}
        </span>
      </button>
    )
  }

  return (
    <section className="branches-panel">
      <header className="branches-header">
        <div><span>Branches</span><small>{snapshot ? snapshot.branches.length : 0}</small></div>
        <button type="button" title="Refresh branches" onClick={() => void refresh()} disabled={loading}>
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
        </button>
      </header>
      {snapshot ? <div className="branches-repo"><FolderGit2 size={11} /><span>{snapshot.repoPath}</span></div> : null}
      <div className="branches-scroll">
        {bound.length > 0 ? <div className="branch-group"><span>Worktrees</span>{bound.map(branchRow)}</div> : null}
        {unbound.length > 0 ? <div className="branch-group"><span>Without worktree</span>{unbound.map(branchRow)}</div> : null}
        {!loading && snapshot && snapshot.branches.length === 0 ? (
          <div className="branches-empty"><strong>No local branches</strong><span>Create a branch with Git, then refresh.</span></div>
        ) : null}
        {!loading && loadError && !snapshot ? (
          <div className="branches-empty branches-empty--error"><strong>Branches unavailable</strong><span>{loadError}</span><button className="small-button" onClick={() => void refresh()}>Retry</button></div>
        ) : null}
      </div>
      {selected && !selected.worktreePath ? (
        <form className="branch-create" onSubmit={(event) => void createWorktree(event)}>
          <div><strong>Create worktree</strong><span>{selected.name}</span></div>
          <label><span>Path</span><input value={worktreePath} onChange={(event) => setWorktreePath(event.target.value)} /></label>
          {actionError ? <p>{actionError}</p> : null}
          <button className="primary-button" type="submit" disabled={!worktreePath.trim() || busyBranch !== null}>
            {busyBranch ? <LoaderCircle className="spin" size={12} /> : <Plus size={12} />} Create
          </button>
        </form>
      ) : actionError && snapshot ? <div className="branches-inline-error">{actionError}</div> : null}
    </section>
  )
}
