import { parseNameControlParams, memberAgentNameInput } from './name-control.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { agentCreationIntentDigest as digest } from './agent-creation-authority.js'
import { parseAgentExecutionCreate } from './public-rpc-agent-execution.js'
import { rpcControlRequest } from './rpc-business-codec.js'
import { decodeHostedValue } from './hosted-value.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { assertSpaceMemberCall, parseSpaceMemberParams } from './space-member-codec.js'
import type { SpaceMemberParams } from './space-member.js'
import type { AgentExecutionOpenInput } from './agent-execution-coordinator.js'
import type { HostRouteCall, HostRouteExecutionScope, HostRouteOperation, HostRouteExecutionAuthorization, HostRouteStatement, HostRouteMemberOperation, HostRouteMemberNameOperation } from './host-route.js'
import { hostRouteExecutorOperation } from './host-route.js'
import { parseAgentOpenDescribe, parseAgentOpenLaunchFields } from './agent-open-contract.js'
import { parseHostEnvironmentSelector } from './host-environment.js'

function deny(): never { throw new AgentMuxError('This child does not belong to the original authorized creation and exact target.', 'HOST_ROUTE_DERIVATION_MISMATCH') }
export const executionCreationId = (bindingId: string, role: string) => createHash('sha256').update(JSON.stringify([bindingId, role])).digest('hex')
function launchContribution(input: Record<string, unknown>): { launchDigest?: string } {
  const fields = parseAgentOpenLaunchFields(input)
  return Object.keys(fields).length ? { launchDigest: digest(fields) } : {}
}
export function executionRouteScope(input: AgentExecutionOpenInput, includeLaunchContribution = true): HostRouteExecutionScope {
  const toolExecution = { bindingId: input.bindingId, resourceHostId: input.resourceHostId, resourceRuntimeId: input.resourceRuntimeId, workspacePath: input.resourceWorkspacePath }
  return { kind: 'execution', bindingId: input.bindingId, agentSessionId: input.agent.agentSessionId, createOperationId: input.agent.createOperationId,
    agentRuntimeId: input.agentRuntimeId, resourceRuntimeId: input.resourceRuntimeId, agentWorkspacePath: input.agent.workspacePath, resourceWorkspacePath: input.resourceWorkspacePath,
    executorId: input.agent.executorId, executorRevision: input.agent.executorRevision, createDigest: digest({ ...input.agent, toolExecution }), promptDigest: digest(input.agent.prompt ?? null),
    ...(includeLaunchContribution ? launchContribution(input.agent) : {}),
    ...(input.agentRoute ? { agentRoute: input.agentRoute } : {}), ...(input.resourceRoute ? { resourceRoute: input.resourceRoute } : {}) }
}
export function memberRouteOperation(input: SpaceMemberParams[keyof SpaceMemberParams]): HostRouteMemberOperation {
  const { target, call } = input
  return { kind: 'space-member', runtimeId: target.reference.runtimeId, spaceId: target.reference.spaceId, regionId: target.regionId,
    targetRuntimeId: target.runtimeId, agentSessionId: target.agentSessionId, ...('expectedRun' in target ? { runId: target.expectedRun.runId } : { access: target.kind }), method: call.method, paramsDigest: digest(call.params),
    ...(target.expectedAdmission ? { expectedAdmission: target.expectedAdmission } : {}) }
}
export function memberNameRouteOperation(method: 'space.member.name.inspect' | 'space.member.name.change', input: unknown): HostRouteMemberNameOperation {
  const parsed = parseNameControlParams(method, input), target = parsed.target
  return { kind: 'space-member-name', runtimeId: target.reference.runtimeId, spaceId: target.reference.spaceId, regionId: target.regionId,
    targetRuntimeId: target.runtimeId, agentSessionId: target.agentSessionId, expectedAdmission: target.expectedAdmission, object: parsed.object,
    method: method === 'space.member.name.change' ? 'agent.name.change' : 'agent.name.inspect', paramsDigest: digest(parsed.object === 'agent' ? memberAgentNameInput(parsed) : parsed) }
}
/** Project only the original schema owner's parsed selectors, never the input text. */
export function hostRouteOperation(call: HostRouteCall): HostRouteOperation | undefined {
  if (call.method === 'space.member.name.inspect' || call.method === 'space.member.name.change') {
    const input = parseNameControlParams(call.method, call.params)
    // A Source Tab never delegates to the execution Core. Its exact original
    // method/parameters are already protected by the signed parent envelope.
    return input.object === 'agent' ? memberNameRouteOperation(call.method, input) : undefined
  }
  if (call.method === 'route.executors') return hostRouteExecutorOperation(call.params)
  if (call.method === 'space.member.call' || call.method === 'space.member.watch') return memberRouteOperation(parseSpaceMemberParams(call.method, call.params))
  if (call.method === 'agent.execution.create') return executionRouteScope(parseAgentExecutionCreate(call.params))
  if (call.method === 'space.sessions.watch' || call.method === 'space.snapshot' || call.method === 'space.watch') {
    const p = rpcRecord(call.params.reference, ['runtimeId','spaceId'])
    return { kind: 'space-reader', runtimeId: rpcString(p.runtimeId, 'Original Space Runtime'), spaceId: rpcString(p.spaceId, 'Original Space') }
  }
  if (call.method === 'space.inspect') {
    const p = rpcRecord(call.params.target)
    if (typeof p.operationId === 'string') return { kind: 'creation-reader', createOperationId: p.operationId }
  }
  if (call.method === 'agent.open.describe') {
    const input = parseAgentOpenDescribe(call.params), target = input.execution?.agentTarget
    if (target) return { kind: 'input-epoch-reader', targetRuntimeId: target.runtimeId, ...(target.adoptedRoute ? { agentRoute: target.adoptedRoute } : {}) }
  }
  if (call.method !== 'agent.open') return undefined
  // A routed write must already have its retained business ID. A route nonce is not a creation ID.
  rpcString(call.params.operationId, 'Original Agent open operation')
  const request = rpcControlRequest('agent.open', call.params)
  if (request.operation !== 'agent.open' || request.content.kind !== 'new-agent' || !request.content.agentTarget) return undefined
  return { kind: 'spatial', createOperationId: request.requestId, targetRuntimeId: request.content.agentTarget.runtimeId,
    executorId: request.content.executorId, promptDigest: digest(request.content.prompt ?? null), destination: request.destination as Record<string,string|boolean>,
    ...launchContribution(request.content),
    ...(request.content.agentTarget.adoptedRoute ? { agentRoute: request.content.agentTarget.adoptedRoute } : {}) }
}
export function assertExecutionParent(authorization: HostRouteExecutionAuthorization): void {
  const { parent, actor, coordinator, scope } = authorization
  if (scope.kind === 'executor-inventory' && !isDeepStrictEqual(scope.operation.adoptedRoute.source, coordinator)) deny()
  if ((scope.kind === 'member-control' || scope.kind === 'member-name') && scope.operation.runtimeId !== coordinator.runtimeId) deny()
  if (!parent) { if (!isDeepStrictEqual(actor.source, coordinator)) deny(); return }
  const root = parent.statement
  if (root.authorization || !isDeepStrictEqual(root.actor, actor) || !isDeepStrictEqual(root.route.hops.at(-1)!.target, coordinator) || parent.endorsements.length !== root.route.hops.length) deny()
  const operation = root.operation
  if (!operation) deny()
  if (scope.kind === 'executor-inventory') {
    if (!isDeepStrictEqual(operation, scope.operation)) deny()
    return
  }
  if (scope.kind === 'member-control' || scope.kind === 'member-name') {
    if (!isDeepStrictEqual(operation, scope.operation)) deny()
    return
  }
  if (scope.kind === 'observation') {
    if (!isDeepStrictEqual(scope.source, operation)) deny()
    return
  }
  if (operation.kind !== 'spatial' && operation.kind !== 'execution') deny()
  if (scope.kind === 'preparation') {
    const target = operation.kind === 'spatial' ? operation.targetRuntimeId : operation.agentRuntimeId
    if (scope.targetRuntimeId !== target || scope.createOperationId !== operation.createOperationId || scope.executorId !== operation.executorId) deny()
  } else if (operation.kind === 'execution') {
    if (!isDeepStrictEqual(scope, operation)) deny()
  } else if (scope.agentRuntimeId !== operation.targetRuntimeId || scope.resourceRuntimeId !== coordinator.runtimeId ||
    scope.createOperationId !== operation.createOperationId || scope.executorId !== operation.executorId || scope.promptDigest !== operation.promptDigest || scope.launchDigest !== operation.launchDigest ||
    !isDeepStrictEqual(scope.agentRoute, operation.agentRoute)) deny()
}
/** Original business/Native owners still validate their full DTO and effect receipt. This
 * check prevents a reusable child carrier from becoming another Session/Host surface. */
