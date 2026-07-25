import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  GitBranch,
  Inbox,
  LoaderCircle,
  MessageSquarePlus,
  RadioTower,
  RefreshCw,
  Search,
  SquareTerminal,
  Unlink,
  X,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { useWorkspaceBranches } from '../hooks/useWorkspaceBranches'
import { api } from '../lib/api'
import {
  PROJECT_BOARD_COLUMNS,
  buildProjectBranchLanes,
  filterProjectBranchLanes,
  type BranchBindingFilter,
  type ProjectBoardColumn,
  type ProjectBranchLane
} from '../lib/project-board'
import { projectWorkspaces } from '../lib/workspace-projects'
import { useAppStore } from '../store'
import { BoardDiscussionCanvas } from './BoardDiscussionCanvas'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { StatusDot } from './StatusDot'

const COLUMN_META: Record<ProjectBoardColumn, {
  label: string
  description: string
  icon: LucideIcon
}> = {
  inbox: { label: 'Inbox', description: 'Start a Branch discussion', icon: Inbox },
  working: { label: 'Working', description: 'Running now', icon: Activity },
  'needs-you': { label: 'Needs You', description: 'Waiting or blocked', icon: BellRing },
  done: { label: 'Done', description: 'Completed runs', icon: CheckCircle2 }
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
      className={`board-run-card board-run-card--${session.status.state}`}
      onClick={onOpen}
      aria-label={`Open ${session.label}`}
    >
      <span className="board-run-card__status"><StatusDot status={session.status} /></span>
      <span className="board-run-card__identity">
        <strong>{session.label}</strong>
        <small>{session.providerId ? <><AgentProviderIcon providerId={session.providerId} size={11} /> {agentProviderLabel(session.providerId)}</> : <><SquareTerminal size={11} /> terminal</>}</small>
      </span>
      <span className="board-run-card__meta">
        <em>{session.status.state}</em>
        <time>{formatAge(session.updatedAt)}</time>
      </span>
      {session.status.detail ? <span className="board-run-card__detail">{session.status.detail}</span> : null}
      <ArrowUpRight size={12} />
    </button>
  )
}

