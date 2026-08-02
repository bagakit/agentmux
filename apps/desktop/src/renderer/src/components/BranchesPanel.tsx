import * as Dialog from '@radix-ui/react-dialog'
import {
  Check,
  FolderGit2,
  GitBranch,
  GitCompareArrows,
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
import { useGitAheadBehind } from '../hooks/useGitAheadBehind'
import { gitSyncBadge } from '../lib/git-sync-badge'
import { MAX_FANOUT_LANES } from '../../../shared/fanout-limits'
import { buildFanOutRequest } from '../lib/fanout-request'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import {
  runningAgentPresenceByWorktree,
  worktreePresenceKey
} from '../lib/branch-agent-presence'
import { defaultWorktreePath } from '../lib/workspace-projects'
import { branchHasWorktree, branchOpenIntent, branchWorktreePath } from '../lib/workspace-branches-state'
import { useAppStore } from '../store'
import { agentProviderLabel } from './AgentProviderIcon'
import { SelectorListHeader, SelectorPresence, SelectorRow } from './SelectorList'
import { BranchContextMenu } from './BranchContextMenu'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function BranchesPanel({ workspace }: { workspace: WorkspaceRecord }) {
  const activateWorkspaceSelection = useAppStore((state) => state.activateWorkspaceSelection)
  const runFanOut = useAppStore((state) => state.runFanOut)
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const [selectedBranch, setSelectedBranch] = useState(workspace.branch ?? null)
  const [createBranch, setCreateBranch] = useState<WorkspaceBranchRecord | null>(null)
  const [worktreePath, setWorktreePath] = useState('')
  const [busyBranch, setBusyBranch] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [fanOutOpen, setFanOutOpen] = useState(false)
  const [fanOutPrompt, setFanOutPrompt] = useState('')
  const [fanOutCount, setFanOutCount] = useState(3)
  const [fanningOut, setFanningOut] = useState(false)
  const { snapshot, loading, error: loadError, refresh } = useWorkspaceBranches(workspace.id)
  // ahead/behind 是 **HEAD** 相对它自己 upstream 的事实，不是逐分支的——所以下面只把它画在
  // `isCurrent` 那一行。画到别的行上会是谎：那些分支各有各的 upstream，这一个计数说不了它们的事。
  const { facts: syncFacts } = useGitAheadBehind(workspace.id)

  useEffect(() => {
    const current = snapshot?.kind === 'git-repository'
      ? snapshot.branches.find((branch) => branch.isCurrent)
      : undefined
    setSelectedBranch(current?.name ?? workspace.branch ?? null)
  }, [snapshot, workspace.branch])

  // 「有没有 worktree」这一个概念只有 branchHasWorktree 一个判定点（见该函数头部注释：此前它在本文件
  // 里被独立判了七次，其中一处用 !== null 而其余用 truthy，空串会让它们结论相反）。
  const bound = useMemo(
    () => snapshot?.kind === 'git-repository'
      ? snapshot.branches.filter(branchHasWorktree)
      : [],
    [snapshot]
  )
  const unbound = useMemo(
    () => snapshot?.kind === 'git-repository'
      ? snapshot.branches.filter((branch) => !branchHasWorktree(branch))
      : [],
    [snapshot]
  )
  const runningAgentsByWorktree = useMemo(
    () => runningAgentPresenceByWorktree(sessions),
    [sessions]
  )

  function openCreateDialog(branch: WorkspaceBranchRecord): void {
    if (snapshot?.kind !== 'git-repository' || branchHasWorktree(branch)) return
    setSelectedBranch(branch.name)
    setCreateBranch(branch)
    setWorktreePath(defaultWorktreePath(snapshot.repoPath, branch.name))
    setActionError(null)
  }

  async function openBranch(branch: WorkspaceBranchRecord): Promise<void> {
    if (!branch || busyBranch) return
    setSelectedBranch(branch.name)
    setActionError(null)
    // 分流本身是 branchOpenIntent 算的，这里只负责执行——它与分组、尾标签、副标题读的是同一个判定。
    if (branchOpenIntent(branch) === 'create-worktree') {
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
    if (!createBranch || branchHasWorktree(createBranch) || !worktreePath.trim() || busyBranch) return
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

  async function startFanOut(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (fanningOut) return
    // The surface only validates shape; branch names and paths are derived in main from the single
    // planning source, so nothing here invents them.
    const draft = buildFanOutRequest({ prompt: fanOutPrompt, count: fanOutCount, config })
    if (draft.kind === 'invalid') {
      setActionError(draft.reason)
      return
    }
    if (draft.kind === 'single') {
      setActionError('One lane is not a comparison — launch an Agent the ordinary way.')
      return
    }
    setFanningOut(true)
    setActionError(null)
    try {
      const result = await runFanOut({
        workspaceId: workspace.id,
        prompt: draft.prompt,
        count: draft.count,
        baseName: draft.baseName,
        executorIds: draft.executorIds
      })
      // Partial failures are already named on the shared error surface by the store; closing here would
      // hide a rejection the user never saw, so only a real fan-out dismisses the dialog.
      if (result.kind === 'fanout') setFanOutOpen(false)
      else if (result.kind === 'rejected') setActionError(result.reason)
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setFanningOut(false)
    }
  }

  async function copyText(text: string): Promise<void> {
    setActionError(null)
    await copyTextToClipboard(text, (cause) => setActionError(message(cause)))
  }

  function branchRow(branch: WorkspaceBranchRecord) {
    const selectedRow = selectedBranch === branch.name
    // 一次判断给出标志与取值。分开算两次是这一族缺陷的来源，所以这里也不许再判第二次。
    const worktree = branchWorktreePath(branch)
    const runningAgents = worktree !== null && snapshot?.kind === 'git-repository'
      ? runningAgentsByWorktree.get(worktreePresenceKey(snapshot.hostId, worktree)) ?? []
      : []
    // 只有当前分支能带同步计数（见 syncFacts 处注释）。`label` 为空的两种状态（没 upstream / 已同步）
    // 不画徽标——它们没有数字可报，画一个空盒子只是噪声。
    // 代价要说清：`gitSyncBadge` 为这两种各准备了一句不同的 `title`，而这里两者都不渲染，于是那两句
    // 在本面板上**到不了 DOM**——用户读不出「还没有 upstream」和「已同步」的区别。要露出前者需要一个
    // 新的视觉记号（不是空盒子），属产品决定，已单独记录；别在这里写「区别落在 title 上」，那会给一个
    // 不可达的东西背书。
    const sync = branch.isCurrent && syncFacts !== null ? gitSyncBadge(syncFacts) : null
    return (
      <BranchContextMenu
        key={branch.name}
        hasWorktree={worktree !== null}
        onOpen={() => void openBranch(branch)}
        onCopyBranchName={() => void copyText(branch.name)}
        onCopyWorktreePath={() => worktree !== null && void copyText(worktree)}
        onRefresh={() => void refresh()}
      >
        <button
          type="button"
          className={`branch-row ${selectedRow ? 'branch-row--selected' : ''}`}
          aria-pressed={selectedRow}
          onClick={() => void openBranch(branch)}
          onContextMenu={() => setSelectedBranch(branch.name)}
        >
          <SelectorRow
            leading={busyBranch === branch.name ? <LoaderCircle className="spin" size={12} /> : <GitBranch size={12} />}
            title={branch.name}
            titleTooltip={branch.name}
            subtitle={worktree ?? 'No worktree'}
            subtitleTooltip={worktree ?? undefined}
            presence={
              <SelectorPresence
                agents={runningAgents.map((agent) => ({
                  key: agent.providerId,
                  providerId: agent.providerId,
                  label: agentProviderLabel(agent.providerId),
                  // 这一簇是按 provider 归并的运行中 Run，不是逐个 Session——它们按定义都在跑。
                  state: 'running',
                  attention: null,
                  count: agent.count
                }))}
              />
            }
            trailing={
              <>
                {sync && sync.label ? (
                  <span
                    className={`branch-row__sync branch-row__sync--${sync.kind}`}
                    title={sync.title}
                    data-sync-kind={sync.kind}
                  >
                    {sync.label}
                  </span>
                ) : null}
                <span className={`branch-row__state ${worktree !== null ? '' : 'branch-row__state--unbound'}`}>
                  {branch.isCurrent ? <><Check size={9} /> Current</> : worktree !== null ? 'Worktree' : <><Unlink size={9} /> Branch</>}
                </span>
              </>
            }
          />
        </button>
      </BranchContextMenu>
    )
  }

  return (
    <section className="branches-panel">
      <SelectorListHeader
        className="branches-header"
        title="Branches"
        count={snapshot?.kind === 'git-repository' ? snapshot.branches.length : 0}
        actions={
          <>
            {/* Absent outside a git repository: a fan-out needs branches, and a button that could only fail
                answers nothing. */}
            {snapshot?.kind === 'git-repository' ? (
              <button
                type="button"
                title="Fan one prompt across N new worktrees"
                aria-label="Fan out a prompt"
                onClick={() => { setActionError(null); setFanOutOpen(true) }}
              >
                <GitCompareArrows size={13} />
              </button>
            ) : null}
            <button type="button" title="Refresh branches" onClick={() => void refresh()} disabled={loading}>
              {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
            </button>
          </>
        }
      />
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
      {/* Fan one prompt across N fresh branches. Lives beside "create worktree" because it is the same
          act repeated — the branch names and paths are main's to derive, never chosen here. */}
      <Dialog.Root
        open={fanOutOpen}
        onOpenChange={(open) => {
          if (fanningOut) return
          setFanOutOpen(open)
          if (!open) setActionError(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="confirmation-dialog__overlay" />
          <Dialog.Content
            className="branch-create-dialog"
            onEscapeKeyDown={(event) => fanningOut && event.preventDefault()}
          >
            <form onSubmit={(event) => void startFanOut(event)}>
              <header>
                <span><GitCompareArrows size={16} /></span>
                <div>
                  <Dialog.Title>Fan out a prompt</Dialog.Title>
                  <Dialog.Description>
                    Run the same request on N new branches, each in its own worktree, then keep one.
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button type="button" className="icon-button" aria-label="Close fan-out dialog" disabled={fanningOut}>
                    <X size={14} />
                  </button>
                </Dialog.Close>
              </header>
              <label>
                <span>Prompt</span>
                <input
                  autoFocus
                  value={fanOutPrompt}
                  onChange={(event) => setFanOutPrompt(event.target.value)}
                  placeholder="Add retry to the uploader"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>Lanes</span>
                <input
                  type="number"
                  min={2}
                  max={MAX_FANOUT_LANES}
                  value={fanOutCount}
                  onChange={(event) => setFanOutCount(Number(event.target.value))}
                />
              </label>
              {actionError ? <p role="alert">{actionError}</p> : null}
              <footer>
                <Dialog.Close asChild>
                  <button className="small-button" type="button" disabled={fanningOut}>Cancel</button>
                </Dialog.Close>
                <button className="primary-button" type="submit" disabled={!fanOutPrompt.trim() || fanningOut}>
                  {fanningOut ? <LoaderCircle className="spin" size={12} /> : <GitCompareArrows size={12} />}
                  {fanningOut ? 'Starting…' : `Fan out ${fanOutCount} lanes`}
                </button>
              </footer>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}
