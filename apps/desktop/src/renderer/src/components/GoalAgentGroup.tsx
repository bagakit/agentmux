import { memo, useMemo } from 'react'
import { AvatarGroup } from '@agentmux/client-ui/components/AvatarGroup'
import { compactReferenceId } from '@agentmux/client-ui/display-name'
import { demandAgentReferenceKey, demandAgentReferenceLabel, goalSupervisorHostWitnesses, type DemandAgentReference } from '@agentmux/demand/relations'
import type { DemandProjection } from '../lib/global-demand-board'
import { agentSessionPresentationIndex, createFirstPromptSelector } from '../lib/session-presentation'
import { goalAgentPresentation } from '../lib/goal-agent-selection'
import { agentDisplayName } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { executorAvatarAppearance, ResolvedAgentAvatar } from './AgentAvatar'
import '@agentmux/client-ui/styles/avatar-group.css'
import '../styles/goal-agent-group.css'

type Face = { key: string; name: string; label: string; executorId: string | undefined; providerId: string | undefined; appearance: ReturnType<typeof executorAvatarAppearance> }

function createGoalAgentGroupSelector(demand: DemandProjection) {
  const assignments = new Map<string, { reference: DemandAgentReference; roles: string[] }>()
  for (const [role, refs] of [['Supervisor', demand.supervisorSessionId ? [demand.supervisorSessionId] : []], ['Executor', demand.assigneeSessionIds ?? []]] as const)
    for (const reference of refs) {
      const key = demandAgentReferenceKey(reference), original = assignments.get(key)
      assignments.set(key, { reference, roles: [...new Set([...original?.roles ?? [], role])] })
    }
  const supervisorHosts = goalSupervisorHostWitnesses(demand)
  const prompts = new Map<string, ReturnType<typeof createFirstPromptSelector>>()
  let held: readonly Face[] = []
  return (state: ReturnType<typeof useAppStore.getState>): readonly Face[] => {
    const index = agentSessionPresentationIndex(state.sessions)
    const faces = new Map<string, Face & { roles: string[]; identity: string }>()
    for (const [referenceKey, { reference, roles }] of assignments) {
      const candidates = typeof reference === 'string' ? index.get(reference) ?? [] : []
      const hosted = reference === demand.supervisorSessionId && supervisorHosts.length === 1 ? candidates.filter(session => session.control.hostId === supervisorHosts[0]) : candidates
      const session = typeof reference === 'string' ? goalAgentPresentation(hosted, reference) : undefined
      const key = session ? JSON.stringify(['actor', session.control.hostId, session.control.agentSessionId]) : referenceKey
      const original = faces.get(key)
      if (original) { original.roles = [...new Set([...original.roles, ...roles])]; continue }
      let name = compactReferenceId(typeof reference === 'string' ? reference : reference.execution.agentSessionId)
      if (session) {
        const prompt = prompts.get(session.id) ?? createFirstPromptSelector(session.id); prompts.set(session.id, prompt)
        name = agentDisplayName({ userName: state.agentNames[session.id], firstPrompt: prompt(state), fallbackLabel: session.label, providerLabel: session.providerId })
      }
      const identity = session ? `${session.control.agentSessionId} · Host ${session.control.hostId}` : `${demandAgentReferenceLabel(reference)}${typeof reference === 'string' ? '' : ` · Source ${reference.source.runtimeId} · Region ${reference.source.regionId}`} · Current presentation unconfirmed`
      faces.set(key, { key, name, identity, roles, label: '', executorId: session?.executorId, providerId: session?.providerId, appearance: executorAvatarAppearance(state.config, session?.executorId) })
    }
    const next = [...faces.values()].map(face => {
      const label = `${face.name} · ${face.roles.join(' / ')} · ${face.identity}`
      const previous = held.find(item => item.key === face.key)
      return previous?.label === label && previous.providerId === face.providerId && previous.executorId === face.executorId && previous.appearance === face.appearance ? previous
        : { key: face.key, name: face.name, label, providerId: face.providerId, executorId: face.executorId, appearance: face.appearance }
    })
    if (next.length !== held.length || next.some((face, i) => face !== held[i])) held = next
    return held
  }
}

/** Current relationship summary only: no history members, per-card RPC or inferred activity. */
export const GoalAgentGroup = memo(function GoalAgentGroup({ demand, descriptionId }: { demand: DemandProjection; descriptionId: string }) {
  const selector = useMemo(() => createGoalAgentGroupSelector(demand), [demand.supervisorSessionId, demand.assigneeSessionIds, demand.creationOrigin, demand.participations, demand.plan, demand.delegations])
  const faces = useAppStore(selector)
  if (!faces.length) return null
  return <span className="goal-agent-group" data-goal-agent-group={demand.id}><span id={descriptionId} className="goals-visually-hidden">Goal agents: {faces.map(face => face.label).join('; ')}</span><span className="goal-agent-group__label">Agents</span><AvatarGroup label="Goal agents" items={faces.map(face => ({ key: face.key, label: face.label,
    avatar: <ResolvedAgentAvatar label={face.name} providerId={face.providerId} executorId={face.executorId} appearance={face.appearance} size={22} /> }))} /></span>
})