export function assertExecutionChild(statement: HostRouteStatement, call: HostRouteCall, stream: boolean): void {
  const authorization = statement.authorization
  if (!authorization) return
  assertExecutionParent(authorization)
  if (!isDeepStrictEqual(statement.actor, authorization.actor) || !isDeepStrictEqual(statement.route.source, authorization.coordinator)) deny()
  const scope = authorization.scope, destination = statement.route.hops.at(-1)!.target.runtimeId
  if (scope.kind === 'executor-inventory') {
    const operation = scope.operation
    if (stream || destination !== operation.targetRuntimeId || !isDeepStrictEqual(statement.route, operation.adoptedRoute)) deny()
    if (call.method === 'runtime.owner.identity') {
      if (rpcRecord(call.params, ['expectedRuntimeId']).expectedRuntimeId !== operation.targetRuntimeId) deny()
      return
    }
    if (call.method !== 'runtime.invoke') deny()
    const invocation = rpcRecord(decodeHostedValue(call.params.invocation), ['method','args'])
    if (invocation.method !== 'listHostExecutors' || !Array.isArray(invocation.args) || invocation.args.length !== 1 ||
        !isDeepStrictEqual(invocation.args[0], { refresh: operation.refresh, ...(operation.executorId === undefined ? {} : { executorId: operation.executorId }) })) deny()
    return
  }
  if (scope.kind === 'member-name') {
    const operation = scope.operation
    if (stream || operation.object !== 'agent' || destination !== operation.targetRuntimeId || call.method !== operation.method || digest(call.params) !== operation.paramsDigest) deny()
    const input = parseNameControlParams(operation.method, call.params)
    if (input.runtimeId !== operation.targetRuntimeId || input.agentSessionId !== operation.agentSessionId || operation.expectedAdmission.kind !== 'creation' ||
        'change' in input && input.createOperationId !== operation.expectedAdmission.operationId) deny()
    return
  }
  if (scope.kind === 'member-control') {
    const operation = scope.operation
    if (destination !== operation.targetRuntimeId) deny()
    const target = { reference: { runtimeId: operation.runtimeId, spaceId: operation.spaceId }, regionId: operation.regionId,
      runtimeId: operation.targetRuntimeId, agentSessionId: operation.agentSessionId, ...(operation.access ? { kind: operation.access } : { expectedRun: { runId: operation.runId } }),
      ...(operation.expectedAdmission ? { expectedAdmission: operation.expectedAdmission } : {}) }
    assertSpaceMemberCall(operation.access ? { ...target, kind: operation.access, expectedAdmission: operation.expectedAdmission! } : target as import('./space-member.js').SpaceMemberTarget, call, stream)
    // Exact metadata is the original action's target check. It cannot submit
    // input, read another SID or turn a snapshot parent into an input grant.
    if (call.method === 'runtime.owner.identity') return
    if (call.method === 'runtime.invoke') {
      const invocation = rpcRecord(decodeHostedValue(call.params.invocation))
      if (invocation.method === 'readAgentSession' || invocation.method === 'runtimeSubject') return
    }
    if (call.method !== operation.method || digest(call.params) !== operation.paramsDigest) deny()
    return
  }
  const roles: ('frontend' | 'executor')[] = []
  if (scope.kind === 'execution') {
    if (destination === scope.agentRuntimeId && isDeepStrictEqual(statement.route, scope.agentRoute)) roles.push('frontend')
    if (destination === scope.resourceRuntimeId && isDeepStrictEqual(statement.route, scope.resourceRoute)) roles.push('executor')
    if (!roles.length) deny()
  } else if (destination !== scope.targetRuntimeId) deny()
  if (scope.kind === 'observation' && scope.source.kind === 'input-epoch-reader') {
    if (stream || !isDeepStrictEqual(statement.route, scope.source.agentRoute)) deny()
    if (call.method === 'runtime.owner.identity') return
    if (call.method !== 'runtime.invoke') deny()
    const invocation = rpcRecord(decodeHostedValue(call.params.invocation), ['method','args'])
    if (invocation.method !== 'readAgentInputEpoch' || !Array.isArray(invocation.args) || invocation.args.length !== 0) deny()
    return
  }
  const observed = scope.kind === 'observation' ? scope.agentSessionIds : scope.kind === 'execution' && destination === scope.agentRuntimeId ? [scope.agentSessionId] : []
  if (call.method === 'runtime.owner.identity' || call.method === 'runtime.release-consumer') return
  if (call.method === 'runtime.bootstrap' || call.method === 'runtime.events') {
    if (scope.kind === 'preparation' || !Array.isArray(call.params.agentSessionIds) || !call.params.agentSessionIds.length || call.params.agentSessionIds.some(id => !observed.includes(id))) deny()
    return
  }
  const helper = statement.helper
  const run = (value: unknown) => typeof value === 'string' ? value : rpcRecord(value).runId
  const checkRun = (value: unknown) => {
    if (scope.kind !== 'execution' || !helper || !roles.includes(helper.role) || run(value) !== helper.runId) deny()
  }
  if (call.method === 'runtime.attachment-watch' || call.method === 'runtime.replay-watch') { checkRun(call.params.target); return }
  if (call.method !== 'runtime.invoke' || stream) deny()
  const invocation = rpcRecord(decodeHostedValue(call.params.invocation), ['method','args'])
  if (!Array.isArray(invocation.args)) deny()
  const [value, second] = invocation.args as unknown[], method = invocation.method
  if (scope.kind === 'observation') {
    if (method === 'readAgentSession' || method === 'inspectAgentCreation') { if (typeof value !== 'string' || !observed.includes(value)) deny(); return }
    if (method === 'runtimeSubject') { const target = rpcRecord(value); if (target.kind !== 'agent-session' || typeof target.agentSessionId !== 'string' || !observed.includes(target.agentSessionId)) deny(); return }
    deny()
  }
  if (method === 'runtimeIdentity' || method === 'agentCreationAuthority') return
  if (scope.kind === 'execution' && ['hostEnvironment','listHostExecutors','resolveAgentCreationSessionId','createHostAgentWithDelivery','runtimeSubject'].some(value => value === method) && destination !== scope.agentRuntimeId) deny()
  if (method === 'hostEnvironment') {
    if (invocation.args.length === 0) return
    if (invocation.args.length !== 1) throw new AgentMuxError('Host environment reads accept zero arguments or one exact Agent Session selector.', 'INVALID_CONTROL_REQUEST')
    const selector = parseHostEnvironmentSelector(value)
    const expected = scope.kind === 'preparation' ? statement.preparationSessionId : scope.agentSessionId
    if (!expected || selector.agentSessionId !== expected) deny()
    return
  }
  if (method === 'listHostExecutors') { if (rpcRecord(value).executorId !== scope.executorId) deny(); return }
  if (method === 'resolveAgentCreationSessionId') { if (value !== scope.createOperationId) deny(); return }
  if (method === 'readAgentSession' || method === 'inspectAgentCreation') {
    // Before admission B signs one exact SID after the target's CID resolver. This
    // method never returns inventory, history or another method's authority.
    if (scope.kind === 'preparation' ? value !== statement.preparationSessionId || !statement.preparationSessionId : (typeof value !== 'string' || !observed.includes(value))) deny()
    return
  }
  if (scope.kind !== 'execution') deny()
  if (method === 'runtimeSubject') {
    const target = rpcRecord(value)
    if (target.kind !== 'agent-session' || target.agentSessionId !== scope.agentSessionId) deny()
    return
  }
  if (method === 'createHostAgentWithDelivery') { if (digest(value) !== scope.createDigest) deny(); return }
  if (method === 'prepareAgentExecutionHelper') {
    const p = rpcRecord(value), role = p.role
    if (role !== 'frontend' && role !== 'executor' || !roles.includes(role)) deny()
    const workspacePath = role === 'frontend' ? scope.agentWorkspacePath : scope.resourceWorkspacePath
    if (p.bindingId !== scope.bindingId || p.agentSessionId !== scope.agentSessionId || p.role !== role || p.workspacePath !== workspacePath || p.createOperationId !== executionCreationId(scope.bindingId, role)) deny()
    return
  }
  if (method === 'createPreparedTerminal' || method === 'inspectPreparedTerminal') {
    const p = rpcRecord(value), role = roles.find(role => p.createOperationId === executionCreationId(scope.bindingId, role))
    if (!role || p.workspacePath !== (role === 'frontend' ? scope.agentWorkspacePath : scope.resourceWorkspacePath)) deny()
    if (second !== undefined) checkRun(second)
    return
  }
  if (method === 'attachTerminal' || method === 'readRunReplay' || method === 'releaseRunAttachment' || method === 'writeTerminal') {
    checkRun(value)
    if (method === 'writeTerminal' && rpcRecord(second).ownerInstanceId !== helper!.ownerInstanceId) deny()
    return
  }
  deny()
}
