import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { SPACE_MEMBER_INVOCATIONS } from './space-member.js'
import { parseHostExecutorInventory, type AgentMuxHostExecutorInventory } from './executor-contract.js'
import type { AgentMuxSpaceAgentTarget } from './space-control.js'

/** Semantic pins survive an owner restart; transport instance fences do not. */
export type HostRouteIdentity = { runtimeId: string; publicKey: string; fingerprint: string }
export type AdoptedHostRoute = {
  source: HostRouteIdentity
  /** Each edge belongs to the preceding Core's configured Host namespace. */
  hops: { edgeId: string; target: HostRouteIdentity }[]
}
export type HostRouteActor = { source: HostRouteIdentity; kind: 'user' | 'device'; id: string }
/** A saved outgoing edge, without transport endpoints or credentials. */
export type HostRouteEdge = { edgeId: string; label: string; kind: 'ssh'; runtimeId?: string }
export type HostRouteEdges = { identity: HostRouteIdentity; actor: HostRouteActor; edges: HostRouteEdge[]; observedAt: number }
export type HostRouteEdgeInspection = { identity: HostRouteIdentity; actor: HostRouteActor; edge: HostRouteEdge; target: HostRouteIdentity; observedAt: number }
export type HostRouteAgentTarget = AgentMuxSpaceAgentTarget & { adoptedRoute: AdoptedHostRoute }
export type HostRouteChoice = { id: string; agentTarget: HostRouteAgentTarget }
export type HostRouteChoices = { identity: HostRouteIdentity; actor: HostRouteActor; routes: HostRouteChoice[]; observedAt: number }
export type HostRouteExecutorRead = { agentTarget: HostRouteAgentTarget; executorId?: string; refresh?: boolean }
export type HostRouteExecutors = { routeId: string; agentTarget: HostRouteAgentTarget; inventory: AgentMuxHostExecutorInventory; observation: HostRouteObservation }

