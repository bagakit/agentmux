import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import { PanelRightOpen, RefreshCw } from 'lucide-react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { GitHistoryCommit, GitHistoryRef, GitCommitSnapshot } from '../../../shared/git-contracts'
import type { useGitHistory } from '../hooks/useGitHistory'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { speakerColorHue } from '../lib/conversation-avatar-color'
import { useAppStore } from '../store'
import { useGitHistoryDetails } from './GitHistoryDetails'

const ROW_HEIGHT = 24
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
    const rowLanes = Math.max(before.length, after.length)
    width = Math.max(width, rowLanes)
    lanes = after
    return { commit, lane, before, after, continued, width: x(rowLanes - 1) + 10 }
  })
  return { rows, width: x(width - 1) + 10, pending: lanes, guides }
}

function branchStyle(name: string | undefined): CSSProperties | undefined {
  return name ? { '--history-branch-hue': speakerColorHue(name) } as CSSProperties : undefined
}

function referenceLabel(ref: GitHistoryRef) {
  return ref.name.replace(/^refs\/(heads|remotes|tags)\//u, '')
}

export function GitHistoryPanel({ workspace, history, onSelectCommit, selectedOid }: {
  workspace: WorkspaceRecord
  history: ReturnType<typeof useGitHistory>
  onSelectCommit?: (snapshot: GitCommitSnapshot) => void
  selectedOid?: string
}) {
  const displayPath = usePathDisplay()
  const openGitWorkbench = useAppStore(state => state.openGitWorkbench)
  const ready = history.result?.kind === 'ready' ? history.result : null
  const graph = useMemo(() => historyGraph(ready?.commits ?? [], ready?.snapshot.refs ?? []), [ready?.commits, ready?.snapshot.refs])
  const detailsScope = useMemo(() => JSON.stringify([workspace.id, workspace.hostId, workspace.path, history.reference, ready?.snapshot ?? null]),
    [workspace.id, workspace.hostId, workspace.path, history.reference, ready?.snapshot])
  const details = useGitHistoryDetails(detailsScope, history.enabled)
  function select(commit: GitHistoryCommit) {
    if (!ready) return
    const snapshot = { hostId: ready.snapshot.hostId, repoPath: ready.snapshot.repoPath,
      commitOid: commit.oid, parentOid: commit.parents[0] ?? null }
    details.close()
    if (onSelectCommit) onSelectCommit(snapshot)
    else openGitWorkbench(workspace.id, snapshot)
  }
  const previousScrollTop = useRef(0)
  const scrollHost = useRef<HTMLDivElement>(null)
  const footer = useRef<HTMLDivElement>(null)
  const readAhead = useCallback(() => {
    const view = scrollHost.current
    if (!view || view.clientHeight <= 0 || !history.enabled || document.visibilityState === 'hidden' ||
      history.loading || history.error || !ready?.nextCursor) return
    if (view.scrollHeight - view.clientHeight - view.scrollTop <= Math.max(view.clientHeight, ROW_HEIGHT * 8)) void history.loadMore()
  }, [history.enabled, history.loading, history.error, history.loadMore, ready?.nextCursor])
  useEffect(() => {
    const view = scrollHost.current, end = footer.current
    if (!view || !end || !history.enabled || history.loading || history.error || !ready?.nextCursor) return
    let active = true
    let intersection: IntersectionObserver | undefined
    const observe = () => {
      intersection?.disconnect()
      intersection = new IntersectionObserver(entries => {
        if (active && entries.some(entry => entry.isIntersecting)) readAhead()
      }, { root: view, rootMargin: `0px 0px ${Math.max(view.clientHeight, ROW_HEIGHT * 8)}px 0px` })
      intersection.observe(end)
    }
    observe()
    const resize = new ResizeObserver(observe)
    resize.observe(view)
    return () => { active = false; intersection?.disconnect(); resize.disconnect() }
  }, [history.enabled, history.loading, history.error, ready?.nextCursor, readAhead])
  useLayoutEffect(() => { previousScrollTop.current = 0 }, [detailsScope])
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
      {!onSelectCommit && ready?.commits[0] && <button className="icon-button" title="Open Git workbench" aria-label="Open Git workbench"
        onClick={() => select(ready.commits[0]!)}><PanelRightOpen size={13} /></button>}
      <button className="icon-button" title="Refresh history"  aria-label="Refresh history" disabled={!history.enabled || history.loading}
        onClick={() => { void history.refresh() }}><RefreshCw size={13} /></button>
    </div>
    {history.error && <div className="git-history-error" role="alert"><span>{history.error}</span>
      <button disabled={!history.enabled || history.loading} onClick={() => { void (ready?.nextCursor ? history.loadMore() : history.refresh()) }}>Retry</button>
    </div>}
    {!ready && !history.error && <div className="branches-empty"><strong>{history.result?.kind === 'not-a-git-repository'
      ? 'Not a Git repository' : history.enabled ? 'Reading history…' : 'History will load when visible'}</strong></div>}
    {ready && ready.commits.length === 0 && <div className="branches-empty"><strong>No commits yet</strong></div>}
    {ready && ready.commits.length > 0 && <div ref={scrollHost} className="git-history-scroll" onScroll={event => {
      details.close()
      if (event.target !== event.currentTarget) return
      const { scrollTop } = event.currentTarget
      const readingDown = scrollTop > previousScrollTop.current
      previousScrollTop.current = scrollTop
      if (readingDown) readAhead()
    }}>
      <div className="git-history-window" style={{ paddingBottom: graph.pending.length ? 12 : 0 }}>
        <div className="git-history-graph" aria-label="Commit relationships">
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
                  d={`M ${x(lane)} ${middle} C ${x(lane)} ${bottom - ROW_HEIGHT / 4}, ${x(after.indexOf(parent))} ${bottom - ROW_HEIGHT / 4}, ${x(after.indexOf(parent))} ${bottom}`} />)}
                <circle className="git-history-node" data-commit-oid={commit.oid} data-branch-ref={graph.guides.get(commit.oid)}
                  style={branchStyle(graph.guides.get(commit.oid))} cx={x(lane)} cy={middle} r={3}
                  {...details.triggerEvents(commit)} />
              </g>
            })}
            {graph.pending.map((oid, lane) => <path key={oid} className="git-history-continuation" data-unloaded-parent={oid}
              data-branch-ref={graph.guides.get(oid)} style={branchStyle(graph.guides.get(oid))}
              d={`M ${x(lane)} ${graph.rows.length * ROW_HEIGHT} v 10`}><title>Parent outside this loaded window: {oid}</title></path>)}
          </svg>
        </div>
        <ol className="git-history-commits">
          {graph.rows.map(({ commit, width }) => <li className="git-history-commit" key={commit.oid} data-history-oid={commit.oid}
            style={{ height: ROW_HEIGHT, '--history-graph-width': `${width}px` } as CSSProperties}
            {...details.triggerEvents(commit)}
            role="button"
            aria-haspopup={undefined}
            aria-keyshortcuts="Enter Space"
            aria-label={`Open commit ${commit.oid.slice(0, 7)}: ${commit.subject || '(No commit message)'}`}
            aria-current={selectedOid === commit.oid ? 'true' : undefined}
            onClick={event => { if (!(event.target instanceof Element) || !event.target.closest('.git-history-refs')) select(commit) }}
            onKeyDown={event => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault(); select(commit)
              } else details.triggerEvents(commit).onKeyDown(event)
            }}>
            <strong>{commit.subject || '(No commit message)'}</strong>
              {commit.refs.length > 0 && <div className="git-history-refs">
                {commit.refs.slice(0, 2).map(ref => {
                  const guide = ref.kind === 'local' || ref.kind === 'remote' ? ref.name : ref.kind === 'head' ? graph.guides.get(commit.oid) : undefined
                  return <span key={ref.name} className={`git-history-ref git-history-ref--${ref.kind}`}
                    {...details.triggerEvents(commit, ref)} data-branch-ref={guide} style={branchStyle(guide)}>{referenceLabel(ref)}</span>
                })}
                {commit.refs.length > 2 && <span className="git-history-ref-count" {...details.triggerEvents(commit)}>+{commit.refs.length - 2}</span>}
              </div>}
            <code className="git-history-hash">{commit.oid.slice(0, 7)}</code>
          </li>)}
        </ol>
      </div>
      <div ref={footer} className="git-history-footer">
        <span>{ready.commits.length} commits{graph.pending.length ? ` · ${graph.pending.length} parent${graph.pending.length > 1 ? 's' : ''} beyond view` : ''}</span>
        {ready.nextCursor && <button disabled={!history.enabled || history.loading} onClick={() => { void history.loadMore() }}>{history.loading ? 'Reading…' : history.error ? 'Retry loading more' : 'Load more'}</button>}
      </div>
    </div>}
    {details.preview}
  </section>
}
