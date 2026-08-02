import {
  ArrowDownToLine,
  ArrowUpFromLine,
  FileDiff,
  FilePlus2,
  FolderGit2,
  GitCommitHorizontal,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { GitFileChange, WorkspaceRecord } from '../../../shared/contracts'
import { useGitStatus } from '../hooks/useGitStatus'
import { gitBridge } from '../lib/git-bridge'
import { describeGitRemote, discardIntent, type GitRemoteVerb } from '../lib/git-remote-outcome'
import { useAppStore } from '../store'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A short, human label for git's two-column status of one file. */
function changeLabel(change: GitFileChange): string {
  if (change.untracked) return 'Untracked'
  const mark = (change.staged ? change.index : change.worktree)
  switch (mark) {
    case 'M': return 'Modified'
    case 'A': return 'Added'
    case 'D': return 'Deleted'
    case 'R': return 'Renamed'
    case 'C': return 'Copied'
    case 'U': return 'Conflicted'
    case 'T': return 'Type changed'
    default: return 'Changed'
  }
}

/**
 * Source Control: the current branch's changes, staging one file, and committing.
 *
 * The minimal end-to-end slice — see changes, stage a file, commit — rendered from `useGitStatus`,
 * which reaches Desktop main through `window.agentmux.git`. A plain folder is a first-class state
 * (`not-a-git-repository`), not an error banner.
 *
 * 写操作面共 8 个动作，分成三族，**错误处理各不相同**（#206）：
 *   - `stage` / `unstage` / `discard`：main 侧返回 `void`，失败靠 `assertGit` 抛，所以这里 try/catch。
 *   - `push` / `pull` / `fetch`：main 侧把失败**分类**成 5 个 kind 并脱敏后返回，不抛。这里必须走
 *     {@link describeGitRemote}——直接 `setError(result.message)` 会把那套分类压回一类。
 *   - `commit`：与第一族同形，但忙态是自己的（一次提交不属于任何一行）。
 * 三族折成一套 try/catch 会让远端那族的分类白做，所以下面的忙态与出错口刻意按族分开。
 */
export function ChangesPanel({ workspace }: { workspace: WorkspaceRecord }) {
  const { status, loading, error: loadError, refresh } = useGitStatus(workspace.id)
  const openFileDiff = useAppStore((state) => state.openFileDiff)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [busyRemote, setBusyRemote] = useState<GitRemoteVerb | null>(null)
  const [committing, setCommitting] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  // 成功回执与失败横幅刻意是两个状态：远端动作成功时那句话是回执不是错误，去的地方不同
  // （见 git-remote-outcome.ts 里 GitRemoteOutcome 分两个形状的理由）。折成一个会让调用方自己再判一次。
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  // 被武装的那一行。discard 对未跟踪文件走 `git clean --force`——从磁盘删除、无 reflog、不可撤销，
  // 而那个按钮就挨在 Stage 旁边。判定本身在 discardIntent 里，这里只存它要的那一个值。
  const [armedDiscard, setArmedDiscard] = useState<string | null>(null)

  const repo = status?.kind === 'git-repository' ? status : null
  const staged = useMemo(
    () => repo ? repo.changes.filter((change) => change.staged) : [],
    [repo]
  )
  const unstaged = useMemo(
    () => repo ? repo.changes.filter((change) => !change.staged) : [],
    [repo]
  )

  /** 桥取值 + 两个消息面清零，三族动作开工前都要做的那一步。 */
  function beginAction(): ReturnType<typeof gitBridge> {
    const lookup = gitBridge()
    if (!lookup.available) {
      setActionError(lookup.reason)
      return lookup
    }
    setActionError(null)
    setActionNotice(null)
    return lookup
  }

  async function stageFile(change: GitFileChange): Promise<void> {
    if (busyPath) return
    // 桥从 gitBridge 取。此前这里是 `window.agentmux!.git`——非空断言，桥缺席时点 Stage 抛裸
    // TypeError，而同一屏上 useGitStatus 对**同一个桥**好好地报了「不可用」。同一个前提判出两种结论。
    const lookup = beginAction()
    if (!lookup.available) return
    setBusyPath(change.path)
    try {
      await lookup.bridge.stage(workspace.id, change.path)
      await refresh()
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setBusyPath(null)
    }
  }

  /** 把一个文件从暂存区退回。worktree 那份不动——这与 discard 是两件事，按钮也分开。 */
  async function unstageFile(change: GitFileChange): Promise<void> {
    if (busyPath) return
    const lookup = beginAction()
    if (!lookup.available) return
    setBusyPath(change.path)
    try {
      await lookup.bridge.unstage(workspace.id, change.path)
      await refresh()
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setBusyPath(null)
    }
  }

  /**
   * 丢弃一行的改动。**两步**：第一次点是武装，第二次点同一行才真的执行。
   *
   * 判定不在这里，在 {@link discardIntent}——「不可能一次点击就删掉文件」必须是一条能被质询的断言，
   * 而不是藏在事件处理里的顺序假设。武装着 A 又去点 B 时，那次点是给 B 武装（不是删 B）。
   */
  async function discardFile(change: GitFileChange): Promise<void> {
    if (busyPath) return
    if (discardIntent(armedDiscard, change.path) === 'arm') {
      setArmedDiscard(change.path)
      return
    }
    const lookup = beginAction()
    if (!lookup.available) return
    setBusyPath(change.path)
    setArmedDiscard(null)
    try {
      await lookup.bridge.discard(workspace.id, change.path, change.untracked)
      await refresh()
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setBusyPath(null)
    }
  }

  /**
   * 一次远端动作。三个动词共用这一条路，因为它们的**结果处理完全相同**：都返回 `GitRemoteResult`，
   * 都必须经 {@link describeGitRemote} 翻成「下一步」。动词之间的差别全部落在那张嵌套表里，不在这里。
   */
  async function runRemote(verb: GitRemoteVerb): Promise<void> {
    if (busyRemote) return
    const lookup = beginAction()
    if (!lookup.available) return
    setBusyRemote(verb)
    try {
      const result = verb === 'push'
        ? await lookup.bridge.push(workspace.id)
        : verb === 'pull'
          ? await lookup.bridge.pull(workspace.id)
          : await lookup.bridge.fetch(workspace.id)
      const outcome = describeGitRemote(verb, result)
      // ok 与失败去两个不同的面。这一步是这一族存在的全部意义：远端失败被分成了 5 类，
      // 每一类的下一步不同；压成一句 git 原话等于把 main 侧那套分类丢掉。
      if (outcome.ok) setActionNotice(outcome.message)
      else setActionError(outcome.message)
      await refresh()
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setBusyRemote(null)
    }
  }

  async function commit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (committing || !commitMessage.trim() || staged.length === 0) return
    const lookup = beginAction()
    if (!lookup.available) return
    setCommitting(true)
    try {
      await lookup.bridge.commit(workspace.id, commitMessage.trim())
      setCommitMessage('')
      await refresh()
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setCommitting(false)
    }
  }

  function changeRow(change: GitFileChange, canStage: boolean) {
    const name = change.path.split('/').pop() || change.path
    const dir = change.path.slice(0, change.path.length - name.length)
    // 「这一行武装了吗」经 discardIntent 取，与点击时那次判定是**同一个**决定。写成
    // `armedDiscard === change.path` 也对，但那是把同一个判断算了两次：两侧一旦漂移，按钮上写着
    // 「再点一次就删」而那次点击去的是武装分支——用户永远删不掉，而两侧各自都「对」。
    // （记忆 read-key-and-write-key-must-be-one-decision。）
    const armed = discardIntent(armedDiscard, change.path) === 'discard'
    return (
      <div className={`change-row change-row--${change.untracked ? 'untracked' : change.staged ? 'staged' : 'unstaged'}`} key={`${change.staged ? 'S' : 'W'}:${change.path}`}>
        <span className="change-row__icon" title={changeLabel(change)}>
          {change.untracked ? <FilePlus2 size={12} /> : <FileDiff size={12} />}
        </span>
        <button
          type="button"
          className="change-row__identity change-row__identity--button"
          title={`Open diff for ${change.path}`}
          onClick={() => void openFileDiff(change.path)}
        >
          <strong>{name}</strong>
          {dir ? <small>{dir}</small> : null}
        </button>
        <span className="change-row__state">{changeLabel(change)}</span>
        {/*
          两个按钮包在一个容器里，而不是直接做 `.change-row` 网格的第 4、5 个孩子：那个网格是四列的，
          第 5 个孩子会折到第二行去。列数与「一行有几个按钮」是两件事，容器让它们不必联动。
        */}
        <span className="change-row__actions">
          {/*
            丢弃只在**未暂存**那一族给：已暂存的行先退回暂存区，再决定要不要丢。武装态换措辞，
            让「再点一次就真的删了」看得出来——武装本身若无可见差别，两步就只是多点一次而不是一道闸。
          */}
          {canStage ? (
            <button
              type="button"
              className={`icon-button change-row__discard${armed ? ' change-row__discard--armed' : ''}`}
              aria-label={armed ? `Confirm discard ${change.path}` : `Discard ${change.path}`}
              title={armed
                ? change.untracked
                  ? 'Click again to delete this untracked file from disk — this cannot be undone'
                  : 'Click again to throw away these changes — this cannot be undone'
                : 'Discard changes'}
              disabled={busyPath !== null}
              onClick={() => void discardFile(change)}
            >
              <Trash2 size={12} />
            </button>
          ) : null}
          {canStage ? (
            <button
              type="button"
              className="icon-button change-row__stage"
              aria-label={`Stage ${change.path}`}
              title="Stage file"
              disabled={busyPath !== null}
              onClick={() => void stageFile(change)}
            >
              {busyPath === change.path ? <LoaderCircle className="spin" size={12} /> : <Plus size={12} />}
            </button>
          ) : (
            <button
              type="button"
              className="icon-button change-row__unstage"
              aria-label={`Unstage ${change.path}`}
              title="Unstage file"
              disabled={busyPath !== null}
              onClick={() => void unstageFile(change)}
            >
              {busyPath === change.path ? <LoaderCircle className="spin" size={12} /> : <Minus size={12} />}
            </button>
          )}
        </span>
      </div>
    )
  }

  /** 一个远端动作按钮。三个只差动词与图标，所以由同一处产出——分别手写三遍必然漂移出第三种说法。 */
  function remoteButton(verb: GitRemoteVerb, icon: ReactNode, label: string) {
    return (
      <button
        type="button"
        className="icon-button changes-remote__action"
        aria-label={label}
        title={label}
        disabled={busyRemote !== null}
        onClick={() => void runRemote(verb)}
      >
        {busyRemote === verb ? <LoaderCircle className="spin" size={13} /> : icon}
      </button>
    )
  }

  return (
    <section className="branches-panel changes-panel">
      <header className="branches-header">
        <div><span>Changes</span><small>{repo ? repo.changes.length : 0}</small></div>
        <button type="button" title="Refresh changes" onClick={() => void refresh()} disabled={loading}>
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
        </button>
      </header>
      {repo ? (
        <div className="branches-repo">
          <FolderGit2 size={11} />
          <span>{repo.branch ?? 'Detached HEAD'}</span>
          <div className="changes-remote">
            {remoteButton('fetch', <RotateCcw size={12} />, 'Fetch from remote')}
            {remoteButton('pull', <ArrowDownToLine size={12} />, 'Pull from remote')}
            {remoteButton('push', <ArrowUpFromLine size={12} />, 'Push to remote')}
          </div>
        </div>
      ) : null}
      <div className="branches-scroll">
        {staged.length > 0 ? (
          <div className="branch-group"><span>Staged</span>{staged.map((change) => changeRow(change, false))}</div>
        ) : null}
        {unstaged.length > 0 ? (
          <div className="branch-group"><span>Changes</span>{unstaged.map((change) => changeRow(change, true))}</div>
        ) : null}
        {!loading && repo && repo.changes.length === 0 ? (
          <div className="branches-empty"><strong>No changes</strong><span>The working tree is clean.</span></div>
        ) : null}
        {!loading && status?.kind === 'not-a-git-repository' ? (
          <div className="branches-empty"><strong>Not a Git repository</strong><span>This workspace is not linked to a Git repository.</span></div>
        ) : null}
        {!loading && loadError && !status ? (
          <div className="branches-empty branches-empty--error"><strong>Changes unavailable</strong><span>{loadError}</span><button className="small-button" onClick={() => void refresh()}>Retry</button></div>
        ) : null}
      </div>
      {/*
        回执与失败是两个面，所以是两个元素而不是一个带 kind 的横幅：`role="status"` 不抢焦点（远端成功
        没什么要处理的），`role="alert"` 抢（失败那 5 类每一类都有下一步）。同一个元素两种 role 就得
        在渲染期再判一次成败，而那个判断已经在 describeGitRemote 里做过了。
      */}
      {actionNotice ? <div className="branches-inline-notice" role="status">{actionNotice}</div> : null}
      {actionError ? <div className="branches-inline-error" role="alert">{actionError}</div> : null}
      {repo ? (
        <form className="commit-box" onSubmit={(event) => void commit(event)}>
          <textarea
            className="commit-box__message"
            placeholder={staged.length > 0 ? 'Commit message' : 'Stage a file to commit'}
            value={commitMessage}
            spellCheck={false}
            rows={2}
            disabled={staged.length === 0 || committing}
            onChange={(event) => setCommitMessage(event.target.value)}
          />
          <button
            type="submit"
            className="primary-button commit-box__submit"
            disabled={staged.length === 0 || !commitMessage.trim() || committing}
          >
            {committing ? <LoaderCircle className="spin" size={12} /> : <GitCommitHorizontal size={13} />}
            {committing ? 'Committing…' : `Commit ${staged.length > 0 ? `(${staged.length})` : ''}`.trim()}
          </button>
        </form>
      ) : null}
    </section>
  )
}