/** Only the real split-execution/Space consumers, not the Hosted SDK as a whole. */
export const HOST_ROUTE_INVOCATIONS = [
  'agentCreationAuthority', 'listHostExecutors', 'hostEnvironment', 'readAgentSession',
  'resolveAgentCreationSessionId', 'inspectAgentCreation', 'createHostAgentWithDelivery',
  'prepareAgentExecutionHelper', 'inspectPreparedTerminal', 'createPreparedTerminal',
  'attachTerminal', 'readRunReplay', 'writeTerminal', 'releaseRunAttachment', 'runtimeIdentity', 'runtimeSubject',
  ...SPACE_MEMBER_INVOCATIONS.filter(method => !['readAgentSession', 'runtimeSubject', 'attachTerminal', 'readRunReplay', 'releaseRunAttachment'].includes(method)),
] as const
export const HOST_ROUTE_CALLS = [
  'route.edges', 'route.edge.inspect', 'route.choices', 'route.executors',
  'runtime.owner.identity', 'runtime.bootstrap', 'runtime.invoke', 'runtime.release-consumer',
  'agent.open', 'space.ls', 'space.inspect', 'space.apply',
  'space.member.call',
  'agent.execution.create', 'agent.execution.binding', 'agent.execution.continue', 'agent.execution.rejoin',
] as const
export const HOST_ROUTE_STREAMS = [
  'runtime.events', 'runtime.attachment-watch', 'runtime.replay-watch',
  'space.snapshot', 'space.watch', 'space.sessions.watch',
  'space.member.watch',
] as const
export type HostRouteCall = { method: string; params: Record<string, unknown> }
export type HostRouteGrant = {
  id: string
  /** Receiver-approved immediate signer, independently from the original actor. */
  delegator: HostRouteIdentity
  actor: HostRouteActor
  destination: HostRouteIdentity
  /** Exact public method or runtime.invoke/<finite tag>. */
  scopes: string[]
}
export type HostRouteDefinition = { id: string; route: AdoptedHostRoute }
export type HostRouteConfiguration = { routes: HostRouteDefinition[]; grants: HostRouteGrant[] }
export type HostRouteSettings = HostRouteConfiguration & {
  identity: HostRouteIdentity
  revision: string
  /** Observed original save identity is distinct from its original durability ACK. */
  operation: { operationId: string; inputDigest: string } | null
}
export type HostRouteStatement = {
  schema: 'agentmux.host-route.v1'; purpose: 'host-route'
  route: AdoptedHostRoute; actor: HostRouteActor; requestId: string
  method: string; paramsDigest: string
  /** Safe selectors signed with the original call, never its prompt/environment. */
  operation?: HostRouteOperation
  /** B signs a child of the original admission; it never impersonates A. */
  authorization?: HostRouteExecutionAuthorization
  preparationSessionId?: string
  helper?: { role: 'frontend' | 'executor'; runId: string; ownerInstanceId: string }
}
export type HostRouteExecutionScope = {
  kind: 'execution'; bindingId: string; agentSessionId: string; createOperationId: string
  agentRuntimeId: string; resourceRuntimeId: string; agentWorkspacePath: string; resourceWorkspacePath: string
  executorId: string; executorRevision: string; createDigest: string; promptDigest: string
  agentRoute?: AdoptedHostRoute; resourceRoute?: AdoptedHostRoute
}
export type HostRoutePreparationScope = {
  kind: 'preparation'; targetRuntimeId: string; createOperationId: string; executorId: string
}
export type HostRouteSpatialOperation = {
  kind: 'spatial'; targetRuntimeId: string; createOperationId: string; executorId: string; promptDigest: string
  destination: Record<string, string | boolean>; agentRoute?: AdoptedHostRoute
}
export type HostRouteReadOperation = { kind: 'space-reader'; runtimeId: string; spaceId: string } | { kind: 'creation-reader'; createOperationId: string }
export type HostRouteObservationScope = { kind: 'observation'; targetRuntimeId: string; agentSessionIds: string[]; source: HostRouteReadOperation }
/** A safe projection of one exact current-viewer call, not a creator's input grant. */
export type HostRouteMemberOperation = { kind: 'space-member'; runtimeId: string; spaceId: string; regionId: string; targetRuntimeId: string; agentSessionId: string; runId: string; method: string; paramsDigest: string }
export type HostRouteMemberScope = { kind: 'member-control'; operation: HostRouteMemberOperation; createOperationId: string }
export type HostRouteExecutorOperation = { kind: 'executor-reader'; routeId: string; adoptedRoute: AdoptedHostRoute; targetRuntimeId: string; executorId?: string; refresh: boolean }
export type HostRouteInventoryScope = { kind: 'executor-inventory'; operation: HostRouteExecutorOperation }
export type HostRouteOperation = HostRouteExecutionScope | HostRouteSpatialOperation | HostRouteReadOperation | HostRouteMemberOperation | HostRouteExecutorOperation
export type HostRouteExecutionAuthorization = {
  schema: 'agentmux.host-route-execution.v1'; purpose: 'host-route-execution'
  coordinator: HostRouteIdentity; actor: HostRouteActor
  scope: HostRouteExecutionScope | HostRoutePreparationScope | HostRouteObservationScope | HostRouteMemberScope | HostRouteInventoryScope
  /** The original signed A parent. It cannot contain another derived child. */
  parent?: HostRouteEnvelope
  signature: string
}
export type HostRouteEndorsement = { index: number; previousDigest: string; signature: string }
export type HostRouteEnvelope = {
  statement: HostRouteStatement; signature: string; endorsements: HostRouteEndorsement[]
}
export type HostRouteObservation = {
  route: AdoptedHostRoute; requestId: string; actor: HostRouteActor
  /** Adopted protocol edges, not physical network/ProxyJump hops. */
  logicalHops: number; observedAt: number; complete: true
}
export const HOST_ROUTE_METHODS = {
  'route.identity': 'short', 'route.inspect': 'short', 'route.configure': 'long',
  'route.edges': 'short', 'route.edge.inspect': 'long',
  'route.choices': 'short', 'route.executors': 'long',
  'route.call': 'long', 'route.receive': 'long', 'route.watch': 'long', 'route.receive-watch': 'long',
} as const
export type HostRouteParams = {
  'route.identity': Record<string, never>
  'route.inspect': Record<string, never>
  'route.edges': Record<string, never>
  'route.edge.inspect': { edgeId: string }
  'route.choices': Record<string, never>
  'route.executors': HostRouteExecutorRead
  'route.configure': { expectedRevision: string; operationId: string; configuration: HostRouteConfiguration }
  'route.call': { routeId: string; adoptedRoute: AdoptedHostRoute; requestId: string; call: HostRouteCall }
  'route.watch': { routeId: string; adoptedRoute: AdoptedHostRoute; requestId: string; call: HostRouteCall }
  'route.receive': { envelope: HostRouteEnvelope; call: HostRouteCall }
  'route.receive-watch': { envelope: HostRouteEnvelope; call: HostRouteCall }
}
export type HostRouteResults = {
  'route.identity': HostRouteIdentity
  'route.inspect': HostRouteSettings
  'route.edges': HostRouteEdges
  'route.edge.inspect': HostRouteEdgeInspection
  'route.choices': HostRouteChoices
  'route.executors': HostRouteExecutors
  'route.configure': { settings: HostRouteSettings; diskDurability: 'confirmed' }
  'route.call': { value: unknown; observation: HostRouteObservation }
  'route.receive': { value: unknown; observation: HostRouteObservation }
  'route.watch': never
  'route.receive-watch': never
}
export type HostRouteStreamMethod = 'route.watch' | 'route.receive-watch'
export type HostRouteStreamInitial = { value: unknown; observation: HostRouteObservation }
export type HostRouteStreamEvent = { type: 'route-event'; event: unknown }

