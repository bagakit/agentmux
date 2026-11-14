import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { displayLabel, type AgentMuxNameContext, type AgentMuxNameTarget } from './display-label.js'
import type { AgentMuxSpatialStateStore } from './spatial-state.js'
import { resolveSpaceMemberIdentity } from './space-member-owner.js'
import { executionRouteRpc } from './host-route-rpc.js'
import type { AgentMuxRpcCallContext, AgentMuxRpcCoreClient } from './public-rpc-service.js'
import type { HostRouteGateway } from './host-route-gateway.js'
import { memberAgentNameInput, type NameChange, type NameChangeResult, type NameObservation, type NameControlParams } from './name-control.js'

export async function inspectOwnedName(store: AgentMuxSpatialStateStore, runtimeId: string, target: AgentMuxNameTarget,
  operationId?: string): Promise<NameObservation> {
  const read = await store.readDisplayLabel(target, operationId)
  return { target: { runtimeId, kind: target.kind as 'agent-session' | 'tab', id: target.id },
    current: { override: read.value, source: read.label?.source ?? null, nameRevision: read.label?.nameRevision ?? 0 },
    record: read.record, diskAcknowledgement: 'not-observed' }
}
/** The same original CAS/audit/write owner; no public response contains the whole spatial graph. */
export async function changeOwnedName(store: AgentMuxSpatialStateStore, runtimeId: string, target: AgentMuxNameTarget,
  change: NameChange, context: AgentMuxNameContext, assertCurrent: () => void | Promise<void>): Promise<NameChangeResult> {
  if (change.kind === 'confirm') {
    const before = await inspectOwnedName(store, runtimeId, target, change.operationId)
    if (!before.record) throw new AgentMuxError('The original name operation is unobserved. Its input is retained; no rename was replayed.', 'NAME_INTENT_ABSENT')
    await assertCurrent()
    const state = await store.confirmNameCommit(change.operationId, target, assertCurrent), label = displayLabel(state.graph, target)
    return { target: before.target, current: { override: label?.value ?? null, source: label?.source ?? null, nameRevision: label?.nameRevision ?? 0 },
      record: before.record, changed: false, applied: before.record.status === 'applied', save: { diskDurability: state.nameCommit!.diskDurability, issue: state.nameCommit!.issue } }
  }
  const result = await store.mutateDisplayLabel({ target, operationId: change.operationId, value: change.name?.trim() || null,
    source: change.source, expectedNameRevision: change.expectedNameRevision }, context, {
      ...(target.kind === 'agent-session' ? { initializeAgentLabel: true as const } : {}), assertCurrent })
  return { target: { runtimeId, kind: target.kind as 'agent-session' | 'tab', id: target.id },
    current: { override: result.label?.value ?? null, source: result.label?.source ?? null, nameRevision: result.label?.nameRevision ?? 0 },
    record: result.record, changed: result.changed, applied: result.applied,
    save: { diskDurability: result.diskDurability, issue: result.issue ?? result.record.reason } }
}

/** The original Source resolves business occurrence only. A local D handler still checks its own exact durable Session and actor. */
export async function sourceMemberName(ports: {
  store: AgentMuxSpatialStateStore; gateway?: HostRouteGateway; clients(): Promise<readonly AgentMuxRpcCoreClient[]>
  local(method: 'agent.name.inspect' | 'agent.name.change', input: NameControlParams['agent.name.inspect'] | NameControlParams['agent.name.change'], context: AgentMuxRpcCallContext): Promise<NameObservation | NameChangeResult>
  nameContext(target: AgentMuxNameTarget): AgentMuxNameContext
}, method: 'space.member.name.inspect' | 'space.member.name.change',
  input: NameControlParams['space.member.name.inspect'] | NameControlParams['space.member.name.change'], context: AgentMuxRpcCallContext): Promise<NameObservation | NameChangeResult> {
  const initial = await resolveSpaceMemberIdentity(ports.store, input.target)
  const current = async () => {
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    if (!isDeepStrictEqual(await resolveSpaceMemberIdentity(ports.store, input.target), initial)) throw new AgentMuxError(
      'The original member admission or placement changed. Keep its exact name operation and inspect its owner.', 'SPACE_MEMBER_TARGET_MISMATCH')
  }
  await current()
  if (input.object === 'tab') {
    const target = { kind: 'tab', id: initial.tabId }, runtimeId = input.target.reference.runtimeId
    return 'change' in input ? await changeOwnedName(ports.store, runtimeId, target, input.change, ports.nameContext(target), current)
      : await inspectOwnedName(ports.store, runtimeId, target, input.operationId)
  }
  if (initial.kind === 'external') throw new AgentMuxError('The original independent Coordinator owns this Agent name. Use its separately authenticated witness and local name API; no reverse carrier was created.', 'SPACE_MEMBER_EXTERNAL_COORDINATOR')
  const selected = initial.execution
  const request = memberAgentNameInput(input)
  const leaf = method === 'space.member.name.change' ? 'agent.name.change' : 'agent.name.inspect'
  let reply: NameObservation | NameChangeResult
  if (selected.adoptedRoute) {
    if (!ports.gateway) throw new AgentMuxError('This original name route has no current viewer authority.', 'HOST_ROUTE_AUTHORIZATION_REQUIRED')
    const authorization = await ports.gateway.authorizeMemberName({ method, input }, context)
    const rpc = executionRouteRpc(ports.gateway, selected.adoptedRoute, authorization, undefined, context)
    reply = leaf === 'agent.name.change'
      ? await rpc.call(leaf, request as NameControlParams['agent.name.change'], context.signal ? { signal: context.signal } : {})
      : await rpc.call(leaf, request as NameControlParams['agent.name.inspect'], context.signal ? { signal: context.signal } : {})
  } else if (selected.hostId === 'local') reply = await ports.local(leaf, request, context)
  else {
    if (context.routeDelegation || context.caller || context.principal?.kind !== 'user') throw new AgentMuxError('This foreign name needs the current viewer\'s exact verified route and receiver name grant.', 'HOST_ROUTE_AUTHORIZATION_REQUIRED')
    const matches = (await ports.clients()).filter(item => item.hostId === selected.hostId)
    if (matches.length !== 1 || !matches[0]!.client.forwardRpc) throw new AgentMuxError('The original name carrier is unavailable or ambiguous.', 'UNKNOWN_HOST')
    const client = matches[0]!.client
    reply = leaf === 'agent.name.change' ? await client.forwardRpc!(leaf, request as NameControlParams['agent.name.change'], context)
      : await client.forwardRpc!(leaf, request as NameControlParams['agent.name.inspect'], context)
  }
  await current()
  return reply
}
