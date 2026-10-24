import { spatialAgentOpenRecord } from '@agentmux/core/spatial-state'
import { AgentMuxError, type AgentMuxAgentSession } from '@agentmux/core'
import { confirmSpatialGoalDiscussionLauncher } from '@agentmux/host/goal-discussion-launcher'
import { confirmGoalDiscussionLauncher, goalDiscussionLaunchersForRegion, readGoalDiscussionBinding, contributeGoalDiscussionBinding, parseGoalDiscussionBinding, resolveGoalDiscussionBinding,
  type GoalDiscussionHandoff } from '@agentmux/host/goal-discussion-bindings'

/** Called only after the original Desktop sender has been authenticated by Main. */
export async function handoffGoalDiscussion(input: GoalDiscussionHandoff, ports: {
  spatial: Parameters<typeof contributeGoalDiscussionBinding>[0]['spatial']
  goal(goalId: string): Promise<{ id: string; discussionOperationId?: string } | null>
  agent(hostId: string, agentSessionId: string): Promise<AgentMuxAgentSession>
}) {
  if (!input || Object.keys(input).some(key => key !== 'goalId' && key !== 'binding') || typeof input.goalId !== 'string' || !input.goalId || input.goalId.includes('\0'))
    throw new AgentMuxError('The original saved Goal discussion reference is invalid.', 'INVALID_CONTROL_REQUEST')
  let binding = parseGoalDiscussionBinding(input.binding)
  const goal = await ports.goal(input.goalId); let state = await ports.spatial.read()
  if (goal?.id !== input.goalId || !state) throw new AgentMuxError('The original Goal or Core workface is unconfirmed. Its saved Desktop relationship is retained.', 'GOAL_DISCUSSION_UNCONFIRMED')
  let canonical = readGoalDiscussionBinding(state.graph, input.goalId)
  if (canonical?.recipient.kind === 'launcher' && canonical.tabId === binding.tabId && canonical.regionId === binding.regionId) {
    const confirmed = await confirmSpatialGoalDiscussionLauncher({ spatial: ports.spatial,
      original: { goalId: input.goalId, binding: canonical }, agent: ports.agent })
    if (confirmed) { state = confirmed.state; canonical = readGoalDiscussionBinding(state.graph, input.goalId) }
  }
  if (binding.recipient.kind === 'launcher' && canonical?.recipient.kind === 'agent' && canonical.tabId === binding.tabId && canonical.regionId === binding.regionId) binding = canonical
  resolveGoalDiscussionBinding(state.graph, binding)
  if (goal.discussionOperationId) {
    const creation = spatialAgentOpenRecord(state.graph, goal.discussionOperationId)
    if (!creation || binding.recipient.kind !== 'agent' || creation.address.tabId !== binding.tabId || creation.address.regionId !== binding.regionId ||
        creation.execution.hostId !== binding.recipient.hostId || creation.agentSessionId !== binding.recipient.agentSessionId)
      throw new AgentMuxError('The saved Desktop discussion conflicts with this Goal’s original Host creation. Both sources are retained for review.', 'GOAL_DISCUSSION_UNCONFIRMED')
  }
  if (binding.recipient.kind === 'agent') {
    const agent = await ports.agent(binding.recipient.hostId, binding.recipient.agentSessionId)
    if (agent.kind !== 'agent' || agent.agentSessionId !== binding.recipient.agentSessionId)
      throw new AgentMuxError('The exact original discussion Session is unconfirmed on its execution Host. Its saved relationship is retained.', 'GOAL_DISCUSSION_UNCONFIRMED')
  }
  return contributeGoalDiscussionBinding({ spatial: ports.spatial, goalId: input.goalId, binding })
}

/** Called by the authenticated Desktop creation consumer; never accepted from public JSON. */
export function launcherCreationSpatialIntent(input: import('../shared/contracts.js').AgentLaunchInput, workspaces: import('../shared/contracts.js').AppConfig['workspaces']): import('@agentmux/core').AgentMuxAgentCreationSpatialIntent | undefined {
  if (!input.launcher) return undefined
  const address = input.launcher
  if (Object.keys(address).some(key => key !== 'tabId' && key !== 'regionId') ||
      ![address.tabId, address.regionId].every(value => typeof value === 'string' && !!value && !value.includes('\0')))
    throw new AgentMuxError('An exact original Launcher position is required.', 'INVALID_CONTROL_REQUEST')
  const matches = workspaces.filter(workspace => workspace.hostId === input.hostId && workspace.path === input.workspacePath &&
    (input.executionWorkspaceId === undefined || workspace.id === input.executionWorkspaceId))
  return matches.length === 1 ? { ...address, executionWorkspaceId: matches[0]!.id } : undefined
}