export function WorkspaceBoard() {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const selectSession = useAppStore((state) => state.selectSession)
  const activateWorkspaceSelection = useAppStore((state) => state.activateWorkspaceSelection)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const [query, setQuery] = useState('')
  const [column, setColumn] = useState<ProjectBoardColumn | 'all'>('all')
  const [binding, setBinding] = useState<BranchBindingFilter>('all')
  const [actionError, setActionError] = useState<string | null>(null)
  const [discussionLane, setDiscussionLane] = useState<ProjectBranchLane | null>(null)

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
    setColumn('all')
    setBinding('all')
    setActionError(null)
    setDiscussionLane(null)
  }, [project?.id])

  const lanes = useMemo(
    () => snapshot && project
      ? buildProjectBranchLanes(snapshot, project.workspaces, sessions)
      : [],
    [project, sessions, snapshot]
  )
  const filteredLanes = useMemo(
    () => filterProjectBranchLanes(lanes, query, column, binding),
    [binding, column, lanes, query]
  )
  const hasFilters = Boolean(query.trim() || column !== 'all' || binding !== 'all')

  function clearFilters(): void {
    setQuery('')
    setColumn('all')
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
          <span>Add or select a Project before opening its Branch board.</span>
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

  if (snapshot?.kind === 'not-a-git-repository') {
    return (
      <section className="board board--empty">
        <div className="board-state"><GitBranch size={22} /><strong>Not a Git repository</strong><span>This workspace is not linked to a Git repository.</span></div>
      </section>
    )
  }

  const columnCounts = Object.fromEntries(PROJECT_BOARD_COLUMNS.map((id) => [
    id,
    id === 'inbox'
      ? filteredLanes.filter((lane) => lane.branch.worktreePath).length
      : filteredLanes.reduce((total, lane) => total + lane.runsByColumn[id].length, 0)
  ])) as Record<ProjectBoardColumn, number>

  return (
    <section className="board board--matrix">
      <header className="board__header">
        <div>
          <div className="eyebrow">Project board</div>
          <h1>Branch × status</h1>
          <p>Branches run vertically. Agent progress moves horizontally within the same row.</p>
        </div>
        <span className="board__context-hint">{project.name} · {lanes.length} branches</span>
      </header>

      <div className="board-toolbar board-toolbar--matrix">
        <label className="board-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search branches, paths, providers, or run details" />{query ? <button title="Clear search" onClick={() => setQuery('')}><X size={11} /></button> : null}</label>
        <label><span>Status</span><select aria-label="Filter by board status" value={column} onChange={(event) => setColumn(event.target.value as ProjectBoardColumn | 'all')}><option value="all">All statuses</option>{PROJECT_BOARD_COLUMNS.map((id) => <option value={id} key={id}>{COLUMN_META[id].label}</option>)}</select></label>
        <label><span>Binding</span><select aria-label="Filter by binding" value={binding} onChange={(event) => setBinding(event.target.value as BranchBindingFilter)}><option value="all">All branches</option><option value="bound">Worktrees</option><option value="unbound">Unbound</option></select></label>
        <span className="board-host-scope"><RadioTower size={11} /> {project.hostId === 'local' ? 'This Mac' : project.hostId}</span>
        <span className="board-filter-count">{filteredLanes.length} / {lanes.length}</span>
        {hasFilters ? <button className="small-button" onClick={clearFilters}><X size={11} /> Reset</button> : <button className="small-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />} Refresh</button>}
      </div>

      {loadError ? <div className="board-inline-warning"><AlertTriangle size={13} /> {loadError}</div> : null}
      {actionError ? <div className="board-inline-warning"><AlertTriangle size={13} /> {actionError}</div> : null}

      {filteredLanes.length === 0 ? (
        <div className="board-no-results"><Search size={18} /><strong>{hasFilters ? 'No matching branches' : 'No local branches'}</strong><span>{hasFilters ? 'Change or reset the Project filters.' : 'Create a branch with Git, then refresh the board.'}</span>{hasFilters ? <button className="small-button" onClick={clearFilters}>Clear filters</button> : null}</div>
      ) : (
        <div className="board-matrix-scroll">
          <div className="board-matrix" role="grid" aria-label="Branch by status board">
            <div className="board-matrix__head" role="row">
              <div className="board-matrix__corner" role="columnheader">
                <GitBranch size={13} /> Branch / Worktree
              </div>
              {PROJECT_BOARD_COLUMNS.map((id) => {
                const meta = COLUMN_META[id]
                const Icon = meta.icon
                return (
                  <div className={`board-column-head board-column-head--${id}`} role="columnheader" key={id}>
                    <span><Icon size={13} /><strong>{meta.label}</strong></span>
                    <small>{meta.description}</small>
                    <em>{columnCounts[id]}</em>
                  </div>
                )
              })}
            </div>
            {filteredLanes.map((lane) => (
              <div className="board-matrix__row" role="row" data-branch-lane={lane.branch.name} key={lane.branch.name}>
                <header className="board-branch-head" role="rowheader">
                  <span className="board-branch-head__glyph">{lane.branch.worktreePath ? <GitBranch size={15} /> : <Unlink size={15} />}</span>
                  <span className="board-branch-head__identity"><strong>{lane.branch.name}</strong><small title={lane.branch.worktreePath ?? undefined}>{lane.branch.worktreePath ?? 'No worktree'}</small></span>
                  <span className="board-branch-head__meta">
                    {lane.branch.isCurrent ? <em>Current</em> : null}
                    <small>{lane.sessions.length} run{lane.sessions.length === 1 ? '' : 's'}</small>
                  </span>
                  <button className="icon-button" type="button" title={lane.workspace ? 'Open workspace' : lane.branch.worktreePath ? 'Open worktree' : 'Open Branches'} onClick={() => void openLane(lane)}><ArrowUpRight size={12} /></button>
                </header>
                {PROJECT_BOARD_COLUMNS.map((id) => (
                  <div className={`board-cell board-cell--${id}`} role="gridcell" data-board-column={id} key={id}>
                    {id === 'inbox' ? (
                      <button className={`board-discussion-card ${lane.branch.worktreePath ? '' : 'board-discussion-card--unbound'}`} type="button" onClick={() => setDiscussionLane(lane)}>
                        <span>{lane.branch.worktreePath ? <MessageSquarePlus size={15} /> : <Unlink size={15} />}</span>
                        <strong>{lane.branch.worktreePath ? 'Start discussion' : 'Worktree required'}</strong>
                        <small>{lane.branch.worktreePath ? `Launch an Agent on ${lane.branch.name}` : 'Create a worktree before launching an Agent'}</small>
                      </button>
                    ) : lane.runsByColumn[id].length > 0 ? (
                      lane.runsByColumn[id].map((session) => <RunCard key={session.id} session={session} onOpen={() => selectSession(session.id)} />)
                    ) : (
                      <div className="board-cell__empty"><span>—</span><small>No {COLUMN_META[id].label.toLocaleLowerCase()} runs</small></div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <BoardDiscussionCanvas
        lane={discussionLane}
        anchor={anchor}
        onClose={() => setDiscussionLane(null)}
        onOpenBranches={(lane) => void openLane(lane)}
      />
    </section>
  )
}
