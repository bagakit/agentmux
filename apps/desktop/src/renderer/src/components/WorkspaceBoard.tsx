import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  CircleDot,
  GitBranch,
  Inbox,
  LoaderCircle,
  RadioTower,
  RefreshCw,
  Search,
  SquareTerminal,
  Unlink,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { useWorkspaceBranches } from '../hooks/useWorkspaceBranches'
import { api } from '../lib/api'
import {
  buildProjectBranchLanes,
  buildProjectInbox,
  filterProjectBranchLanes,
  type BranchActivityState,
  type BranchBindingFilter,
  type ProjectBranchLane
} from '../lib/project-board'
import { projectWorkspaces } from '../lib/workspace-projects'
import { useAppStore } from '../store'
import { StatusDot } from './StatusDot'

const ACTIVITY_FILTERS: { id: BranchActivityState; label: string }[] = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'active', label: 'Active' },
  { id: 'complete', label: 'Complete' },
  { id: 'idle', label: 'Idle' }
]

const ACTIVITY_LABELS: Record<BranchActivityState, string> = {
  attention: 'Needs attention',
  active: 'Active',
  complete: 'Complete',
  idle: 'Idle'
}

function formatAge(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function RunCard({ session, onOpen }: { session: SessionSnapshot; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`branch-run-card branch-run-card--${session.status.state}`}
      onClick={onOpen}
      aria-label={`Open ${session.label}`}
    >
      <span className="branch-run-card__marker"><StatusDot status={session.status} /></span>
      <span className="branch-run-card__identity">
        <strong>{session.label}</strong>
        <small>{session.agentId ? <><Bot size={11} /> {session.agentId}</> : <><SquareTerminal size={11} /> terminal</>}</small>
      </span>
      <span className="branch-run-card__state">
        <strong>{session.status.state}</strong>
        <small>{session.status.detail ?? session.status.source}</small>
      </span>
      <time>{formatAge(session.updatedAt)}</time>
      <ArrowUpRight size={13} />
    </button>
  )
}

