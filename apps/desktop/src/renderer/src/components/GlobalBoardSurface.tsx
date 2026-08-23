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
  Trash2,
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
} from '../lib/global-demand-board'
import { workspaceForSession } from '../lib/workbench-tabs'
import { SessionPane } from './SessionPane'
import { SessionRegionHost } from './SessionRegionHost'
import { StatusDot } from './StatusDot'
import { AgentTopologySummary } from './AgentTopologySummary'
import { requestPmoTeamsTopicFloatingOpen } from '../lib/pmo-teams-topic-floating'

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

function formatDemandDate(value: number | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function DemandCard({ demand, selected, onSelect, sessions, tabs, config }: { demand: DemandProjection; selected: boolean; onSelect: () => void; sessions: readonly SessionSnapshot[]; tabs: ReturnType<typeof useAppStore.getState>['tabs']; config: ReturnType<typeof useAppStore.getState>['config'] }) {
  const status = STATUS_META[demand.status]
  const Icon = status.icon
  return (
    <div
      role="button"
      tabIndex={0}
      className={`global-demand-card ${selected ? 'global-demand-card--selected' : ''}`}
      data-demand-id={demand.id}
      data-demand-status={demand.status}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }}
    >
      <span className="global-demand-card__topline">
        <span className="global-demand-card__id">{demand.id.startsWith('session:') ? 'SESSION' : demand.id.slice(0, 12).toUpperCase()}</span>
        <span className={`global-demand-card__priority global-demand-card__priority--${demand.priority}`}>{PRIORITY_LABEL[demand.priority]}</span>
      </span>
      <strong className="global-demand-card__title">{demand.title}</strong>
      {demand.description ? <span className="global-demand-card__description">{demand.description}</span> : null}
      <span className="global-demand-card__meta">
        <span><Icon size={12} /> {status.label}</span>
        <span>{demand.projectName ?? 'Unassigned project'}</span>
        <span>{demand.sessions.length} Session{demand.sessions.length === 1 ? '' : 's'}</span>
      </span>
      {demand.tags?.length || demand.plannedStartAt || demand.targetAt || demand.phaseIndex !== null && demand.phaseIndex !== undefined ? (
        <span className="global-demand-card__metadata" aria-label="Demand metadata">
          {demand.tags?.slice(0, 3).map((tag) => <span className="global-demand-card__tag" key={tag}>{tag}</span>)}
          {formatDemandDate(demand.plannedStartAt) ? <span>Start {formatDemandDate(demand.plannedStartAt)}</span> : null}
          {formatDemandDate(demand.targetAt) ? <span>Target {formatDemandDate(demand.targetAt)}</span> : null}
          {demand.phaseIndex !== null && demand.phaseIndex !== undefined ? <span>Batch {demand.phaseIndex + 1}</span> : null}
        </span>
      ) : null}
      {demand.activities?.length || demand.decisions?.length ? <span className="global-demand-card__activity-count">{(demand.activities?.length ?? 0) + (demand.decisions?.length ?? 0)} updates</span> : null}
      {demand.sessionIds.length > 0 ? <AgentTopologySummary sessionIds={demand.sessionIds} sessions={sessions} tabs={tabs} config={config} /> : null}
    </div>
  )
}

