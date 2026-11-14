import type { GoalRelationAccess, GoalRuntimeAccess } from '@agentmux/core/control'
import { demandAgentReferenceKey, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { HostConfig } from '../../../shared/contracts'
import { SelectionField } from './SelectionField'

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
  return [...groups].map(([key, members]) => {
    const source = members[0]!.source, keys = new Set(members.map(demandAgentReferenceKey))
    const original = accesses.filter(value => keys.has(demandAgentReferenceKey(value.reference)))
    const retained = new Map(original.map(value => [JSON.stringify(value.access.source), value.access.source]))
    const selected = retained.size === 1 && original.length === members.length ? [...retained.keys()][0]! : ''
    const choices = new Map<string, { value: GoalRuntimeAccess; label: string }>()
    for (const host of hosts) choices.set(JSON.stringify({ hostId: host.id }), { value: { hostId: host.id }, label: host.label || host.id })
    for (const [id, value] of retained) if (!choices.has(id)) choices.set(id, { value, label: value.via ? `Saved prefix ${value.via.routeId}` : `Saved device ${value.hostId}` })
    return <div className="goal-agent-picker__locations" key={key}><strong>Project connection</strong>
      <SelectionField label={`Project connection for ${source.spaceId}`} value={selected} disabled={disabled}
        options={[{ value: '', label: retained.size > 1 ? 'Review the different retained routes…' : 'Choose a saved device…', disabled: true }, ...[...choices].map(([value, item]) => ({ value, label: item.label }))]}
        onValueChange={id => {
          const choice = choices.get(id)
          if (!choice) return
          onChange([...accesses.filter(value => !keys.has(demandAgentReferenceKey(value.reference))), ...members.map(reference => ({ reference,
            access: { ...original.find(value => demandAgentReferenceKey(value.reference) === demandAgentReferenceKey(reference))?.access, source: choice.value } }))])
        }} />
      <details className="goal-team__identity-details"><summary>Original project reference</summary><code>{JSON.stringify({ runtimeId: source.runtimeId, spaceId: source.spaceId })}</code></details>
    </div>
  })
}