const invalid = (message: string): never => { throw new AgentMuxError(message, 'HOST_ROUTE_INVALID') }
// The original business owner defines ID/path validity. This carrier preserves
// its exact strings; the existing RPC frame already bounds physical input.
const originalString = (value: unknown, name: string): string => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value) ? value : invalid(`${name} must retain its original string.`)
const list = (value: unknown, name: string): unknown[] => Array.isArray(value) ? value : invalid(`${name} must be an array.`)
export function parseHostRouteIdentity(value: unknown): HostRouteIdentity {
  const p = rpcRecord(value, ['runtimeId', 'publicKey', 'fingerprint'])
  return { runtimeId: rpcString(p.runtimeId, 'Original route Runtime'), publicKey: rpcString(p.publicKey, 'Original route public key'), fingerprint: rpcString(p.fingerprint, 'Original route key fingerprint') }
}
export function parseAdoptedHostRoute(value: unknown): AdoptedHostRoute {
  const p = rpcRecord(value, ['source', 'hops']), source = parseHostRouteIdentity(p.source)
  const hops = list(p.hops, 'Route hops').map(value => {
    const hop = rpcRecord(value, ['edgeId', 'target'])
    return { edgeId: rpcString(hop.edgeId, 'Configured route edge'), target: parseHostRouteIdentity(hop.target) }
  })
  if (!hops.length) invalid('A route must name at least one configured edge; local calls retain their original owner.')
  const nodes = [source.runtimeId, ...hops.map(hop => hop.target.runtimeId)]
  if (new Set(nodes).size !== nodes.length) invalid('The exact adopted route contains a Runtime loop.')
  return { source, hops }
}
export function parseHostRouteActor(value: unknown): HostRouteActor {
  const p = rpcRecord(value, ['source', 'kind', 'id'])
  if (p.kind !== 'user' && p.kind !== 'device') invalid('A route needs its actual authenticated user/device; managed callers retain their own limited path.')
  return { source: parseHostRouteIdentity(p.source), kind: p.kind as HostRouteActor['kind'], id: rpcString(p.id, 'Original actor ID') }
}
export function hostRouteScope(call: HostRouteCall, stream: boolean): string {
  if (!(stream ? HOST_ROUTE_STREAMS : HOST_ROUTE_CALLS).some(method => method === call.method)) invalid('This method is outside the finite execution/Space route surface.')
  for (const key of ['caller', 'principal', 'delegation', 'forwarding']) if (Object.hasOwn(call.params, key)) invalid('Business arguments cannot supply route authority.')
  if (call.method !== 'runtime.invoke') return call.method
  const invocation = rpcRecord(call.params.invocation, ['method', 'args'])
  const method = rpcString(invocation.method, 'Original Hosted invocation')
  if (!HOST_ROUTE_INVOCATIONS.some(value => value === method)) invalid('This Hosted invocation is outside the finite execution route surface.')
  return `runtime.invoke/${method}`
}
export function parseHostRouteCall(value: unknown, stream: boolean): HostRouteCall {
  const p = rpcRecord(value, ['method', 'params'])
  const call = { method: rpcString(p.method, 'Original routed method'), params: rpcRecord(p.params) }
  hostRouteScope(call, stream)
  return call
}
export function parseHostRouteConfiguration(value: unknown): HostRouteConfiguration {
  const p = rpcRecord(value, ['routes', 'grants'])
  const routes = list(p.routes, 'Configured routes').map(value => {
    const item = rpcRecord(value, ['id', 'route'])
    return { id: rpcString(item.id, 'Original route ID'), route: parseAdoptedHostRoute(item.route) }
  })
  const grants = list(p.grants, 'Receiver grants').map(value => {
    const item = rpcRecord(value, ['id', 'delegator', 'actor', 'destination', 'scopes'])
    const scopes = list(item.scopes, 'Finite route scopes').map(scope => rpcString(scope, 'Exact route scope'))
    const valid = [...HOST_ROUTE_CALLS.filter(m => m !== 'runtime.invoke'), ...HOST_ROUTE_STREAMS, ...HOST_ROUTE_INVOCATIONS.map(m => `runtime.invoke/${m}`)]
    if (scopes.some(scope => !valid.includes(scope as typeof valid[number])) || new Set(scopes).size !== scopes.length) invalid('Receiver grant scopes must name distinct finite original methods.')
    return { id: rpcString(item.id, 'Original receiver grant ID'), delegator: parseHostRouteIdentity(item.delegator), actor: parseHostRouteActor(item.actor), destination: parseHostRouteIdentity(item.destination), scopes }
  })
  if (new Set(routes.map(r => r.id)).size !== routes.length || new Set(grants.map(g => g.id)).size !== grants.length) invalid('Route and receiver grant IDs must be unique on their original owner.')
  return { routes, grants }
}
export function parseHostRouteOperation(value: unknown): HostRouteOperation {
  const kind = rpcRecord(value).kind
  if (kind === 'executor-reader') {
    const p = rpcRecord(value, ['kind','routeId','adoptedRoute','targetRuntimeId','executorId','refresh'])
    if (typeof p.refresh !== 'boolean') invalid('The original executor read needs its exact refresh intent.')
    const operation = hostRouteExecutorOperation({ agentTarget: { hostId: p.routeId, runtimeId: p.targetRuntimeId, adoptedRoute: p.adoptedRoute }, refresh: p.refresh,
      ...(p.executorId === undefined ? {} : { executorId: p.executorId }) })
    if (p.targetRuntimeId !== operation.targetRuntimeId) invalid('The executor read names another adopted target.')
    return operation
  }
  if (kind === 'space-member') {
    const fields = ['runtimeId','spaceId','regionId','targetRuntimeId','agentSessionId','runId','method','paramsDigest'] as const
    const p = rpcRecord(value, ['kind',...fields])
    return { kind, ...Object.fromEntries(fields.map(key => [key, originalString(p[key], `Original member ${key}`)])) } as HostRouteMemberOperation
  }
  if (kind === 'space-reader') {
    const p = rpcRecord(value, ['kind','runtimeId','spaceId'])
    return { kind, runtimeId: rpcString(p.runtimeId, 'Original Space Runtime'), spaceId: rpcString(p.spaceId, 'Original Space') }
  }
  if (kind === 'creation-reader') {
    const p = rpcRecord(value, ['kind','createOperationId'])
    return { kind, createOperationId: rpcString(p.createOperationId, 'Original creation operation') }
  }
  if (kind === 'spatial') {
    const p = rpcRecord(value, ['kind','targetRuntimeId','createOperationId','executorId','promptDigest','destination','agentRoute'])
    const destination = rpcRecord(p.destination, ['spaceId','zoneId','tabId','regionId','displayWorkspaceId','groupId','newTab'])
    for (const [key, value] of Object.entries(destination)) {
      if (key === 'newTab' ? typeof value !== 'boolean' : typeof value !== 'string' || !value) invalid('The original source destination is invalid.')
    }
    return { kind, targetRuntimeId: rpcString(p.targetRuntimeId, 'Original target Runtime'), createOperationId: originalString(p.createOperationId, 'Original CID'),
      executorId: originalString(p.executorId, 'Original Executor'), promptDigest: rpcString(p.promptDigest, 'Original input digest'), destination: destination as Record<string,string|boolean>,
      ...(p.agentRoute === undefined ? {} : { agentRoute: parseAdoptedHostRoute(p.agentRoute) }) }
  }
  if (kind !== 'execution') invalid('This parent has no bounded execution operation.')
  const p = rpcRecord(value, ['kind','bindingId','agentSessionId','createOperationId','agentRuntimeId','resourceRuntimeId','agentWorkspacePath','resourceWorkspacePath','executorId','executorRevision','createDigest','promptDigest','agentRoute','resourceRoute'])
  const fields = ['bindingId','agentSessionId','createOperationId','agentRuntimeId','resourceRuntimeId','agentWorkspacePath','resourceWorkspacePath','executorId','executorRevision','createDigest','promptDigest'] as const
  const result = { kind: 'execution' as const, ...Object.fromEntries(fields.map(key => [key,originalString(p[key], `Original ${key}`)])) } as HostRouteExecutionScope
  if (p.agentRoute !== undefined) result.agentRoute = parseAdoptedHostRoute(p.agentRoute)
  if (p.resourceRoute !== undefined) result.resourceRoute = parseAdoptedHostRoute(p.resourceRoute)
  return result
}
export function parseHostRouteExecutionAuthorization(value: unknown): HostRouteExecutionAuthorization {
  const p = rpcRecord(value, ['schema','purpose','coordinator','actor','scope','parent','signature'])
  if (p.schema !== 'agentmux.host-route-execution.v1' || p.purpose !== 'host-route-execution') invalid('This signature has another execution purpose.')
  let scope: HostRouteExecutionAuthorization['scope']
  if (rpcRecord(p.scope).kind === 'executor-inventory') {
    const s = rpcRecord(p.scope, ['kind','operation']), operation = parseHostRouteOperation(s.operation)
    if (operation.kind !== 'executor-reader') invalid('An inventory child needs the exact original executor read.')
    scope = { kind: 'executor-inventory', operation: operation as HostRouteExecutorOperation }
  } else if (rpcRecord(p.scope).kind === 'member-control') {
    const s = rpcRecord(p.scope, ['kind','operation','createOperationId']), operation = parseHostRouteOperation(s.operation)
    if (operation.kind !== 'space-member') invalid('A member control needs its exact original member operation.')
    scope = { kind: 'member-control', operation: operation as HostRouteMemberOperation, createOperationId: originalString(s.createOperationId, 'Original member creation operation') }
  } else if (rpcRecord(p.scope).kind === 'observation') {
    const s = rpcRecord(p.scope, ['kind','targetRuntimeId','agentSessionIds','source'])
    const source = parseHostRouteOperation(s.source)
    if (source.kind !== 'space-reader' && source.kind !== 'creation-reader') invalid('An observation must retain its original read scope.')
    const agentSessionIds = list(s.agentSessionIds, 'Exact observed Sessions').map(id => rpcString(id, 'Original member SID'))
    if (!agentSessionIds.length || new Set(agentSessionIds).size !== agentSessionIds.length) invalid('An observation needs distinct original members.')
    scope = { kind: 'observation', targetRuntimeId: rpcString(s.targetRuntimeId, 'Original Session Runtime'), agentSessionIds, source: source as HostRouteReadOperation }
  } else if (rpcRecord(p.scope).kind === 'preparation') {
    const s = rpcRecord(p.scope, ['kind','targetRuntimeId','createOperationId','executorId'])
    scope = { kind: 'preparation', targetRuntimeId: rpcString(s.targetRuntimeId, 'Original target Runtime'), createOperationId: originalString(s.createOperationId, 'Original CID'), executorId: originalString(s.executorId, 'Original Executor') }
  } else scope = parseHostRouteOperation(p.scope) as HostRouteExecutionScope
  if (scope.kind !== 'execution' && scope.kind !== 'preparation' && scope.kind !== 'observation' && scope.kind !== 'member-control' && scope.kind !== 'executor-inventory') invalid('This execution authorization has another scope.')
  return { schema: 'agentmux.host-route-execution.v1', purpose: 'host-route-execution', coordinator: parseHostRouteIdentity(p.coordinator), actor: parseHostRouteActor(p.actor), scope,
    ...(p.parent === undefined ? {} : { parent: parseHostRouteEnvelope(p.parent, true) }), signature: rpcString(p.signature, 'Original coordinator signature') }
}
export function parseHostRouteEnvelope(value: unknown, parent = false): HostRouteEnvelope {
  const p = rpcRecord(value, ['statement', 'signature', 'endorsements'])
  const s = rpcRecord(p.statement, ['schema', 'purpose', 'route', 'actor', 'requestId', 'method', 'paramsDigest', 'operation', 'authorization', 'helper', 'preparationSessionId'])
  if (s.schema !== 'agentmux.host-route.v1' || s.purpose !== 'host-route') invalid('This signature has another protocol purpose.')
  const statement: HostRouteStatement = { schema: 'agentmux.host-route.v1', purpose: 'host-route', route: parseAdoptedHostRoute(s.route), actor: parseHostRouteActor(s.actor), requestId: rpcString(s.requestId, 'Original route request'), method: rpcString(s.method, 'Original routed method'), paramsDigest: rpcString(s.paramsDigest, 'Original call digest') }
  if (s.operation !== undefined) statement.operation = parseHostRouteOperation(s.operation)
  if (s.authorization !== undefined) {
    if (parent) invalid('A derived child cannot become another original parent.')
    statement.authorization = parseHostRouteExecutionAuthorization(s.authorization)
  }
  if (s.preparationSessionId !== undefined) statement.preparationSessionId = rpcString(s.preparationSessionId, 'Original CID-resolved Session')
  if (s.helper !== undefined) {
    const h = rpcRecord(s.helper, ['role', 'runId', 'ownerInstanceId'])
    if (h.role !== 'frontend' && h.role !== 'executor') invalid('A helper needs its original role.')
    statement.helper = { role: h.role as 'frontend' | 'executor', runId: rpcString(h.runId, 'Original helper Run'), ownerInstanceId: rpcString(h.ownerInstanceId, 'Original helper owner') }
  }
  return { statement, signature: rpcString(p.signature, 'Original source signature'), endorsements: list(p.endorsements, 'Original endorsements').map(value => {
    const e = rpcRecord(value, ['index', 'previousDigest', 'signature'])
    if (!Number.isSafeInteger(e.index) || Number(e.index) < 0) invalid('The original route endorsement index is invalid.')
    return { index: e.index as number, previousDigest: rpcString(e.previousDigest, 'Previous route digest'), signature: rpcString(e.signature, 'Original hop signature') }
  }) }
}

