import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseGitOpenResult } from './public-rpc-git.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest,
  type AgentMuxControlResult, type AgentMuxControlCaller } from './control.js'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from './control-codec.js'
import { AgentMuxError } from './errors.js'
import { isToolkitRequest, assertToolkitResultTarget, type ToolkitResult } from './toolkit.js'
import { resolveAgentSessionId } from './agent-session-id.js'
import { isBrowserTaskControlOperation, parseBrowserTaskControlPayload, parseBrowserTaskControlResult, assertBrowserTaskControlTarget } from './browser-task-control.js'
import { AGENTMUX_RPC_CONTROL_METHODS, type AgentMuxRpcMethod } from './public-rpc.js'

import { parseMotePreferencesReadResult, parseMotePreferencesSaveResult } from './mote-preferences.js'
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
  if ((method === 'goal.activity.append' || method === 'goal.activity.inspect') && typeof source.operationId !== 'string') {
    throw new AgentMuxError('Goal activity append/check requires the original explicit operationId.', 'INVALID_CONTROL_REQUEST')
  }
  if ((method === 'settings.hosts.upgrade' || method === 'settings.hosts.upgrade-inspect') && typeof source.operationId !== 'string') {
    throw new AgentMuxError('Core maintenance requires the original explicit operationId.', 'INVALID_CONTROL_REQUEST')
  }
  if (method === 'space.mote.preferences.save' && typeof source.operationId !== 'string') {
    throw new AgentMuxError('Mote preference saves require the original explicit operationId.', 'INVALID_CONTROL_REQUEST')
  }
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
  const resource = /^settings\.(executors|prompts|themes)\.(ls|inspect|create|update|delete)$/u.exec(method)
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
    'arrange', 'promote.region', 'interrupt', 'resume', 'stop', 'demand.start', 'demand.continuation-action', 'browser.run', 'browser.replay',
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
    (key === 'request' || key === 'report' || key === 'binding' || key === 'receipt') && data && typeof data === 'object'
      ? operationKeys(data as Record<string, unknown>, inverse) : data
  ]))
}

