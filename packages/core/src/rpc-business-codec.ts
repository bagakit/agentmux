import { randomUUID } from 'node:crypto'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest,
  type AgentMuxControlResult, type AgentMuxControlCaller } from './control.js'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from './control-codec.js'
import { AgentMuxError } from './errors.js'
import { resolveAgentSessionId } from './agent-session-id.js'
import { isBrowserTaskControlOperation, parseBrowserTaskControlPayload, parseBrowserTaskControlResult, assertBrowserTaskControlTarget } from './browser-task-control.js'
import { isToolkitRequest, assertToolkitResultTarget } from './toolkit.js'
import { AGENTMUX_RPC_CONTROL_METHODS, type AgentMuxRpcMethod } from './public-rpc.js'

import { rpcRecord } from './rpc-data.js'
export { rpcRecord } from './rpc-data.js'

export function rpcString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value) || Buffer.byteLength(value) > 4096) {
    throw new AgentMuxError(`${label} is invalid.`, 'INVALID_CONTROL_REQUEST')
  }
  return value
}
export function rpcText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > 16 * 1024 * 1024) {
    throw new AgentMuxError(`${label} is invalid.`, 'INVALID_CONTROL_REQUEST')
  }
  return value
}
export function rpcCount(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new AgentMuxError('RPC numeric parameter is invalid.', 'INVALID_CONTROL_REQUEST')
  }
  return value as number
}

/** Adapt public named params into the original owner DTO, never an old wire. */
export function rpcControlRequest(method: keyof typeof AGENTMUX_RPC_CONTROL_METHODS,
  value: unknown, caller?: AgentMuxControlCaller): AgentMuxControlRequest {
  const source = rpcRecord(value)
  if (['schemaVersion', 'requestId', 'operation', 'caller', 'resource'].some(key => Object.hasOwn(source, key))) {
    throw new AgentMuxError('RPC business parameters cannot contain an internal Control envelope.', 'INVALID_CONTROL_REQUEST')
  }
  const operation = AGENTMUX_RPC_CONTROL_METHODS[method]
  if (method.startsWith('goal.')) {
    const oldKeys = (value: Record<string, unknown>): boolean =>
      Object.keys(value).some(key => ['demandId', 'parentDemandId', 'demand', 'demands'].includes(key)) ||
      ['patch', 'decision'].some(key => value[key] && typeof value[key] === 'object' && oldKeys(rpcRecord(value[key])))
    if (oldKeys(source)) throw new AgentMuxError('Public Goal parameters require canonical Goal names.', 'INVALID_CONTROL_REQUEST')
  }
  if (method === 'space.inspect' && source.target && typeof source.target === 'object' && Object.hasOwn(source.target, 'requestId')) {
    throw new AgentMuxError('Public inspection uses operationId, independent of JSON-RPC id.', 'INVALID_CONTROL_REQUEST')
  }
  const { operationId, ...originalBody } = source
  const body = method.startsWith('goal.') ? goalKeys(originalBody, true) : originalBody
  const requestId = operationId === undefined ? randomUUID() : rpcString(operationId, 'Operation ID')
  if (method === 'space.inspect' && body.target && typeof body.target === 'object' &&
    Object.hasOwn(body.target, 'operationId')) {
    const target = rpcRecord(body.target, ['operationId'])
    body.target = { requestId: rpcString(target.operationId, 'Operation ID') }
  }
  if (method === 'goal.focus') {
    const p = rpcRecord(source, ['goalId', 'input', 'operationId'])
    delete body.demandId; delete body.input
    body.target = { kind: 'goal', goalId: rpcString(p.goalId, 'Goal ID') }
    body.inputPolicy = p.input ?? 'preserve'
  }
  const resource = /^settings\.(executors|prompts)\.(ls|inspect|create|update|delete)$/u.exec(method)
  if (resource) body.resource = resource[1]
  if (method.endsWith('.update') && resource || method === 'toolkit.update') {
    const p = rpcRecord(body.input, ['changes', 'expected'])
    delete body.input; Object.assign(body, p)
  } else if (method.endsWith('.delete') && resource || method === 'toolkit.delete') {
    const p = body.input === undefined ? {} : rpcRecord(body.input, ['expected'])
    delete body.input; Object.assign(body, p)
  }
  if (method === 'settings.browser-links.forget') {
    const p = rpcRecord(body.input, ['scheme']); delete body.input; Object.assign(body, p)
  }
  if (method === 'toolkit.stop' && body.input !== undefined) {
    const p = rpcRecord(body.input, ['executionId']); delete body.input; Object.assign(body, p)
  }
  if (operation.startsWith('browser.') && operationId !== undefined) body.operationId = operationId
  const usesCaller = ['inspect.region', 'inspect.tab', 'open.terminal', 'open.browser', 'send',
    'arrange', 'promote.region', 'interrupt', 'resume', 'stop', 'browser.run', 'browser.replay',
    'browser.stop', 'agent.open'].includes(operation)
  const input = { ...body, schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation,
    ...(caller && usesCaller ? { caller } : {}) }
  const parsed = parseAgentMuxControlRequest(input)
  // The original parser is the schema owner. Do not silently drop fields that it
  // did not consume: a CLI raw carrier and a typed SDK share this check.
  if (Object.keys(input).some(key => !Object.hasOwn(parsed, key))) {
    throw new AgentMuxError('RPC parameters contain an unsupported business field.', 'INVALID_CONTROL_REQUEST')
  }
  return parsed
}

