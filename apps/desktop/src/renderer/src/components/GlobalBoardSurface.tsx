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
} from '../lib/global-demand-board'
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

function DemandCard({ demand, selected, onSelect }: { demand: DemandProjection; selected: boolean; onSelect: () => void }) {
  const status = STATUS_META[demand.status]
  const Icon = status.icon
  return (
    <button
      type="button"
      className={`global-demand-card ${selected ? 'global-demand-card--selected' : ''}`}
      data-demand-id={demand.id}
      data-demand-status={demand.status}
      aria-pressed={selected}
      onClick={onSelect}
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
      
    </button>
  )
}

function DemandWorkspace({ demand, arrangement, onArrangement, onClose, onUpdate, executors }: {
  demand: DemandProjection
  arrangement: DemandArrangement
  onArrangement: (value: DemandArrangement) => void
  onClose: () => void
  onUpdate: (patch: Partial<Pick<DemandProjection, 'status' | 'priority' | 'assigneeExecutorId' | 'activityLog'>>) => void
  executors: Record<string, { label: string }>
}) {
  const config = useAppStore((state) => state.config)
  const selectSession = useAppStore((state) => state.selectSession)
  const sessions = demand.sessions
  const arrangementClass = arrangement === 'grid' ? 'global-demand-workspace__regions--grid' : arrangement === 'balanced' ? 'global-demand-workspace__regions--balanced' : 'global-demand-workspace__regions--columns'
  return (
    <aside className="global-demand-workspace" aria-label={`Demand workspace for ${demand.title}`}>
      <header className="global-demand-workspace__header">
        <div className="global-demand-workspace__identity">
          <span className="global-demand-workspace__status" data-status={demand.status}>{STATUS_META[demand.status].label}</span>
          <strong>{demand.title}</strong>
          <small>{demand.projectName ?? 'Global demand'} · {demand.sessionIds.length} linked Session{demand.sessionIds.length === 1 ? '' : 's'}</small>
        </div>
        <button type="button" className="icon-button" title="Close demand workspace" aria-label="Close demand workspace" onClick={onClose}><PanelRightClose size={15} /></button>
      </header>
      <div className="global-demand-workspace__toolbar">
        <span className="global-demand-workspace__fact">{demand.description || 'No demand description yet'}</span><label className="global-board-select">Status<select aria-label="Demand status" value={demand.status} onChange={(event) => onUpdate({ status: event.target.value as DemandStatus })}>{DEMAND_STATUS_IDS.map((status) => <option key={status} value={status}>{STATUS_META[status].label}</option>)}</select></label><label className="global-board-select">Assignee<select aria-label="Demand assignee" value={demand.assigneeExecutorId ?? ''} onChange={(event) => onUpdate({ assigneeExecutorId: event.target.value || null })}><option value="">Unassigned</option>{Object.entries(executors).map(([id, executor]) => <option key={id} value={id}>{executor.label}</option>)}</select></label>
        <div className="global-demand-workspace__arrangement" role="group" aria-label="Session arrangement">
          <button type="button" className={arrangement === 'columns' ? 'is-active' : ''} onClick={() => onArrangement('columns')} title="Columns"><Columns3 size={13} /></button>
          <button type="button" className={arrangement === 'grid' ? 'is-active' : ''} onClick={() => onArrangement('grid')} title="Grid"><Grid2X2 size={13} /></button>
          <button type="button" className={arrangement === 'balanced' ? 'is-active' : ''} onClick={() => onArrangement('balanced')} title="Balanced"><SlidersHorizontal size={13} /></button>
        </div>
      </div>
      {sessions.length === 0 ? (
        <div className="global-demand-workspace__empty">
          <NotebookPen size={18} />
          <strong>No Session linked yet</strong>
          <span>Use the Default Topic to route this demand to a Project and attach a Session.</span>
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
  const projectedDemands = useMemo(() => projectDemands(config, sessions, demands), [demands, config, sessions])
  const filteredDemands = useMemo(() => projectedDemands.filter((demand) => {
    const normalized = query.trim().toLocaleLowerCase()
    const matchesQuery = !normalized || `${demand.title} ${demand.description} ${demand.projectName ?? ''}`.toLocaleLowerCase().includes(normalized)
    return matchesQuery && (statusFilter === 'all' || demand.status === statusFilter) && (projectFilter === 'all' || demand.projectId === projectFilter)
  }), [projectFilter, query, statusFilter, projectedDemands])
  const columns = useMemo(() => demandColumns(filteredDemands), [filteredDemands])
  const selectedDemand = projectedDemands.find((demand) => demand.id === selectedDemandId) ?? null
  const projects = useMemo(() => [...new Map(projectedDemands.filter((demand) => demand.projectId && demand.projectName).map((demand) => [demand.projectId!, demand.projectName!])).entries()], [projectedDemands])

  useEffect(() => {
    if (selectedDemandId && !selectedDemand) setSelectedDemand(null)
  }, [selectedDemandId, selectedDemand, setSelectedDemand])

  function createDemandCard(): void {
    const project = projectFilter !== 'all' ? projects.find(([id]) => id === projectFilter) : undefined
    createDemand({ title: 'New demand', projectId: project?.[0] ?? null, projectName: project?.[1] ?? null })
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
                  {columns[status].map((demand) => <DemandCard key={demand.id} demand={demand} selected={demand.id === selectedDemandId} onSelect={() => setSelectedDemand(demand.id)} />)}
                  {columns[status].length === 0 ? <div className="global-board-column__empty">Nothing here</div> : null}
                </div>
              </section>
            )
          })}
        </div>
        <footer className="global-board-footer"><span>{filteredDemands.length} of {projectedDemands.length} demands</span><span className="global-board-footer__hint">Select a demand to keep its context beside the board</span><DefaultSessionEntry placement="board" /></footer>
      </div>
      {selectedDemand ? <DemandWorkspace demand={selectedDemand} arrangement={demandArrangement} onArrangement={setDemandArrangement} onClose={() => setSelectedDemand(null)} executors={executors} onUpdate={(patch) => updateDemand(selectedDemand.id, { ...patch, ...(patch.status ? { activityLog: [...(selectedDemand.activityLog ?? []), `Status → ${patch.status}`] } : {}) })} /> : null}
    </section>
  )
}
