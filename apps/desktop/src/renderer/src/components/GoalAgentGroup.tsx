import { memo, useMemo, type ReactNode } from 'react'
import { AvatarGroup } from '@agentmux/client-ui/components/AvatarGroup'
import { compactReferenceId } from '@agentmux/client-ui/display-name'
import { demandAgentReferenceKey, demandAgentReferenceLabel, goalSupervisorHostWitnesses, type DemandAgentReference } from '@agentmux/demand/relations'
import type { DemandProjection } from '../lib/global-demand-board'
import { agentSessionPresentationIndex, createFirstPromptSelector, sessionStatusLabel } from '../lib/session-presentation'
import { goalAgentPresentation } from '../lib/goal-agent-selection'
import { agentDisplayName, topicIdForSession, workspaceForSession } from '../lib/workbench-tabs'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { agentContextForSession } from '../lib/focus-context'
import { useAgentInformationPreview } from './AgentInformationPreview'
import * as Menu from './HoverDropdownMenu'
import { useAppStore } from '../store'
import { executorAvatarAppearance, ResolvedAgentAvatar } from './AgentAvatar'
import '@agentmux/client-ui/styles/avatar-group.css'
import '../styles/goal-agent-group.css'

type Subject = { id: string; hostId: string; agentSessionId: string; runId: string }
type Face = { key: string; name: string; label: string; identity: string; roles: string; subject: Subject | undefined; executorId: string | undefined; providerId: string | undefined; appearance: ReturnType<typeof executorAvatarAppearance> }

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
    const faces = new Map<string, Omit<Face, 'roles'> & { roles: string[] }>()
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
      const subject = session ? { id: session.id, hostId: session.control.hostId, agentSessionId: session.control.agentSessionId, runId: session.control.run.runId } : undefined
      faces.set(key, { key, name, identity, roles, subject, label: '', executorId: session?.executorId, providerId: session?.providerId, appearance: executorAvatarAppearance(state.config, session?.executorId) })
    }
    const next = [...faces.values()].map(face => {
      const label = `${face.name} · ${face.roles.join(' / ')} · ${face.identity}`
      const previous = held.find(item => item.key === face.key)
      return previous?.label === label && previous.providerId === face.providerId && previous.executorId === face.executorId && previous.appearance === face.appearance && previous.subject?.id === face.subject?.id && previous.subject?.runId === face.subject?.runId ? previous
        : { key: face.key, name: face.name, label, identity: face.identity, roles: face.roles.join(' / '), subject: face.subject, providerId: face.providerId, executorId: face.executorId, appearance: face.appearance }
    })
    if (next.length !== held.length || next.some((face, i) => face !== held[i])) held = next
    return held
  }
}

