import {
  ArrowUpRight,
  UserRound,
  Check,
  ChevronDown,
  CirclePlus,
  Columns3,
  Grid2X2,
  Inbox,
  MoreHorizontal,
  NotebookPen,
  PanelRightClose,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import {
  DEMAND_STATUS_IDS,
  demandColumns,
  projectDemands,
  type DemandArrangement,
  type DemandPriority,
  type DemandProjection,
  type DemandStatus
} from '../lib/global-task-board'
import { workspaceForSession } from '../lib/workbench-tabs'
import { SessionPane } from './SessionPane'
import { SessionRegionHost } from './SessionRegionHost'
import { StatusDot } from './StatusDot'
import { DefaultSessionEntry } from './DefaultSessionEntry'

const STATUS_META: Record<DemandStatus, { label: string; icon: typeof Inbox }> = {
  backlog: { label: 'Backlog', icon: Inbox },
  todo: { label: 'Todo', icon: NotebookPen },
  in_progress: { label: 'In progress', icon: SquareTerminal },
  in_review: { label: 'In review', icon: UserRound },
  blocked: { label: 'Blocked', icon: UserRound },
  done: { label: 'Done', icon: Check },
  cancelled: { label: 'Cancelled', icon: X }
}

const PRIORITY_LABEL: Record<DemandPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent'
}

function sessionWorkspaceId(config: ReturnType<typeof useAppStore.getState>['config'], session: SessionSnapshot): string {
  return workspaceForSession(config, session)?.id ?? SCRATCH_WORKSPACE_ID
}