function goalKeys(value: Record<string, unknown>, inverse: boolean): Record<string, unknown> {
  const pairs = inverse ? { goalId: 'demandId', parentGoalId: 'parentDemandId', goal: 'demand', goals: 'demands' }
    : { demandId: 'goalId', parentDemandId: 'parentGoalId', demand: 'goal', demands: 'goals' }
  return Object.fromEntries(Object.entries(value).map(([key, data]) => [
    (pairs as Record<string, string>)[key] ?? key,
    ['receipt', 'goal', 'demand', 'patch'].includes(key) && data && typeof data === 'object' ? goalKeys(data as Record<string, unknown>, inverse)
      : ['decisions', 'goals', 'demands'].includes(key) && Array.isArray(data) ? data.map(item => goalKeys(item, inverse)) : data
  ]))
}
function operationKeys(value: Record<string, unknown>, inverse: boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, data]) => [
    key === (inverse ? 'operationId' : 'requestId') ? (inverse ? 'requestId' : 'operationId') : key,
    (key === 'request' || key === 'report' || key === 'binding') && data && typeof data === 'object'
      ? operationKeys(data as Record<string, unknown>, inverse) : data
  ]))
}

export function rpcControlResult(method: AgentMuxRpcMethod, result: AgentMuxControlResult): Record<string, unknown> {
  const { operation: _operation, ...body } = result
  const canonical = method.startsWith('goal.') ? goalKeys(body, false) : body
  return operationKeys(canonical, false)
}

