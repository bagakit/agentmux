import {
  ArrowUpRight,
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
  Sparkles,
  SquareTerminal,
  UserRound,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import {
  BOARD_TASK_STATUS_IDS,
  boardTaskColumns,
  projectBoardTasks,
  type BoardTaskArrangement,
  type BoardTaskPriority,
  type BoardTaskProjection,
  type BoardTaskStatus
} from '../lib/global-task-board'
import { workspaceForSession } from '../lib/workbench-tabs'
import { SessionPane } from './SessionPane'
import { StatusDot } from './StatusDot'
import { agentProviderLabel } from './AgentProviderIcon'

const STATUS_META: Record<BoardTaskStatus, { label: string; icon: typeof Inbox }> = {
  inbox: { label: 'Inbox', icon: Inbox },
  working: { label: 'Working', icon: SquareTerminal },
  'needs-you': { label: 'Needs you', icon: UserRound },
  done: { label: 'Done', icon: Check }
}

const PRIORITY_LABEL: Record<BoardTaskPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent'
}

function sessionWorkspaceId(config: ReturnType<typeof useAppStore.getState>['config'], session: SessionSnapshot): string {
  return workspaceForSession(config, session)?.id ?? SCRATCH_WORKSPACE_ID
}

function TaskCard({ task, selected, onSelect }: { task: BoardTaskProjection; selected: boolean; onSelect: () => void }) {
  const firstSession = task.sessions[0]
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
        <span>{task.projectName ?? 'Global'}</span>
        {firstSession ? <span><StatusDot status={firstSession.status} /> {firstSession.providerId ? agentProviderLabel(firstSession.providerId) : 'terminal'}</span> : null}
      </span>
      {task.sessions.length > 1 ? <span className="global-task-card__sessions">{task.sessions.length} sessions</span> : null}
    </button>
  )
}

function TaskWorkspace({ task, arrangement, onArrangement, onClose }: {
  task: BoardTaskProjection
  arrangement: BoardTaskArrangement
  onArrangement: (value: BoardTaskArrangement) => void
  onClose: () => void
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
        <span className="global-task-workspace__fact">{task.description || 'No task description yet'}</span>
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
        <div className={`global-task-workspace__regions ${arrangementClass}`}>
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
                    visible
                    linkOrigin={{ workspaceId, tabGroupId: `task-group:${task.id}`, tabId, regionId }}
                  />
                </div>
                <span className="global-task-region__index">{index + 1} / {sessions.length}</span>
              </section>
            )
          })}
        </div>
      )}
    </aside>
  )
}

function DefaultSessionLauncher({ hidden, onHiddenChange }: { hidden: boolean; onHiddenChange: (hidden: boolean) => void }) {
  const config = useAppStore((state) => state.config)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const [opening, setOpening] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const defaultTopicId = 'launcher:default'

  async function openDefaultTopic(): Promise<void> {
    if (opening) return
    const scratch = config?.workspaces.find((workspace) => workspace.id === SCRATCH_WORKSPACE_ID)
    if (!scratch) return
    setOpening(true)
    try {
      await selectWorkspace(scratch.id)
      await openScratchTopic(defaultTopicId)
    } finally {
      setOpening(false)
    }
  }

  if (hidden) {
    return (
      <button type="button" className="global-default-session__recover" onClick={() => onHiddenChange(false)} title="Show Default Session launcher"><Sparkles size={13} /> Default Session</button>
    )
  }
  return (
    <div className="global-default-session">
      <button
        type="button"
        className="global-default-session__button"
        onClick={() => void openDefaultTopic()}
        onContextMenu={(event) => { event.preventDefault(); setMenuOpen((value) => !value) }}
        aria-label="Open Default Session"
        title="Open Default Session"
      >
        <Sparkles size={14} />
        <span>{opening ? 'Opening…' : 'Default Session'}</span>
      </button>
      {menuOpen ? (
        <div className="global-default-session__menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { onHiddenChange(true); setMenuOpen(false) }}>Hide launcher</button>
          <button type="button" role="menuitem" onClick={() => { setWorkspaceTool('files-branches'); setMenuOpen(false) }}>Show Topic files</button>
        </div>
      ) : null}
    </div>
  )
}

