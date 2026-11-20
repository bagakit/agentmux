import { parseNameControlParams, type NameControlParams } from './name-control.js'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { agentCreationIntentDigest as digest, verifyHostRouteEnvelope, verifyHostRouteExecutionAuthorization, type AgentMuxCreationAuthority } from './agent-creation-authority.js'
import { parseHostRouteConfiguration, parseHostRouteCall, parseHostRouteEnvelope, parseHostRouteEdge, hostRouteScope, hostRouteExecutorOperation,
  type AdoptedHostRoute, type HostRouteActor, type HostRouteCall, type HostRouteEnvelope, type HostRouteSettings,
  type HostRouteObservationScope, type HostRouteExecutionAuthorization, type HostRouteStatement, type HostRouteParams, type HostRouteObservation, type HostRouteIdentity, type HostRouteStreamInitial, type HostRouteConfiguration, type HostRouteEdge, type HostRouteEdges, type HostRouteEdgeInspection,
  type HostRouteChoices, type HostRouteExecutors, type HostRouteAgentTarget, type HostRouteDefinition, type HostRelayEdge } from './host-route.js'
import { hostRouteTransport } from './host-route-rpc.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from './public-rpc-client.js'
import { hostRouteOperation, executionRouteScope, memberRouteOperation, memberNameRouteOperation, assertExecutionChild } from './host-route-execution.js'
import { parseSpaceMemberParams } from './space-member-codec.js'
import type { SpaceMemberParams } from './space-member.js'
import type { AgentExecutionOpenInput } from './agent-execution-coordinator.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { decodeHostedValue, parseHostedRuntimeOwnerIdentity } from './hosted-value.js'
import { parseHostExecutorInventory } from './executor-contract.js'
import { mintObjectId } from './object-id.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { validateAgentInputWaitRef, type AgentInputCallContext } from './agent-input-wait.js'
import type { AgentMuxRpcCallContext, AgentMuxRpcServiceSubscription } from './public-rpc-service.js'
import type { AgentMuxRpcMethod, AgentMuxRpcParams, AgentMuxRpcResult, AgentMuxRpcStreamMethod, AgentMuxRpcStreamEvent } from './public-rpc.js'

type Delegation = { envelope: HostRouteEnvelope; actor: HostRouteActor; call: HostRouteCall; stream: boolean; assertCurrent(): Promise<void> }
const verified = new WeakMap<object, Delegation>()
/** Opaque in-process proof; only a signature/policy-verified gateway can construct one. */
export type VerifiedHostRouteDelegation = object & { readonly __hostRouteDelegation: unique symbol }
export function delegatedHostRouteActor(context: AgentMuxRpcCallContext): HostRouteActor | undefined {
  if (!context.routeDelegation) return undefined
  const authority = verified.get(context.routeDelegation)
  if (!authority) throw new AgentMuxError('Unverified in-process route authority.', 'HOST_ROUTE_AUTHORITY_INVALID')
  return authority.actor
}
/** Safe original Source provenance from a verified name child, never from business JSON. */
export function delegatedHostRouteMemberName(context: AgentMuxRpcCallContext): import('./host-route.js').HostRouteMemberNameOperation | undefined {
  if (!context.routeDelegation) return undefined
  delegatedHostRouteActor(context)
  const scope = verified.get(context.routeDelegation)!.envelope.statement.authorization?.scope
  return scope?.kind === 'member-name' ? structuredClone(scope.operation) : undefined
}
export async function assertHostRouteDispatch(context: AgentMuxRpcCallContext, method: string, params: unknown, stream: boolean): Promise<void> {
  if (!context.routeDelegation) return
  const authority = verified.get(context.routeDelegation)
  if (!authority || authority.stream !== stream || authority.call.method !== method || !isDeepStrictEqual(authority.call.params, params))
    throw new AgentMuxError('Delegation cannot authorize a different original method or input.', 'HOST_ROUTE_AUTHORITY_INVALID')
  await authority.assertCurrent()
}
export function hostRouteActorScope(context: AgentMuxRpcCallContext): string | undefined {
  const actor = delegatedHostRouteActor(context)
  if (!actor) return undefined
  const authorization = verified.get(context.routeDelegation!)!.envelope.statement.authorization
  // A narrower child cannot reuse its actor's broader consumer namespace.
  // Keep the original stable scope across calls, without a per-call lease Store.
  let scope = authorization?.scope
  if (scope?.kind === 'member-control') {
    const { method: _method, paramsDigest: _paramsDigest, ...member } = scope.operation
    return digest({ actor, coordinator: authorization!.coordinator, scope: { kind: scope.kind, member, createOperationId: scope.createOperationId } })
  }
  return authorization ? digest({ actor, coordinator: authorization.coordinator, scope }) : digest(actor)
}

export type HostRouteExecutionAccess = { authorization: HostRouteExecutionAuthorization; helper?: () => HostRouteStatement['helper'] } | { context: AgentMuxRpcCallContext; call: HostRouteCall } | { context: AgentMuxRpcCallContext; observation: HostRouteObservationScope }

