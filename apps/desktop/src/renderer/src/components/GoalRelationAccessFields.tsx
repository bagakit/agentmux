import type { GoalRelationAccess, GoalRuntimeAccess } from '@agentmux/core/control'
import { demandAgentReferenceKey, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { HostConfig } from '../../../shared/contracts'
import { SelectionField } from './SelectionField'
import { useEffect, useRef, useState } from 'react'
import type { HostRouteChoices } from '@agentmux/core/host-route'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'

/** This edit chooses a carrier, never an actor or a grant. Save checks its owner. */
export function GoalRelationAccessFields({ references, hosts, accesses, disabled, onChange }: {
  references: DemandSpaceMemberReference[]; hosts: readonly HostConfig[]; accesses: GoalRelationAccess[]
  disabled: boolean; onChange(value: GoalRelationAccess[]): void
}) {
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
    const choices = new Map<string, { value: GoalRuntimeAccess; label: string }>()
    for (const host of hosts) choices.set(JSON.stringify({ hostId: host.id }), { value: { hostId: host.id }, label: host.label || host.id })
    for (const [id, value] of retained) if (!choices.has(id)) choices.set(id, { value, label: value.via ? `Saved prefix ${value.via.routeId}` : `Saved device ${value.hostId}` })
    const carrier = selected ? choices.get(selected)?.value.hostId : undefined, host = hosts.find(host => host.id === carrier)
    const scope = JSON.stringify([source.runtimeId, source.spaceId, carrier, host])
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
      if (route.agentTarget.runtimeId !== source.runtimeId) continue
      const value: GoalRuntimeAccess = { hostId: carrier!, via: { routeId: route.id, adoptedRoute: route.agentTarget.adoptedRoute } }
      choices.set(JSON.stringify(value), { value, label: `${route.id} · Saved project route` })
    }
    return <div className="goal-agent-picker__locations"><strong>Project connection</strong>
      <SelectionField label={`Project connection for ${source.spaceId}`} value={selected} disabled={disabled}
        options={[{ value: '', label: retained.size > 1 ? 'Review the different retained routes…' : 'Choose a saved device…', disabled: true }, ...[...choices].map(([value, item]) => ({ value, label: item.label }))]}
        onValueChange={id => {
          const choice = choices.get(id)
          if (!choice) return
          onChange([...accesses.filter(value => !keys.has(demandAgentReferenceKey(value.reference))), ...members.map(reference => ({ reference,
            access: { ...original.find(value => demandAgentReferenceKey(value.reference) === demandAgentReferenceKey(reference))?.access, source: choice.value } }))])
        }} />
      <button type="button" className="small-button" disabled={disabled || !carrier || reading} onClick={() => void readRoutes()}>{reading ? 'Reading saved routes…' : 'Read saved project routes'}</button>
      {discovery?.issue ? <p role="status">{discovery.issue}</p> : discovery?.result ? <small>{discovery.result.routes.some(route => route.agentTarget.runtimeId === source.runtimeId)
        ? 'Choose a saved route above. Its access is checked when saving.' : 'No saved route on this device ends at the original project.'}</small> : null}
      <details className="goal-team__identity-details"><summary>Original project reference</summary><code>{JSON.stringify({ runtimeId: source.runtimeId, spaceId: source.spaceId })}</code></details>
    </div>
}
