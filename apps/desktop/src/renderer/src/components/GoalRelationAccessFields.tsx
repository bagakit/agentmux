import type { GoalRelationAccess, GoalRuntimeAccess, GoalInspectionAccess } from '@agentmux/core/control'
import { demandAgentReferenceKey, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { HostConfig } from '../../../shared/contracts'
import { SelectionField } from './SelectionField'
import { useEffect, useRef, useState } from 'react'
import type { HostRouteChoices } from '@agentmux/core/host-route'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'

/** This edit chooses a carrier, never an actor or a grant. Save checks its owner. */
type RelationFields = { purpose?: 'relation'; references: DemandSpaceMemberReference[]; hosts: readonly HostConfig[]; accesses: GoalRelationAccess[]
  disabled: boolean; onChange(value: GoalRelationAccess[]): void }
type InputFields = { purpose: 'input'; reference: DemandSpaceMemberReference; hosts: readonly HostConfig[]; access: GoalInspectionAccess | undefined
  original: boolean; disabled: boolean; onChange(value: GoalInspectionAccess): void }
export function GoalRelationAccessFields(props: RelationFields | InputFields) {
  if (props.purpose === 'input') return <GoalInputConnections {...props} />
  return <GoalRelationshipConnections {...props} />
}
function GoalRelationshipConnections({ references, hosts, accesses, disabled, onChange }: RelationFields) {
  const groups = new Map<string, DemandSpaceMemberReference[]>()
  for (const reference of references) {
    const key = JSON.stringify([reference.source.runtimeId, reference.source.spaceId])
    groups.set(key, [...groups.get(key) ?? [], reference])
  }
  return [...groups].map(([key, members]) => <GoalProjectConnection key={key} members={members} hosts={hosts} accesses={accesses} disabled={disabled} onChange={onChange} />)
}
function GoalProjectConnection({ members, hosts, accesses, disabled, onChange }: {
  members: DemandSpaceMemberReference[]; hosts: readonly HostConfig[]; accesses: GoalRelationAccess[]
  disabled: boolean; onChange(value: GoalRelationAccess[]): void
}) {
    const source = members[0]!.source, keys = new Set(members.map(demandAgentReferenceKey))
    const original = accesses.filter(value => keys.has(demandAgentReferenceKey(value.reference)))
    const retained = new Map(original.map(value => [JSON.stringify(value.access.source), value.access.source]))
    const selected = retained.size === 1 && original.length === members.length ? [...retained.keys()][0]! : ''
    return <><GoalCarrierConnection runtimeId={source.runtimeId} hosts={hosts} values={[...retained.values()]} selected={selected}
      title="Project connection" label={`Project connection for ${source.spaceId}`} routeNoun="project" disabled={disabled}
      empty={retained.size > 1 ? 'Review the different retained routes…' : 'Choose a saved device…'}
      onChange={value => onChange([...accesses.filter(value => !keys.has(demandAgentReferenceKey(value.reference))), ...members.map(reference => ({ reference,
        access: { ...original.find(value => demandAgentReferenceKey(value.reference) === demandAgentReferenceKey(reference))?.access, source: value } }))])} />
      <details className="goal-team__identity-details"><summary>Original project reference</summary><code>{JSON.stringify({ runtimeId: source.runtimeId, spaceId: source.spaceId })}</code></details></>
}
function GoalInputConnections({ reference, hosts, access, original, disabled, onChange }: InputFields) {
  const external = reference.source.admission.kind === 'association'
  return <><GoalCarrierConnection runtimeId={reference.source.runtimeId} hosts={hosts} values={access?.source ? [access.source] : []}
    selected={access?.source ? JSON.stringify(access.source) : ''} title="Project connection" label={`Project connection for ${reference.source.spaceId}`}
    routeNoun="project" empty="Choose a saved device…" disabled={disabled} input onChange={source => onChange({ ...access, source })} />
    {external || original ? <><GoalCarrierConnection runtimeId={reference.execution.runtimeId} hosts={hosts} values={access?.coordinator ? [access.coordinator] : []}
      selected={access?.coordinator ? JSON.stringify(access.coordinator) : ''} title="Agent connection" label={`Coordinator connection for ${reference.execution.runtimeId}`}
      routeNoun="Coordinator" empty="Choose an independent saved device…" disabled={disabled} input onChange={coordinator => onChange({ ...access, coordinator })} />
      {!external ? <><small>Checking can use the Agent connection; continuing also needs project access.</small>
        {access?.coordinator && access.source ? <button type="button" className="small-button" disabled={disabled} onClick={() => onChange({ source: access.source! })}>Use project connection for Check</button> : null}</> : <small>Project access alone cannot control this Agent.</small>}</> : null}</>
}
function GoalCarrierConnection({ runtimeId, hosts, values, selected, title, label, routeNoun, empty, disabled, input = false, onChange }: {
  runtimeId: string; hosts: readonly HostConfig[]; values: GoalRuntimeAccess[]; selected: string; title: string; label: string
  routeNoun: string; empty: string; disabled: boolean; input?: boolean; onChange(value: GoalRuntimeAccess): void
}) {
    const choices = new Map<string, { value: GoalRuntimeAccess; label: string }>()
    for (const host of hosts) choices.set(JSON.stringify({ hostId: host.id }), { value: { hostId: host.id }, label: host.label || host.id })
    const retained = new Map(values.map(value => [JSON.stringify(value), value]))
    for (const [id, value] of retained) if (!choices.has(id)) choices.set(id, { value, label: value.via ? `Saved prefix ${value.via.routeId}` : `Saved device ${value.hostId}` })
    const carrier = selected ? choices.get(selected)?.value.hostId : undefined, host = hosts.find(host => host.id === carrier)
    const scope = JSON.stringify([runtimeId, carrier, host])
    const reader = useRef<AbortController | undefined>(undefined), current = useRef(scope); current.current = scope
    const [reading, setReading] = useState(false), [read, setRead] = useState<{ scope: string; result?: HostRouteChoices; issue?: string }>()
    useEffect(() => { setReading(false); return () => reader.current?.abort() }, [scope])
    async function readRoutes() {
      if (!carrier || disabled) return
      reader.current?.abort(); const controller = new AbortController(); reader.current = controller
      setReading(true)
      try {
        const identity = await api.hostRoutes.call({ hostId: carrier, ...(host?.kind === 'ssh' && host.runtimeId ? { expectedRuntimeId: host.runtimeId } : {}) }, 'route.identity', {}, controller.signal)
        controller.signal.throwIfAborted()
        const result = await api.spaceMounts.call('routeChoices', { hostId: carrier, expectedRuntimeId: identity.runtimeId }, controller.signal)
        if (!controller.signal.aborted && current.current === scope) setRead({ scope, result })
      } catch (cause) { if (!controller.signal.aborted && current.current === scope) setRead({ scope, issue: presentError(cause) }) }
      finally { if (!controller.signal.aborted && current.current === scope) setReading(false) }
    }
    const discovery = read?.scope === scope ? read : undefined
    for (const route of discovery?.result?.routes ?? []) {
      if (route.agentTarget.runtimeId !== runtimeId) continue
      const value: GoalRuntimeAccess = { hostId: carrier!, via: { routeId: route.id, adoptedRoute: route.agentTarget.adoptedRoute } }
      choices.set(JSON.stringify(value), { value, label: `${route.id} · Saved ${routeNoun} route` })
    }
    return <div className="goal-agent-picker__locations"><strong>{title}</strong>
      <SelectionField label={label} value={selected} disabled={disabled}
        options={[{ value: '', label: empty, disabled: true }, ...[...choices].map(([value, item]) => ({ value, label: item.label }))]}
        onValueChange={id => {
          const choice = choices.get(id)
          if (!choice) return
          onChange(choice.value)
        }} />
      <button type="button" className="small-button" disabled={disabled || !carrier || reading} onClick={() => void readRoutes()}>{reading ? 'Reading saved routes…' : `Read saved ${routeNoun} routes`}</button>
      {discovery?.issue ? <p role="status">{discovery.issue}</p> : discovery?.result ? <small>{discovery.result.routes.some(route => route.agentTarget.runtimeId === runtimeId)
        ? `Choose a saved route above. Its access is checked ${input ? 'for each requested action' : 'when saving'}.` : `No saved route on this device ends at the original ${routeNoun}.`}</small> : null}
    </div>
}