/** The original DTO owns identities. Validate a result against that same admitted request. */
export function assertControlResultTarget(request: AgentMuxControlRequest, result: AgentMuxControlResult): void {
  const fail = () => { throw new AgentMuxError('Business result belongs to another target.', 'CONTROL_PROTOCOL_ERROR') }
  const sessionMatches = (selector: string, actual: unknown) => {
    if (typeof actual !== 'string') return false
    try { return resolveAgentSessionId(selector, [actual]) === actual } catch { return false }
  }
  if (request.operation !== result.operation) fail()
  if (isBrowserTaskControlOperation(request.operation)) {
    assertBrowserTaskControlTarget(parseBrowserTaskControlPayload(request), parseBrowserTaskControlResult(request.operation, result))
  }
  if (isToolkitRequest(request) && isToolkitRequest(result)) assertToolkitResultTarget(request, result)
  const actual = result as unknown as Record<string, unknown>
  switch (request.operation) {
    case 'browser.targets':
      if (request.workspaceId && (result as Extract<AgentMuxControlResult, { operation: 'browser.targets' }>).targets.some(target => target.workspaceId !== request.workspaceId)) fail()
      break
    case 'agent.view': case 'agent.rename': case 'agent.inspect':
      if (actual.agentSessionId !== request.agentSessionId) fail()
      break
    case 'interrupt': case 'resume': case 'stop':
      if (request.target.kind === 'agent-session' && !sessionMatches(request.target.agentSessionId, actual.agentSessionId)) fail()
      break
    case 'space.view': if (actual.regionId !== request.regionId) fail(); break
    case 'space.swap':
      if (actual.regionId !== request.regionId || actual.withRegionId !== request.withRegionId) fail()
      break
    case 'space.rename': if (actual.tabId !== request.tabId) fail(); break
    case 'open.file': {
      if (actual.requestedPath !== request.path) fail()
      const resource = actual.resource as Record<string, unknown> | null
      if (resource && resource.zoneId !== request.zoneId) fail()
      break
    }
    case 'agent.open': case 'space.mv': case 'space.bind': case 'space.unbind':
      if (actual.requestId !== request.requestId) fail()
      if (request.operation === 'space.mv') {
        const from = actual.from as Record<string, unknown> | null, agent = actual.agent as Record<string, unknown> | null
        if (from && from.regionId !== request.fromRegionId || agent && agent.agentSessionId !== request.expectedAgentSessionId) fail()
      }
      if (request.operation === 'agent.open' && actual.agent) {
        const agent = actual.agent as Record<string, unknown>
        if (request.content.kind === 'agent-session' && agent.agentSessionId !== request.content.agentSessionId ||
          request.content.kind === 'new-agent' && agent.executorId !== null && agent.executorId !== request.content.executorId) fail()
      }
      break
    case 'space.inspect':
      if ('requestId' in request.target && (actual.request as Record<string, unknown> | undefined)?.requestId !== request.target.requestId) fail()
      break
    case 'focus': {
      const nav = actual.navigation as Record<string, unknown>
      const target = nav.requested as Record<string, unknown>
      if (Object.keys(target).length !== Object.keys(request.target).length ||
        Object.entries(request.target).some(([key, value]) => target[key] !== value) ||
        (actual.input as Record<string, unknown>).policy !== request.inputPolicy) fail()
      break
    }
    case 'promote.region': if (request.target.kind === 'region' && actual.regionId !== request.target.regionId) fail(); break
    case 'inspect.region': if (request.target.kind === 'region' && (actual.region as Record<string, unknown>).regionId !== request.target.regionId) fail(); break
    case 'inspect.tab': case 'arrange': if (request.target.kind === 'tab' && (actual.tab as Record<string, unknown>).tabId !== request.target.tabId) fail(); break
    case 'send': if (request.target.kind === 'agent-session' && !sessionMatches(request.target.agentSessionId, actual.agentSessionId)) fail(); break
    case 'settings.set': if ((actual.entry as Record<string, unknown>).key !== request.key) fail(); break
    case 'settings.browser.links.forget': if (actual.scheme !== request.scheme) fail(); break
    case 'settings.resource.get': case 'settings.resource.add': case 'settings.resource.update':
      if (actual.resource !== request.resource || (actual.item as Record<string, unknown>).id !== request.id) fail()
      break
    case 'settings.resource.remove': if (actual.resource !== request.resource || actual.id !== request.id) fail(); break
    case 'demand.show': case 'demand.update': case 'demand.assign': case 'demand.start': case 'demand.handoff':
    case 'demand.delete': case 'demand.link-session': case 'demand.link-project': case 'demand.decision-log':
      if (actual.demand && (actual.demand as Record<string, unknown>).id !== request.demandId ||
        actual.demandId !== undefined && actual.demandId !== request.demandId ||
        actual.receipt && (actual.receipt as Record<string, unknown>).demandId !== request.demandId) fail()
      break
    case 'browser.operation': case 'browser.stop':
      if (actual.runOperation && (actual.runOperation as Record<string, unknown>).id !== request.operationId) fail()
      break
  }
}

