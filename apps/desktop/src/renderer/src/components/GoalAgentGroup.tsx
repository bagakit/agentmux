import { Fragment, memo, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { AvatarGroup } from '@agentmux/client-ui/components/AvatarGroup'
import { compactReferenceId } from '@agentmux/client-ui/display-name'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { demandAgentReferenceKey, type DemandAgentReference, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { DemandProjection } from '../lib/global-demand-board'
import { agentSessionPresentationIndex, createFirstPromptSelector, sessionStatusLabel } from '../lib/session-presentation'
import { goalAgentPresentation, goalSupervisorPresentationHosts } from '../lib/goal-agent-selection'
import { agentDisplayName, topicIdForSession, workspaceForSession } from '../lib/workbench-tabs'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { agentContextForSession } from '../lib/focus-context'
import { useAgentInformationPreview } from './AgentInformationPreview'
import * as Menu from './HoverDropdownMenu'
import { useAppStore } from '../store'
import { executorAvatarAppearance, ResolvedAgentAvatar } from './AgentAvatar'
import { useWorkbenchNameTooltip, useWorkbenchTooltipFocus } from './WorkbenchNameTooltip'
import '@agentmux/client-ui/styles/avatar-group.css'
import '../styles/goal-agent-group.css'

type Subject = { id: string; hostId: string; agentSessionId: string; runId: string }
type Face = {
  key: string
  name: string | undefined
  label: string
  sessionId: string
  reference: DemandSpaceMemberReference | undefined
  roles: string
  subject: Subject | undefined
  executorId: string | undefined
  providerId: string | undefined
  appearance: ReturnType<typeof executorAvatarAppearance>
}
const ReferenceChevron = semanticIconComponent('navigation.forward')
const LOCATION_UNCONFIRMED = 'Location unconfirmed'

function createGoalAgentGroupSelector(demand: DemandProjection) {
  const assignments = new Map<string, { reference: DemandAgentReference; roles: string[] }>()
  for (const [role, refs] of [['Supervisor', demand.supervisorSessionId ? [demand.supervisorSessionId] : []], ['Executor', demand.assigneeSessionIds ?? []]] as const)
    for (const reference of refs) {
      const key = demandAgentReferenceKey(reference), original = assignments.get(key)
      assignments.set(key, { reference, roles: [...new Set([...original?.roles ?? [], role])] })
    }
  const supervisorHosts = goalSupervisorPresentationHosts(demand)
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
      const sessionId = session?.control.agentSessionId ?? (typeof reference === 'string' ? reference : reference.execution.agentSessionId)
      let name: string | undefined
      if (session) {
        const prompt = prompts.get(session.id) ?? createFirstPromptSelector(session.id); prompts.set(session.id, prompt)
        name = agentDisplayName({ userName: state.agentNames[session.id], firstPrompt: prompt(state), fallbackLabel: session.label, providerLabel: session.providerId })
      }
      const subject = session ? { id: session.id, hostId: session.control.hostId, agentSessionId: session.control.agentSessionId, runId: session.control.run.runId } : undefined
      faces.set(key, { key, name, sessionId, reference: typeof reference === 'string' ? undefined : reference, roles, subject, label: '', executorId: session?.executorId, providerId: session?.providerId, appearance: executorAvatarAppearance(state.config, session?.executorId) })
    }
    const next = [...faces.values()].map(face => {
      const roles = face.roles.join(' / ')
      const label = face.name ? `${face.name} · ${roles}` : `${roles} · Session ${memberReference(face).join(' · ')} · ${LOCATION_UNCONFIRMED}`
      const previous = held.find(item => item.key === face.key)
      return previous?.label === label && previous.providerId === face.providerId && previous.executorId === face.executorId && previous.appearance === face.appearance && previous.subject?.id === face.subject?.id && previous.subject?.runId === face.subject?.runId ? previous
        : { ...face, label, roles }
    })
    if (next.length !== held.length || next.some((face, i) => face !== held[i])) held = next
    return held
  }
}

