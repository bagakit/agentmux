import { AgentMuxError } from '@agentmux/core/control'
import type { AgentMuxAgentSession, AgentMuxSpatialStateStore } from '@agentmux/core'
import type { AgentMuxSpatialGraph, SpatialJson } from '@agentmux/core/spatial-graph'

export type GoalDiscussionBinding = {
  schema: 'agentmux.goal-discussion-binding.v1'
  tabId: string
  regionId: string
  recipient: { kind: 'agent'; hostId: string; agentSessionId: string } | { kind: 'launcher' }
}
export type GoalDiscussionHandoff = { goalId: string; binding: GoalDiscussionBinding }
export type GoalDiscussionBindingReceipt = Awaited<ReturnType<AgentMuxSpatialStateStore['commitOwnedResource']>>
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && !!value && !value.includes('\0')
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const unconfirmed = (message: string): never => { throw new AgentMuxError(message + ' The original Goal, workface and Session are retained.', 'GOAL_DISCUSSION_UNCONFIRMED') }

export function goalDiscussionBindingKey(goalId: string): string {
  if (!id(goalId)) return unconfirmed('An exact original Goal ID is required.')
  return 'owned:goal-discussion:' + goalId
}
export function parseGoalDiscussionBinding(value: unknown): GoalDiscussionBinding {
  if (!object(value) || !exact(value, ['schema', 'tabId', 'regionId', 'recipient']) || value.schema !== 'agentmux.goal-discussion-binding.v1' ||
      !id(value.tabId) || !id(value.regionId) || !object(value.recipient)) return unconfirmed('The saved discussion binding is unreadable.')
  const recipient = value.recipient
  if (recipient.kind === 'launcher' && exact(recipient, ['kind'])) return { schema: 'agentmux.goal-discussion-binding.v1', tabId: value.tabId, regionId: value.regionId, recipient: { kind: 'launcher' } }
  if (recipient.kind === 'agent' && exact(recipient, ['kind', 'hostId', 'agentSessionId']) && id(recipient.hostId) && id(recipient.agentSessionId))
    return { schema: 'agentmux.goal-discussion-binding.v1', tabId: value.tabId, regionId: value.regionId, recipient: { kind: 'agent', hostId: recipient.hostId, agentSessionId: recipient.agentSessionId } }
  return unconfirmed('The original discussion recipient is unconfirmed.')
}
export function readGoalDiscussionBinding(graph: AgentMuxSpatialGraph, goalId: string): GoalDiscussionBinding | null {
  const value = graph.resources[goalDiscussionBindingKey(goalId)]
  return value === undefined ? null : parseGoalDiscussionBinding(value)
}
const noGoals: readonly string[] = []
export type GoalDiscussionLauncherReference = { goalId: string; binding: GoalDiscussionBinding }
const indexes = new WeakMap<AgentMuxSpatialGraph['resources'], { recipients: Map<string, readonly string[]>; sessions: Map<string, readonly string[]>; launchers: Map<string, readonly GoalDiscussionLauncherReference[]> }>()
function bindingIndex(graph: AgentMuxSpatialGraph) {
  let index = indexes.get(graph.resources)
  if (!index) {
    const recipients = new Map<string, string[]>(), sessions = new Map<string, string[]>(), launchers = new Map<string, GoalDiscussionLauncherReference[]>()
    for (const [key, value] of Object.entries(graph.resources)) {
      if (!key.startsWith('owned:goal-discussion:')) continue
      let binding: GoalDiscussionBinding
      try { binding = parseGoalDiscussionBinding(value) } catch { continue }
      const goalId = key.slice('owned:goal-discussion:'.length)
      if (binding.recipient.kind === 'launcher') {
        const address = JSON.stringify([binding.tabId, binding.regionId])
        launchers.set(address, [...launchers.get(address) ?? [], { goalId, binding }]); continue
      }
      const recipient = binding.recipient
      const target = JSON.stringify([binding.tabId, binding.regionId, recipient.hostId, recipient.agentSessionId])
      recipients.set(target, [...recipients.get(target) ?? [], goalId])
      const session = JSON.stringify([recipient.hostId, recipient.agentSessionId])
      sessions.set(session, [...sessions.get(session) ?? [], JSON.stringify([goalId, binding.tabId, binding.regionId])])
    }
    index = { recipients, sessions, launchers }; indexes.set(graph.resources, index)
  }
  return index
}
/** Immutable reverse projection; unrelated Runtime output does not scan Goal relations. */
export function goalDiscussionGoalsForRecipient(graph: AgentMuxSpatialGraph | null, target: {
  tabId?: string; regionId?: string; hostId: string; agentSessionId: string
}): readonly string[] {
  return graph ? bindingIndex(graph).recipients.get(JSON.stringify([target.tabId, target.regionId, target.hostId, target.agentSessionId])) ?? noGoals : noGoals
}
/** Only a notification fingerprint; canonical records remain in the same Core graph. */
export function goalDiscussionSessionBindings(graph: AgentMuxSpatialGraph | null, hostId: string, agentSessionId: string): readonly string[] {
  return graph ? bindingIndex(graph).sessions.get(JSON.stringify([hostId, agentSessionId])) ?? noGoals : noGoals
}
/** The saved recipient never follows a later occupant of the same Region. */
export function resolveGoalDiscussionBinding(graph: AgentMuxSpatialGraph, binding: GoalDiscussionBinding) {
  const tab = graph.tabs.find(tab => tab.tabId === binding.tabId)
  const region = graph.regions.find(region => region.tabId === binding.tabId && region.regionId === binding.regionId)
  if (!tab || !tab.regionIds.includes(binding.regionId) || !region) return unconfirmed('The original discussion workface is unavailable.')
  if (binding.recipient.kind === 'launcher') {
    if (region.kind !== 'launcher' || region.agentSessionId !== null) return unconfirmed('The original discussion launcher changed; its saved reference was not reassigned.')
  } else if (region.kind !== 'agent' || region.agentSessionId !== binding.recipient.agentSessionId || region.execution?.hostId !== binding.recipient.hostId)
    return unconfirmed('The current Region does not confirm the saved discussion Session and execution Host.')
  return { tab, region }
}
/** A producer ACK always comes from the original locked durable write, including equal values. */
export async function contributeGoalDiscussionBinding(input: {
  spatial: Pick<AgentMuxSpatialStateStore, 'read' | 'commitOwnedResource'>
  goalId: string
  binding: GoalDiscussionBinding
}): Promise<GoalDiscussionBindingReceipt> {
  const binding = parseGoalDiscussionBinding(input.binding), state = await input.spatial.read()
  if (!state) return unconfirmed('The original Core spatial document is unavailable.')
  resolveGoalDiscussionBinding(state.graph, binding)
  const original = readGoalDiscussionBinding(state.graph, input.goalId)
  if (original && JSON.stringify(original) !== JSON.stringify(binding)) return unconfirmed('This Goal already retains a different original discussion binding.')
  return input.spatial.commitOwnedResource({ key: goalDiscussionBindingKey(input.goalId), expectedRevision: state.revision, value: binding as unknown as SpatialJson })
}

