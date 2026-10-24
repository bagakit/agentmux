import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { GitCommitDetailsResult, GitCommitSnapshot } from '../../../../../shared/git-contracts'
import { presentCommitMessage, summarizeCommitChanges } from './commit-presentation'
import { GitAuthorAvatar } from './GitAuthorAvatar'

const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')


type ReadyCommit = Extract<GitCommitDetailsResult, { kind: 'ready' }>
type ChangedFile = ReadyCommit['entries'][number]

function CommitTime({ value, source = 'Author time' }: { value: number | null; source?: string }) {
  const date = value === null ? null : new Date(value)
  return date && Number.isFinite(date.getTime())
    ? <time dateTime={date.toISOString()} title={`${source} · ${date.toLocaleString()} (local time) · ${date.toISOString()}`}>{date.toLocaleString()}</time>
    : <span>Unknown date</span>
}

/** Complete fixed-commit content, shared by standalone details and repository browsing. */
export function GitCommitDetails({ regionId, selection, result, loading, error, onReload, onSelectParent, onSelectFile, selectedPath }: {
  regionId: string; selection: { commitOid: string; parentOid: string | null } | null
  result: ReadyCommit | null; loading: boolean; error: string | null
  onReload(): void; onSelectParent(snapshot: GitCommitSnapshot): void; onSelectFile(file: ChangedFile): void; selectedPath?: string
}) {
  const message = presentCommitMessage(result?.commit.message ?? '')
  const changes = summarizeCommitChanges(result?.entries ?? [])
  const differentCommitter = result && result.commit.author !== result.commit.committer
  const showCommitted = result && (differentCommitter || result.commit.authoredAt !== result.commit.committedAt
    || result.commit.authoredAt === null || result.commit.committedAt === null)
  return <article className="git-workbench__details" aria-label="Commit details" aria-busy={loading}>
    {!selection && <div className="pane-state"><strong>Select a commit</strong><span>Choose a commit to read its message and files.</span></div>}
    {selection && <div className="git-workbench__target">
      <span>Fixed commit</span>
      <code title={selection.commitOid}>{selection.commitOid.slice(0, 12)}</code>
      <button className="icon-button" aria-label="Reload commit details" title="Reload this fixed commit" disabled={loading} onClick={onReload}><ThemeActionRefreshIcon size={13} /></button>
    </div>}
    {error && <div className="git-history-error" role="alert"><span>{error}</span><button onClick={onReload}>Retry</button></div>}
    {selection && !result && !error && <div className="pane-state"><span>Reading commit…</span></div>}
    {result && <>
      <header className="git-workbench__message-header">
        <pre className="git-workbench__message"><span className="git-workbench__message-heading" role="heading" aria-level={2}>{message.firstLine}</span>{message.remainder}</pre>
        {!result.commit.message && <p className="git-workbench__empty">No commit message</p>}
        {message.type && <div className="git-workbench__message-format" aria-label="Commit message format">
          <span>{message.type}</span>
          {message.scope && <span aria-label={'Scope: ' + message.scope}>{message.scope}</span>}
          {message.breaking && <span className="git-workbench__message-breaking" title="Marked by ! in the commit subject">Breaking change</span>}
        </div>}
      </header>
      <dl className="git-workbench__author">
        <dt>Author</dt><dd className="git-workbench__identity">
          <GitAuthorAvatar author={result.commit.author} email={result.commit.authorEmail} />
          <span><span className="git-workbench__person">{result.commit.author || 'Unknown author'}</span><span className="git-workbench__identity-time"><CommitTime value={result.commit.authoredAt} /></span></span>
        </dd>
      </dl>
      <details className="git-workbench__commit-info" key={result.commit.oid}>
        <summary>Commit information</summary>
        <dl className="git-workbench__metadata">
        {showCommitted && <><dt>Committed</dt><dd>
          {differentCommitter && <span className="git-workbench__person">{result.commit.committer || 'Unknown committer'}</span>}
          <span className="git-workbench__identity-time"><CommitTime value={result.commit.committedAt} source="Committer time" /></span>
        </dd></>}
        <dt>Commit</dt><dd><code>{result.commit.oid}</code></dd>
        <dt>Parents</dt><dd>{result.commit.parents.length ? result.commit.parents.map(oid => <code key={oid}>{oid}</code>) : 'None · root commit'}</dd>
        {result.commit.refs.length > 0 && <><dt>References</dt><dd className="git-workbench__references">
          {result.commit.refs.map(reference => <span className="git-workbench__reference" key={reference.kind + ':' + reference.name}
            title={reference.kind + ' · ' + reference.name + '\n' + reference.oid}>
            <small>{reference.kind}</small><span>{reference.name}</span>
          </span>)}
        </dd></>}
        </dl>
      </details>
      <div className="git-workbench__comparison">
        <label htmlFor={'git-parent-' + regionId}>Compare with</label>
        {result.commit.parents.length ? <select id={'git-parent-' + regionId} aria-label="Comparison parent" value={result.snapshot.parentOid ?? ''}
          onChange={event => onSelectParent({ ...result.snapshot, parentOid: event.currentTarget.value })}>
          {result.commit.parents.map((oid, index) => <option key={oid} value={oid}>{index === 0 ? 'First parent' : 'Parent ' + (index + 1)} · {oid.slice(0, 12)}</option>)}
        </select> : <span>Empty tree</span>}
      </div>
      {result.warnings.map((warning, index) => <p className="git-workbench__warning" key={index}>{warning}</p>)}
      <div className="git-workbench__files-title"><strong>Changed files</strong><span>{result.entries.length} {result.entries.length === 1 ? 'file' : 'files'}</span></div>
      {changes.length > 0 && <ul className="git-workbench__file-summary" aria-label="File change summary">
        {changes.map(summary => <li key={summary.change} className={'git-workbench__file-summary--' + summary.change}>{summary.count} {summary.change.replace('-', ' ')}</li>)}
      </ul>}
      {result.entries.length === 0 && <p className="git-workbench__empty">No file changes against this parent.</p>}
      <ul className="git-workbench__files">{result.entries.map(file => <li key={file.path}>
        <button aria-label={'Open diff for ' + file.path} aria-pressed={selectedPath === file.path}
          title={file.origPath ? file.origPath + ' → ' + file.path : file.path} onClick={() => onSelectFile(file)}>
          <span className={'git-workbench__change git-workbench__change--' + file.change} title={file.change}>{file.change === 'type-changed' ? 'T' : file.change[0]!.toUpperCase()}</span>
          <span className="git-workbench__file-path">
            <span className="git-workbench__file-name">{file.path.slice(file.path.lastIndexOf('/') + 1)}</span>
            {file.path.includes('/') && <small>{file.path.slice(0, file.path.lastIndexOf('/') + 1)}</small>}
            {file.origPath && <small className="git-workbench__file-origin">{file.origPath} → {file.path}</small>}
          </span>
        </button>
      </li>)}</ul>
    </>}
  </article>
}