export function GlobalBoardSurface() {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const boardTasks = useAppStore((state) => state.boardTasks)
  const selectedBoardTaskId = useAppStore((state) => state.selectedBoardTaskId)
  const setSelectedBoardTask = useAppStore((state) => state.setSelectedBoardTask)
  const createBoardTask = useAppStore((state) => state.createBoardTask)
  const boardTaskArrangement = useAppStore((state) => state.boardTaskArrangement)
  const setBoardTaskArrangement = useAppStore((state) => state.setBoardTaskArrangement)
  const defaultSessionLauncherHidden = useAppStore((state) => state.defaultSessionLauncherHidden)
  const setDefaultSessionLauncherHidden = useAppStore((state) => state.setDefaultSessionLauncherHidden)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<BoardTaskStatus | 'all'>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const tasks = useMemo(() => projectBoardTasks(config, sessions, boardTasks), [boardTasks, config, sessions])
  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const normalized = query.trim().toLocaleLowerCase()
    const matchesQuery = !normalized || `${task.title} ${task.description} ${task.projectName ?? ''}`.toLocaleLowerCase().includes(normalized)
    return matchesQuery && (statusFilter === 'all' || task.status === statusFilter) && (projectFilter === 'all' || task.projectId === projectFilter)
  }), [projectFilter, query, statusFilter, tasks])
  const columns = useMemo(() => boardTaskColumns(filteredTasks), [filteredTasks])
  const selectedTask = tasks.find((task) => task.id === selectedBoardTaskId) ?? null
  const projects = useMemo(() => [...new Map(tasks.filter((task) => task.projectId && task.projectName).map((task) => [task.projectId!, task.projectName!])).entries()], [tasks])

  useEffect(() => {
    if (selectedBoardTaskId && !selectedTask) setSelectedBoardTask(null)
  }, [selectedBoardTaskId, selectedTask, setSelectedBoardTask])

  function createTask(): void {
    const project = projectFilter !== 'all' ? projects.find(([id]) => id === projectFilter) : undefined
    createBoardTask({ title: 'New task', projectId: project?.[0] ?? null, projectName: project?.[1] ?? null })
  }

  return (
    <section className={`global-board-surface ${selectedTask ? 'global-board-surface--task-open' : ''}`}>
      <div className="global-board-main">
        <header className="global-board-toolbar">
          <div className="global-board-toolbar__scope"><span className="global-board-toolbar__mark"><Columns3 size={14} /></span><strong>Agents</strong><span className="global-board-toolbar__crumb">Global · Board</span></div>
          <div className="global-board-toolbar__controls">
            <label className="global-board-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks" />{query ? <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={11} /></button> : null}</label>
            <label className="global-board-select"><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as BoardTaskStatus | 'all')}><option value="all">All</option>{BOARD_TASK_STATUS_IDS.map((status) => <option key={status} value={status}>{STATUS_META[status].label}</option>)}</select><ChevronDown size={12} /></label>
            <label className="global-board-select"><span>Project</span><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">All</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><ChevronDown size={12} /></label>
            <button type="button" className="global-board-action" onClick={createTask}><CirclePlus size={14} /> Task</button>
            <button type="button" className="global-board-icon-action" title="Board filters" aria-label="Board filters"><MoreHorizontal size={15} /></button>
          </div>
        </header>
        <div className="global-board-columns" role="region" aria-label="Global task board">
          {BOARD_TASK_STATUS_IDS.map((status) => {
            const meta = STATUS_META[status]
            const Icon = meta.icon
            return (
              <section className="global-board-column" key={status} data-status={status}>
                <header className="global-board-column__header"><span><Icon size={13} /><strong>{meta.label}</strong><em>{columns[status].length}</em></span><button type="button" title={`Add ${meta.label} task`} aria-label={`Add ${meta.label} task`} onClick={createTask}><CirclePlus size={13} /></button></header>
                <div className="global-board-column__cards">
                  {columns[status].map((task) => <TaskCard key={task.id} task={task} selected={task.id === selectedBoardTaskId} onSelect={() => setSelectedBoardTask(task.id)} />)}
                  {columns[status].length === 0 ? <div className="global-board-column__empty">Nothing here</div> : null}
                </div>
              </section>
            )
          })}
        </div>
        <footer className="global-board-footer"><span>{filteredTasks.length} of {tasks.length} tasks</span><span className="global-board-footer__hint">Select a task to keep its context beside the board</span><DefaultSessionLauncher hidden={defaultSessionLauncherHidden} onHiddenChange={setDefaultSessionLauncherHidden} /></footer>
      </div>
      {selectedTask ? <TaskWorkspace task={selectedTask} arrangement={boardTaskArrangement} onArrangement={setBoardTaskArrangement} onClose={() => setSelectedBoardTask(null)} /> : null}
    </section>
  )
}