/** A derived lookup for the trusted original Launcher producer, not a new binding owner. */
export function goalDiscussionLaunchersForRegion(graph: AgentMuxSpatialGraph, tabId: string, regionId: string): readonly GoalDiscussionLauncherReference[] {
  return bindingIndex(graph).launchers.get(JSON.stringify([tabId, regionId])) ?? []
}

/** The original creation producer confirms its exact captured Launcher and actual Core receipt. */
export async function confirmGoalDiscussionLauncher(input: {
  spatial: Parameters<typeof contributeGoalDiscussionBinding>[0]['spatial']
  original: GoalDiscussionLauncherReference
  agent: AgentMuxAgentSession
  hostId: string
  agentSessionId: string
  createOperationId: string
  workspaceId: string
}): Promise<GoalDiscussionBindingReceipt> {
  const { agent, original } = input, creation = agent.creation
  if (original.binding.recipient.kind !== 'launcher' || agent.kind !== 'agent' || agent.agentSessionId !== input.agentSessionId || agent.hostId !== input.hostId ||
      creation?.createOperationId !== input.createOperationId || !creation.createdRun || !id(input.hostId) || !id(input.workspaceId) || !id(agent.workspacePath))
    return unconfirmed('The explicit Launcher creation and its actual Core receipt are unconfirmed.')
  const state = await input.spatial.read()
  if (!state) return unconfirmed('The original Core spatial document is unavailable.')
  const binding: GoalDiscussionBinding = { ...original.binding, recipient: { kind: 'agent', hostId: input.hostId, agentSessionId: agent.agentSessionId } }
  const saved = readGoalDiscussionBinding(state.graph, original.goalId)
  if (!saved || JSON.stringify(saved) !== JSON.stringify(original.binding) && JSON.stringify(saved) !== JSON.stringify(binding))
    return unconfirmed('The original discussion Launcher binding changed before confirmation.')
  // One Core lock publishes the original position and canonical recipient together. No new
  // creation record, input acknowledgement or Goal participation is inferred from this binding.
  return input.spatial.commitOwnedResource({ key: goalDiscussionBindingKey(original.goalId), expectedRevision: state.revision, value: binding as unknown as SpatialJson,
    agentRegion: { tabId: binding.tabId, regionId: binding.regionId, agentSessionId: agent.agentSessionId, runId: agent.run.runId,
      execution: { hostId: input.hostId, cwd: agent.workspacePath }, resource: { workspaceId: input.workspaceId, phase: 'attached',
        agentPresentation: { sessionId: agent.agentSessionId, agentSessionId: agent.agentSessionId, hostId: input.hostId } } } })
}
