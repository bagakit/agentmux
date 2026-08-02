import {
  Check,
  FileDiff,
  FilePlus2,
  FolderGit2,
  GitCommitHorizontal,
  LoaderCircle,
  Plus,
  RefreshCw
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { GitFileChange, WorkspaceRecord } from '../../../shared/contracts'
import { useGitStatus } from '../hooks/useGitStatus'
import { gitBridge } from '../lib/git-bridge'
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
 */
export function ChangesPanel({ workspace }: { workspace: WorkspaceRecord }) {
  const { status, loading, error: loadError, refresh } = useGitStatus(workspace.id)
  const openFileDiff = useAppStore((state) => state.openFileDiff)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const repo = status?.kind === 'git-repository' ? status : null
  const staged = useMemo(
    () => repo ? repo.changes.filter((change) => change.staged) : [],
    [repo]
  )
  const unstaged = useMemo(
    () => repo ? repo.changes.filter((change) => !change.staged) : [],
    [repo]
  )

  async function stageFile(change: GitFileChange): Promise<void> {
    if (busyPath) return
    // 桥从 gitBridge 取。此前这里是 `window.agentmux!.git`——非空断言，桥缺席时点 Stage 抛裸
    // TypeError，而同一屏上 useGitStatus 对**同一个桥**好好地报了「不可用」。同一个前提判出两种结论。
    const lookup = gitBridge()
    if (!lookup.available) {
      setActionError(lookup.reason)
      return
    }
    setBusyPath(change.path)
    setActionError(null)
    try {
      await lookup.bridge.stage(workspace.id, change.path)
      await refresh()
    } catch (cause) {
      setActionError(message(cause))
    } finally {
      setBusyPath(null)
    }
  }

  async function commit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (committing || !commitMessage.trim() || staged.length === 0) return
    const lookup = gitBridge()
    if (!lookup.available) {
      setActionError(lookup.reason)
      return
    }
    setCommitting(true)
    setActionError(null)
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
          <span className="change-row__staged-mark" title="Staged"><Check size={12} /></span>
        )}
      </div>
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
