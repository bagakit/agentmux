import { AgentMuxError, readSpaceSnapshot, parseSpaceCloseParams, parseSpaceCloseResult, type AgentMuxRpcCallContext } from '@agentmux/core'
import type { RuntimeController } from './runtime-controller'
import type { SourceWorkbenchCloseCall, SourceWorkbenchCloseDestination, SourceWorkbenchCloseLocations, SourceWorkbenchCloseMember } from '../shared/source-workbench-close'
import { sourceWorkbenchCloseMemberMatches } from '../shared/source-workbench-close'

export function parseSourceWorkbenchCloseMember(value: unknown): SourceWorkbenchCloseMember {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Choose an original workface member.', 'INVALID_CONTROL_REQUEST')
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !['tabId', 'regionId', 'kind', 'agentSessionId', 'scope'].includes(key)) ||
    !['tabId', 'regionId'].every(key => typeof p[key] === 'string' && p[key] !== '' && !(p[key] as string).includes('\0')) ||
    p.agentSessionId !== null && (typeof p.agentSessionId !== 'string' || !p.agentSessionId || p.agentSessionId.includes('\0'))) throw new AgentMuxError('Use the exact original workface member.', 'INVALID_CONTROL_REQUEST')
  if (p.scope !== 'tab' && p.scope !== 'region') throw new AgentMuxError('Choose an original Tab or Region close.', 'INVALID_CONTROL_REQUEST')
  if (!['agent', 'terminal', 'file', 'browser', 'launcher', 'git', 'git-diff'].includes(p.kind as string)) throw new AgentMuxError('Choose the original member kind.', 'INVALID_CONTROL_REQUEST')
  return { tabId: p.tabId as string, regionId: p.regionId as string, kind: p.kind as SourceWorkbenchCloseMember['kind'], agentSessionId: p.agentSessionId as string | null, scope: p.scope }
}

/** The original public workface owner keeps drafts, effects and durable receipts. */
export function sourceWorkbenchClosePort(runtime: Pick<RuntimeController, 'callOriginalCore' | 'subscribeOriginalCore'>) {
  const source = async (destination: SourceWorkbenchCloseDestination, context: AgentMuxRpcCallContext) => {
    const { owner } = await runtime.callOriginalCore(destination.hostId, 'runtime.owner.identity', { expectedRuntimeId: destination.reference.runtimeId }, context)
    return { ...context, runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } }
  }
  const locations = async (destination: SourceWorkbenchCloseDestination, member: SourceWorkbenchCloseMember, context: AgentMuxRpcCallContext): Promise<SourceWorkbenchCloseLocations> => {
    const snapshot = await readSpaceSnapshot({ subscribe: (method, params, handlers) => runtime.subscribeOriginalCore(destination.hostId, method, params, handlers, context) }, destination.reference, context.signal ? { signal: context.signal } : {})
    const original = snapshot.scope.regions.find(region => region.tabId === member.tabId && region.regionId === member.regionId)
    const tab = snapshot.scope.tabs.find(tab => tab.tabId === member.tabId)
    if (!tab?.regionIds.includes(member.regionId) || !original || original.kind !== member.kind || original.agentSessionId !== member.agentSessionId) throw new AgentMuxError('This original workface member changed. Its current content and inputs are retained; choose its current position.', 'WORKBENCH_CLOSE_STALE')
    const inspected = await runtime.callOriginalCore(destination.hostId, 'space.inspect', { target: { spaceId: destination.reference.spaceId, regionId: member.regionId } }, context)
    return { kind: member.scope === 'region' ? 'region' : 'tab-occurrence',
      locations: inspected.catalog.locations.filter(location => location.spaceId === destination.reference.spaceId && location.tabId === member.tabId && location.regionId === member.regionId)
        .map(({ displayWorkspaceId, groupId, tabId, regionId }) => ({ displayWorkspaceId, groupId, tabId, regionId })) }
  }
  return {
    async locations(destination: SourceWorkbenchCloseDestination, member: SourceWorkbenchCloseMember, context: AgentMuxRpcCallContext) {
      return await locations(destination, member, await source(destination, context))
    },
    async call(input: SourceWorkbenchCloseCall, context: AgentMuxRpcCallContext) {
      const current = await source(input, context), request = parseSpaceCloseParams(input.method, input.request)
      if (input.method === 'space.close.prepare') {
        const prepare = parseSpaceCloseParams('space.close.prepare', input.request), choices = await locations(input, input.member, current)
        if (!prepare.keepAgentSessions || choices.kind !== prepare.target.kind || !choices.locations.some(location => location.displayWorkspaceId === prepare.target.displayWorkspaceId && location.groupId === prepare.target.groupId && location.tabId === prepare.target.tabId && (prepare.target.kind !== 'region' || location.regionId === prepare.target.regionId))) throw new AgentMuxError('Select the exact original display position and keep its Agent sessions for this view close. No workface was closed.', 'WORKBENCH_CLOSE_TARGET_REQUIRED')
      }
      // A returned effect receipt survives carrier changes; only the original owner
      // interprets its operation. Never reselect an endpoint from receipt text.
      const result = parseSpaceCloseResult(input.method, await runtime.callOriginalCore(input.hostId, input.method, request, current), request)
      if (input.method === 'space.close.prepare' && result.operation) {
        if (!sourceWorkbenchCloseMemberMatches(result.operation, input.member)) throw new AgentMuxError('The original close plan now contains another member. Keep this plan and inspect its original operation before closing.', 'WORKBENCH_CLOSE_STALE')
      }
      return result
    }
  }
}
