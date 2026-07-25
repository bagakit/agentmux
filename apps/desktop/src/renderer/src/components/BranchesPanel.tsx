import * as Dialog from '@radix-ui/react-dialog'
import {
  Check,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  Plus,
  RefreshCw,
  Unlink,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  WorkspaceBranchesSnapshot,
  WorkspaceBranchRecord,
  WorkspaceRecord
} from '../../../shared/contracts'
import { useWorkspaceBranches } from '../hooks/useWorkspaceBranches'
import { api } from '../lib/api'
import {
  runningAgentPresenceByWorktree,
  worktreePresenceKey
} from '../lib/branch-agent-presence'
import { defaultWorktreePath } from '../lib/workspace-projects'
import { useAppStore } from '../store'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { BranchContextMenu } from './BranchContextMenu'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function BranchesPanel({ workspace }: { workspace: WorkspaceRecord }) {
  const activateWorkspaceSelection = useAppStore((state) => state.activateWorkspaceSelection)
  const sessions = useAppStore((state) => state.sessions)
  const [selectedBranch, setSelectedBranch] = useState(workspace.branch ?? null)
  const [createBranch, setCreateBranch] = useState<WorkspaceBranchRecord | null>(null)
  const [worktreePath, setWorktreePath] = useState('')
  const [busyBranch, setBusyBranch] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const { snapshot, loading, error: loadError, refresh } = useWorkspaceBranches(workspace.id)

  useEffect(() => {
    const current = snapshot?.kind === 'git-repository'
      ? snapshot.branches.find((branch) => branch.isCurrent)
      : undefined
    setSelectedBranch(current?.name ?? workspace.branch ?? null)
  }, [snapshot, workspace.branch])

  const bound = useMemo(
    () => snapshot?.kind === 'git-repository'
      ? snapshot.branches.filter((branch) => branch.worktreePath)
      : [],
    [snapshot]
  )
  const unbound = useMemo(
    () => snapshot?.kind === 'git-repository'
      ? snapshot.branches.filter((branch) => !branch.worktreePath)
      : [],
    [snapshot]
  )
  const runningAgentsByWorktree = useMemo(
    () => runningAgentPresenceByWorktree(sessions),
    [sessions]
  )

  function openCreateDialog(branch: WorkspaceBranchRecord): void {
    if (snapshot?.kind !== 'git-repository' || branch.worktreePath) return
    setSelectedBranch(branch.name)
    setCreateBranch(branch)
    setWorktreePath(defaultWorktreePath(snapshot.repoPath, branch.name))
    setActionError(null)
  }

  async function openBranch(branch: WorkspaceBranchRecord): Promise<void> {
    if (!branch || busyBranch) return
    setSelectedBranch(branch.name)
    setActionError(null)
    if (!branch.worktreePath) {
      openCreateDialog(branch)
      return
    }
    setBusyBranch(branch.name)
    try {
      activateWorkspaceSelection(await api.workspaces.openBranch(workspace.id, branch.name))
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setBusyBranch(null)
    }
  }

  async function createWorktree(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!createBranch || createBranch.worktreePath || !worktreePath.trim() || busyBranch) return
    setBusyBranch(createBranch.name)
    setActionError(null)
    try {
      activateWorkspaceSelection(await api.workspaces.createWorktreeForBranch({
        workspaceId: workspace.id,
        branch: createBranch.name,
        path: worktreePath.trim()
      }))
      setCreateBranch(null)
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setBusyBranch(null)
    }
  }

  async function copyText(text: string): Promise<void> {
    setActionError(null)
    try {
      await api.ui.writeClipboardText(text)
    } catch (cause) {
      setActionError(message(cause))
    }
  }

  function branchRow(branch: WorkspaceBranchRecord) {
    const selectedRow = selectedBranch === branch.name
    const runningAgents = branch.worktreePath && snapshot?.kind === 'git-repository'
      ? runningAgentsByWorktree.get(worktreePresenceKey(snapshot.hostId, branch.worktreePath)) ?? []
      : []
    const visibleAgents = runningAgents.slice(0, 4)
    const hiddenAgentTypes = runningAgents.length - visibleAgents.length
    const runningAgentLabel = runningAgents
      .map((agent) => `${agentProviderLabel(agent.providerId)}${agent.count > 1 ? ` ×${agent.count}` : ''}`)
      .join(', ')
    return (
      <BranchContextMenu
        key={branch.name}
        hasWorktree={branch.worktreePath !== null}
        onOpen={() => void openBranch(branch)}
        onCopyBranchName={() => void copyText(branch.name)}
        onCopyWorktreePath={() => branch.worktreePath && void copyText(branch.worktreePath)}
        onRefresh={() => void refresh()}
      >
        <button
          type="button"
          className={`branch-row ${selectedRow ? 'branch-row--selected' : ''}`}
          aria-pressed={selectedRow}
          onClick={() => void openBranch(branch)}
          onContextMenu={() => setSelectedBranch(branch.name)}
        >
          <span className="branch-row__icon">
            {busyBranch === branch.name ? <LoaderCircle className="spin" size={12} /> : <GitBranch size={12} />}
          </span>
          <span className="branch-row__identity">
            <strong title={branch.name}>{branch.name}</strong>
            <small title={branch.worktreePath ?? undefined}>{branch.worktreePath ?? 'No worktree'}</small>
          </span>
          <span className="branch-row__meta">
            {visibleAgents.length > 0 ? (
              <span
                className="branch-row__agents"
                aria-label={`Running agents: ${runningAgentLabel}`}
                title={`Running agents: ${runningAgentLabel}`}
              >
                {visibleAgents.map((agent) => (
                  <span className="branch-row__agent" key={agent.providerId}>
                    <AgentProviderIcon providerId={agent.providerId} size={11} />
                    {agent.count > 1 ? <small>{agent.count}</small> : null}
                  </span>
                ))}
                {hiddenAgentTypes > 0 ? <em>+{hiddenAgentTypes}</em> : null}
              </span>
            ) : null}
            <span className={`branch-row__state ${branch.worktreePath ? '' : 'branch-row__state--unbound'}`}>
              {branch.isCurrent ? <><Check size={9} /> Current</> : branch.worktreePath ? 'Worktree' : <><Unlink size={9} /> Branch</>}
            </span>
          </span>
        </button>
      </BranchContextMenu>
    )
  }

  return (
    <section className="branches-panel">
      <header className="branches-header">
        <div><span>Branches</span><small>{snapshot?.kind === 'git-repository' ? snapshot.branches.length : 0}</small></div>
        <button type="button" title="Refresh branches" onClick={() => void refresh()} disabled={loading}>
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
        </button>
      </header>
      {snapshot?.kind === 'git-repository' ? <div className="branches-repo"><FolderGit2 size={11} /><span>{snapshot.repoPath}</span></div> : null}
      <div className="branches-scroll">
        {bound.length > 0 ? <div className="branch-group"><span>Worktrees</span>{bound.map(branchRow)}</div> : null}
        {unbound.length > 0 ? <div className="branch-group"><span>Without worktree</span>{unbound.map(branchRow)}</div> : null}
        {!loading && snapshot?.kind === 'not-a-git-repository' ? (
          <div className="branches-empty"><strong>Not a Git repository</strong><span>This workspace is not linked to a Git repository.</span></div>
        ) : null}
        {!loading && snapshot?.kind === 'git-repository' && snapshot.branches.length === 0 ? (
          <div className="branches-empty"><strong>No local branches</strong><span>Create a branch with Git, then refresh.</span></div>
        ) : null}
        {!loading && loadError && !snapshot ? (
          <div className="branches-empty branches-empty--error"><strong>Branches unavailable</strong><span>{loadError}</span><button className="small-button" onClick={() => void refresh()}>Retry</button></div>
        ) : null}
      </div>
      {actionError && !createBranch && snapshot ? <div className="branches-inline-error" role="alert">{actionError}</div> : null}
      <Dialog.Root
        open={createBranch !== null}
        onOpenChange={(open) => {
          if (!open && busyBranch === null) {
            setCreateBranch(null)
            setActionError(null)
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="confirmation-dialog__overlay" />
          <Dialog.Content
            className="branch-create-dialog"
            onEscapeKeyDown={(event) => busyBranch !== null && event.preventDefault()}
          >
            <form onSubmit={(event) => void createWorktree(event)}>
              <header>
                <span><GitBranch size={16} /></span>
                <div>
                  <Dialog.Title>Create worktree</Dialog.Title>
                  <Dialog.Description>Bind this Branch to an isolated working directory.</Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button type="button" className="icon-button" aria-label="Close create worktree dialog" disabled={busyBranch !== null}>
                    <X size={14} />
                  </button>
                </Dialog.Close>
              </header>
              <section className="branch-create-dialog__context">
                <GitBranch size={13} />
                <span><small>Branch</small><strong>{createBranch?.name}</strong></span>
              </section>
              <label>
                <span>Worktree path</span>
                <input
                  autoFocus
                  value={worktreePath}
                  onChange={(event) => setWorktreePath(event.target.value)}
                  spellCheck={false}
                />
              </label>
              {actionError ? <p role="alert">{actionError}</p> : null}
              <footer>
                <Dialog.Close asChild>
                  <button className="small-button" type="button" disabled={busyBranch !== null}>Cancel</button>
                </Dialog.Close>
                <button className="primary-button" type="submit" disabled={!worktreePath.trim() || busyBranch !== null}>
                  {busyBranch ? <LoaderCircle className="spin" size={12} /> : <Plus size={12} />}
                  {busyBranch ? 'Creating…' : 'Create Worktree'}
                </button>
              </footer>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}