export type HostRouteTransport = {
  identity(signal?: AbortSignal): Promise<HostRouteIdentity>
  call(method: 'route.receive', params: HostRouteParams['route.receive'], signal: AbortSignal): Promise<{ value: unknown; observation: HostRouteObservation }>
  watch(params: HostRouteParams['route.receive-watch'], emit: (event: unknown) => void | Promise<void>, signal: AbortSignal): Promise<{
    initial: HostRouteStreamInitial; start?(): void | Promise<void>; dispose(): void | Promise<void>
  }>
}
type State = HostRouteConfiguration & { schema: 'agentmux.host-route-settings.v1'; runtimeId: string; revision: string;
  operation: { operationId: string; inputDigest: string } | null }
type PolicyIndex = { routes: Map<string, AdoptedHostRoute>; chains: Set<string>; grants: Set<string>; relayEdges: Map<string, HostRelayEdge> }
const grantKey = (delegator: HostRouteIdentity, actor: HostRouteActor, destination: HostRouteIdentity, scope: string) => digest([delegator, actor, destination, scope])
const policyIndex = (state: HostRouteConfiguration): PolicyIndex => ({ routes: new Map(state.routes.map(item => [item.id, item.route])), chains: new Set(state.routes.map(item => digest(item.route))),
  grants: new Set(state.grants.flatMap(item => item.scopes.map(scope => grantKey(item.delegator, item.actor, item.destination, scope)))),
  relayEdges: new Map((state.relayEdges ?? []).map(edge => [edge.edgeId, edge])) })
