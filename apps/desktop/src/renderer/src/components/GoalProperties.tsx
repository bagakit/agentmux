import { useEffect, useMemo, useState } from 'react'
import type { DemandProjection, DemandPriority, DemandStatus } from '../lib/global-demand-board'
import { DEMAND_STATUS_IDS } from '../lib/global-demand-board'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { projectWorkspaces } from '../lib/workspace-projects'

const STATUS_LABELS = ['Backlog', 'Todo', 'In progress', 'In review', 'Blocked', 'Done', 'Cancelled']
export function GoalProperties({ demand, onUpdate }: { demand: DemandProjection; onUpdate: (patch: Parameters<ReturnType<typeof useAppStore.getState>['updateDemand']>[1]) => void }) {
  const config = useAppStore((state) => state.config)
  const demands = useAppStore((state) => state.demands)
  const projects = useMemo(() => projectWorkspaces((config?.workspaces ?? []).filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID)), [config?.workspaces])
  const unavailableProject = Boolean(demand.projectId && !projects.some(project => project.id === demand.projectId))
  const [tags, setTags] = useState((demand.tags ?? []).join(', '))
  useEffect(() => setTags((demand.tags ?? []).join(', ')), [demand.tags])
  return <details className="goals-properties"><summary>More properties</summary><div className="goals-properties__fields">
    <label>Work status<select aria-label="Goal work status" value={demand.status} onChange={(event) => onUpdate({ status: event.target.value as DemandStatus })}>{DEMAND_STATUS_IDS.map((status, i) => <option key={status} value={status}>{STATUS_LABELS[i]}</option>)}</select></label>
    <label>Priority<select aria-label="Goal priority" value={demand.priority} onChange={(event) => onUpdate({ priority: event.target.value as DemandPriority })}>{['low', 'normal', 'high', 'urgent'].map((priority) => <option key={priority} value={priority}>{priority}</option>)}</select></label>
    <label>Project<select aria-label="Goal project" value={demand.projectId ?? ''} onChange={(event) => { if (!event.target.value) { onUpdate({ projectId: null, projectName: null }); return }; const project = projects.find(project => project.id === event.target.value); if (project) onUpdate({ projectId: project.id, projectName: project.name }) }}><option value="">Unassigned</option>{unavailableProject ? <option value={demand.projectId!} disabled>{demand.projectName ?? 'Bound project'} · Unavailable</option> : null}{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <label>Assignee<select aria-label="Goal assignee" value={demand.assigneeExecutorId ?? ''} onChange={(event) => onUpdate({ assigneeExecutorId: event.target.value || null })}><option value="">Unassigned</option>{Object.entries(config?.executors ?? {}).map(([id, executor]) => <option key={id} value={id}>{executor.label}</option>)}</select></label>
    <label>Tags<input aria-label="Goal tags" value={tags} onChange={(event) => setTags(event.target.value)} onBlur={() => onUpdate({ tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) })} /></label>
    <label>Planned start<input type="date" aria-label="Goal planned start" value={demand.plannedStartAt ? new Date(demand.plannedStartAt).toISOString().slice(0, 10) : ''} onChange={(event) => onUpdate({ plannedStartAt: event.target.value ? Date.parse(`${event.target.value}T00:00:00`) : null })} /></label>
    <label>Target date<input type="date" aria-label="Goal target date" value={demand.targetAt ? new Date(demand.targetAt).toISOString().slice(0, 10) : ''} onChange={(event) => onUpdate({ targetAt: event.target.value ? Date.parse(`${event.target.value}T00:00:00`) : null })} /></label>
    <label>Batch<input type="number" min={1} aria-label="Goal batch" value={demand.phaseIndex === null || demand.phaseIndex === undefined ? '' : demand.phaseIndex + 1} onChange={(event) => onUpdate({ phaseIndex: event.target.value ? Math.max(0, Number(event.target.value) - 1) : null })} /></label>
    <label>Parent goal<select aria-label="Parent goal" value={demand.parentDemandId ?? ''} onChange={(event) => onUpdate({ parentDemandId: event.target.value || null })}><option value="">None</option>{Object.values(demands).filter((item) => item.id !== demand.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    {demand.alignment ? <span className="goals-properties__id">Goal version · {demand.alignment.revision}</span> : null}
    {demand.grounding ? <span className="goals-properties__id">Report · {demand.grounding.submissionId}</span> : null}
    <span className="goals-properties__id" title={demand.id}>ID · {demand.id}</span>
  </div></details>
}