/** Captured by the authenticated original native creation call before it enters Runtime. */
export async function captureGoalDiscussionLauncherLaunch(input: import('../shared/contracts.js').AgentLaunchInput, ports: {
  spatial: Parameters<typeof contributeGoalDiscussionBinding>[0]['spatial']
  workspaces: import('../shared/contracts.js').AppConfig['workspaces']
}) {
  if (!input.launcher) return null
  const address = input.launcher, spatialIntent = launcherCreationSpatialIntent(input, ports.workspaces)
  let state: Awaited<ReturnType<typeof ports.spatial.read>>
  try { state = await ports.spatial.read() }
  catch (error) { return { metadataIssue: 'The original Launcher placement could not be read: ' + (error instanceof Error ? error.message : String(error)) } }
  if (!state) return { metadataIssue: 'The original Launcher spatial document is unavailable; its Goal binding remains unconfirmed.' }
  const originals = goalDiscussionLaunchersForRegion(state.graph, address.tabId, address.regionId)
  if (!originals.length) return null
  const tab = state.graph.tabs.find(tab => tab.tabId === address.tabId)
  const region = state.graph.regions.find(region => region.tabId === address.tabId && region.regionId === address.regionId)
  if (!tab?.regionIds.includes(address.regionId) || !region || !input.agentSessionId || !input.createOperationId ||
      !(region.kind === 'launcher' && region.agentSessionId === null || region.kind === 'agent' && region.agentSessionId === input.agentSessionId) ||
      region.kind === 'agent' && region.execution && region.execution.hostId !== input.hostId)
    throw new AgentMuxError('The exact original discussion Launcher changed. Its original binding and request are retained.', 'GOAL_DISCUSSION_UNCONFIRMED')
  if (!spatialIntent) return { metadataIssue: 'The explicit Launcher execution Workspace is unconfirmed; its original Core creation remains available.' }
  return { originals, workspaceId: spatialIntent.executionWorkspaceId, hostId: input.hostId, agentSessionId: input.agentSessionId, createOperationId: input.createOperationId }
}

export async function confirmGoalDiscussionLauncherLaunch(captured: Awaited<ReturnType<typeof captureGoalDiscussionLauncherLaunch>>, result: import('../shared/contracts.js').AgentLaunchResult,
  ports: { spatial: Parameters<typeof contributeGoalDiscussionBinding>[0]['spatial']; agent(hostId: string, agentSessionId: string): Promise<AgentMuxAgentSession> }) {
  if (!captured) return
  if ('metadataIssue' in captured) return captured.metadataIssue
  const agent = await ports.agent(captured.hostId, captured.agentSessionId)
  const receipt = result.creation ?? result.created.creation
  if (result.created.agentSessionId !== captured.agentSessionId || result.created.hostId !== captured.hostId || receipt?.createOperationId !== captured.createOperationId ||
      receipt.createdRun?.runId !== agent.creation?.createdRun?.runId) throw new AgentMuxError('The original Core Launcher creation receipt changed. Its Session and operation are retained.', 'GOAL_DISCUSSION_UNCONFIRMED')
  for (const original of captured.originals) {
    const position = agent.creation?.spatialIntent
    if (!position || position.tabId !== original.binding.tabId || position.regionId !== original.binding.regionId || position.executionWorkspaceId !== captured.workspaceId)
      throw new AgentMuxError('The actual Core creation has no matching original Launcher position. Its Session and input remain available.', 'GOAL_DISCUSSION_UNCONFIRMED')
    await confirmGoalDiscussionLauncher({ spatial: ports.spatial, original, agent,
      hostId: captured.hostId, agentSessionId: captured.agentSessionId, createOperationId: captured.createOperationId, workspaceId: captured.workspaceId })
  }
}