type Active = { controller: AbortController; check(policy?: PolicyIndex): void }
export type HostRouteGatewayOptions = {
  stateDirectory: string
  authority: AgentMuxCreationAuthority
  /** Borrow exact configured edge transports, never caller-provided endpoints. */
  edge(edgeId: string): HostRouteTransport | Promise<HostRouteTransport>
  /** Read the original Host owner's safe saved-edge projection; never discover by connecting. */
  edges?(): Promise<HostRouteEdge[]>
  call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>>
  subscribe<M extends AgentMuxRpcStreamMethod>(method: M, params: Record<string, unknown>, emit: (event: AgentMuxRpcStreamEvent<M>) => void | Promise<void>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcServiceSubscription<M>>
}
function denied(message: string, code = 'HOST_ROUTE_NOT_DELEGATED'): never { throw new AgentMuxError(message, code) }

/** One Runtime's explicit route policy and related readers; no execution/replay journal. */
export class HostRouteGateway {
  private statePromise: Promise<State> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private readonly active = new Set<Active>()
  private policy = policyIndex({ routes: [], grants: [] })
  private readonly relayClients = new Map<string, { binding: HostRelayEdge; client: Promise<AgentMuxRpcClient> }>()
  private disposed = false
  constructor(private readonly options: HostRouteGatewayOptions) {}
  private state(): Promise<State> {
    return this.statePromise ??= (async () => {
      let state: State
      try {
        const p = rpcRecord(JSON.parse(await readFile(join(this.options.stateDirectory, 'host-route-settings.json'), 'utf8')),
          ['schema', 'runtimeId', 'revision', 'operation', 'routes', 'grants', 'relayEdges'])
        if (p.schema !== 'agentmux.host-route-settings.v1' || p.runtimeId !== this.options.authority.runtimeId) denied('The original route policy belongs to another Core.', 'HOST_ROUTE_POLICY_UNCONFIRMED')
        const operation = p.operation === null ? null : rpcRecord(p.operation, ['operationId', 'inputDigest'])
        state = { schema: p.schema as State['schema'], runtimeId: p.runtimeId as string, revision: rpcString(p.revision, 'Original route revision'),
          operation: operation ? { operationId: rpcString(operation.operationId, 'Original save operation'), inputDigest: rpcString(operation.inputDigest, 'Original save digest') } : null,
          ...parseHostRouteConfiguration({ routes: p.routes, grants: p.grants, ...(p.relayEdges === undefined ? {} : { relayEdges: p.relayEdges }) }) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        state = { schema: 'agentmux.host-route-settings.v1', runtimeId: this.options.authority.runtimeId,
          revision: digest({ runtimeId: this.options.authority.runtimeId, routes: [], grants: [] }), operation: null, routes: [], grants: [] }
      }
      this.index(state); return state
    })().catch(error => { this.statePromise = undefined; throw error })
  }
  private index(state: State) {
    this.policy = policyIndex(state)
    for (const [id, lease] of this.relayClients) if (!isDeepStrictEqual(this.policy.relayEdges.get(id), lease.binding)) this.releaseRelay(id)
  }
  private releaseRelay(edgeId: string) {
    const lease = this.relayClients.get(edgeId)
    this.relayClients.delete(edgeId)
    void lease?.client.then(client => client.dispose()).catch(error => {
      process.emitWarning(`Releasing Relay edge ${edgeId} is unconfirmed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  private async transport(edgeId: string, relay: boolean, expectedTarget?: HostRouteIdentity): Promise<HostRouteTransport> {
    if (!relay) return await this.options.edge(edgeId)
    const binding = this.policy.relayEdges.get(edgeId)
    if (!binding || this.disposed) denied('This exact saved Relay edge is unavailable. Keep its original route and operation.', 'HOST_ROUTE_EDGE_UNAVAILABLE')
    if (expectedTarget && !isDeepStrictEqual(binding.target, expectedTarget)) denied('The saved Relay edge pins another original target.', 'HOST_ROUTE_TARGET_MISMATCH')
    let lease = this.relayClients.get(edgeId)
    if (!lease) {
      lease = { binding, client: connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: binding.offer } }) }
      this.relayClients.set(edgeId, lease)
    }
    const client = await lease.client.catch(error => { if (this.relayClients.get(edgeId) === lease) this.relayClients.delete(edgeId); throw error })
    if (this.relayClients.get(edgeId) !== lease) denied('This Relay edge changed while opening. Keep its original operation.', 'HOST_ROUTE_EDGE_UNAVAILABLE')
    const port = hostRouteTransport(client)
    return { ...port, identity: async signal => {
      const target = await port.identity(signal)
      if (!isDeepStrictEqual(binding.target, target)) denied('The Relay endpoint answers for another original Core.', 'HOST_ROUTE_TARGET_MISMATCH')
      return target
    } }
  }
  async identity(): Promise<HostRouteIdentity> { return await this.options.authority.identity() }
  private async discovery(context: AgentMuxRpcCallContext) {
    if (context.caller) denied('Managed callers retain their original limited capabilities.', 'HOST_ROUTE_ACTOR_REQUIRED')
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    const identity = await this.identity(), delegated = delegatedHostRouteActor(context)
    const principal = delegated ? undefined : this.originalUser(context)
    const actor = delegated ?? { source: identity, kind: principal!.kind, id: principal!.id }
    return { identity, actor }
  }
  private async savedEdges(): Promise<HostRouteEdge[]> {
    const state = await this.state()
    if (!this.options.edges && state.relayEdges === undefined) denied('The original Host saved-edge source is unavailable. Existing routes and Agents are retained.', 'HOST_ROUTE_EDGE_UNAVAILABLE')
    return [...(await this.options.edges?.() ?? []).map(parseHostRouteEdge), ...(state.relayEdges ?? []).map(edge =>
      ({ edgeId: edge.edgeId, label: edge.label, kind: 'relay' as const, runtimeId: edge.target.runtimeId }))]
  }
  async edges(context: AgentMuxRpcCallContext): Promise<HostRouteEdges> {
    const source = await this.discovery(context), edges = await this.savedEdges()
    await context.assertCurrent?.(); context.signal?.throwIfAborted()
    return { ...source, edges, observedAt: Date.now() }
  }
  private agentTarget(definition: HostRouteDefinition): HostRouteAgentTarget {
    return { hostId: definition.id, runtimeId: definition.route.hops.at(-1)!.target.runtimeId, adoptedRoute: structuredClone(definition.route) }
  }
  async choices(context: AgentMuxRpcCallContext): Promise<HostRouteChoices> {
    const source = await this.discovery(context), state = await this.state()
    await context.assertCurrent?.(); context.signal?.throwIfAborted()
    return { ...source, routes: state.routes.map(definition => ({ id: definition.id, agentTarget: this.agentTarget(definition) })), observedAt: Date.now() }
  }
  /** Current-viewer inventory only. Creation and Provider qualification retain their original owners. */
  async executors(input: HostRouteParams['route.executors'], context: AgentMuxRpcCallContext): Promise<HostRouteExecutors> {
    const operation = hostRouteExecutorOperation(input)
    const current = async () => {
      await context.assertCurrent?.(); context.signal?.throwIfAborted()
      if (!isDeepStrictEqual(await this.configuredRoute(operation.routeId), operation.adoptedRoute)) denied('This exact saved route changed. Retain the selection; no other Host or route was used.', 'HOST_ROUTE_CHANGED')
    }
    await current()
    const authorization = await this.options.authority.attestHostRouteExecution({ schema: 'agentmux.host-route-execution.v1', purpose: 'host-route-execution',
      ...await this.origin(context), scope: { kind: 'executor-inventory', operation } })
    const call = async (method: 'runtime.owner.identity' | 'runtime.invoke', params: Record<string, unknown>) => {
      await current()
      return await this.call({ routeId: operation.routeId, adoptedRoute: operation.adoptedRoute, requestId: mintObjectId(), call: { method, params } }, context, false, { authorization })
    }
    const identity = await call('runtime.owner.identity', { expectedRuntimeId: operation.targetRuntimeId })
    const owner = parseHostedRuntimeOwnerIdentity(rpcRecord(identity.value).owner)
    if (owner.runtimeId !== operation.targetRuntimeId) denied('The executor read reached another semantic Runtime.', 'HOST_ROUTE_TARGET_MISMATCH')
    const result = await call('runtime.invoke', { consumerId: mintObjectId(), fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId },
      invocation: { method: 'listHostExecutors', args: [{ refresh: operation.refresh, ...(operation.executorId === undefined ? {} : { executorId: operation.executorId }) }] } })
    const inventory = parseHostExecutorInventory(decodeHostedValue(rpcRecord(result.value).value))
    if (inventory.runtimeId !== operation.targetRuntimeId) denied('The executor inventory names another original Runtime.', 'HOST_ROUTE_TARGET_MISMATCH')
    await current()
    return { routeId: operation.routeId, agentTarget: this.agentTarget({ id: operation.routeId, route: operation.adoptedRoute }), inventory, observation: result.observation }
  }
  async inspectEdge(input: HostRouteParams['route.edge.inspect'], context: AgentMuxRpcCallContext): Promise<HostRouteEdgeInspection> {
    const source = await this.discovery(context)
    const matching = (await this.savedEdges()).filter(edge => edge.edgeId === input.edgeId)
    if (matching.length !== 1) denied('This exact saved outgoing edge is absent or ambiguous. Retain the route draft; no alternate Host was selected.', 'HOST_ROUTE_EDGE_UNAVAILABLE')
    const edge = matching[0]!, target = await (await this.transport(input.edgeId, edge.kind === 'relay')).identity(context.signal)
    await context.assertCurrent?.(); context.signal?.throwIfAborted()
    if (edge.runtimeId !== undefined && target.runtimeId !== edge.runtimeId)
      denied('The selected edge no longer matches its saved Runtime pin. Retain that pin and inspect the original Host configuration.', 'HOST_ROUTE_TARGET_MISMATCH')
    return { ...source, edge, target, observedAt: Date.now() }
  }
  async inspect(): Promise<HostRouteSettings> {
    const state = await this.state()
    const { schema: _schema, runtimeId: _runtimeId, ...settings } = state
    return structuredClone({ identity: await this.identity(), ...settings })
  }
  async configuredRoute(routeId: string): Promise<AdoptedHostRoute | undefined> {
    await this.state(); const route = this.policy.routes.get(routeId); return route ? structuredClone(route) : undefined
  }
  async configure(input: HostRouteParams['route.configure'], context: AgentMuxRpcCallContext): Promise<{ settings: HostRouteSettings; diskDurability: 'confirmed' }> {
    this.originalUser(context)
    const work = this.tail.then(async () => {
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const current = await this.state(), proposed = parseHostRouteConfiguration(input.configuration)
      const identity = await this.identity(), inputDigest = digest(input)
      if (current.operation?.operationId === input.operationId) {
        if (current.operation.inputDigest !== inputDigest) denied('This original policy operation has another input.', 'HOST_ROUTE_OPERATION_CHANGED')
        // A readback is not a replacement for the original durable write ACK.
        denied('This save is already observed. Inspect its original revision; do not replay it.', 'HOST_ROUTE_SAVE_ALREADY_OBSERVED')
      }
      if (current.revision !== input.expectedRevision) denied('Route policy changed. Read the same original owner and preserve both edits.', 'HOST_ROUTE_POLICY_CHANGED')
      const relayEdges = proposed.relayEdges ?? current.relayEdges
      if (!isDeepStrictEqual(relayEdges, current.relayEdges)) {
        if (context.transport !== 'unix' || context.principal?.kind !== 'user') denied('Changing a Relay destination requires its original user configuration transport.', 'HOST_ROUTE_ACTOR_REQUIRED')
        const originalIds = new Set((await this.options.edges?.() ?? []).map(edge => edge.edgeId))
        if (relayEdges?.some(edge => originalIds.has(edge.edgeId) || edge.target.runtimeId === identity.runtimeId))
          denied('A Relay edge must identify one distinct remote target and a unique saved edge.', 'HOST_ROUTE_INVALID')
      }
      const configuration = { ...proposed, ...(relayEdges === undefined ? {} : { relayEdges }) }
      if (configuration.routes.some(item => !isDeepStrictEqual(item.route.source, identity))) denied('An outgoing route must originate at this actual Core.', 'HOST_ROUTE_SOURCE_MISMATCH')
      const state: State = { schema: current.schema, runtimeId: current.runtimeId, revision: digest({ previous: current.revision, operationId: input.operationId, configuration }),
        operation: { operationId: input.operationId, inputDigest }, ...configuration }
      await context.assertCurrent?.(); context.signal?.throwIfAborted()
      try { await durableWriteFile(join(this.options.stateDirectory, 'host-route-settings.json'), JSON.stringify(state) + '\n', { mode: 0o600, requireDirectorySync: true }) }
      catch (error) {
        this.statePromise = undefined
        const failure = new AgentMuxError('The original route policy save is unconfirmed. Retain this operation and inspect the same owner; no execution was replayed.', 'HOST_ROUTE_POLICY_SAVE_UNCONFIRMED')
        Object.defineProperty(failure, 'cause', { value: error })
        const proposed = policyIndex(configuration)
        for (const item of this.active) { try { item.check(proposed) } catch { item.controller.abort(failure) } }
        throw failure
      }
      this.statePromise = Promise.resolve(state); this.index(state)
      for (const item of this.active) { try { item.check() } catch (error) { item.controller.abort(error) } }
      return { settings: await this.inspect(), diskDurability: 'confirmed' as const }
    })
    this.tail = work.catch(() => {}); return await work
  }
  private originalUser(context: AgentMuxRpcCallContext) {
    if (context.caller || context.routeDelegation || !context.principal || !['user', 'device'].includes(context.principal.kind))
      denied('Only the actual original user/device can configure policy or enter a new source route. Managed callers keep their original capabilities.', 'HOST_ROUTE_ACTOR_REQUIRED')
    return context.principal!
  }
  private activeContext(context: AgentMuxRpcCallContext, check: (policy?: PolicyIndex) => void): { signal: AbortSignal; current(): Promise<void>; dispose(): void; retainForInput(): ReturnType<NonNullable<AgentInputCallContext['retainAcceptedInputAuthority']>> } {
    let closed = false
    const controller = new AbortController(), item: Active = { controller, check }
    const abort = () => controller.abort(context.signal?.reason)
    context.signal?.addEventListener('abort', abort, { once: true }); if (context.signal?.aborted) abort()
    this.active.add(item)
    const current = async () => {
      controller.signal.throwIfAborted(); if (closed || this.disposed) denied('This exact route reader is closed.', 'HOST_ROUTE_READER_CLOSED')
      await context.assertCurrent?.(); check(); controller.signal.throwIfAborted()
    }
    return { signal: controller.signal, current, retainForInput: async () => {
      await current()
      // The original input owner keeps only D's current receiver restrictions.
      // Released upstream readers are not a continuous network revocation service.
      let released = false
      return { assertCurrent: async () => {
        await this.state()
        if (released || this.disposed) denied('This accepted input restriction was released.', 'HOST_ROUTE_READER_CLOSED')
        check()
      }, release: () => { released = true } }
    }, dispose: () => { closed = true; context.signal?.removeEventListener('abort', abort); this.active.delete(item) } }
  }
  private async source(input: HostRouteParams['route.call'], context: AgentMuxRpcCallContext, stream: boolean) {
    const principal = this.originalUser(context), route = await this.configuredRoute(input.routeId)
    if (!route) denied('The exact original configured route is absent. Existing bindings and Runs are retained.', 'HOST_ROUTE_UNKNOWN')
    if (!isDeepStrictEqual(route, input.adoptedRoute)) denied('The configured route differs from this original adopted chain. No call was rerouted.', 'HOST_ROUTE_CHANGED')
    const call = parseHostRouteCall(input.call, stream), identity = await this.identity()
    if (!isDeepStrictEqual(route.source, identity)) denied('The saved source key changed; retain the original route and identity.', 'HOST_ROUTE_SOURCE_MISMATCH')
    const actor: HostRouteActor = { source: identity, kind: principal.kind, id: principal.id }
    const authority = this.activeContext(context, (policy = this.policy) => {
      if (!isDeepStrictEqual(policy.routes.get(input.routeId), route)) denied('The original route was changed or removed.', 'HOST_ROUTE_CHANGED')
    })
    try {
      await authority.current()
      const envelope = await this.options.authority.attestHostRoute({ schema: 'agentmux.host-route.v1', purpose: 'host-route', route, actor,
        requestId: input.requestId, method: call.method, paramsDigest: digest(call.params),
        ...(hostRouteOperation(call) ? { operation: hostRouteOperation(call)! } : {}) })
      return { envelope, call, authority }
    } catch (error) { authority.dispose(); throw error }
  }
  private async origin(context: AgentMuxRpcCallContext): Promise<{ actor: HostRouteActor; parent?: HostRouteEnvelope }> {
    if (context.routeDelegation) {
      const authority = verified.get(context.routeDelegation)
      if (!authority) denied('Unverified original admission authority.', 'HOST_ROUTE_AUTHORITY_INVALID')
      await authority.assertCurrent()
      if (authority.envelope.statement.authorization) denied('A derived child cannot mint a different admission.', 'HOST_ROUTE_DERIVATION_MISMATCH')
      return { actor: structuredClone(authority.actor), parent: structuredClone(authority.envelope) }
    }
    const principal = this.originalUser(context)
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    return { actor: { source: await this.identity(), kind: principal.kind, id: principal.id } }
  }
  /** Called by the original binding owner, before its immutable admission is saved. */
  async authorizeExecution(input: AgentExecutionOpenInput, context: AgentMuxRpcCallContext): Promise<HostRouteExecutionAuthorization> {
    return await this.options.authority.attestHostRouteExecution({ schema: 'agentmux.host-route-execution.v1', purpose: 'host-route-execution',
      ...await this.origin(context), scope: executionRouteScope(input) })
  }
  async retainExecution(input: AgentExecutionOpenInput, context: AgentMuxRpcCallContext | undefined,
    retained: HostRouteExecutionAuthorization | undefined, existing: boolean): Promise<HostRouteExecutionAuthorization | undefined> {
    // An inbound A parent cannot turn B's saved SSH account into an implicit
    // grant on a foreign Core. A direct real B user keeps its existing owner path.
    const delegated = !!context?.routeDelegation || !!retained?.parent
    if (delegated) for (const [runtimeId, route] of [[input.agentRuntimeId, input.agentRoute], [input.resourceRuntimeId, input.resourceRoute]] as const) {
      if (runtimeId !== this.options.authority.runtimeId && !route) denied('The foreign endpoint has no adopted delegation for this original actor. Keep the original request and choose its explicitly approved route.', 'HOST_ROUTE_AUTHORIZATION_REQUIRED')
    }
    if (!input.agentRoute && !input.resourceRoute && !delegated && !retained) return undefined
    if (retained) {
      const original = verifyHostRouteExecutionAuthorization(retained)
      // Original scopes retain their signed shape. Their complete createDigest still
      // binds every frozen input field; an old parent never authorizes new fields.
      if (!isDeepStrictEqual(original.coordinator, await this.identity()) || !isDeepStrictEqual(original.scope, executionRouteScope(input, original.scope.kind === 'execution' && original.scope.launchDigest !== undefined))) denied('The original route admission no longer matches this frozen binding.', 'HOST_ROUTE_DERIVATION_MISMATCH')
      if (context) {
        const current = await this.origin(context)
        // A real local owner may explicitly inspect/continue its own admission.
        // Another routed viewer cannot borrow the creator's input authorization.
        if (context.routeDelegation && !isDeepStrictEqual(current.actor, original.actor)) denied('Another original actor cannot continue this admitted creation.', 'HOST_ROUTE_ACTOR_REQUIRED')
      }
      return original
    }
    if (existing || !context) denied('The original route admission is unconfirmed. Keep its original binding; no new origin was invented.', 'HOST_ROUTE_AUTHORITY_INVALID')
    return await this.authorizeExecution(input, context)
  }
  /** Original pre-admission metadata only; the caller must still carry the same exact parent. */
  async authorizePreparation(targetRuntimeId: string, context: AgentMuxRpcCallContext, originalCall?: HostRouteCall): Promise<HostRouteExecutionAuthorization> {
    const origin = await this.origin(context)
    const call = context.routeDelegation ? verified.get(context.routeDelegation)!.call : originalCall
    const operation = call ? hostRouteOperation(call) : undefined
    if (!operation || operation.kind !== 'spatial' && operation.kind !== 'execution') denied('Preparation needs the same original typed creation and target.', 'HOST_ROUTE_DERIVATION_MISMATCH')
    const target = operation.kind === 'spatial' ? operation.targetRuntimeId : operation.agentRuntimeId
    if (target !== targetRuntimeId || !operation.agentRoute) denied('Preparation needs the adopted route to the original Agent target.', 'HOST_ROUTE_TARGET_MISMATCH')
    return await this.options.authority.attestHostRouteExecution({ schema: 'agentmux.host-route-execution.v1', purpose: 'host-route-execution', ...origin,
      scope: { kind: 'preparation', targetRuntimeId, createOperationId: operation.createOperationId, executorId: operation.executorId, agentRoute: operation.agentRoute } })
  }
  /** Original Space/admission read owner supplies only its confirmed members.
   * This uses the current viewer's read parent, never a creator's frozen input grant. */
  async authorizeObservation(scope: HostRouteObservationScope, context: AgentMuxRpcCallContext): Promise<HostRouteExecutionAuthorization> {
    return await this.options.authority.attestHostRouteExecution({ schema: 'agentmux.host-route-execution.v1', purpose: 'host-route-execution',
      ...await this.origin(context), scope })
  }
  /** The original Space owner has already checked this exact member/admission.
   * It signs one current viewer action, never a creator's retained input grant. */
  async authorizeMemberControl(input: SpaceMemberParams[keyof SpaceMemberParams] & { createOperationId: string }, context: AgentMuxRpcCallContext): Promise<HostRouteExecutionAuthorization> {
    const identity = await this.identity(), stream = input.call.method === 'runtime.events' || input.call.method === 'runtime.attachment-watch' || input.call.method === 'runtime.replay-watch' || input.call.method === 'runtime.conversation-watch'
    const parsed = parseSpaceMemberParams(stream ? 'space.member.watch' : 'space.member.call', { target: input.target, call: input.call })
    if (parsed.target.reference.runtimeId !== identity.runtimeId) denied('This Core does not own the original member Space.', 'HOST_ROUTE_TARGET_MISMATCH')
    return await this.options.authority.attestHostRouteExecution({ schema: 'agentmux.host-route-execution.v1', purpose: 'host-route-execution', ...await this.origin(context),
      scope: { kind: 'member-control', operation: memberRouteOperation(parsed), createOperationId: rpcString(input.createOperationId, 'Original member creation operation') } })
  }
  /** A current viewer's original name parent authorizes exactly one local label method, never IO or creator control. */
  async authorizeMemberName(input: { method: 'space.member.name.inspect' | 'space.member.name.change'; input: NameControlParams['space.member.name.inspect'] | NameControlParams['space.member.name.change'] }, context: AgentMuxRpcCallContext): Promise<HostRouteExecutionAuthorization> {
    const identity = await this.identity(), parsed = parseNameControlParams(input.method, input.input)
    if (parsed.target.reference.runtimeId !== identity.runtimeId || parsed.object !== 'agent') denied('This Core does not own the original Source Agent name request.', 'HOST_ROUTE_TARGET_MISMATCH')
    return await this.options.authority.attestHostRouteExecution({ schema: 'agentmux.host-route-execution.v1', purpose: 'host-route-execution', ...await this.origin(context),
      scope: { kind: 'member-name', operation: memberNameRouteOperation(input.method, parsed) } })
  }
  /** Internal typed child port. No RPC accepts an authorization or actor from business JSON. */
  private async derived(input: HostRouteParams['route.call'], context: AgentMuxRpcCallContext, stream: boolean,
    derived: { authorization: HostRouteExecutionAuthorization; helper?: HostRouteStatement['helper']; preparationSessionId?: string }) {
    await this.state()
    const authorization = verifyHostRouteExecutionAuthorization(derived.authorization), route = input.adoptedRoute, identity = await this.identity()
    if (!isDeepStrictEqual(authorization.coordinator, identity) || !isDeepStrictEqual(route.source, identity)) denied('Only the original admission Core can issue this child.', 'HOST_ROUTE_SOURCE_MISMATCH')
    const selector = digest(route), call = parseHostRouteCall(input.call, stream)
    const authority = this.activeContext(context, (policy = this.policy) => {
      if (!policy.chains.has(selector)) denied('The original adopted route is no longer configured. Original bindings and Runs remain retained.', 'HOST_ROUTE_CHANGED')
    })
    try {
      await authority.current()
      const statement: HostRouteStatement = { schema: 'agentmux.host-route.v1', purpose: 'host-route', route, actor: authorization.actor,
        requestId: input.requestId, method: call.method, paramsDigest: digest(call.params), authorization,
        ...(derived.helper ? { helper: structuredClone(derived.helper) } : {}), ...(derived.preparationSessionId ? { preparationSessionId: derived.preparationSessionId } : {}) }
      assertExecutionChild(statement, call, stream)
      return { envelope: await this.options.authority.attestHostRoute(statement), call, authority }
    } catch (error) { authority.dispose(); throw error }
  }
  private async receiving(input: HostRouteParams['route.receive'], context: AgentMuxRpcCallContext, stream: boolean) {
    if (context.caller || !context.principal) denied('A managed caller cannot wrap itself in an approved transport account.', 'HOST_ROUTE_ACTOR_REQUIRED')
    await this.state()
    const call = parseHostRouteCall(input.call, stream), envelope = verifyHostRouteEnvelope(parseHostRouteEnvelope(input.envelope), call, await this.identity(), stream)
    const { statement } = envelope, index = envelope.endorsements.length
    const delegator = index === 1 ? statement.route.source : statement.route.hops[index - 2]!.target
    const destination = statement.route.hops.at(-1)!.target, scope = hostRouteScope(call, stream)
    const selector = grantKey(delegator, statement.actor, destination, scope)
    if (!this.policy.grants.has(selector)) denied('This receiving Core has not delegated this original actor, destination and finite method. Existing Agent capabilities remain available.')
    const authority = this.activeContext(context, (policy = this.policy) => {
      if (!policy.grants.has(selector)) denied('This original receiver grant was changed or revoked.')
    })
    try { await authority.current(); return { envelope, call, authority } }
    catch (error) { authority.dispose(); throw error }
  }
  private observation(envelope: HostRouteEnvelope): HostRouteObservation {
    return { route: structuredClone(envelope.statement.route), actor: structuredClone(envelope.statement.actor), requestId: envelope.statement.requestId,
      logicalHops: envelope.statement.route.hops.length, observedAt: Date.now(), complete: true }
  }
  private async next(envelope: HostRouteEnvelope, authority: { signal: AbortSignal; current(): Promise<void> }) {
    await authority.current()
    const hop = envelope.statement.route.hops[envelope.endorsements.length]!, edge = await this.transport(hop.edgeId, hop.kind === 'relay', hop.target)
    await authority.current()
    // The original receiver verifies its exact adopted identity before dispatch.
    // An independent metadata probe cannot gate this authenticated business call.
    return { edge, envelope: await this.options.authority.endorseHostRoute(envelope) }
  }
  async call(input: HostRouteParams['route.call'] | HostRouteParams['route.receive'], context: AgentMuxRpcCallContext, receive = false, derived?: { authorization: HostRouteExecutionAuthorization; helper?: HostRouteStatement['helper']; preparationSessionId?: string }) {
    const value = receive ? await this.receiving(input as HostRouteParams['route.receive'], context, false) : derived ? await this.derived(input as HostRouteParams['route.call'], context, false, derived) : await this.source(input as HostRouteParams['route.call'], context, false)
    try {
      if (value.envelope.endorsements.length < value.envelope.statement.route.hops.length) {
        const next = await this.next(value.envelope, value.authority)
        return await next.edge.call('route.receive', { envelope: next.envelope, call: value.call }, value.authority.signal)
      }
      const token = {} as VerifiedHostRouteDelegation
      verified.set(token, { envelope: value.envelope, actor: value.envelope.statement.actor, call: value.call, stream: false, assertCurrent: value.authority.current })
      const invocation = value.call.method === 'runtime.invoke' ? rpcRecord(decodeHostedValue(rpcRecord(value.call.params).invocation)) : undefined
      const prompt = invocation?.method === 'submitAgentPrompt' && Array.isArray(invocation.args) ? rpcRecord(invocation.args[0]) : undefined
      const rejoin = invocation?.method === 'rejoinAgentInputWaiting' && Array.isArray(invocation.args) ? rpcRecord(invocation.args[0]) : undefined
      const inputKey = prompt ? validateAgentPromptInputKey({ kind: 'prompt', agentSessionId: prompt.agentSessionId, expectedRun: prompt.expectedRun, submissionId: prompt.operationId })
        : rejoin ? validateAgentInputWaitRef(rejoin.ref).key : undefined
      const retain: AgentInputCallContext['retainAcceptedInputAuthority'] = inputKey ? async key => {
        if (!isDeepStrictEqual(key, inputKey)) denied('This accepted input differs from the original routed Session, Run or operation.', 'HOST_ROUTE_TARGET_MISMATCH')
        return await value.authority.retainForInput()
      } : undefined
      const result = await this.options.call(value.call.method as AgentMuxRpcMethod, value.call.params as AgentMuxRpcParams<AgentMuxRpcMethod>,
        { ...context, signal: value.authority.signal, assertCurrent: value.authority.current, routeDelegation: token, ...(retain ? { retainAcceptedInputAuthority: retain } : {}) })
      return { value: result, observation: this.observation(value.envelope) }
    } finally { value.authority.dispose() }
  }
  async watch(input: HostRouteParams['route.watch'] | HostRouteParams['route.receive-watch'], emit: (event: unknown) => void | Promise<void>, context: AgentMuxRpcCallContext, receive = false, derived?: { authorization: HostRouteExecutionAuthorization; helper?: HostRouteStatement['helper']; preparationSessionId?: string }) {
    const value = receive ? await this.receiving(input as HostRouteParams['route.receive-watch'], context, true) : derived ? await this.derived(input as HostRouteParams['route.watch'], context, true, derived) : await this.source(input as HostRouteParams['route.watch'], context, true)
    try {
      const relay = async (event: unknown) => { await value.authority.current(); await emit(event) }
      let subscription: { initial: HostRouteStreamInitial; start?(): void | Promise<void>; dispose(): void | Promise<void> }
      if (value.envelope.endorsements.length < value.envelope.statement.route.hops.length) {
        const next = await this.next(value.envelope, value.authority)
        subscription = await next.edge.watch({ envelope: next.envelope, call: value.call }, relay, value.authority.signal)
      } else {
        const token = {} as VerifiedHostRouteDelegation
        verified.set(token, { envelope: value.envelope, actor: value.envelope.statement.actor, call: value.call, stream: true, assertCurrent: value.authority.current })
        const original = await this.options.subscribe(value.call.method as AgentMuxRpcStreamMethod, value.call.params,
          event => relay(event), { ...context, signal: value.authority.signal, assertCurrent: value.authority.current, routeDelegation: token })
        subscription = { ...original, initial: { value: original.initial, observation: this.observation(value.envelope) } }
      }
      let closed = false
      const abort = () => {
        if (closed) return; closed = true
        const reason = value.authority.signal.reason
        void Promise.resolve().then(async () => {
          if (!context.signal?.aborted) await emit({ type: 'error', error: {
            code: reason instanceof AgentMuxError ? reason.code : 'HOST_ROUTE_READER_UNAVAILABLE',
            message: reason instanceof Error ? reason.message : 'The original route reader is unavailable. Keep its original cursor and operation.',
          } })
        }).finally(async () => { try { await subscription.dispose() } finally { value.authority.dispose() } }).catch(() => {})
      }
      value.authority.signal.addEventListener('abort', abort, { once: true }); if (value.authority.signal.aborted) abort()
      return { initial: subscription.initial, ...(subscription.start ? { start: () => subscription.start!() } : {}), dispose: async () => {
        closed = true
        value.authority.signal.removeEventListener('abort', abort)
        try { await subscription.dispose() } finally { value.authority.dispose() }
      } }
    } catch (error) { value.authority.dispose(); throw error }
  }
  dispose(): void { this.disposed = true; for (const item of this.active) item.controller.abort(new AgentMuxError('The original route reader is closed; durable operations remain retained.', 'HOST_ROUTE_READER_CLOSED')); this.active.clear(); for (const id of this.relayClients.keys()) this.releaseRelay(id) }
}
