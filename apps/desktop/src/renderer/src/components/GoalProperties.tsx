import { civilClock } from "../lib/civil-clock"
import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useMemo, useState } from 'react'
import type { DemandProjection, DemandPriority, DemandStatus } from '../lib/global-demand-board'
import { DEMAND_STATUS_IDS } from '../lib/global-demand-board'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { projectWorkspaces } from '../lib/workspace-projects'
import { agentDisplayName, firstPromptFromTimeline } from '../lib/workbench-tabs'
import { SelectionField } from './SelectionField'

function localDateInput(timestamp: number | null | undefined): string {
  if (timestamp == null) return ''
  const date = new Date(timestamp)
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

type Props = { demand: DemandProjection; onUpdate: (patch: Parameters<ReturnType<typeof useAppStore.getState>['updateDemand']>[1]) => void }
const STATUS_LABELS = ['Backlog', 'Todo', 'In progress', 'In review', 'Blocked', 'Done', 'Cancelled']
export function GoalCommonProperties({ demand, onUpdate }: Props) {
  const workspaces = useAppStore(state => state.config?.workspaces)
  const projects = useMemo(() => projectWorkspaces((workspaces ?? []).filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID)), [workspaces])
  const unavailableProject = Boolean(demand.projectId && !projects.some(project => project.id === demand.projectId))
  return <div className="goals-common-properties" aria-label="Common Goal properties">
    <label>Work status<SelectionField label="Goal work status" value={demand.status} options={DEMAND_STATUS_IDS.map((value, index) => ({ value, label: STATUS_LABELS[index]! }))} onValueChange={status => onUpdate({ status: status as DemandStatus })} /></label>
    <label>Priority<SelectionField label="Goal priority" value={demand.priority} options={['low', 'normal', 'high', 'urgent'].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))} onValueChange={priority => onUpdate({ priority: priority as DemandPriority })} /></label>
    <label>Project<SelectionField label="Goal project" value={demand.projectId ?? ''} options={[{ value: '', label: 'Unassigned' }, ...(unavailableProject ? [{ value: demand.projectId!, label: `${demand.projectName ?? 'Bound Project'} · Unavailable`, disabled: true }] : []), ...projects.map(project => ({ value: project.id, label: project.name }))]}
      onValueChange={id => { if (!id) onUpdate({ projectId: null, projectName: null }); else { const project = projects.find(project => project.id === id); if (project) onUpdate({ projectId: project.id, projectName: project.name }) } }} /></label>
  </div>
}
export function GoalProperties(props: Props) {
  const [open, setOpen] = useState(false)
  return <details className="goals-properties" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }}><summary>More properties</summary>{open ? <GoalMoreProperties {...props} /> : null}</details>
}
function GoalMoreProperties({ demand, onUpdate }: Props) {
  const timelines = useAppStore(state => state.timelines)
  const demands = useAppStore(state => state.demands), sessions = useAppStore(state => state.sessions), names = useAppStore(state => state.agentNames)
  const sessionName = (id: string, hostId: string) => { const candidates = sessions.filter((session): session is Extract<(typeof sessions)[number], { kind: 'agent' }> => session.hostId === hostId && session.kind === 'agent' && (session.id === id || session.control.agentSessionId === id)); const session = candidates.length === 1 ? candidates[0] : undefined; return session ? agentDisplayName({ userName: names[session.id], firstPrompt: firstPromptFromTimeline(timelines[session.id]), fallbackLabel: session.label, providerLabel: session.providerId }) : `${id} · ${hostId} · Identity unavailable` }
  const [tags, setTags] = useState((demand.tags ?? []).join(', '))
  useEffect(() => setTags((demand.tags ?? []).join(', ')), [demand.tags])
  return <div className="goals-properties__groups">
    <fieldset><legend>Planning</legend><div className="goals-properties__fields">
      <label>Planned start<TextInput type="date" aria-label="Goal planned start" value={localDateInput(demand.plannedStartAt)} onChange={event => onUpdate({ plannedStartAt: event.target.value ? Date.parse(`${event.target.value}T${civilClock(0, 0, 0)}`) : null })} /></label>
      <label>Target date<TextInput type="date" aria-label="Goal target date" value={localDateInput(demand.targetAt)} onChange={event => onUpdate({ targetAt: event.target.value ? Date.parse(`${event.target.value}T${civilClock(0, 0, 0)}`) : null })} /></label>
      <label>Batch<TextInput type="number" min={1} aria-label="Goal batch" value={demand.phaseIndex === null || demand.phaseIndex === undefined ? '' : demand.phaseIndex + 1} onChange={event => onUpdate({ phaseIndex: event.target.value ? Math.max(0, Number(event.target.value) - 1) : null })} /></label>
    </div></fieldset>
    <fieldset><legend>Classification</legend><div className="goals-properties__fields">
      <label>Tags<TextInput aria-label="Goal tags" value={tags} onChange={event => setTags(event.target.value)} onBlur={() => onUpdate({ tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) })} /></label>

    </div></fieldset>
    <fieldset><legend>Relationships</legend><div className="goals-properties__fields">
      <label>Parent goal<SelectionField label="Parent goal" value={demand.parentDemandId ?? ''} options={[{ value: '', label: 'None' }, ...Object.values(demands).filter(item => item.id !== demand.id).map(item => ({ value: item.id, label: item.title }))]} onValueChange={parentDemandId => onUpdate({ parentDemandId: parentDemandId || null })} /></label>
    </div><div className="goals-properties__references">
      {demand.participations?.map(source => <div key={source.id}><strong>{sessionName(source.agentSessionId, source.hostId)}</strong><span>{source.kind} · {source.entryPoint} · {source.hostId}</span><span>{source.agentSessionId}</span>{source.mote ? <span>Mote · {source.mote.topicId} · {source.mote.identityDirectoryPath}</span> : null}<time dateTime={new Date(source.recordedAt).toISOString()}>{new Date(source.recordedAt).toLocaleString()}</time></div>)}
      {demand.alignment ? <span>Goal version · {demand.alignment.revision}</span> : null}
      {demand.grounding ? <span>Report · {demand.grounding.submissionId}</span> : null}
      <span title={demand.id}>ID · {demand.id}</span>
    </div></fieldset>
  </div>
}
