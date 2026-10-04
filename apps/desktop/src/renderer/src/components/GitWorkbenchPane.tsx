import { useEffect, useRef, useState } from 'react'
import { GitCommitHorizontal, RefreshCw } from 'lucide-react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { GitCommitDetailsResult, GitCommitSnapshot } from '../../../shared/git-contracts'
import type { GitWorkbenchSurface } from '../lib/workbench-tabs'
import { gitBridge } from '../lib/git-bridge'
import { useGitHistory } from '../hooks/useGitHistory'
import { useAppStore } from '../store'
import { GitHistoryPanel } from './GitHistoryPanel'

/** The original Region owns selection; immutable content is read only while visible. */
export function GitWorkbenchPane({ surface, visible = true }: { surface: GitWorkbenchSurface; visible?: boolean }) {
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === surface.workspaceId))
  if (!workspace || workspace.hostId !== surface.scope.hostId || workspace.path !== surface.scope.workspacePath) return <section className="pane-state" role="alert">
    <strong>Original Git workspace unavailable</strong><span>The saved repository and commit are retained. Restore the original workspace Host and path to read them.</span><code>{surface.scope.workspacePath}</code>
  </section>
  return <RepositoryWorkbench surface={surface} workspace={workspace} visible={visible} />
}

function RepositoryWorkbench({ surface, workspace, visible }: {
  surface: GitWorkbenchSurface; workspace: WorkspaceRecord; visible: boolean
}) {
  const history = useGitHistory(workspace, visible)
  const foreignHistory = history.result?.kind === 'ready' &&
    (history.result.snapshot.hostId !== surface.scope.hostId || history.result.snapshot.repoPath !== surface.scope.repoPath)
  const selectCommit = useAppStore(state => state.selectGitCommit)
  const openDiff = useAppStore(state => state.openBranchDiff)
  const selection = surface.selection
  const key = JSON.stringify([workspace.id, workspace.hostId, workspace.path, surface.scope, selection])
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{ key: string; result: GitCommitDetailsResult | null; loading: boolean; error: string | null } | null>(null)
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    if (!visible || !selection) return
    let current = true
    const previous = latest.current?.key === key ? latest.current : null
    const publish = (value: typeof read) => { if (current) setRead(value) }
    const lookup = gitBridge()
    if (!lookup.available || workspace.hostId !== surface.scope.hostId) {
      publish({ key, result: previous?.result ?? null, loading: false,
        error: lookup.available ? 'The workspace Host changed. This saved Git scope is retained; restore the original resource.' : lookup.reason })
      return
    }
    publish({ key, result: previous?.result ?? null, loading: true, error: null })
    void lookup.bridge.commitDetails(workspace.id, { oid: selection.commitOid,
      ...(selection.parentOid ? { parentOid: selection.parentOid } : {}) }).then(result => {
      if (result.kind !== 'ready') throw new Error('The original workspace is no longer a Git repository.')
      const fixed = result.snapshot
      if (fixed.hostId !== surface.scope.hostId || fixed.repoPath !== surface.scope.repoPath ||
          fixed.commitOid !== selection.commitOid || fixed.parentOid !== selection.parentOid) {
        throw new Error('The repository or comparison parent changed. This fixed selection is retained.')
      }
      publish({ key, result, loading: false, error: null })
    }).catch(error => publish({ key, result: previous?.result ?? null, loading: false,
      error: error instanceof Error ? error.message : String(error) }))
    return () => { current = false }
  }, [key, visible, attempt])
  const owned = read?.key === key ? read : null
  const result = owned?.result?.kind === 'ready' ? owned.result : null
  const select = (snapshot: GitCommitSnapshot) => selectCommit(surface.regionId, snapshot)
  return <section className="git-workbench" data-git-workbench-region={surface.regionId} aria-label="Git workbench">
    <header className="git-workbench__header">
      <GitCommitHorizontal size={15} /><strong>History</strong>
      <span title={surface.scope.repoPath}>{workspace.name}</span>
      <span className="git-workbench__readonly">Read only</span>
    </header>
    <div className="git-workbench__body">
      <aside className="git-workbench__history" aria-label="Repository history">
        {foreignHistory ? <div className="git-history-error" role="alert"><span>The repository changed. The original Git history scope and selected commit are retained.</span>
          <button onClick={() => void history.refresh()}>Retry history</button></div>
          : <GitHistoryPanel workspace={workspace} history={history} onSelectCommit={select} {...(selection ? { selectedOid: selection.commitOid } : {})} />}
      </aside>
      <article className="git-workbench__details" aria-label="Commit details" aria-busy={Boolean(owned?.loading)}>
        {!selection && <div className="pane-state"><strong>Select a commit</strong><span>Read its message and files, then open a fixed version diff.</span></div>}
        {selection && <div className="git-workbench__target">
          <code title={selection.commitOid}>{selection.commitOid.slice(0, 12)}</code>
          <button className="icon-button" aria-label="Reload commit details" title="Reload this fixed commit"
            disabled={Boolean(owned?.loading)} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} /></button>
        </div>}
        {owned?.error && <div className="git-history-error" role="alert"><span>{owned.error}</span>
          <button onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
        {selection && !result && !owned?.error && <div className="pane-state"><span>Reading commit…</span></div>}
        {result && <>
          <pre className="git-workbench__message">{result.commit.message || '(No commit message)'}</pre>
          <dl className="git-workbench__metadata">
            <dt>Author</dt><dd>{result.commit.author}</dd>
            <dt>Committed</dt><dd>{result.commit.committedAt === null ? 'Unknown date' : new Date(result.commit.committedAt).toLocaleString()}</dd>
            <dt>Commit</dt><dd><code>{result.commit.oid}</code></dd>
            <dt>Parents</dt><dd>{result.commit.parents.length ? result.commit.parents.map(oid => <code key={oid}>{oid}</code>) : 'None · root commit'}</dd>
          </dl>
          <div className="git-workbench__comparison">
            <label htmlFor={'git-parent-' + surface.regionId}>Compare with</label>
            {result.commit.parents.length ? <select id={'git-parent-' + surface.regionId} aria-label="Comparison parent" value={result.snapshot.parentOid ?? ''}
              onChange={event => select({ ...result.snapshot, parentOid: event.currentTarget.value })}>
              {result.commit.parents.map((oid, index) => <option key={oid} value={oid}>
                {index === 0 ? 'First parent' : 'Parent ' + (index + 1)} · {oid.slice(0, 12)}
              </option>)}
            </select> : <span>Empty tree</span>}
          </div>
          {result.warnings.map((warning, index) => <p className="git-workbench__warning" key={index}>{warning}</p>)}
          <div className="git-workbench__files-title"><strong>Changed files</strong><span>{result.entries.length} files</span></div>
          {result.entries.length === 0 && <p className="git-workbench__empty">No file changes against this parent.</p>}
          <ul className="git-workbench__files">{result.entries.map(file => <li key={file.path}>
            <button aria-label={'Open diff for ' + file.path} title={file.origPath ? file.origPath + ' → ' + file.path : file.path}
              onClick={() => openDiff(workspace.id, { kind: 'commit', snapshot: result.snapshot, file: { path: file.path, origPath: file.origPath } })}>
              <span className={'git-workbench__change git-workbench__change--' + file.change} title={file.change}>{file.change === 'type-changed' ? 'T' : file.change[0]!.toUpperCase()}</span>
              <span>{file.origPath && <small>{file.origPath} → </small>}{file.path}</span>
            </button>
          </li>)}</ul>
        </>}
      </article>
    </div>
  </section>
}