function DemandWorkspace({ demand, arrangement, onArrangement, onClose, onUpdate, onDelete, executors, allSessions, tabs }: {
  demand: DemandProjection
  arrangement: DemandArrangement
  onArrangement: (value: DemandArrangement) => void
  onClose: () => void
  onUpdate: (patch: Partial<Pick<DemandProjection, 'title' | 'description' | 'status' | 'priority' | 'projectId' | 'projectName' | 'assigneeExecutorId' | 'tags' | 'plannedStartAt' | 'targetAt' | 'parentDemandId' | 'phaseIndex' | 'activityLog' | 'sessionIds'>>) => void
  onDelete: () => void
  executors: Record<string, { label: string }>
  allSessions: readonly SessionSnapshot[]
  tabs: ReturnType<typeof useAppStore.getState>['tabs']
}) {
  const config = useAppStore((state) => state.config)
  const selectSession = useAppStore((state) => state.selectSession)
  const sessions = demand.sessions
  const [title, setTitle] = useState(demand.title)
  const [description, setDescription] = useState(demand.description)
  const [sessionToAdd, setSessionToAdd] = useState('')
  const [tags, setTags] = useState((demand.tags ?? []).join(', '))
  useEffect(() => { setTitle(demand.title); setDescription(demand.description); setTags((demand.tags ?? []).join(', ')); setSessionToAdd('') }, [demand.id, demand.title, demand.description, demand.tags])
  const arrangementClass = arrangement === 'grid' ? 'global-demand-workspace__regions--grid' : arrangement === 'balanced' ? 'global-demand-workspace__regions--balanced' : 'global-demand-workspace__regions--columns'
  return (
    <aside className="global-demand-workspace" aria-label={`Demand workspace for ${demand.title}`}>
      <header className="global-demand-workspace__header">
        <div className="global-demand-workspace__identity">
          <span className="global-demand-workspace__status" data-status={demand.status}>{STATUS_META[demand.status].label}</span>
          <strong>{demand.title}</strong>
          <small>{demand.projectName ?? 'Global demand'} · {demand.sessionIds.length} linked Session{demand.sessionIds.length === 1 ? '' : 's'}</small>
        </div>
        <div className="global-demand-workspace__header-actions"><button type="button" className="icon-button" title="Delete demand" aria-label="Delete demand" onClick={() => { if (window.confirm(`Delete demand “${demand.title}”?`)) onDelete() }}><Trash2 size={14} /></button><button type="button" className="icon-button" title="Close demand workspace" aria-label="Close demand workspace" onClick={onClose}><PanelRightClose size={15} /></button></div>
      </header>
      <div className="global-demand-workspace__editor">
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => onUpdate({ title })} /></label>
        <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} onBlur={() => onUpdate({ description })} rows={3} /></label>
        <label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} onBlur={() => onUpdate({ tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) })} placeholder="design, customer, release" /></label>
        <div className="global-demand-workspace__toolbar">
          <label className="global-board-select">Status<select aria-label="Demand status" value={demand.status} onChange={(event) => onUpdate({ status: event.target.value as DemandStatus })}>{DEMAND_STATUS_IDS.map((status) => <option key={status} value={status}>{STATUS_META[status].label}</option>)}</select></label>
          <label className="global-board-select">Priority<select aria-label="Demand priority" value={demand.priority} onChange={(event) => onUpdate({ priority: event.target.value as DemandPriority })}>{Object.entries(PRIORITY_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label className="global-board-select">Project<select aria-label="Demand project" value={demand.projectId ?? ''} onChange={(event) => { const project = config?.workspaces.find((workspace) => workspace.id === event.target.value); onUpdate({ projectId: project?.id ?? null, projectName: project?.name ?? null }) }}><option value="">Unassigned</option>{config?.workspaces.filter((workspace) => workspace.id !== SCRATCH_WORKSPACE_ID).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          <label className="global-board-select">Assignee<select aria-label="Demand assignee" value={demand.assigneeExecutorId ?? ''} onChange={(event) => onUpdate({ assigneeExecutorId: event.target.value || null })}><option value="">Unassigned</option>{Object.entries(executors).map(([id, executor]) => <option key={id} value={id}>{executor.label}</option>)}</select></label>
        </div>
        <div className="global-demand-workspace__dates">
          <label>Planned start<input type="date" value={demand.plannedStartAt ? new Date(demand.plannedStartAt).toISOString().slice(0, 10) : ''} onChange={(event) => onUpdate({ plannedStartAt: event.target.value ? Date.parse(`${event.target.value}T00:00:00`) : null })} /></label>
          <label>Target date<input type="date" value={demand.targetAt ? new Date(demand.targetAt).toISOString().slice(0, 10) : ''} onChange={(event) => onUpdate({ targetAt: event.target.value ? Date.parse(`${event.target.value}T00:00:00`) : null })} /></label>
          <label>Progress batch<input type="number" min={1} value={demand.phaseIndex === null || demand.phaseIndex === undefined ? '' : demand.phaseIndex + 1} onChange={(event) => onUpdate({ phaseIndex: event.target.value ? Math.max(0, Number(event.target.value) - 1) : null })} /></label>
        </div>
        <div className="global-demand-workspace__assignment"><strong>Linked Sessions</strong><div className="global-demand-workspace__assignment-add"><select aria-label="Add Session to demand" value={sessionToAdd} onChange={(event) => setSessionToAdd(event.target.value)}><option value="">Choose a Session</option>{allSessions.filter((session) => !demand.sessionIds.includes(session.id)).map((session) => <option key={session.id} value={session.id}>{session.label} · {session.id.slice(0, 8)}</option>)}</select><button type="button" className="small-button" disabled={!sessionToAdd} onClick={() => { onUpdate({ sessionIds: [...demand.sessionIds, sessionToAdd] }); setSessionToAdd('') }}>Add</button></div>{demand.sessions.map((session) => <div className="global-demand-workspace__assignment-row" key={session.id}><span>{session.label}</span><button type="button" className="small-button" onClick={() => onUpdate({ sessionIds: demand.sessionIds.filter((id) => id !== session.id) })}>Remove</button></div>)}</div>
        <AgentTopologySummary sessionIds={demand.sessionIds} sessions={allSessions} tabs={tabs} config={config} />
      </div>
      <div className="global-demand-workspace__toolbar">
        <div className="global-demand-workspace__arrangement" role="group" aria-label="Session arrangement">
          <button type="button" className={arrangement === 'columns' ? 'is-active' : ''} onClick={() => onArrangement('columns')} title="Columns"><Columns3 size={13} /></button>
          <button type="button" className={arrangement === 'grid' ? 'is-active' : ''} onClick={() => onArrangement('grid')} title="Grid"><Grid2X2 size={13} /></button>
          <button type="button" className={arrangement === 'balanced' ? 'is-active' : ''} onClick={() => onArrangement('balanced')} title="Balanced"><SlidersHorizontal size={13} /></button>
        </div>
      </div>
      {(demand.activities?.length || demand.decisions?.length) ? <section className="global-demand-workspace__timeline" aria-label="Demand activity timeline"><strong>Activity</strong>{[...(demand.activities ?? []).map((activity) => ({ id: activity.id, at: activity.createdAt, label: activity.kind, text: activity.message })), ...(demand.decisions ?? []).map((decision) => ({ id: decision.id, at: decision.createdAt, label: 'decision', text: decision.decision }))].sort((left, right) => right.at - left.at).slice(0, 12).map((entry) => <div className="global-demand-workspace__timeline-row" key={entry.id}><time dateTime={new Date(entry.at).toISOString()}>{formatDemandDate(entry.at)}</time><span><b>{entry.label}</b> {entry.text}</span></div>)}</section> : null}
      {sessions.length === 0 ? (
        <div className="global-demand-workspace__empty">
          <NotebookPen size={18} />
          <strong>No Session linked yet</strong>
          <span>Use PMO teams topic to route this demand to a Project and attach a Session.</span>
        </div>
      ) : (
        <SessionRegionHost arrangement={arrangement} className={`global-demand-workspace__regions ${arrangementClass}`}>
          {sessions.map((session, index) => {
            const workspaceId = sessionWorkspaceId(config, session)
            const tabId = `demand-workspace:${demand.id}`
            const regionId = `demand-region:${demand.id}:${session.id}`
            return (
              <section className="global-demand-region" key={session.id} data-region-id={regionId}>
                <header className="global-demand-region__header">
                  <span className="global-demand-region__name"><StatusDot status={session.status} /> {session.label}</span>
                  <button type="button" className="global-demand-region__jump" onClick={() => selectSession(session.id)} title="Open this Session in its Project"><ArrowUpRight size={12} /> Project</button>
                </header>
                <div className="global-demand-region__body">
                  <SessionPane
                    sessionId={session.id}
                    surfaceKind={session.kind}
                    interactiveResize={false}
                    readOnly
                    visible
                    linkOrigin={{ workspaceId, tabGroupId: `demand-group:${demand.id}`, tabId, regionId }}
                  />
                </div>
                <span className="global-demand-region__index">{index + 1} / {sessions.length}</span>
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
  const tabs = useAppStore((state) => state.tabs)
  const demands = useAppStore((state) => state.demands)
  const selectedDemandId = useAppStore((state) => state.selectedDemandId)
  const setSelectedDemand = useAppStore((state) => state.setSelectedDemand)
  const demandArrangement = useAppStore((state) => state.demandArrangement)
  const setDemandArrangement = useAppStore((state) => state.setDemandArrangement)
  const updateDemand = useAppStore((state) => state.updateDemand)
  const deleteDemand = useAppStore((state) => state.deleteDemand)
  const executorCatalog = useAppStore((state) => state.config?.executors)
  const executors = executorCatalog ?? EMPTY_EXECUTORS
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<DemandStatus | 'all'>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [routingFilter, setRoutingFilter] = useState<'all' | 'unassigned' | 'assigned'>('all')
  const [executorFilter, setExecutorFilter] = useState('all')
  const projectedDemands = useMemo(() => projectDemands(config, sessions, demands), [demands, config, sessions])
  const filteredDemands = useMemo(() => projectedDemands.filter((demand) => {
    const normalized = query.trim().toLocaleLowerCase()
    const matchesQuery = !normalized || `${demand.title} ${demand.description} ${demand.projectName ?? ''}`.toLocaleLowerCase().includes(normalized)
    const matchesRouting = routingFilter === 'all' || (routingFilter === 'unassigned' ? !demand.projectId || !demand.assigneeExecutorId : Boolean(demand.projectId && demand.assigneeExecutorId))
    return matchesQuery && (statusFilter === 'all' || demand.status === statusFilter) && (projectFilter === 'all' || demand.projectId === projectFilter) && matchesRouting && (executorFilter === 'all' || demand.assigneeExecutorId === executorFilter)
  }), [executorFilter, projectFilter, query, routingFilter, statusFilter, projectedDemands])
  const columns = useMemo(() => demandColumns(filteredDemands), [filteredDemands])
  const selectedDemand = projectedDemands.find((demand) => demand.id === selectedDemandId) ?? null
  const projects = useMemo(() => (config?.workspaces ?? []).filter((workspace) => workspace.id !== SCRATCH_WORKSPACE_ID).map((workspace) => [workspace.id, workspace.name] as [string, string]), [config?.workspaces])

  useEffect(() => {
    if (selectedDemandId && !selectedDemand) setSelectedDemand(null)
  }, [selectedDemandId, selectedDemand, setSelectedDemand])

  function createDemandCard(): void {
    const project = projectFilter !== 'all' ? projects.find(([id]) => id === projectFilter) : undefined
    const projectContext = project ? `\n当前筛选的目标 Project：${project[1]}（${project[0]}）。` : '\n当前没有预选 Project，请先澄清归属。'
    requestPmoTeamsTopicFloatingOpen({
      anchor: 'floating',
      prompt: `你现在是 AgentMux 的 PMO Teams Topic，从 Board 的 New Demand 入口接到一条新需求。你的身份是项目调度与需求澄清者，不是代替用户直接完成需求的执行 Agent。请先和用户对话澄清，不要先创建空 Demand。${projectContext}\n请确认需求标题、描述、优先级、风险、目标 Project、执行 Agent/Session 和验收标准；形成可审查的方案后，等待用户明确确认，再通过公开 Demand/CUI 能力写入并返回 receipt。`
    })
  }

  return (
    <section className={`global-board-surface ${selectedDemand ? 'global-board-surface--demand-open' : ''}`}>
      <div className="global-board-main">
        <header className="global-board-toolbar">
          <div className="global-board-toolbar__scope"><span className="global-board-toolbar__mark"><Columns3 size={14} /></span><strong>Board</strong><span className="global-board-toolbar__crumb">Demands · Global</span></div>
          <div className="global-board-toolbar__controls">
            <label className="global-board-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search demands" />{query ? <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={11} /></button> : null}</label>
            <label className="global-board-select"><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as DemandStatus | 'all')}><option value="all">All</option>{DEMAND_STATUS_IDS.map((status) => <option key={status} value={status}>{STATUS_META[status].label}</option>)}</select><ChevronDown size={12} /></label>
            <label className="global-board-select"><span>Project</span><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">All</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><ChevronDown size={12} /></label>
            <label className="global-board-select"><span>Routing</span><select aria-label="Demand routing" value={routingFilter} onChange={(event) => setRoutingFilter(event.target.value as typeof routingFilter)}><option value="all">All</option><option value="unassigned">Needs routing</option><option value="assigned">Assigned</option></select><ChevronDown size={12} /></label>
            <label className="global-board-select"><span>Executor</span><select aria-label="Demand executor" value={executorFilter} onChange={(event) => setExecutorFilter(event.target.value)}><option value="all">All</option>{Object.entries(executors).map(([id, executor]) => <option key={id} value={id}>{executor.label}</option>)}</select><ChevronDown size={12} /></label>
            <button type="button" className="global-board-action" onClick={createDemandCard}><CirclePlus size={14} /> Demand</button>
            <button type="button" className="global-board-icon-action" title="Board filters" aria-label="Board filters"><MoreHorizontal size={15} /></button>
          </div>
        </header>
        <div className="global-board-columns" role="region" aria-label="Global demand board">
          {DEMAND_STATUS_IDS.map((status) => {
            const meta = STATUS_META[status]
            const Icon = meta.icon
            return (
              <section className="global-board-column" key={status} data-status={status}>
                <header className="global-board-column__header"><span><Icon size={13} /><strong>{meta.label}</strong><em>{columns[status].length}</em></span><button type="button" title={`Add ${meta.label} demand`} aria-label={`Add ${meta.label} demand`} onClick={createDemandCard}><CirclePlus size={13} /></button></header>
                <div className="global-board-column__cards">
                  {columns[status].map((demand) => <DemandCard key={demand.id} demand={demand} selected={demand.id === selectedDemandId} onSelect={() => setSelectedDemand(demand.id)} sessions={sessions} tabs={tabs} config={config} />)}
                  {columns[status].length === 0 ? <div className="global-board-column__empty">Nothing here</div> : null}
                </div>
              </section>
            )
          })}
        </div>
        <footer className="global-board-footer"><span>{filteredDemands.length} of {projectedDemands.length} demands</span><span className="global-board-footer__hint">Select a demand to keep its context beside the board</span></footer>
      </div>
      {selectedDemand ? <DemandWorkspace demand={selectedDemand} arrangement={demandArrangement} onArrangement={setDemandArrangement} onClose={() => setSelectedDemand(null)} onDelete={() => { deleteDemand(selectedDemand.id); setSelectedDemand(null) }} executors={executors} allSessions={sessions} tabs={tabs} onUpdate={(patch) => updateDemand(selectedDemand.id, { ...patch, ...(patch.status ? { activityLog: [...(selectedDemand.activityLog ?? []), `Status → ${patch.status}`] } : {}) })} /> : null}
    </section>
  )
}