/** Resolve only the exact held presentation; no local namesake or unrelated timeline reading. */
function faceSession(face: Face, state = useAppStore.getState()) {
  const subject = face.subject
  return subject ? agentSessionPresentationIndex(state.sessions).get(subject.id)?.find(session => session.kind === 'agent' && session.id === subject.id && session.control.hostId === subject.hostId &&
    session.hostId === subject.hostId && session.control.agentSessionId === subject.agentSessionId && session.control.run.runId === subject.runId) : undefined
}
function faceContext(face: Face) {
  const state = useAppStore.getState(), session = faceSession(face, state)
  if (!session) return
  const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)
  return agentContextForSession(session, state.timelines[session.id], state.agentNames[session.id], workspaceForSession(state.config, session, topics), topicIdForSession(state.config, session, topics))
}
function FaceAvatar({ face }: { face: Face }) {
  return <ResolvedAgentAvatar label={face.name} providerId={face.providerId} executorId={face.executorId} appearance={face.appearance} size={22} />
}
function GoalAgentButton({ face, row = false, branch }: { face: Face; row?: boolean; branch?: ReturnType<typeof Menu.useHoverMenuBranch> }) {
  const preview = useAgentInformationPreview(undefined, true, undefined, undefined, () => { useAppStore.getState().selectSession(face.subject!.id) },
    { resolveContext: () => faceContext(face), ...(branch ? { readingKey: 'ArrowRight' as const, readingBranch: branch } : {}) })
  const button = <button ref={preview.anchor} type="button" className={row ? 'tab-context-menu__item goal-agent-menu__member' : 'goal-agent-group__avatar'}
    aria-label={`Read ${face.label}`} aria-describedby={preview.describedBy} {...preview.triggerEvents}
    onPointerDown={event => { event.stopPropagation() }}
    onClick={event => { event.stopPropagation(); branch?.enterKeyboard(); preview.read() }}
    onKeyDown={event => { event.stopPropagation(); preview.triggerEvents.onKeyDown(event); if (event.defaultPrevented) branch?.enterKeyboard() }}>
    <FaceAvatar face={face} />{row ? <MemberText face={face} /> : null}
  </button>
  return row ? <Menu.Item asChild onSelect={event => event.preventDefault()}>{button}</Menu.Item> : button
}
function MemberText({ face }: { face: Face }) {
  const status = useAppStore(state => { const session = faceSession(face, state); return session ? sessionStatusLabel(session) : 'Current presentation unconfirmed' })
  return <span className="goal-agent-menu__text"><strong>{face.name}</strong><small>{face.roles} · {status}</small><small className="goal-agent-menu__identity">{face.identity}</small></span>
}
function GoalTeamMember({ face }: { face: Face }) {
  const branch = Menu.useHoverMenuBranch()
  return face.subject ? <GoalAgentButton face={face} row branch={branch} />
    : <Menu.Label className="goal-agent-menu__member"><FaceAvatar face={face} /><MemberText face={face} /></Menu.Label>
}
function GoalTeamMenu({ faces, children, className, label }: { faces: readonly Face[]; children: ReactNode; className: string; label: string }) {
  return <Menu.Root><Menu.Trigger className={className} aria-label={label} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{children}</Menu.Trigger>
    <Menu.Portal><Menu.Content className="tab-context-menu goal-agent-menu" side="bottom" align="end" sideOffset={6} collisionPadding={8}
      onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <Menu.Label className="goal-agent-menu__heading">{faces.length === 1 ? 'Goal agent' : `Goal agents · ${faces.length}`}</Menu.Label>
      {faces.map(face => <GoalTeamMember key={face.key} face={face} />)}
    </Menu.Content></Menu.Portal></Menu.Root>
}

/** Current relationship summary only: no history members, per-card RPC or inferred activity. */
export const GoalAgentGroup = memo(function GoalAgentGroup({ demand, descriptionId }: { demand: DemandProjection; descriptionId: string }) {
  const selector = useMemo(() => createGoalAgentGroupSelector(demand), [demand.supervisorSessionId, demand.assigneeSessionIds, demand.creationOrigin, demand.participations, demand.plan, demand.delegations])
  const faces = useAppStore(selector)
  if (!faces.length) return null
  return <span className="goal-agent-group" data-goal-agent-group={demand.id}><span id={descriptionId} className="goals-visually-hidden">Goal agents: {faces.map(face => face.label).join('; ')}</span>
    <GoalTeamMenu faces={faces} className="goal-agent-group__label" label="Read all Goal agents">Agents</GoalTeamMenu>
    <AvatarGroup label="Goal agents" interactive items={faces.map(face => ({ key: face.key, label: face.label,
      avatar: face.subject ? <GoalAgentButton face={face} /> : <GoalTeamMenu faces={[face]} className="goal-agent-group__avatar" label={`Read ${face.label}`}><FaceAvatar face={face} /></GoalTeamMenu> }))}
      overflow={<GoalTeamMenu faces={faces} className="goal-agent-group__overflow" label={`Read all ${faces.length} Goal agents`}>+{faces.length - 3}</GoalTeamMenu>} />
  </span>
})