export function rpcControlResult(method: AgentMuxRpcMethod, result: AgentMuxControlResult): Record<string, unknown> {
  const { operation: _operation, ...body } = result
  const canonical = method.startsWith('goal.') && method !== 'goal.focus' ? goalKeys(body, false) : body
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
  if (isToolkitRequest(request)) { assertToolkitResultTarget(request, result as ToolkitResult); return }
  if (isBrowserTaskControlOperation(request.operation)) {
    assertBrowserTaskControlTarget(parseBrowserTaskControlPayload(request), parseBrowserTaskControlResult(request.operation, result))
  }
  const actual = result as unknown as Record<string, unknown>
  if (request.operation === 'demand.create' || request.operation === 'demand.update') {
    const refs = request.operation === 'demand.create' ? request.contentRefs : request.patch.contentRefs
    const demand = (result as Extract<AgentMuxControlResult, { operation: 'demand.create' | 'demand.update' }>).demand
    if (refs?.some(ref => !demand.contentRefs?.some(saved => saved.hostId === ref.hostId && saved.workspaceId === ref.workspaceId && saved.zoneId === ref.zoneId))) fail()
  }
  switch (request.operation) {
    case 'space.mote.preferences.read': {
      const { operation: _operation, ...body } = result as Extract<AgentMuxControlResult, { operation: 'space.mote.preferences.read' }>
      parseMotePreferencesReadResult(body, request)
      break
    }
    case 'space.mote.preferences.save': {
      const { operation: _operation, requestId, ...body } = result as Extract<AgentMuxControlResult, { operation: 'space.mote.preferences.save' }>
      parseMotePreferencesSaveResult({ ...body, operationId: requestId }, { ...request, operationId: request.requestId })
      break
    }
    case 'open.git': {
      const { operation: _operation, ...body } = result as Extract<AgentMuxControlResult, { operation: 'open.git' }>
      parseGitOpenResult(body, request)
      break
    }
    case 'demand.create':
      if (actual.receipt && (actual.receipt as Record<string, unknown>).demandId !== (actual.demand as Record<string, unknown>)?.id ||
          request.demandId !== undefined && (actual.demand as Record<string, unknown>)?.id !== request.demandId) fail()
      break
    case 'demand.activity.append': {
      const activity = actual.activity as import('./control.js').AgentMuxDemandActivity
      const receipt = actual.receipt as Record<string, unknown>
      const demand = actual.demand as import('./control.js').AgentMuxDemand
      if (demand.id !== request.demandId || receipt.demandId !== request.demandId || receipt.requestId !== request.requestId || receipt.activityId !== activity.id ||
          activity.operationId !== request.requestId || activity.kind !== request.kind || activity.message !== request.message ||
          !demand.activities?.some(saved => isDeepStrictEqual(saved, activity))) fail()
      break
    }
    case 'demand.activity.inspect':
      if (actual.demandId !== request.demandId || actual.requestId !== request.requestId || actual.activity && (actual.activity as Record<string, unknown>).operationId !== request.requestId) fail()
      break
    case 'message.pending.ls': case 'message.pending.edit': case 'message.pending.send': case 'message.pending.stop':
    case 'message.pending.archive': case 'message.pending.restore':
      if (actual.agentSessionId !== request.agentSessionId) fail()
      if ((request.operation === 'message.pending.edit' || request.operation === 'message.pending.stop' || request.operation === 'message.pending.archive' || request.operation === 'message.pending.restore') &&
          (actual.message as { pendingId?: string })?.pendingId !== request.pendingId) fail()
      if (request.operation === 'message.pending.send' && actual.pendingId !== request.pendingId) fail()
      break
    case 'browser.targets':
      if (request.workspaceId && (result as Extract<AgentMuxControlResult, { operation: 'browser.targets' }>).targets.some(target => target.workspaceId !== request.workspaceId)) fail()
      break
    case 'agent.view': case 'agent.rename': case 'agent.inspect':
      if (actual.agentSessionId !== request.agentSessionId) fail()
      break
    case 'interrupt': case 'resume': case 'stop':
      if (request.target.kind === 'agent-session' && !sessionMatches(request.target.agentSessionId, actual.agentSessionId)) fail()
      break
    case 'file.build':
      if (actual.regionId !== request.regionId || actual.buildId !== request.requestId) fail()
      break
    case 'file.build.inspect': case 'file.build.cancel':
      if (actual.regionId !== request.regionId || actual.buildId !== request.buildId) fail()
      break
    case 'space.view': case 'file.format': if (actual.regionId !== request.regionId) fail(); break
    case 'space.swap':
      if (actual.regionId !== request.regionId || actual.withRegionId !== request.withRegionId) fail()
      break
    case 'space.rename': if (actual.tabId !== request.tabId) fail(); break
    case 'open.file': {
      if (actual.requestedPath !== request.path) fail()
      const resource = actual.resource as Record<string, unknown> | null
      if (resource && resource.zoneId !== request.zoneId) fail()
      if (request.tabId) {
        const placement = (result as Extract<AgentMuxControlResult, { operation: 'open.file' }>).placement
        if (placement.tabId !== null && placement.tabId !== request.tabId) fail()
        if ((placement.status === 'created' || placement.status === 'reused') && (placement.tabId !== request.tabId || placement.regionId === null)) fail()
        if (placement.locations.some(location => location.tabId !== request.tabId || location.regionId !== placement.regionId)) fail()
        if ((placement.status === 'created' || placement.status === 'reused') && !placement.locations.some(location =>
          location.displayWorkspaceId === request.displayWorkspaceId && location.groupId === request.groupId)) fail()
      }
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
        if (request.content.kind === 'fork-agent') {
          const origin = agent.forkedFrom as typeof request.content.source | undefined, expected = request.content.source
          if (agent.agentSessionId === expected.agentSessionId || !origin || origin.agentSessionId !== expected.agentSessionId ||
            origin.expectedRun.runId !== expected.expectedRun.runId || origin.expectedNativeHandle.providerId !== expected.expectedNativeHandle.providerId ||
            origin.expectedNativeHandle.sessionId !== expected.expectedNativeHandle.sessionId || origin.expectedNativeHandle.transcriptPath !== expected.expectedNativeHandle.transcriptPath) fail()
        }
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
        (actual.input as Record<string, unknown>).policy !== request.inputPolicy ||
        nav.expectedAgentSessionId !== request.expectedAgentSessionId) fail()
      break
    }
    case 'promote.region': if (request.target.kind === 'region' && actual.regionId !== request.target.regionId) fail(); break
    case 'inspect.region': if (request.target.kind === 'region' && (actual.region as Record<string, unknown>).regionId !== request.target.regionId) fail(); break
    case 'inspect.tab': case 'arrange': if (request.target.kind === 'tab' && (actual.tab as Record<string, unknown>).tabId !== request.target.tabId) fail(); break
    case 'send': if (request.target.kind === 'agent-session' && !sessionMatches(request.target.agentSessionId, actual.agentSessionId)) fail(); break
    case 'settings.set': if ((actual.entry as Record<string, unknown>).key !== request.key || actual.requestId !== undefined && actual.requestId !== request.requestId) fail(); break
    case 'settings.hosts.upgrade-check': {
      const check = actual.check as { input: Record<string, unknown> }
      if (request.id !== undefined ? check.input.id !== request.id : !isDeepStrictEqual(check.input, request.input)) fail()
      break
    }
    case 'settings.hosts.upgrade': case 'settings.hosts.upgrade-inspect': {
      const receipt = actual.receipt as { input: { id: string }; operationId: string; expected: unknown } | null
      if (request.operation === 'settings.hosts.upgrade' && !receipt) fail()
      if (receipt && (receipt.input.id !== request.id || receipt.operationId !== request.requestId ||
        request.operation === 'settings.hosts.upgrade' && !isDeepStrictEqual(receipt.expected, request.expected))) fail()
      break
    }
    case 'settings.browser.links.forget': if (actual.scheme !== request.scheme) fail(); break
    case 'settings.resource.get': {
      const item = actual.item as Record<string, unknown>
      if (actual.resource !== request.resource || (request.keyword === undefined
        ? item.id !== request.id
        : (item.value as Record<string, unknown>).keyword !== request.keyword)) fail()
      break
    }
    case 'settings.resource.add': case 'settings.resource.update':
      if (actual.resource !== request.resource || (actual.item as Record<string, unknown>).id !== request.id) fail()
      break
    case 'settings.resource.remove': if (actual.resource !== request.resource || actual.id !== request.id) fail(); break
    case 'demand.discuss': case 'demand.confirm': case 'demand.accept':
    case 'demand.activity.read': case 'demand.continuation-action': case 'demand.show': case 'demand.update': case 'demand.assign': case 'demand.start': case 'demand.handoff':
    case 'demand.delete': case 'demand.link-session': case 'demand.link-project': case 'demand.decision-log':
      if (actual.demand && (actual.demand as Record<string, unknown>).id !== request.demandId ||
        actual.demandId !== undefined && actual.demandId !== request.demandId ||
        actual.receipt && (actual.receipt as Record<string, unknown>).demandId !== request.demandId) fail()
      if (request.operation === 'demand.discuss' && ((actual.receipt as Record<string, unknown>).requestId !== request.requestId || (actual.receipt as Record<string, unknown>).mode !== request.mode)) fail()
      if (request.operation === 'demand.confirm') {
        const goal = actual.demand as AgentMuxControlResult & { alignment?: { revision: number; confirmedAt: number } }
        const receipt = actual.receipt as Record<string, unknown>
        if (receipt.confirmedRevision !== request.expectedRevision || goal.alignment?.revision !== request.expectedRevision || goal.alignment.confirmedAt !== receipt.confirmedAt || !(Number(receipt.confirmedAt) > 0)) fail()
      }
      if (request.operation === 'demand.accept') {
        const goal = actual.demand as { alignment?: { revision: number }; grounding?: { alignmentRevision: number; submissionId: string; acceptedAt: number; checks: { outcome: string }[] } }
        const receipt = actual.receipt as Record<string, unknown>
        if (receipt.alignmentRevision !== request.expectedAlignmentRevision || receipt.submissionId !== request.expectedSubmissionId || goal.alignment?.revision !== request.expectedAlignmentRevision || goal.grounding?.alignmentRevision !== request.expectedAlignmentRevision || goal.grounding.submissionId !== request.expectedSubmissionId || goal.grounding.acceptedAt !== receipt.acceptedAt || !(Number(receipt.acceptedAt) > 0) || receipt.acceptedWithGaps !== goal.grounding.checks.some(check => check.outcome === 'gap') || receipt.acceptedWithGaps === true && !request.acceptGaps) fail()
      }
      if (actual.goalContinuations && (actual.goalContinuations as import('./continuous-progress-scheduler.js').ContinuousProgressLoop[]).some(loop => loop.taskSource?.kind !== 'goal' || loop.taskSource.goalId !== request.demandId)) fail()
      if (request.operation === 'demand.start' && Boolean(request.continuation) !== Boolean(actual.continuation)) fail()
      if (actual.continuation) {
        const loop = actual.continuation as import('./continuous-progress-scheduler.js').ContinuousProgressLoop
        if (loop.taskSource?.kind !== 'goal' || loop.taskSource.goalId !== request.demandId) fail()
        if (request.operation === 'demand.continuation-action' && (loop.loopId !== request.loopId || loop.lastMutation?.operationId !== request.requestId || loop.lastMutation?.action !== request.action || loop.lastMutation?.expectedRevision !== request.expectedRevision || loop.revision !== request.expectedRevision + 1)) fail()
        if (request.operation === 'demand.start' && request.continuation && (loop.agentSessionId !== request.sessionId || loop.creationOperationId !== request.requestId || loop.taskSource?.kind !== 'goal' || loop.taskSource.alignmentRevision !== request.continuation.alignmentRevision || loop.intervalMs !== request.continuation.intervalMs)) fail()
      }
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
  const presentation = method === 'space.inspect' ? source.presentation : undefined
  const body = { ...source }
  if (method === 'space.inspect') delete body.presentation
  if (['schemaVersion', 'requestId', 'operation'].some(key => Object.hasOwn(body, key))) {
    throw new AgentMuxError('RPC result contains an internal Control envelope.', 'CONTROL_PROTOCOL_ERROR')
  }
  // Maintenance receipts already own operationId; it is not a Control requestId.
  const legacy = method === 'settings.hosts.upgrade' || method === 'settings.hosts.upgrade-inspect' ? body
    : operationKeys(method.startsWith('goal.') && method !== 'goal.focus' ? goalKeys(body, true) : body, true)
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
    const resource = /^settings\.(executors|prompts|themes)\./u.exec(method)
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