export function parseHostRouteParams<M extends keyof HostRouteParams>(method: M, value: unknown): HostRouteParams[M] {
  if (method === 'route.identity' || method === 'route.inspect' || method === 'route.edges' || method === 'route.choices') return rpcRecord(value, []) as HostRouteParams[M]
  if (method === 'route.executors') {
    const p = rpcRecord(value, ['agentTarget','executorId','refresh'])
    if (p.refresh !== undefined && typeof p.refresh !== 'boolean') invalid('Executor refresh must be boolean.')
    return { agentTarget: parseHostRouteAgentTarget(p.agentTarget),
      ...(p.executorId === undefined ? {} : { executorId: rpcString(p.executorId, 'Original Executor') }), refresh: p.refresh ?? false } as HostRouteParams[M]
  }
  if (method === 'route.edge.inspect') {
    const p = rpcRecord(value, ['edgeId'])
    return { edgeId: rpcString(p.edgeId, 'Exact saved edge') } as HostRouteParams[M]
  }
  if (method === 'route.configure') {
    const p = rpcRecord(value, ['expectedRevision', 'operationId', 'configuration'])
    return { expectedRevision: rpcString(p.expectedRevision, 'Original route revision'), operationId: rpcString(p.operationId, 'Original save operation'), configuration: parseHostRouteConfiguration(p.configuration) } as HostRouteParams[M]
  }
  const receive = method === 'route.receive' || method === 'route.receive-watch', stream = method === 'route.watch' || method === 'route.receive-watch'
  const p = rpcRecord(value, receive ? ['envelope', 'call'] : ['routeId', 'adoptedRoute', 'requestId', 'call'])
  const call = parseHostRouteCall(p.call, stream)
  return (receive ? { envelope: parseHostRouteEnvelope(p.envelope), call } : {
    routeId: rpcString(p.routeId, 'Exact configured route'), adoptedRoute: parseAdoptedHostRoute(p.adoptedRoute), requestId: rpcString(p.requestId, 'Original route request'), call,
  }) as HostRouteParams[M]
}
export function parseHostRouteObservation(value: unknown): HostRouteObservation {
  const p = rpcRecord(value, ['route', 'requestId', 'actor', 'logicalHops', 'observedAt', 'complete']), route = parseAdoptedHostRoute(p.route)
  if (p.logicalHops !== route.hops.length || p.complete !== true || typeof p.observedAt !== 'number' || !Number.isFinite(p.observedAt)) invalid('The exact adopted route observation is invalid.')
  return { route, actor: parseHostRouteActor(p.actor), requestId: rpcString(p.requestId, 'Original route request'), logicalHops: route.hops.length, observedAt: p.observedAt as number, complete: true }
}
export function parseHostRouteResult(method: keyof HostRouteParams, value: unknown): unknown {
  if (method === 'route.identity') return parseHostRouteIdentity(value)
  if (method === 'route.choices') {
    const p = rpcRecord(value, ['identity','actor','routes','observedAt']), identity = parseHostRouteIdentity(p.identity)
    if (typeof p.observedAt !== 'number' || !Number.isFinite(p.observedAt)) invalid('The original route choice time is invalid.')
    const routes = list(p.routes, 'Saved route choices').map(value => {
      const r = rpcRecord(value, ['id','agentTarget']), id = rpcString(r.id, 'Original saved route'), agentTarget = parseHostRouteAgentTarget(r.agentTarget, id)
      if (JSON.stringify(agentTarget.adoptedRoute.source) !== JSON.stringify(identity)) invalid('The route choice belongs to another source Core.')
      return { id, agentTarget }
    })
    if (new Set(routes.map(r => r.id)).size !== routes.length) invalid('Original route choice IDs must be unique.')
    return { identity, actor: parseHostRouteActor(p.actor), routes, observedAt: p.observedAt }
  }
  if (method === 'route.executors') {
    const p = rpcRecord(value, ['routeId','agentTarget','inventory','observation']), routeId = rpcString(p.routeId, 'Original saved route')
    const agentTarget = parseHostRouteAgentTarget(p.agentTarget, routeId), inventory = parseHostExecutorInventory(p.inventory), observation = parseHostRouteObservation(p.observation)
    if (inventory.runtimeId !== agentTarget.runtimeId || JSON.stringify(agentTarget.adoptedRoute) !== JSON.stringify(observation.route)) invalid('The executor inventory belongs to another adopted target or route.')
    return { routeId, agentTarget, inventory, observation }
  }
  if (method === 'route.edges' || method === 'route.edge.inspect') {
    const p = rpcRecord(value, method === 'route.edges' ? ['identity', 'actor', 'edges', 'observedAt'] : ['identity', 'actor', 'edge', 'target', 'observedAt'])
    if (typeof p.observedAt !== 'number' || !Number.isFinite(p.observedAt)) invalid('The edge observation time is invalid.')
    const base = { identity: parseHostRouteIdentity(p.identity), actor: parseHostRouteActor(p.actor), observedAt: p.observedAt }
    return method === 'route.edges' ? { ...base, edges: list(p.edges, 'Saved outgoing edges').map(parseHostRouteEdge) }
      : { ...base, edge: parseHostRouteEdge(p.edge), target: parseHostRouteIdentity(p.target) }
  }
  if (method === 'route.configure') {
    const p = rpcRecord(value, ['settings', 'diskDurability'])
    if (p.diskDurability !== 'confirmed') invalid('This save did not return its original durable write acknowledgement.')
    return { settings: parseHostRouteResult('route.inspect', p.settings), diskDurability: 'confirmed' }
  }
  if (method === 'route.inspect') {
    const p = rpcRecord(value, ['identity', 'revision', 'operation', 'routes', 'grants'])
    const operation = p.operation === null ? null : rpcRecord(p.operation, ['operationId', 'inputDigest'])
    return { identity: parseHostRouteIdentity(p.identity), revision: rpcString(p.revision, 'Original route revision'),
      operation: operation ? { operationId: rpcString(operation.operationId, 'Original save operation'), inputDigest: rpcString(operation.inputDigest, 'Original save digest') } : null,
      ...parseHostRouteConfiguration({ routes: p.routes, grants: p.grants }) }
  }
  const p = rpcRecord(value, ['value', 'observation'])
  return { value: p.value, observation: parseHostRouteObservation(p.observation) }
}

