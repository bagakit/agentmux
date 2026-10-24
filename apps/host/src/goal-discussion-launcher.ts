import { AgentMuxError, type AgentMuxAgentCreationInspection } from '@agentmux/core'
import { spatialAgentOpenRecord } from '@agentmux/core/spatial-state'
import { confirmGoalDiscussionLauncher, readGoalDiscussionBinding, type GoalDiscussionLauncherReference } from './goal-discussion-bindings.js'

const unconfirmed = (message: string): never => { throw new AgentMuxError(message + ' The original Goal, workface and Core creation remain retained.', 'GOAL_DISCUSSION_UNCONFIRMED') }
/** Native creation intent and public spatial admission each prove their original position. */
export async function confirmSpatialGoalDiscussionLauncher(input: {
  spatial: Parameters<typeof confirmGoalDiscussionLauncher>[0]['spatial']
  original: GoalDiscussionLauncherReference
  candidates?(tabId: string, regionId: string): Promise<import('@agentmux/core').AgentMuxAgentSession[]>
  agent(hostId: string, agentSessionId: string): Promise<AgentMuxAgentCreationInspection>
}) {
  const state = await input.spatial.read(), binding = input.original.binding
  if (!state || binding.recipient.kind !== 'launcher') return unconfirmed('The original discussion Launcher is unconfirmed.')
  const saved = readGoalDiscussionBinding(state.graph, input.original.goalId)
  if (!saved || saved.tabId !== binding.tabId || saved.regionId !== binding.regionId) return unconfirmed('The canonical discussion position changed.')
  if (saved.recipient.kind === 'agent') return null
  const region = state.graph.regions.find(region => region.tabId === binding.tabId && region.regionId === binding.regionId)
  let hostId: string, sessionId: string
  if (region?.kind === 'launcher' && region.agentSessionId === null) {
    const candidates = await input.candidates?.(binding.tabId, binding.regionId) ?? []
    if (!candidates.length) return null
    if (candidates.length !== 1) return unconfirmed('Several original Core creations name this Launcher; no recipient was chosen.')
    hostId = candidates[0]!.hostId; sessionId = candidates[0]!.agentSessionId
  } else {
    if (region?.kind !== 'agent' || !region.agentSessionId || !region.execution) return unconfirmed('The selected original Launcher Agent is unconfirmed.')
    hostId = region.execution.hostId; sessionId = region.agentSessionId
  }
  const agent = await input.agent(hostId, sessionId)
  if (agent.kind !== 'agent') return unconfirmed('The original Launcher creation was retired; no replacement was selected.')
  const operationId = agent.creation?.createOperationId, native = agent.creation?.spatialIntent
  const record = operationId && spatialAgentOpenRecord(state.graph, operationId)
  const nativeWorkspace = native?.tabId === binding.tabId && native.regionId === binding.regionId ? native.executionWorkspaceId : undefined
  const publicWorkspace = record && record.address.tabId === binding.tabId && record.address.regionId === binding.regionId &&
    record.agentSessionId === agent.agentSessionId && record.execution.hostId === hostId && record.execution.workspacePath === agent.workspacePath ? record.execution.workspaceId : undefined
  const workspaceId = nativeWorkspace ?? publicWorkspace
  if (!workspaceId || agent.agentSessionId !== sessionId || agent.hostId !== hostId || !operationId || !agent.creation?.createdRun)
    return unconfirmed('The current Region has no confirmed original Core creation at this Launcher.')
  return confirmGoalDiscussionLauncher({ spatial: input.spatial, original: input.original, agent,
    hostId, agentSessionId: sessionId, createOperationId: operationId, workspaceId })
}
