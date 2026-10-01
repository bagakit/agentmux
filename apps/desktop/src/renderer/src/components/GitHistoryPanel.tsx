import { useMemo, type CSSProperties } from 'react'
import { RefreshCw } from 'lucide-react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { GitHistoryCommit, GitHistoryRef } from '../../../shared/git-contracts'
import type { useGitHistory } from '../hooks/useGitHistory'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { speakerColorHue } from '../lib/conversation-avatar-color'

const ROW_HEIGHT = 40
const LANE_WIDTH = 14
const x = (lane: number) => 10 + lane * LANE_WIDTH

/** Only the loaded topological window. An unresolved parent stays an explicit continuation. */
function historyGraph(commits: GitHistoryCommit[], refs: GitHistoryRef[]) {
  // A guide is a stable ref identity, not exclusive ownership of a shared commit. Prefer a local
  // name, then the full ref name; row order and moving lane numbers never choose a colour.
  const branches = refs.filter(ref => ref.kind === 'local' || ref.kind === 'remote').sort((a, b) =>
    Number(a.kind === 'remote') - Number(b.kind === 'remote') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const priority = new Map(branches.map((ref, index) => [ref.name, index]))
  const guides = new Map<string, string>()
  for (const ref of branches) if (!guides.has(ref.oid)) guides.set(ref.oid, ref.name)
  const tips = new Set(guides.keys())
  // Git supplies descendant-before-parent order. Carry each known guide along its first-parent
  // line; at a shared ancestor the deterministic ref priority wins, while each incoming edge keeps
  // its own guide. A ref tip remains its own anchor. Unknown/disconnected lines stay neutral.
  for (const commit of commits) {
    const guide = guides.get(commit.oid), parent = commit.parents[0]
    if (!guide || !parent || tips.has(parent)) continue
    const current = guides.get(parent)
    if (!current || priority.get(guide)! < priority.get(current)!) guides.set(parent, guide)
  }
  let lanes: string[] = []
  let width = 1
  const rows = commits.map(commit => {
    let lane = lanes.indexOf(commit.oid)
    const continued = lane >= 0
    if (lane < 0) { lane = lanes.length; lanes.push(commit.oid) }
    const before = [...lanes]
    const after = lanes.filter(oid => oid !== commit.oid)
    commit.parents.forEach((parent, index) => {
      if (!after.includes(parent)) after.splice(Math.min(lane + index, after.length), 0, parent)
    })
    width = Math.max(width, before.length, after.length)
    lanes = after
    return { commit, lane, before, after, continued }
  })
  return { rows, width: x(width - 1) + 10, pending: lanes, guides }
}

function branchStyle(name: string | undefined): CSSProperties | undefined {
  return name ? { '--history-branch-hue': speakerColorHue(name) } as CSSProperties : undefined
}

function referenceLabel(ref: GitHistoryRef) {
  return ref.name.replace(/^refs\/(heads|remotes|tags)\//u, '')
}

export function GitHistoryPanel({ workspace, history }: { workspace: WorkspaceRecord; history: ReturnType<typeof useGitHistory> }) {
  const displayPath = usePathDisplay()
  const ready = history.result?.kind === 'ready' ? history.result : null
  const graph = useMemo(() => historyGraph(ready?.commits ?? [], ready?.snapshot.refs ?? []), [ready?.commits, ready?.snapshot.refs])
  return <section className="git-history-panel" aria-label="Git history" aria-busy={history.loading}>
    <div className="git-history-controls">
      <select aria-label="History reference" value={history.reference ?? ''}
        onChange={event => history.selectReference(event.currentTarget.value || null)}
        title={ready ? displayPath(ready.snapshot.repoPath, workspace.hostId) : undefined}>
        <option value="">All branches</option>
        {history.refs.filter(ref => ref.kind !== 'tag').map(ref =>
          <option key={ref.name} value={ref.name}>{ref.kind === 'remote' ? 'Remote · ' : ''}{referenceLabel(ref)}</option>)}
        {history.reference && !history.refs.some(ref => ref.name === history.reference) && <option value={history.reference}>{history.reference.replace(/^refs\/(heads|remotes)\//u, '')}</option>}
      </select>
      <button className="icon-button" title="Refresh history" aria-label="Refresh history" disabled={history.loading}
        onClick={() => { void history.refresh() }}><RefreshCw size={13} /></button>
    </div>
    {history.error && <div className="git-history-error" role="alert">{history.error}</div>}
    {!ready && !history.error && <div className="branches-empty"><strong>{history.loading ? 'Reading history…' : 'Not a Git repository'}</strong></div>}
    {ready && ready.commits.length === 0 && <div className="branches-empty"><strong>No commits yet</strong></div>}
    {ready && ready.commits.length > 0 && <div className="git-history-scroll">
      <div className="git-history-window">
        <div className="git-history-graph" aria-label="Commit relationships" tabIndex={0}>
          <svg width={graph.width} height={graph.rows.length * ROW_HEIGHT + (graph.pending.length ? 12 : 0)} role="img" aria-label="Loaded commit graph">
            {graph.rows.map(({ commit, lane, before, after, continued }, row) => {
              const top = row * ROW_HEIGHT, middle = top + ROW_HEIGHT / 2, bottom = top + ROW_HEIGHT
              return <g key={commit.oid}>
                {before.filter(oid => oid !== commit.oid).map(oid => <path key={oid} className="git-history-track"
                  data-branch-ref={graph.guides.get(oid)} style={branchStyle(graph.guides.get(oid))}
                  d={`M ${x(before.indexOf(oid))} ${top} C ${x(before.indexOf(oid))} ${middle}, ${x(after.indexOf(oid))} ${middle}, ${x(after.indexOf(oid))} ${bottom}`} />)}
                {continued && row > 0 && <path className="git-history-track" data-branch-ref={graph.guides.get(commit.oid)}
                  style={branchStyle(graph.guides.get(commit.oid))} d={`M ${x(lane)} ${top} V ${middle}`} />}
                {commit.parents.map(parent => <path key={parent} className="git-history-track git-history-parent"
                  data-child-oid={commit.oid} data-parent-oid={parent}
                  data-branch-ref={graph.guides.get(commit.parents[0] === parent ? commit.oid : parent)}
                  style={branchStyle(graph.guides.get(commit.parents[0] === parent ? commit.oid : parent))}
                  d={`M ${x(lane)} ${middle} C ${x(lane)} ${bottom - 12}, ${x(after.indexOf(parent))} ${bottom - 12}, ${x(after.indexOf(parent))} ${bottom}`} />)}
                <circle className="git-history-node" data-commit-oid={commit.oid} data-branch-ref={graph.guides.get(commit.oid)}
                  style={branchStyle(graph.guides.get(commit.oid))} cx={x(lane)} cy={middle} r={3}>
                  <title>{commit.oid}{commit.parents.length === 0 ? ' · Root commit' : ` · ${commit.parents.length} parent${commit.parents.length > 1 ? 's' : ''}`}</title>
                </circle>
              </g>
            })}
            {graph.pending.map((oid, lane) => <path key={oid} className="git-history-continuation" data-unloaded-parent={oid}
              data-branch-ref={graph.guides.get(oid)} style={branchStyle(graph.guides.get(oid))}
              d={`M ${x(lane)} ${graph.rows.length * ROW_HEIGHT} v 10`}><title>Parent outside this loaded window: {oid}</title></path>)}
          </svg>
        </div>
        <ol className="git-history-commits">
          {ready.commits.map(commit => <li className="git-history-commit" key={commit.oid} data-history-oid={commit.oid} style={{ height: ROW_HEIGHT }}>
            <strong title={commit.subject || '(No commit message)'}>{commit.subject || '(No commit message)'}</strong>
            <div className="git-history-meta" title={`${commit.oid} · ${commit.author}${commit.authoredAt === null ? '' : ` · ${new Date(commit.authoredAt).toLocaleString()}`}`}>
              <code>{commit.oid.slice(0, 7)}</code><span>{commit.author}</span>
              {commit.refs.length > 0 && <div className="git-history-refs" title={commit.refs.map(ref => ref.name).join('\n')}>
                {commit.refs.slice(0, 2).map(ref => {
                  const guide = ref.kind === 'local' || ref.kind === 'remote' ? ref.name : ref.kind === 'head' ? graph.guides.get(commit.oid) : undefined
                  return <span key={ref.name} className={`git-history-ref git-history-ref--${ref.kind}`} title={ref.name}
                    data-branch-ref={guide} style={branchStyle(guide)}>{referenceLabel(ref)}</span>
                })}
                {commit.refs.length > 2 && <span className="git-history-ref-count">+{commit.refs.length - 2}</span>}
              </div>}
            </div>
          </li>)}
        </ol>
      </div>
      <div className="git-history-footer">
        <span>{ready.commits.length} commits{graph.pending.length ? ` · ${graph.pending.length} parent${graph.pending.length > 1 ? 's' : ''} beyond view` : ''}</span>
        {ready.nextCursor && <button disabled={history.loading} onClick={() => { void history.loadMore() }}>{history.loading ? 'Reading…' : 'Load more'}</button>}
      </div>
    </div>}
  </section>
}