/** A typed original read parent. This contains no creation/input authority. */
export function hostRouteExecutorOperation(value: unknown): HostRouteExecutorOperation {
  const input = parseHostRouteParams('route.executors', value)
  return { kind: 'executor-reader', routeId: input.agentTarget.hostId, adoptedRoute: input.agentTarget.adoptedRoute,
    targetRuntimeId: input.agentTarget.runtimeId, refresh: input.refresh ?? false,
    ...(input.executorId === undefined ? {} : { executorId: input.executorId }) }
}
export function parseHostRouteAgentTarget(value: unknown, expectedRouteId?: string): HostRouteAgentTarget {
  const p = rpcRecord(value, ['hostId','runtimeId','adoptedRoute']), adoptedRoute = parseAdoptedHostRoute(p.adoptedRoute)
  const hostId = rpcString(p.hostId, 'Original saved route')
  if (expectedRouteId !== undefined && hostId !== expectedRouteId || p.runtimeId !== adoptedRoute.hops.at(-1)!.target.runtimeId) invalid('The Agent target does not match this original route choice.')
  return { hostId, runtimeId: p.runtimeId as string, adoptedRoute }
}

export function parseHostRouteEdge(value: unknown): HostRouteEdge {
  const p = rpcRecord(value, ['edgeId', 'label', 'kind', 'runtimeId'])
  if (p.kind !== 'ssh') invalid('An outgoing edge must be an original saved remote Host.')
  return { edgeId: rpcString(p.edgeId, 'Exact saved edge'), label: rpcString(p.label, 'Saved Host label'), kind: 'ssh',
    ...(p.runtimeId === undefined ? {} : { runtimeId: rpcString(p.runtimeId, 'Known saved Runtime') }) }
}
