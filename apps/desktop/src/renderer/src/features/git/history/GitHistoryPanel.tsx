import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { PanelRightOpen, RefreshCw } from 'lucide-react'
import type { WorkspaceRecord } from '../../../../../shared/contracts'
import type { GitHistoryCommit, GitHistoryRef, GitCommitSnapshot } from '../../../../../shared/git-contracts'
import type { useGitHistory } from './useGitHistory'
import { usePathDisplay } from '../../../hooks/usePathDisplay'
import { speakerColorHue } from '../../../lib/conversation-avatar-color'
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

export type GitHistoryViewportState = { scope: string; scrollTop: number }
type History = ReturnType<typeof useGitHistory>
type Graph = ReturnType<typeof historyGraph>
type PreviewEvents = ReturnType<typeof useGitHistoryDetails>['triggerEvents']

export function GitHistoryPanel({ workspace, history, onSelectCommit, onOpenRepository, selectedOid, revealOid, viewportState }: {
  workspace: WorkspaceRecord
  history: History
  onSelectCommit: (snapshot: GitCommitSnapshot) => void
  onOpenRepository?: () => void
  selectedOid?: string
  revealOid?: string
  viewportState?: RefObject<GitHistoryViewportState | null>
}) {
  const displayPath = usePathDisplay()
  const ready = history.result?.kind === 'ready' ? history.result : null
  const graph = useMemo(() => historyGraph(ready?.commits ?? [], ready?.snapshot.refs ?? []), [ready?.commits, ready?.snapshot.refs])
  // A page keeps its pinned roots and timestamp. Moving labels do not define reading position.
  const scope = useMemo(() => JSON.stringify([workspace.id, workspace.hostId, workspace.path, history.reference,
    ready?.snapshot.checkedAt, ready?.snapshot.roots]), [workspace.id, workspace.hostId, workspace.path, history.reference, ready?.snapshot])
  const details = useGitHistoryDetails(scope, history.enabled)
  const localViewport = useRef<GitHistoryViewportState | null>(null)
  const position = viewportState ?? localViewport
  const scrollHost = useRef<HTMLDivElement>(null)
  const footer = useRef<HTMLDivElement>(null)
  const select = useCallback((commit: GitHistoryCommit) => {
    if (!ready) return
    details.close()
    onSelectCommit({ hostId: ready.snapshot.hostId, repoPath: ready.snapshot.repoPath,
      commitOid: commit.oid, parentOid: commit.parents[0] ?? null })
  }, [ready, details.close, onSelectCommit])
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
      {onOpenRepository && <button className="small-button git-history-open-repository" title="Open repository history" aria-label="Open repository history"
        onClick={() => onOpenRepository()}><PanelRightOpen size={13} /><span>Repository history</span></button>}
      <button className="icon-button" title="Refresh history" aria-label="Refresh history" disabled={!history.enabled || history.loading}
        onClick={() => { void history.refresh() }}><RefreshCw size={13} /></button>
    </div>
    {history.error && <div className="git-history-error" role="alert"><span>{history.error}</span>
      <button disabled={!history.enabled || history.loading} onClick={() => { void (ready?.nextCursor ? history.loadMore() : history.refresh()) }}>Retry</button>
    </div>}
    {!ready && !history.error && <div className="branches-empty"><strong>{history.result?.kind === 'not-a-git-repository'
      ? 'Not a Git repository' : history.enabled ? 'Reading history…' : 'History will load when visible'}</strong></div>}
    {ready && ready.commits.length === 0 && <div className="branches-empty"><strong>No commits yet</strong></div>}
    {ready && ready.commits.length > 0 && <HistoryViewport graph={graph} history={history} {...(selectedOid ? { selectedOid } : {})}
      {...(revealOid ? { revealOid } : {})} scope={scope} position={position} scrollHost={scrollHost} footer={footer}
      select={select} previewEvents={details.triggerEvents} closePreview={details.close} readAhead={readAhead} />}
    {details.preview}
  </section>
}