function DemandCard({ task, selected, onSelect }: { task: DemandProjection; selected: boolean; onSelect: () => void }) {
  const status = STATUS_META[task.status]
  const Icon = status.icon
  return (
    <button
      type="button"
      className={`global-task-card ${selected ? 'global-task-card--selected' : ''}`}
      data-task-id={task.id}
      data-task-status={task.status}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="global-task-card__topline">
        <span className="global-task-card__id">{task.id.startsWith('session:') ? 'SESSION' : task.id.slice(0, 12).toUpperCase()}</span>
        <span className={`global-task-card__priority global-task-card__priority--${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>
      </span>
      <strong className="global-task-card__title">{task.title}</strong>
      {task.description ? <span className="global-task-card__description">{task.description}</span> : null}
      <span className="global-task-card__meta">
        <span><Icon size={12} /> {status.label}</span>
        <span>{task.projectName ?? 'Unassigned project'}</span>
        <span>{task.sessions.length} Session{task.sessions.length === 1 ? '' : 's'}</span>
      </span>
      
    </button>
  )
}

function DemandWorkspace({ task, arrangement, onArrangement, onClose, onUpdate, executors }: {
  task: DemandProjection
  arrangement: DemandArrangement
  onArrangement: (value: DemandArrangement) => void
  onClose: () => void
  onUpdate: (patch: Partial<Pick<DemandProjection, 'status' | 'priority' | 'assigneeExecutorId' | 'activityLog'>>) => void
  executors: Record<string, { label: string }>
}) {
  const config = useAppStore((state) => state.config)
  const selectSession = useAppStore((state) => state.selectSession)
  const sessions = task.sessions
  const arrangementClass = arrangement === 'grid' ? 'global-task-workspace__regions--grid' : arrangement === 'balanced' ? 'global-task-workspace__regions--balanced' : 'global-task-workspace__regions--columns'
  return (
    <aside className="global-task-workspace" aria-label={`Task workspace for ${task.title}`}>
      <header className="global-task-workspace__header">
        <div className="global-task-workspace__identity">
          <span className="global-task-workspace__status" data-status={task.status}>{STATUS_META[task.status].label}</span>
          <strong>{task.title}</strong>
          <small>{task.projectName ?? 'Global task'} · {task.sessionIds.length} linked Session{task.sessionIds.length === 1 ? '' : 's'}</small>
        </div>
        <button type="button" className="icon-button" title="Close task workspace" aria-label="Close task workspace" onClick={onClose}><PanelRightClose size={15} /></button>
      </header>
      <div className="global-task-workspace__toolbar">
        <span className="global-task-workspace__fact">{task.description || 'No task description yet'}</span><label className="global-board-select">Status<select aria-label="Task status" value={task.status} onChange={(event) => onUpdate({ status: event.target.value as DemandStatus })}>{DEMAND_STATUS_IDS.map((status) => <option key={status} value={status}>{STATUS_META[status].label}</option>)}</select></label><label className="global-board-select">Assignee<select aria-label="Task assignee" value={task.assigneeExecutorId ?? ''} onChange={(event) => onUpdate({ assigneeExecutorId: event.target.value || null })}><option value="">Unassigned</option>{Object.entries(executors).map(([id, executor]) => <option key={id} value={id}>{executor.label}</option>)}</select></label>
        <div className="global-task-workspace__arrangement" role="group" aria-label="Session arrangement">
          <button type="button" className={arrangement === 'columns' ? 'is-active' : ''} onClick={() => onArrangement('columns')} title="Columns"><Columns3 size={13} /></button>
          <button type="button" className={arrangement === 'grid' ? 'is-active' : ''} onClick={() => onArrangement('grid')} title="Grid"><Grid2X2 size={13} /></button>
          <button type="button" className={arrangement === 'balanced' ? 'is-active' : ''} onClick={() => onArrangement('balanced')} title="Balanced"><SlidersHorizontal size={13} /></button>
        </div>
      </div>
      {sessions.length === 0 ? (
        <div className="global-task-workspace__empty">
          <NotebookPen size={18} />
          <strong>No Session linked yet</strong>
          <span>Use the Default Topic to route this task to a Project and attach a Session.</span>
        </div>
      ) : (
        <SessionRegionHost arrangement={arrangement} className={`global-task-workspace__regions ${arrangementClass}`}>
          {sessions.map((session, index) => {
            const workspaceId = sessionWorkspaceId(config, session)
            const tabId = `task-workspace:${task.id}`
            const regionId = `task-region:${task.id}:${session.id}`
            return (
              <section className="global-task-region" key={session.id} data-region-id={regionId}>
                <header className="global-task-region__header">
                  <span className="global-task-region__name"><StatusDot status={session.status} /> {session.label}</span>
                  <button type="button" className="global-task-region__jump" onClick={() => selectSession(session.id)} title="Open this Session in its Project"><ArrowUpRight size={12} /> Project</button>
                </header>
                <div className="global-task-region__body">
                  <SessionPane
                    sessionId={session.id}
                    surfaceKind={session.kind}
                    interactiveResize={false}
                    readOnly
                    visible
                    linkOrigin={{ workspaceId, tabGroupId: `task-group:${task.id}`, tabId, regionId }}
                  />
                </div>
                <span className="global-task-region__index">{index + 1} / {sessions.length}</span>
              </section>
            )
          })}
        </SessionRegionHost>
      )}
    </aside>
  )
}

const EMPTY_EXECUTORS: Record<string, { label: string }> = {}

export function GlobalBoardSurface() {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const demands = useAppStore((state) => state.demands)
  const selectedDemandId = useAppStore((state) => state.selectedDemandId)
  const setSelectedDemand = useAppStore((state) => state.setSelectedDemand)
  const createDemand = useAppStore((state) => state.createDemand)
  const demandArrangement = useAppStore((state) => state.demandArrangement)
  const setDemandArrangement = useAppStore((state) => state.setDemandArrangement)
  const updateDemand = useAppStore((state) => state.updateDemand)
  const executorCatalog = useAppStore((state) => state.config?.executors)
  const executors = executorCatalog ?? EMPTY_EXECUTORS
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<DemandStatus | 'all'>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const tasks = useMemo(() => projectDemands(config, sessions, demands), [demands, config, sessions])
  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const normalized = query.trim().toLocaleLowerCase()
    const matchesQuery = !normalized || `${task.title} ${task.description} ${task.projectName ?? ''}`.toLocaleLowerCase().includes(normalized)
    return matchesQuery && (statusFilter === 'all' || task.status === statusFilter) && (projectFilter === 'all' || task.projectId === projectFilter)
  }), [projectFilter, query, statusFilter, tasks])
  const columns = useMemo(() => demandColumns(filteredTasks), [filteredTasks])
  const selectedDemand = tasks.find((task) => task.id === selectedDemandId) ?? null
  const projects = useMemo(() => [...new Map(tasks.filter((task) => task.projectId && task.projectName).map((task) => [task.projectId!, task.projectName!])).entries()], [tasks])

  useEffect(() => {
    if (selectedDemandId && !selectedDemand) setSelectedDemand(null)
  }, [selectedDemandId, selectedDemand, setSelectedDemand])

  function createTask(): void {
    const project = projectFilter !== 'all' ? projects.find(([id]) => id === projectFilter) : undefined
    createDemand({ title: 'New task', projectId: project?.[0] ?? null, projectName: project?.[1] ?? null })
  }

  return (
    <section className={`global-board-surface ${selectedDemand ? 'global-board-surface--task-open' : ''}`}>
      <div className="global-board-main">
        <header className="global-board-toolbar">
          <div className="global-board-toolbar__scope"><span className="global-board-toolbar__mark"><Columns3 size={14} /></span><strong>Board</strong><span className="global-board-toolbar__crumb">Demands · Global</span></div>
          <div className="global-board-toolbar__controls">
            <label className="global-board-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search demands" />{query ? <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={11} /></button> : null}</label>
            <label className="global-board-select"><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as DemandStatus | 'all')}><option value="all">All</option>{DEMAND_STATUS_IDS.map((status) => <option key={status} value={status}>{STATUS_META[status].label}</option>)}</select><ChevronDown size={12} /></label>
            <label className="global-board-select"><span>Project</span><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">All</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><ChevronDown size={12} /></label>
            <button type="button" className="global-board-action" onClick={createTask}><CirclePlus size={14} /> Demand</button>
            <button type="button" className="global-board-icon-action" title="Board filters" aria-label="Board filters"><MoreHorizontal size={15} /></button>
          </div>
        </header>
        <div className="global-board-columns" role="region" aria-label="Global demand board">
          {DEMAND_STATUS_IDS.map((status) => {
            const meta = STATUS_META[status]
            const Icon = meta.icon
            return (
              <section className="global-board-column" key={status} data-status={status}>
                <header className="global-board-column__header"><span><Icon size={13} /><strong>{meta.label}</strong><em>{columns[status].length}</em></span><button type="button" title={`Add ${meta.label} demand`} aria-label={`Add ${meta.label} demand`} onClick={createTask}><CirclePlus size={13} /></button></header>
                <div className="global-board-column__cards">
                  {columns[status].map((task) => <DemandCard key={task.id} task={task} selected={task.id === selectedDemandId} onSelect={() => setSelectedDemand(task.id)} />)}
                  {columns[status].length === 0 ? <div className="global-board-column__empty">Nothing here</div> : null}
                </div>
              </section>
            )
          })}
        </div>
        <footer className="global-board-footer"><span>{filteredTasks.length} of {tasks.length} demands</span><span className="global-board-footer__hint">Select a task to keep its context beside the board</span><DefaultSessionEntry placement="board" /></footer>
      </div>
      {selectedDemand ? <DemandWorkspace task={selectedDemand} arrangement={demandArrangement} onArrangement={setDemandArrangement} onClose={() => setSelectedDemand(null)} executors={executors} onUpdate={(patch) => updateDemand(selectedDemand.id, { ...patch, ...(patch.status ? { activityLog: [...(selectedDemand.activityLog ?? []), `Status → ${patch.status}`] } : {}) })} /> : null}
    </section>
  )
}
