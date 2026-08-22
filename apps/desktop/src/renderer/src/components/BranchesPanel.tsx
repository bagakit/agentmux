import * as Dialog from '@radix-ui/react-dialog'
import {
  Check,
  FolderGit2,
  GitBranch,
  GitCompareArrows,
  LoaderCircle,
  Pin,
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
import { defaultWorktreePath, workspaceProjectId } from '../lib/workspace-projects'
import { partitionPinned } from '../lib/topic-order'
import { branchHasWorktree, branchOpenIntent, branchWorktreePath } from '../lib/workspace-branches-state'
import {
  nextAfterWorktreeRemoval,
  worktreeRemovalEffect,
  worktreeRemovalPrompt,
  type WorktreeRemovalRequest
} from '../lib/worktree-removal-request'
import { useAppStore } from '../store'
import { agentProviderLabel } from './AgentProviderIcon'
import { SelectorListHeader, SelectorPresence, SelectorRow } from './SelectorList'
import { BranchContextMenu } from './BranchContextMenu'
import { ConfirmationDialog } from './ConfirmationDialog'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function BranchesPanel({ workspace }: { workspace: WorkspaceRecord }) {
  const activateWorkspaceSelection = useAppStore((state) => state.activateWorkspaceSelection)
  const runFanOut = useAppStore((state) => state.runFanOut)
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const removeWorktree = useAppStore((state) => state.removeWorktree)
  const pinnedItems = useAppStore((state) => state.pinnedItems)
  const togglePinnedItem = useAppStore((state) => state.togglePinnedItem)
  // 分支名只在一个 repo 内唯一——两个项目都能有 `main`。所以 pin 的 scope 必须**派生**自
  // workspaceProjectId（= `[hostId, repoPath]`，横跨一个 repo 的多个 worktree），绝不在这里手写一个
  // 字面量：手写的常量在单项目测试下看着没问题，真实使用里会跨项目串 pin（见 pinnedItems 的注释）。
  const pinScope = workspaceProjectId(workspace)
  const pinnedBranches = pinnedItems[pinScope] ?? []
  const [selectedBranch, setSelectedBranch] = useState(workspace.branch ?? null)
  const [createBranch, setCreateBranch] = useState<WorkspaceBranchRecord | null>(null)
  const [worktreePath, setWorktreePath] = useState('')
  const [busyBranch, setBusyBranch] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [fanOutOpen, setFanOutOpen] = useState(false)
  const [fanOutPrompt, setFanOutPrompt] = useState('')
  const [fanOutCount, setFanOutCount] = useState(3)
  const [fanningOut, setFanningOut] = useState(false)
  const [removal, setRemoval] = useState<WorktreeRemovalRequest | null>(null)
  const [removing, setRemoving] = useState(false)
  // 文案与「确认键真正做什么」只算一次，对话框的四个 prop 和 confirmRemoval 发出去的实参都取这一份。
  // 分开各调一次同一个函数在今天等价，但它把一个决定重新拆成五个取值点——下一个人给某一档加条件时
  // 只会改到其中一处，那正是本仓「读的 key 与写的 key 必须只判一次」栽过的形状：按钮说要丢弃、
  // 请求里却没带。
  const removalPrompt = removal === null ? null : worktreeRemovalPrompt(removal)
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

  // 置顶是**组内**的一次分区，不是重新分组：`partitionPinned` 只重排一段里的次序（置顶的靠前，
  // 两段各自的相对次序原样保留），绝不把一个没有 worktree 的分支提进「Worktrees」组——那会让
  // 那个标题说谎。所以对 bound / unbound 各调一次，而不是对合并后的全表调一次。
  function pinFirst(branches: WorkspaceBranchRecord[]): WorkspaceBranchRecord[] {
    const order = partitionPinned(branches.map((branch) => branch.name), pinnedBranches)
    const byName = new Map(branches.map((branch) => [branch.name, branch]))
    return order.map((name) => byName.get(name)!)
  }

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

  async function confirmRemoval(): Promise<void> {
    if (!removal || !removalPrompt || removing) return
    setRemoving(true)
    setActionError(null)
    try {
      // 走 store 而不是直接调 api：`removed` 带回来的是**权威的新配置**，而 store 里的
      // `activeWorkspaceId` 是指进它的一个引用。面板自己 await 完把 config 丢掉时，store 仍持有那条
      // 已经不存在的记录——`App.tsx` 照它找活动 Workspace 得到 undefined，于是在别的项目都还在的
      // 情况下渲染出空白欢迎页，而屏幕上没有一句话解释刚才发生了什么。批量收尾一直是走 store 的，
      // 单条却绕过了它，那道不对称就是这个缺陷本身。
      const outcome = await removeWorktree({
        workspaceId: removal.workspaceId,
        // 取的就是确认键上那句话算出来的同一份，不在这里再判第二次。
        discardChanges: removalPrompt.discardChanges
      })
      // 三种走向落到屏幕上是什么样，全在 `worktreeRemovalEffect` 里算。这里刻意**一个 if 都没有**：
      // 分派留在面板里就没有任何东西执行它（renderToStaticMarkup 不跑 effect、也点不了确认键），
      // 实测过 `setActionError(next.reason)` 改成 null 时 21 条 + tsc 全绿。搬进纯函数之后那九件事
      // 逐条可判，而这里剩下的三句无条件赋值是「壳有没有接住」——由 AST 守卫钉住它们只是转发。
      const effect = worktreeRemovalEffect(nextAfterWorktreeRemoval(removal, outcome))
      setRemoval(effect.removal)
      setActionError(effect.error)
      if (effect.rescan) await refresh()
    } catch (cause) {
      setRemoval(null)
      setActionError(message(cause))
    } finally {
      setRemoving(false)
    }
  }

  function branchRow(branch: WorkspaceBranchRecord) {
    const selectedRow = selectedBranch === branch.name
    const pinned = pinnedBranches.includes(branch.name)
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
        onRemoveWorktree={() => {
          // 要删的是**这一行**那个 worktree，所以 workspaceId 取 branch.workspaceId，不取
          // `workspace.id`（那是当前打开的项目，通常正是别的分支）。两者今天在「点自己那一行」时
          // 恰好一致，正是这种偶然一致会把一个删错对象的 bug 藏起来。
          // 缺 workspaceId 说明这个 worktree 还没登记成 Workspace，那就没有可撤的记录可删——
          // 用缺席表达，不画一个按了会报错的菜单项（该项已按 hasWorktree 挡住，这里是第二道）。
          if (worktree === null || branch.workspaceId === null) return
          setActionError(null)
          const workspaceId = branch.workspaceId
          setRemoval({
            workspaceId,
            branch: branch.name,
            path: worktree,
            stage: { kind: 'confirm' }
          })
          // 「这条分支会留下什么」是问 main 才知道的（要跑 git），所以先把框开出来、再补那句话。
          //
          // 反过来做——等查完再开框——会让右键菜单在慢仓上静默卡住几百毫秒，用户以为没点中。而这一问
          // 的作用是让用户**改主意**，只要它在用户读完、按下之前到达就有效。
          //
          // 不 catch 掉就完事：main 侧那个通道承诺永不抛（查不出来会回一句「没查出来」的正常文案）。
          // 真抛了说明是别的毛病，那就让它进错误条，而不是在这里咽掉变成一句沉默。
          void api.workspaces
            .worktreeRemovalNotice(workspaceId)
            .then((notice) => {
              // 只补给还停在**同一个 workspace 的确认屏**上的那个请求。用户如果已经关掉、或者换了一行、
              // 或者已经被推进到「丢弃产出？」那一屏，这句迟到的话就不该再贴上去——贴上去会让第二屏的
              // 措辞混进第一屏的内容，而那两屏刻意不共用实词。
              setRemoval((current) =>
                current && current.workspaceId === workspaceId && current.stage.kind === 'confirm'
                  ? { ...current, note: notice.note }
                  : current
              )
            })
            .catch((cause) => setActionError(message(cause)))
        }}
      >
        <div
          className={`branch-row ${selectedRow ? 'branch-row--selected' : ''}`}
          onContextMenu={() => setSelectedBranch(branch.name)}
        >
          <button
            type="button"
            className="branch-row__open"
            aria-pressed={selectedRow}
            onClick={() => void openBranch(branch)}
          >
            <SelectorRow
              leading={busyBranch === branch.name ? <LoaderCircle className="spin" size={12} /> : pinned ? <Pin size={12} aria-label="Pinned branch" /> : <GitBranch size={12} />}
              title={branch.name}
              titleTooltip={branch.name}
              subtitle={worktree ?? 'No worktree'}
              subtitleTooltip={worktree ?? undefined}
              presence={
                <SelectorPresence
                  agents={runningAgents.map((agent) => ({
                    key: agent.executorId,
                    providerId: agent.providerId,
                    label: config?.executors[agent.executorId]?.label ?? agentProviderLabel(agent.providerId),
                    executorId: agent.executorId,
                    appearance: config?.executors[agent.executorId]?.avatar,
                    // A stack uses the same urgency order as the roster; a live process is not always ready.
                    state: agent.state,
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
          {/* Pin status uses the existing leading slot; this action reveals on hover/focus. */}
          <button
            type="button"
            className={`icon-button branch-row__pin ${pinned ? 'branch-row__pin--pinned' : ''}`}
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${branch.name}` : `Pin ${branch.name}`}
            title={pinned ? 'Unpin branch' : 'Pin branch'}
            onClick={() => togglePinnedItem(pinScope, branch.name)}
          >
            <Pin size={11} />
          </button>
        </div>
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
        {bound.length > 0 ? <div className="branch-group"><span>Worktrees</span>{pinFirst(bound).map(branchRow)}</div> : null}
        {unbound.length > 0 ? <div className="branch-group"><span>Without worktree</span>{pinFirst(unbound).map(branchRow)}</div> : null}
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
      {/*
        单条 worktree 移除的确认。两个阶段共用这一个对话框，文案由 worktreeRemovalPrompt 按阶段算，
        因为「确认键写什么」和「请求带不带 discardChanges」必须是同一次决定——分两处算就会漂移成
        按钮说要丢弃、请求里却没带。
      */}
      <ConfirmationDialog
        open={removalPrompt !== null}
        title={removalPrompt?.title ?? ''}
        description={removalPrompt?.description ?? ''}
        {...(removalPrompt ? { subject: removalPrompt.subject } : {})}
        confirmLabel={removalPrompt?.confirmLabel ?? ''}
        busy={removing}
        onCancel={() => {
          if (!removing) setRemoval(null)
        }}
        onConfirm={() => void confirmRemoval()}
      />
    </section>
  )
}