/** Hover state stays above this memo boundary; only the viewport owns row/SVG generation. */
const HistoryViewport = memo(function HistoryViewport({ graph, history, selectedOid, revealOid, scope, position, scrollHost, footer,
  select, previewEvents, closePreview, readAhead }: {
  graph: Graph; history: History; selectedOid?: string; revealOid?: string; scope: string
  position: RefObject<GitHistoryViewportState | null>; scrollHost: RefObject<HTMLDivElement | null>; footer: RefObject<HTMLDivElement | null>
  select: (commit: GitHistoryCommit) => void; previewEvents: PreviewEvents; closePreview: () => void; readAhead: () => void
}) {
  const previousScrollTop = useRef(0)
  const pendingFocus = useRef<number | null>(null)
  const revealed = useRef<string | null>(null)
  const getItemKey = useCallback((index: number) => graph.rows[index]!.commit.oid, [graph.rows])
  const virtualizer = useVirtualizer({ count: graph.rows.length, getScrollElement: () => scrollHost.current,
    estimateSize: () => ROW_HEIGHT, getItemKey, overscan: 8, useFlushSync: false,
    initialOffset: () => position.current?.scope === scope ? position.current.scrollTop : 0 })
  const items = virtualizer.getVirtualItems()
  useLayoutEffect(() => {
    const top = position.current?.scope === scope ? position.current.scrollTop : 0
    previousScrollTop.current = top
    position.current = { scope, scrollTop: top }
    virtualizer.scrollToOffset(top)
    revealed.current = null
  }, [scope, position, virtualizer])
  useLayoutEffect(() => {
    if (!revealOid) { revealed.current = null; return }
    if (!history.enabled || revealed.current === revealOid) return
    const index = graph.rows.findIndex(row => row.commit.oid === revealOid)
    if (index < 0) return
    virtualizer.scrollToIndex(index, { align: 'center' })
    revealed.current = revealOid
  }, [revealOid, graph.rows, history.enabled, virtualizer])
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return
    const row = scrollHost.current?.querySelector<HTMLElement>(`[data-history-index="${pendingFocus.current}"]`)
    if (row) { pendingFocus.current = null; row.focus({ preventScroll: true }) }
  })
  const start = items[0]?.start ?? 0
  const atEnd = items.at(-1)?.index === graph.rows.length - 1
  const graphHeight = (items.at(-1)?.end ?? start) - start + (atEnd && graph.pending.length ? 12 : 0)
  return <div ref={scrollHost} className="git-history-scroll" onScroll={event => {
    if (event.target !== event.currentTarget) return
    closePreview()
    const { scrollTop } = event.currentTarget
    const readingDown = scrollTop > previousScrollTop.current
    previousScrollTop.current = scrollTop
    position.current = { scope, scrollTop }
    if (readingDown) readAhead()
  }}>
    <div className="git-history-window" style={{ height: virtualizer.getTotalSize(), paddingBottom: graph.pending.length ? 12 : 0 }}>
      <div className="git-history-graph" style={{ top: start }} aria-label="Commit relationships">
        <svg width={graph.width} height={graphHeight} viewBox={`0 ${start} ${graph.width} ${Math.max(1, graphHeight)}`} role="img" aria-label="Loaded commit graph">
          {items.map(({ index: row }) => {
            const { commit, lane, before, after, continued } = graph.rows[row]!
            const top = row * ROW_HEIGHT, middle = top + ROW_HEIGHT / 2, bottom = top + ROW_HEIGHT
            const afterIndexes = new Map(after.map((oid, index) => [oid, index]))
            return <g key={commit.oid} data-history-graph-row={row}>
              {before.map((oid, index) => oid === commit.oid ? null : <path key={oid} className="git-history-track"
                data-branch-ref={graph.guides.get(oid)} style={branchStyle(graph.guides.get(oid))}
                d={`M ${x(index)} ${top} C ${x(index)} ${middle}, ${x(afterIndexes.get(oid)!)} ${middle}, ${x(afterIndexes.get(oid)!)} ${bottom}`} />)}
              {continued && row > 0 && <path className="git-history-track" data-branch-ref={graph.guides.get(commit.oid)}
                style={branchStyle(graph.guides.get(commit.oid))} d={`M ${x(lane)} ${top} V ${middle}`} />}
              {commit.parents.map(parent => <path key={parent} className="git-history-track git-history-parent"
                data-child-oid={commit.oid} data-parent-oid={parent}
                data-branch-ref={graph.guides.get(commit.parents[0] === parent ? commit.oid : parent)}
                style={branchStyle(graph.guides.get(commit.parents[0] === parent ? commit.oid : parent))}
                d={`M ${x(lane)} ${middle} C ${x(lane)} ${bottom - ROW_HEIGHT / 4}, ${x(afterIndexes.get(parent)!)} ${bottom - ROW_HEIGHT / 4}, ${x(afterIndexes.get(parent)!)} ${bottom}`} />)}
              <circle className="git-history-node" data-commit-oid={commit.oid} data-branch-ref={graph.guides.get(commit.oid)}
                style={branchStyle(graph.guides.get(commit.oid))} cx={x(lane)} cy={middle} r={3} {...previewEvents(commit)} />
            </g>
          })}
          {atEnd && graph.pending.map((oid, lane) => <path key={oid} className="git-history-continuation" data-unloaded-parent={oid}
            data-branch-ref={graph.guides.get(oid)} style={branchStyle(graph.guides.get(oid))}
            d={`M ${x(lane)} ${graph.rows.length * ROW_HEIGHT} v 10`}><title>Parent outside this loaded window: {oid}</title></path>)}
        </svg>
      </div>
      <ol className="git-history-commits">
        {items.map(({ index }) => {
          const { commit, width } = graph.rows[index]!
          return <li className="git-history-commit" key={commit.oid} data-history-oid={commit.oid} data-history-index={index}
            style={{ height: ROW_HEIGHT, top: index * ROW_HEIGHT, '--history-graph-width': `${width}px` } as CSSProperties}
            {...previewEvents(commit)} role="button" aria-haspopup={undefined} aria-keyshortcuts="Enter Space"
            aria-posinset={index + 1} aria-setsize={graph.rows.length}
            aria-label={`Open commit ${commit.oid.slice(0, 7)}: ${commit.subject || '(No commit message)'}`}
            aria-current={selectedOid === commit.oid ? 'true' : undefined}
            onClick={event => { if (!(event.target instanceof Element) || !event.target.closest('.git-history-refs')) select(commit) }}
            onKeyDown={event => {
              if (event.target !== event.currentTarget) { previewEvents(commit).onKeyDown(event); return }
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(commit); return }
              const pageSize = Math.max(1, Math.floor((scrollHost.current?.clientHeight ?? ROW_HEIGHT) / ROW_HEIGHT))
              const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 :
                event.key === 'Home' ? 0 : event.key === 'End' ? graph.rows.length - 1 :
                event.key === 'PageDown' ? index + pageSize : event.key === 'PageUp' ? index - pageSize : null
              if (next === null) return
              event.preventDefault(); closePreview()
              pendingFocus.current = Math.max(0, Math.min(next, graph.rows.length - 1))
              virtualizer.scrollToIndex(pendingFocus.current, { align: 'auto' })
              const target = scrollHost.current?.querySelector<HTMLElement>(`[data-history-index="${pendingFocus.current}"]`)
              if (target) { pendingFocus.current = null; target.focus({ preventScroll: true }) }
            }}>
            <strong>{commit.subject || '(No commit message)'}</strong>
            {commit.refs.length > 0 && <div className="git-history-refs">{commit.refs.slice(0, 2).map(ref => {
              const guide = ref.kind === 'local' || ref.kind === 'remote' ? ref.name : ref.kind === 'head' ? graph.guides.get(commit.oid) : undefined
              return <span key={ref.name} className={`git-history-ref git-history-ref--${ref.kind}`}
                {...previewEvents(commit, ref)} data-branch-ref={guide} style={branchStyle(guide)}>{referenceLabel(ref)}</span>
            })}{commit.refs.length > 2 && <span className="git-history-ref-count" {...previewEvents(commit)}>+{commit.refs.length - 2}</span>}</div>}
            <code className="git-history-hash">{commit.oid.slice(0, 7)}</code>
          </li>
        })}
      </ol>
    </div>
    <div ref={footer} className="git-history-footer">
      <span>{graph.rows.length} commits{graph.pending.length ? ` · ${graph.pending.length} parent${graph.pending.length > 1 ? 's' : ''} beyond view` : ''}</span>
      {history.result?.kind === 'ready' && history.result.nextCursor && <button disabled={!history.enabled || history.loading} onClick={() => { void history.loadMore() }}>{history.loading ? 'Reading…' : history.error ? 'Retry loading more' : 'Load more'}</button>}
    </div>
  </div>
})
