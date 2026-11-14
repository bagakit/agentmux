import { civilClock } from "../lib/civil-clock"
import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DemandProjection, DemandPriority, DemandStatus } from '../lib/global-demand-board'
import { DEMAND_STATUS_IDS, DEMAND_STATUS_LABELS } from '../lib/global-demand-board'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { useAppStore } from '../store'
import { projectWorkspaces } from '../lib/workspace-projects'
import { agentDisplayName } from '../lib/workbench-tabs'
import { agentSessionPresentationIndex, createFirstPromptSelector } from '../lib/session-presentation'
import { SelectionField } from './SelectionField'

function localDateInput(timestamp: number | null | undefined): string {
  if (timestamp == null) return ''
  const date = new Date(timestamp)
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

type Props = { demand: DemandProjection; onUpdate: (patch: Parameters<ReturnType<typeof useAppStore.getState>['updateDemand']>[1]) => void }
export function GoalCommonProperties({ demand, onUpdate }: Props) {
  const workspaces = useAppStore(state => state.config?.workspaces)
  const projects = useMemo(() => projectWorkspaces((workspaces ?? []).filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID)), [workspaces])
  const unavailableProject = Boolean(demand.projectId && !projects.some(project => project.id === demand.projectId))
  return <div className="goals-common-properties" aria-label="Common Goal properties">
    <label>Work status<SelectionField label="Goal work status" value={demand.status} options={DEMAND_STATUS_IDS.map(value => ({ value, label: DEMAND_STATUS_LABELS[value] }))} onValueChange={status => onUpdate({ status: status as DemandStatus })} /></label>
    <label>Priority<SelectionField label="Goal priority" value={demand.priority} options={['low', 'normal', 'high', 'urgent'].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))} onValueChange={priority => onUpdate({ priority: priority as DemandPriority })} /></label>
    <label>Project<SelectionField key={demand.id} label="Goal project" value={demand.projectId ?? ''} options={[{ value: '', label: 'Unassigned' }, ...(unavailableProject ? [{ value: demand.projectId!, label: `${demand.projectName ?? 'Bound Project'} · Unavailable`, disabled: true }] : []), ...projects.map(project => ({ value: project.id, label: project.name }))]}
      onValueChange={id => { if (!id) onUpdate({ projectId: null, projectName: null }); else { const project = projects.find(project => project.id === id); if (project) onUpdate({ projectId: project.id, projectName: project.name }) } }} /></label>
  </div>
}
export function GoalProperties(props: Props) {
  const [open, setOpen] = useState(false)
  return <details className="goals-properties" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }}><summary>More properties</summary>{open ? <GoalMoreProperties {...props} /> : null}</details>
}
function GoalMoreProperties({ demand, onUpdate }: Props) {
  // The open parent picker deliberately consumes the Goal inventory; participant names do not.
  const demands = useAppStore(state => state.demands)
  const [tags, setTags] = useState((demand.tags ?? []).join(', '))
  useEffect(() => setTags((demand.tags ?? []).join(', ')), [demand.tags])
  return <div className="goals-properties__groups">
    <fieldset><legend>Planning</legend><div className="goals-properties__fields">
      <label>Planned start<TextInput type="date" aria-label="Goal planned start" value={localDateInput(demand.plannedStartAt)} onChange={event => onUpdate({ plannedStartAt: event.target.value ? Date.parse(`${event.target.value}T${civilClock(0, 0, 0)}`) : null })} /></label>
      <label>Batch<TextInput type="number" min={0} step={1} aria-label="Goal batch" value={demand.phaseIndex ?? ''} onChange={event => { const value = event.target.value; if (value === '' || Number.isSafeInteger(Number(value)) && Number(value) >= 0) onUpdate({ phaseIndex: value === '' ? null : Number(value) }) }} /></label>
      <label>Target date<TextInput type="date" aria-label="Goal target date" value={localDateInput(demand.targetAt)} onChange={event => onUpdate({ targetAt: event.target.value ? Date.parse(`${event.target.value}T${civilClock(0, 0, 0)}`) : null })} /></label>
    </div></fieldset>
    <fieldset><legend>Classification</legend><div className="goals-properties__fields">
      <label>Tags<TextInput aria-label="Goal tags" value={tags} onChange={event => setTags(event.target.value)} onBlur={() => onUpdate({ tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) })} /></label>

    </div></fieldset>
    <fieldset><legend>Relationships</legend><div className="goals-properties__fields">
      <label>Parent goal<SelectionField key={demand.id} label="Parent goal" value={demand.parentDemandId ?? ''} options={[{ value: '', label: 'None' }, ...Object.values(demands).filter(item => item.id !== demand.id).map(item => ({ value: item.id, label: item.title }))]} onValueChange={parentDemandId => onUpdate({ parentDemandId: parentDemandId || null })} /></label>
    </div><div className="goals-properties__references">
      {demand.participations?.map(source => <GoalParticipation key={source.id} source={source} />)}
      {demand.alignment ? <span>Goal version · {demand.alignment.revision}</span> : null}
      {demand.grounding ? <span>Report · {demand.grounding.submissionId}</span> : null}
      <span title={demand.id}>ID · {demand.id}</span>
    </div></fieldset>
  </div>
}

function GoalParticipation({ source }: { source: NonNullable<DemandProjection['participations']>[number] }) {
  const presentation = useAppStore(useShallow(state => {
    const candidates = (agentSessionPresentationIndex(state.sessions).get(source.agentSessionId) ?? []).filter(session =>
      session.hostId === source.hostId && session.control.hostId === source.hostId)
    const session = candidates.length === 1 ? candidates[0] : undefined
    return session ? { id: session.id, label: session.label, providerId: session.providerId } : null
  }))
  const userName = useAppStore(state => presentation ? state.agentNames[presentation.id] : undefined)
  const firstPrompt = useAppStore(useMemo(() => presentation ? createFirstPromptSelector(presentation.id) : () => null, [presentation?.id]))
  const name = presentation ? agentDisplayName({ userName, firstPrompt, fallbackLabel: presentation.label, providerLabel: presentation.providerId })
    : `${source.agentSessionId} · ${source.hostId} · Presentation unavailable`
  return <div><strong>{name}</strong><span>{source.kind} · {source.entryPoint} · {source.hostId}</span><span>{source.agentSessionId}</span>{source.mote ? <span>Mote · {source.mote.topicId} · {source.mote.identityDirectoryPath}</span> : null}<time dateTime={new Date(source.recordedAt).toISOString()}>{new Date(source.recordedAt).toLocaleString()}</time></div>
}
