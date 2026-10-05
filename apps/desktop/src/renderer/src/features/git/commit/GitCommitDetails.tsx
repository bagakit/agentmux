import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { GitCommitDetailsResult, GitCommitSnapshot } from '../../../../../shared/git-contracts'

const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')


type ReadyCommit = Extract<GitCommitDetailsResult, { kind: 'ready' }>
type ChangedFile = ReadyCommit['entries'][number]
/** Complete fixed-commit content, shared by standalone details and repository browsing. */
export function GitCommitDetails({ regionId, selection, result, loading, error, onReload, onSelectParent, onSelectFile, selectedPath }: {
  regionId: string; selection: { commitOid: string; parentOid: string | null } | null
  result: ReadyCommit | null; loading: boolean; error: string | null
  onReload(): void; onSelectParent(snapshot: GitCommitSnapshot): void; onSelectFile(file: ChangedFile): void; selectedPath?: string
}) {
  return <article className="git-workbench__details" aria-label="Commit details" aria-busy={loading}>
    {!selection && <div className="pane-state"><strong>Select a commit</strong><span>Choose a commit to read its message and files.</span></div>}
    {selection && <div className="git-workbench__target">
      <code title={selection.commitOid}>{selection.commitOid.slice(0, 12)}</code>
      <button className="icon-button" aria-label="Reload commit details" title="Reload this fixed commit" disabled={loading} onClick={onReload}><ThemeActionRefreshIcon size={13} /></button>
    </div>}
    {error && <div className="git-history-error" role="alert"><span>{error}</span><button onClick={onReload}>Retry</button></div>}
    {selection && !result && !error && <div className="pane-state"><span>Reading commit…</span></div>}
    {result && <>
      <pre className="git-workbench__message">{result.commit.message || '(No commit message)'}</pre>
      <dl className="git-workbench__metadata">
        <dt>Author</dt><dd>{result.commit.author}</dd>
        <dt>Committed</dt><dd>{result.commit.committedAt === null ? 'Unknown date' : new Date(result.commit.committedAt).toLocaleString()}</dd>
        <dt>Commit</dt><dd><code>{result.commit.oid}</code></dd>
        <dt>Parents</dt><dd>{result.commit.parents.length ? result.commit.parents.map(oid => <code key={oid}>{oid}</code>) : 'None · root commit'}</dd>
      </dl>
      <div className="git-workbench__comparison">
        <label htmlFor={'git-parent-' + regionId}>Compare with</label>
        {result.commit.parents.length ? <select id={'git-parent-' + regionId} aria-label="Comparison parent" value={result.snapshot.parentOid ?? ''}
          onChange={event => onSelectParent({ ...result.snapshot, parentOid: event.currentTarget.value })}>
          {result.commit.parents.map((oid, index) => <option key={oid} value={oid}>{index === 0 ? 'First parent' : 'Parent ' + (index + 1)} · {oid.slice(0, 12)}</option>)}
        </select> : <span>Empty tree</span>}
      </div>
      {result.warnings.map((warning, index) => <p className="git-workbench__warning" key={index}>{warning}</p>)}
      <div className="git-workbench__files-title"><strong>Changed files</strong><span>{result.entries.length} files</span></div>
      {result.entries.length === 0 && <p className="git-workbench__empty">No file changes against this parent.</p>}
      <ul className="git-workbench__files">{result.entries.map(file => <li key={file.path}>
        <button aria-label={'Open diff for ' + file.path} aria-pressed={selectedPath === file.path}
          title={file.origPath ? file.origPath + ' → ' + file.path : file.path} onClick={() => onSelectFile(file)}>
          <span className={'git-workbench__change git-workbench__change--' + file.change} title={file.change}>{file.change === 'type-changed' ? 'T' : file.change[0]!.toUpperCase()}</span>
          <span>{file.origPath && <small>{file.origPath} → </small>}{file.path}</span>
        </button>
      </li>)}</ul>
    </>}
  </article>
}