function memberReference({ sessionId, reference }: Pick<Face, 'sessionId' | 'reference'>) {
  const id = compactReferenceId(sessionId)
  return reference ? [id, compactReferenceId(reference.source.runtimeId)] : [id]
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
function FaceAvatar({ face, size = 22 }: { face: Face; size?: number }) {
  return <ResolvedAgentAvatar label={face.name ?? face.roles} providerId={face.providerId} executorId={face.executorId} appearance={face.appearance} size={size} />
}
export function useGoalConfirmationSupervisor(demand: DemandProjection, enabled: boolean) {
  const selector = useMemo(() => createGoalAgentGroupSelector({ ...demand, assigneeSessionIds: [] }), [demand])
  const unambiguous = enabled && goalSupervisorPresentationHosts(demand).length === 1
  return useAppStore(state => {
    if (!unambiguous) return undefined
    const face = selector(state)[0]
    return face?.subject ? face : undefined
  })
}
export function GoalConfirmationSupervisorAvatar({ face }: { face: Face }) {
  const name = face.name ?? face.label
  const status = useAppStore(state => { const session = faceSession(face, state); return session ? sessionStatusLabel(session) : LOCATION_UNCONFIRMED })
  const tooltip = useWorkbenchNameTooltip(name, `Supervisor · ${status}`, false, { placement: 'top', pointerPassThrough: true })
  const anchor = useRef<HTMLSpanElement>(null)
  useWorkbenchTooltipFocus(anchor, tooltip, false, face.key)
  return <><span ref={anchor} className="goal-review__confirm-agent" data-goal-confirm-agent {...tooltip.props}>
    <FaceAvatar face={face} size={18} /><span className="goal-review__confirm-name">{name}</span>
  </span>{tooltip.content}</>
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
  const status = useAppStore(state => { const session = faceSession(face, state); return session ? sessionStatusLabel(session) : LOCATION_UNCONFIRMED })
  return <span className="goal-agent-menu__text">
    <strong>{face.name ?? face.roles}</strong>
    <small>{face.name ? face.roles : <>Session {memberReference(face).map((part, index) => <Fragment key={index}>
      {index ? ' · ' : null}<span className="goal-agent-menu__reference">{part}</span>
    </Fragment>)}</>}</small>
    <small className="goal-agent-menu__status">{status}</small>
  </span>
}
function RetainedMember({ face }: { face: Face }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId(), reference = face.reference
  return <>
    <Menu.Item className="tab-context-menu__item goal-agent-menu__member" aria-expanded={open} aria-controls={open ? detailsId : undefined}
      onSelect={event => { event.preventDefault(); setOpen(value => !value) }}>
      <FaceAvatar face={face} /><MemberText face={face} />
      <ReferenceChevron className="goal-agent-menu__chevron" size={13} aria-hidden="true" />
    </Menu.Item>
    {open ? <dl id={detailsId} className="goal-agent-menu__source">
      <div><dt>Session</dt><dd>{face.sessionId}</dd></div>
      {reference ? <>
        <div><dt>Execution runtime</dt><dd>{reference.execution.runtimeId}</dd></div>
        <div><dt>Source runtime</dt><dd>{reference.source.runtimeId}</dd></div>
        <div><dt>Space</dt><dd>{reference.source.spaceId}</dd></div>
        <div><dt>Region</dt><dd>{reference.source.regionId}</dd></div>
      </> : null}
    </dl> : null}
  </>
}
function GoalTeamMember({ face }: { face: Face }) {
  const branch = Menu.useHoverMenuBranch()
  return face.subject ? <GoalAgentButton face={face} row branch={branch} /> : <RetainedMember face={face} />
}
function GoalTeamMenu({ faces, children, className, label }: { faces: readonly Face[]; children: ReactNode; className: string; label: string }) {
  return <Menu.Root><Menu.Trigger className={className} aria-label={label} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{children}</Menu.Trigger>
    <Menu.Portal><Menu.Content className="tab-context-menu goal-agent-menu" side="bottom" align="end" sideOffset={6} collisionPadding={8}
      onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      {faces.length > 1 ? <Menu.Label className="goal-agent-menu__heading">Goal agents</Menu.Label> : null}
      {faces.map(face => <GoalTeamMember key={face.key} face={face} />)}
    </Menu.Content></Menu.Portal></Menu.Root>
}

/** Current relationship summary only: no history members, per-card RPC or inferred activity. */
export const GoalAgentGroup = memo(function GoalAgentGroup({ demand, descriptionId, board = false }: { demand: DemandProjection; descriptionId: string; board?: boolean }) {
  const selector = useMemo(() => createGoalAgentGroupSelector(demand), [demand.supervisorSessionId, demand.assigneeSessionIds, demand.creationOrigin, demand.participations, demand.plan, demand.delegations])
  const faces = useAppStore(selector)
  if (!faces.length) return board && demand.responsibility?.supervisor.state !== 'missing' ? <span className="goals-board__unassigned" data-goal-board-role>Team unassigned</span> : null
  return <span className={`goal-agent-group${board ? ' goal-agent-group--board' : ''}`} data-goal-agent-group={demand.id}><span id={descriptionId} className="goals-visually-hidden">Goal agents: {faces.map(face => face.label).join('; ')}</span>
    <GoalTeamMenu faces={faces} className="goal-agent-group__label" label="Read all Goal agents">{board
      ? faces.slice(0, 2).map(face => <span className="goals-board__member" data-goal-board-role key={face.key} title={face.label}>
          <small>{face.roles.replace('Executor', 'Assignee')}</small><span>{face.name ?? memberReference(face).join(' @ ')}</span>
        </span>) : 'Agents'}</GoalTeamMenu>
    <AvatarGroup label="Goal agents" interactive items={faces.map(face => ({ key: face.key, label: face.label,
      avatar: face.subject ? <GoalAgentButton face={face} /> : <GoalTeamMenu faces={[face]} className="goal-agent-group__avatar" label={`Read ${face.label}`}><FaceAvatar face={face} /></GoalTeamMenu> }))}
      overflow={<GoalTeamMenu faces={faces} className="goal-agent-group__overflow" label={`Read all ${faces.length} Goal agents`}>+{faces.length - 3}</GoalTeamMenu>} />
  </span>
})