export function WorkspaceBoard() {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const boardTool = useAppStore((state) => state.boardTool)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const selectSession = useAppStore((state) => state.selectSession)
  const activateWorkspaceSelection = useAppStore((state) => state.activateWorkspaceSelection)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const [query, setQuery] = useState('')
  const [activity, setActivity] = useState<BranchActivityState | 'all'>('all')
  const [binding, setBinding] = useState<BranchBindingFilter>('all')
  const [actionError, setActionError] = useState<string | null>(null)

  const projects = useMemo(() => projectWorkspaces(config?.workspaces ?? []), [config?.workspaces])
  const project = projects.find((candidate) =>
    candidate.workspaces.some((workspace) => workspace.id === activeWorkspaceId)
  )
  const anchor = project?.workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    ?? project?.workspaces.find((workspace) => workspace.id === project.preferredWorkspaceId)
    ?? null
  const { snapshot, loading, error: loadError, refresh } = useWorkspaceBranches(anchor?.id ?? null)

  useEffect(() => {
    setQuery('')
    setActivity('all')
    setBinding('all')
    setActionError(null)
  }, [project?.id])

  const lanes = useMemo(
    () => snapshot && project
      ? buildProjectBranchLanes(snapshot, project.workspaces, sessions)
      : [],
    [project, sessions, snapshot]
  )
  const filteredLanes = useMemo(
    () => filterProjectBranchLanes(lanes, query, activity, binding),
    [activity, binding, lanes, query]
  )
  const inboxItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return buildProjectInbox(lanes).filter(
      (item) =>
        (!normalized || item.lane.searchText.includes(normalized)) &&
        (binding === 'all' || (binding === 'bound') === Boolean(item.lane.branch.worktreePath))
    )
  }, [binding, lanes, query])
  const hasLaneFilters = Boolean(query.trim() || activity !== 'all' || binding !== 'all')

  function clearFilters(): void {
    setQuery('')
    setActivity('all')
    setBinding('all')
  }

  async function openLane(lane: ProjectBranchLane): Promise<void> {
    if (!anchor) return
    setActionError(null)
    try {
      if (lane.workspace) {
        await selectWorkspace(lane.workspace.id)
      } else if (lane.branch.worktreePath) {
        activateWorkspaceSelection(await api.workspaces.openBranch(anchor.id, lane.branch.name))
      } else {
        await selectWorkspace(anchor.id)
        setWorkspaceTool('files-branches')
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (!project || !anchor) {
    return (
      <section className="board board--empty">
        <div className="board-state">
          <GitBranch size={22} />
          <strong>No project selected</strong>
          <span>Add or select a Project before opening its Branch lanes.</span>
        </div>
      </section>
    )
  }

  if (!snapshot && loading) {
    return (
      <section className="board board--empty">
        <div className="board-state"><LoaderCircle className="spin" size={22} /><strong>Loading branches</strong><span>Reading Git truth from {project.name}.</span></div>
      </section>
    )
  }

  if (!snapshot && loadError) {
    return (
      <section className="board board--empty">
        <div className="board-state board-state--error"><AlertTriangle size={22} /><strong>Branches unavailable</strong><span>{loadError}</span><button className="small-button" onClick={() => void refresh()}>Retry</button></div>
      </section>
    )
  }

  if (boardTool === 'inbox') {
    return (
      <section className="board board--inbox">
        <header className="board__header">
          <div><div className="eyebrow">Project inbox</div><h1>Attention inbox</h1><p>Waiting, blocked, disconnected, and failed sessions from this Project only.</p></div>
          <span className="board__context-hint">{project.name} · {inboxItems.length} open</span>
        </header>
        <div className="board-toolbar board-toolbar--inbox">
          <label className="board-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search branch, worktree, agent, or detail" />{query ? <button title="Clear search" onClick={() => setQuery('')}><X size={11} /></button> : null}</label>
          <label><span>Binding</span><select aria-label="Filter inbox by binding" value={binding} onChange={(event) => setBinding(event.target.value as BranchBindingFilter)}><option value="all">All branches</option><option value="bound">Worktrees</option><option value="unbound">Unbound</option></select></label>
          <span className="board-filter-count">{inboxItems.length} items</span>
          <button className="small-button" type="button" title="Refresh branches" onClick={() => void refresh()} disabled={loading}>{loading ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />} Refresh</button>
        </div>
        {loadError ? <div className="board-inline-warning"><AlertTriangle size={13} /> {loadError}</div> : null}
        {inboxItems.length > 0 ? (
          <div className="board-inbox-list">
            {inboxItems.map((item) => (
              <button className={`board-inbox-item board-inbox-item--${item.session.status.state}`} type="button" key={item.id} onClick={() => selectSession(item.session.id)}>
                <span className="board-inbox-item__status"><StatusDot status={item.session.status} /></span>
                <span className="board-inbox-item__identity"><strong>{item.reason}</strong><small>{item.session.label}</small></span>
                <span className="board-inbox-item__branch"><GitBranch size={12} /><strong>{item.lane.branch.name}</strong><small>{item.lane.branch.worktreePath ?? 'No worktree'}</small></span>
                <span className="board-inbox-item__meta"><RadioTower size={11} /> {item.session.hostId === 'local' ? 'This Mac' : item.session.hostId}<time>{formatAge(item.session.updatedAt)}</time></span>
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
        ) : (
          <div className="board-inbox-empty">
            <span className="board-inbox-empty__icon"><CheckCircle2 size={22} /></span>
            <strong>{query ? 'No matching attention items' : 'All caught up'}</strong>
            <span>{query ? 'Change the search to inspect other Project items.' : 'No waiting, blocked, disconnected, or failed sessions need you right now.'}</span>
            <em>Project clear</em>
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="board board--branches">
      <header className="board__header">
        <div><div className="eyebrow">Project board</div><h1>Branch lanes</h1><p>Each Git Branch owns one lane; Agents and Terminals appear as Runs on that lane.</p></div>
        <span className="board__context-hint">{project.name} · {lanes.length} branches</span>
      </header>
      <div className="board-toolbar">
        <label className="board-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search branches, paths, agents, or terminals" />{query ? <button title="Clear search" onClick={() => setQuery('')}><X size={11} /></button> : null}</label>
        <label><span>Activity</span><select aria-label="Filter by activity" value={activity} onChange={(event) => setActivity(event.target.value as BranchActivityState | 'all')}><option value="all">All activity</option>{ACTIVITY_FILTERS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
        <label><span>Binding</span><select aria-label="Filter by binding" value={binding} onChange={(event) => setBinding(event.target.value as BranchBindingFilter)}><option value="all">All branches</option><option value="bound">Worktrees</option><option value="unbound">Unbound</option></select></label>
        <span className="board-filter-count">{filteredLanes.length} / {lanes.length}</span>
        {hasLaneFilters ? <button className="small-button" onClick={clearFilters}><X size={11} /> Reset</button> : <button className="small-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />} Refresh</button>}
      </div>
      {loadError ? <div className="board-inline-warning"><AlertTriangle size={13} /> {loadError}</div> : null}
      {actionError ? <div className="board-inline-warning"><AlertTriangle size={13} /> {actionError}</div> : null}
      {filteredLanes.length === 0 ? (
        <div className="board-no-results"><Search size={18} /><strong>{hasLaneFilters ? 'No matching branches' : 'No local branches'}</strong><span>{hasLaneFilters ? 'Change or reset the Project filters.' : 'Create a branch with Git, then refresh the board.'}</span>{hasLaneFilters ? <button className="small-button" onClick={clearFilters}>Clear filters</button> : null}</div>
      ) : (
        <div className="branch-lanes">
          {filteredLanes.map((lane) => (
            <section className={`branch-lane branch-lane--${lane.activity}`} data-branch-lane={lane.branch.name} key={lane.branch.name}>
              <header className="branch-lane__header">
                <span className="branch-lane__glyph">{lane.branch.worktreePath ? <GitBranch size={15} /> : <Unlink size={15} />}</span>
                <span className="branch-lane__identity"><strong>{lane.branch.name}</strong><small title={lane.branch.worktreePath ?? undefined}>{lane.branch.worktreePath ?? 'No worktree'}</small></span>
                <span className={`branch-lane__activity branch-lane__activity--${lane.activity}`}><CircleDot size={11} /> {ACTIVITY_LABELS[lane.activity]}</span>
                {lane.branch.isCurrent ? <em>Current</em> : null}
                <button className="small-button" type="button" onClick={() => void openLane(lane)}>{lane.workspace ? 'Open workspace' : lane.branch.worktreePath ? 'Open worktree' : 'Open Branches'} <ArrowUpRight size={11} /></button>
              </header>
              <div className="branch-lane__track">
                <span className="branch-lane__rail" aria-hidden />
                {lane.sessions.map((session) => <RunCard key={session.id} session={session} onOpen={() => selectSession(session.id)} />)}
                {lane.sessions.length === 0 ? (
                  <div className="branch-lane__empty-run">
                    <span>{lane.branch.worktreePath ? <SquareTerminal size={14} /> : <Unlink size={14} />}</span>
                    <strong>{lane.branch.worktreePath ? 'No runs yet' : 'Branch has no worktree'}</strong>
                    <small>{lane.branch.worktreePath ? 'Open this workspace to start a Terminal or Agent.' : 'Create a worktree from Workspace → Files + Branches.'}</small>
                  </div>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  )
}