/** Real client consumption of the original strict result codec. */
export function parseRpcControlResult(method: keyof typeof AGENTMUX_RPC_CONTROL_METHODS,
  value: unknown, params?: unknown): Record<string, unknown> {
  const source = rpcRecord(value, undefined, 'CONTROL_PROTOCOL_ERROR')
  const body = { ...source }
  const presentation = method === 'space.inspect' ? body.presentation : undefined
  if (method === 'space.inspect') delete body.presentation
  if (['schemaVersion', 'requestId', 'operation'].some(key => Object.hasOwn(body, key))) {
    throw new AgentMuxError('RPC result contains an internal Control envelope.', 'CONTROL_PROTOCOL_ERROR')
  }
  const legacy = operationKeys(method.startsWith('goal.') ? goalKeys(body, true) : body, true)
  const operation = AGENTMUX_RPC_CONTROL_METHODS[method]
  // The spatial owner validates this envelope against the same durable business
  // ID. JSON-RPC's correlation ID is deliberately absent from this DTO.
  const requestId = legacy.requestId ?? (params && rpcRecord(params).operationId) ?? randomUUID()
  const receipt = parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId, ok: true, operation, result: legacy })
  if (!receipt.ok) throw new AgentMuxError('RPC result is not a successful business body.', 'CONTROL_PROTOCOL_ERROR')
  const result = { operation, ...receipt.result } as AgentMuxControlResult
  if (params !== undefined) {
    // Read-only requests may omit an operation ID; compare write identity only when supplied.
    const p = rpcRecord(params), identity = method.startsWith('goal.') ? goalKeys(p, true) : { ...p }
    if (method === 'goal.focus') { identity.target = { kind: 'goal', goalId: p.goalId }; identity.inputPolicy = p.input ?? 'preserve' }
    if (method === 'space.inspect' && identity.target && Object.hasOwn(identity.target as object, 'operationId')) identity.target = operationKeys(identity.target as Record<string, unknown>, true)
    const resource = /^settings\.(executors|prompts)\./u.exec(method)
    if (resource) identity.resource = resource[1]
    if (method === 'settings.browser-links.forget') identity.scheme = rpcRecord(p.input).scheme
    const request = { ...identity, operation, requestId: p.operationId ?? ('requestId' in result ? result.requestId : '') } as AgentMuxControlRequest
    assertControlResultTarget(request, result)
  }
  const canonical = rpcControlResult(method, result)
  if (presentation !== undefined) {
    const observed = rpcRecord(presentation, ['region', 'tab', 'unavailable'], 'CONTROL_PROTOCOL_ERROR')
    for (const kind of ['region', 'tab'] as const) if (observed[kind] !== null) {
      const receipt = parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: randomUUID(), ok: true,
        operation: `inspect.${kind}`, result: { [kind]: observed[kind] } })
      if (!receipt.ok) throw new AgentMuxError('Invalid space presentation.', 'CONTROL_PROTOCOL_ERROR')
      const target = params === undefined ? undefined : rpcRecord(rpcRecord(params).target)
      if (target && target[`${kind}Id`] && target[`${kind}Id`] !== 'self' &&
        (observed[kind] as Record<string, unknown>)[`${kind}Id`] !== target[`${kind}Id`]) {
        throw new AgentMuxError('Space presentation belongs to another target.', 'CONTROL_PROTOCOL_ERROR')
      }
    }
    if (!Array.isArray(observed.unavailable)) throw new AgentMuxError('Space presentation availability is invalid.', 'CONTROL_PROTOCOL_ERROR')
    for (const item of observed.unavailable) {
      const issue = rpcRecord(item, ['code', 'message', 'recovery'], 'CONTROL_PROTOCOL_ERROR')
      if (['code', 'message', 'recovery'].some(key => typeof issue[key] !== 'string' || !issue[key])) throw new AgentMuxError('Invalid presentation issue.', 'CONTROL_PROTOCOL_ERROR')
    }
    canonical.presentation = observed
  }
  return canonical
}
