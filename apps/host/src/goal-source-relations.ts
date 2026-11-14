import { mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxError, routedAgentMuxRpc, type AgentMuxHeadlessRuntime, type AgentMuxRpcCallContext, type AgentMuxRpcClient } from '@agentmux/core'
import type { AgentMuxSpaceMutationReport, GoalRelationAccess, GoalRuntimeAccess } from '@agentmux/core/control'
import { demandAgentReferenceKey, mergeDemandAgentReferences, type DemandAgentReference, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { Demand } from '@agentmux/demand'
import type { GoalExecutionClient } from './goal-runtime.js'

type Relations = Pick<Demand, 'sessionIds' | 'assigneeSessionIds' | 'supervisorSessionId'>
type Rpc = Pick<AgentMuxRpcClient, 'call' | 'subscribe'>
function unavailable(message: string): never { throw new AgentMuxError(message, 'GOAL_RELATION_SOURCE_UNCONFIRMED') }

/** A single explicit operation borrows the original configured Source transport.
 * No Source access or principal is retained in the business relationship. */
export async function goalSourceRpc(options: {
  runtime(): AgentMuxHeadlessRuntime
  clients(): readonly { hostId: string; client: GoalExecutionClient }[]
}, access: GoalRuntimeAccess, expectedRuntimeId: string, context: AgentMuxRpcCallContext): Promise<Rpc> {
  const local = access.hostId === 'local' ? options.runtime() : undefined
  const matches = local ? [] : options.clients().filter(item => item.hostId === access.hostId)
  const client = matches.length === 1 ? matches[0]!.client : undefined
  const transport = client && 'forwardRpc' in client && 'subscribeRpc' in client ? client : undefined
  if (!local && (!transport?.forwardRpc || !transport.subscribeRpc)) unavailable('The exact configured Goal Source carrier is unavailable. Original relations and work are retained.')
  const assertCurrent = async () => {
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    if (local ? options.runtime() !== local : options.clients().filter(item => item.hostId === access.hostId).length !== 1 || options.clients().find(item => item.hostId === access.hostId)?.client !== client)
      unavailable('The original Goal Source carrier changed. Retain this request and its original relations.')
  }
  let fence: import('@agentmux/core').AgentMuxRuntimeFence | undefined
  const original: Rpc = {
    async call(method, params, callOptions = {}) {
      await assertCurrent()
      const current = { ...context, ...callOptions, ...(fence ? { runtimeFence: fence } : {}) }
      const result = local ? await local.server.callRpc(method, params, current) : await transport!.forwardRpc!(method, params, current, fence)
      await assertCurrent(); return result
    },
    async subscribe(method, params, handlers) {
      await assertCurrent()
      if (!local) {
        if (context.caller) throw new AgentMuxError('This configured subscription does not carry the original managed caller. Its relation and existing work remain retained.', 'CONTROL_PERMISSION_DENIED')
        return await transport!.subscribeRpc!(method, params, { ...handlers, ...(fence ? { runtimeFence: fence } : {}), ...(context.principal?.kind === 'device' && context.forwarding ? { forwarding: context.forwarding } : {}) })
      }
      const reader = await local.server.subscribeRpc(method, params, handlers.onEvent, { ...context, ...(handlers.signal ? { signal: handlers.signal } : {}), ...(fence ? { runtimeFence: fence } : {}) })
      try { await assertCurrent(); handlers.onInitial(reader.initial); await reader.start?.(); return { subscriptionId: mintObjectId(), dispose: async () => { await reader.dispose() } } }
      catch (error) { await reader.dispose(); throw error }
    }
  }
  const expectedCarrier = access.via?.adoptedRoute.source.runtimeId ?? expectedRuntimeId
  const { owner } = await original.call('runtime.owner.identity', { expectedRuntimeId: expectedCarrier })
  if (owner.runtimeId !== expectedCarrier) unavailable('The Goal Source carrier belongs to another original Runtime.')
  fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  if (!access.via) return original
  if (access.via.adoptedRoute.hops.at(-1)?.target.runtimeId !== expectedRuntimeId) unavailable('The saved prefix does not reach this original Goal Source.')
  const routed = routedAgentMuxRpc(original, access.via.routeId, access.via.adoptedRoute)
  const target = await routed.call('runtime.owner.identity', { expectedRuntimeId })
  if (target.owner.runtimeId !== expectedRuntimeId) unavailable('The routed Goal Source reply belongs to another Runtime.')
  return routed
}

/** New references are qualified by a Source business cut, never Agent liveness or A input authority. */
export type GoalSourceRelationFact = { kind: 'creation' } | { kind: 'association'; association: NonNullable<AgentMuxSpaceMutationReport['association']> }
export async function assertGoalSourceRelation(rpc: Rpc, ref: DemandSpaceMemberReference, signal?: AbortSignal): Promise<GoalSourceRelationFact> {
  if (ref.source.admission.kind === 'creation') {
    // This is a business graph read, not creation inspection of D or a Native probe.
    const { catalog } = await rpc.call('space.inspect', { target: { spaceId: ref.source.spaceId, regionId: ref.source.regionId } }, signal ? { signal } : {})
    const region = catalog.regions.find(item => item.regionId === ref.source.regionId)
    const tab = region && catalog.tabs.find(item => item.tabId === region.tabId)
    if (!region || !tab?.zoneId || !catalog.bindings.some(item => item.zoneId === tab.zoneId && item.spaceId === ref.source.spaceId) ||
        region.creationOperationId !== ref.source.admission.operationId || region.agentSessionId !== ref.execution.agentSessionId || region.execution?.runtimeId !== ref.execution.runtimeId)
      unavailable('The Source creation names another original member, occurrence or admission. No relationship was saved.')
    return { kind: 'creation' }
  }
  const inspected = await rpc.call('space.inspect', { target: { operationId: ref.source.admission.operationId } }, signal ? { signal } : {})
  const report = inspected.request?.report, association = report?.association
  // The original Source association producer checks L/address/resource together
  // in one graph cut. Its opened read is not the old write ACK or A input authority.
  if (!inspected.request?.known || report?.outcome !== 'opened' || report.to?.spaceId !== ref.source.spaceId || report.to.regionId !== ref.source.regionId ||
      association?.operationId !== ref.source.admission.operationId || association.resource.runtimeId !== ref.source.runtimeId ||
      association.reference.runtimeId !== ref.execution.runtimeId || association.reference.binding.agentSessionId !== ref.execution.agentSessionId)
    unavailable('The original Source association, resource or reference is not confirmed. The Agent and selection were retained.')
  return { kind: 'association', association }
}

export async function assertNewGoalSourceRelations(previous: Relations | undefined, next: Partial<Relations>, access: readonly GoalRelationAccess[] | undefined,
  resolve: (access: GoalRuntimeAccess, runtimeId: string) => Promise<Rpc>, signal?: AbortSignal): Promise<void> {
  const additions: DemandAgentReference[][] = []
  for (const field of ['sessionIds', 'assigneeSessionIds', 'supervisorSessionId'] as const) {
    if (!Object.hasOwn(next, field)) continue
    const list = (value: Relations[typeof field] | undefined) => value == null ? [] : Array.isArray(value) ? value : [value]
    const existing = new Set(list(previous?.[field]).map(demandAgentReferenceKey))
    additions.push(list(next[field]).filter(ref => typeof ref !== 'string' && !existing.has(demandAgentReferenceKey(ref))))
  }
  const sources = new Map<string, Promise<Rpc>>()
  for (const ref of mergeDemandAgentReferences(...additions)) {
    if (typeof ref === 'string') continue
    const entry = access?.find(item => demandAgentReferenceKey(item.reference) === demandAgentReferenceKey(ref))
    if (!entry) unavailable('Choose the current access for this exact new Source relation. Existing Goal edits and relations remain available.')
    const sourceKey = JSON.stringify([ref.source.runtimeId, entry.access.source])
    let pending = sources.get(sourceKey)
    if (!pending) { pending = resolve(entry.access.source, ref.source.runtimeId); sources.set(sourceKey, pending) }
    await assertGoalSourceRelation(await pending, ref, signal)
  }
}
