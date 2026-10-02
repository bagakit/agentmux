import { parseAgentMuxSpatialGraph } from './spatial-state.js'
import { AgentMuxError } from './errors.js'
import { normalizeAgentSession } from './agent-session-store.js'
import { validateAgentMuxMessageEnvelope } from './agent-global-message-queue.js'
import { validateAgentPromptCondition } from './agent-prompt-condition.js'
import { resolveAgentSessionId } from './agent-session-id.js'
import { assertDispatchEventKind } from './agent-handoff.js'
import { isAgentDeliveryState } from './agent-message.js'
import { parseRpcControlResult, rpcRecord } from './rpc-business-codec.js'
import type { AgentMuxRpcCredentials, AgentMuxRpcMethod } from './public-rpc.js'
import { isAgentMuxRpcDeviceMethod, parseAgentMuxRpcDeviceParams, parseAgentMuxRpcDeviceResult } from './public-rpc-device.js'

const fail = (): never => { throw new AgentMuxError('Core RPC result is malformed or belongs to another object.', 'CONTROL_PROTOCOL_ERROR') }
const record = (value: unknown, fields?: readonly string[]) => rpcRecord(value, fields, 'CONTROL_PROTOCOL_ERROR')
function string(value: unknown, nullable = false): void {
  if (nullable && value === null) return
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) fail()
}
function text(value: unknown): void { if (typeof value !== 'string') fail() }
function count(value: unknown, nullable = false): void { if (!(nullable && value === null) && (!Number.isSafeInteger(value) || (value as number) < 0)) fail() }
function bool(value: unknown): void { if (typeof value !== 'boolean') fail() }
function member(value: unknown, values: readonly unknown[]): void { if (!values.includes(value)) fail() }
function array(value: unknown, consume: (item: unknown) => void): void { if (!Array.isArray(value)) return fail(); for (const item of value) consume(item) }
function runRef(value: unknown): Record<string, unknown> { const run = record(value, ['runId']); string(run.runId); return run }
function issues(value: unknown, source = false): void {
  array(value, item => { const issue = record(item, source ? ['source', 'code', 'message', 'recovery'] : ['code', 'message', 'recovery'])
    string(issue.code); text(issue.message); string(issue.recovery); if (source) string(issue.source) })
}
export function parseRpcAgentSession(value: unknown): ReturnType<typeof normalizeAgentSession> {
  const source = record(value)
  if (Object.hasOwn(source, 'hookBindingId') || Object.hasOwn(source, 'hookToken')) fail()
  try { return normalizeAgentSession(source) } catch { return fail() }
}
/** Prefix admission belongs to the service's full durable set. The client only
 * verifies that its canonical answer can be the exact requested identity. */
export function rpcSessionTargetMatches(selector: unknown, actual: string, credentials?: AgentMuxRpcCredentials): boolean {
  const expected = selector === 'self' ? credentials?.agentSessionId : selector
  if (typeof expected !== 'string' || !expected) return false
  try { return resolveAgentSessionId(expected, [actual]) === actual } catch { return false }
}
/** Host bootstrap is a read projection of the original SDK, never a new registry. */
export function parseRpcHostedBootstrap(value: unknown): Record<string, unknown> {
  const p = record(value, ['identity', 'storePath', 'hostProcessId', 'catalog', 'sessions', 'messageQueuePath'])
  const identity = record(p.identity, ['ownership', 'hostId', 'buildIdentity', 'protocolVersion', 'processId', 'instanceId'])
  for (const key of ['hostId', 'buildIdentity', 'instanceId']) string(identity[key])
  count(identity.protocolVersion); count(identity.processId, true)
  if (identity.ownership !== undefined) member(identity.ownership, ['owned', 'unverified'])
  string(p.storePath, true); count(p.hostProcessId); string(p.messageQueuePath)
  array(p.sessions, session => parseRpcAgentSession(session))
  array(p.catalog, item => { const entry = record(item)
    for (const key of ['id', 'label', 'executable', 'expectedProcess']) string(entry[key])
    record(entry.capabilities); array(entry.launchOptions, option => record(option))
  })
  return p
}
function status(value: unknown, expected?: ReturnType<typeof normalizeAgentSession>): void {
  const p = record(value, ['session', 'run', 'capabilities', 'observation']), session = parseRpcAgentSession(p.session)
  const run = record(p.run)
  if (run.runId !== session.run.runId || run.agentSessionId !== session.agentSessionId || run.kind !== 'agent' ||
    run.providerId !== session.providerId || run.executorId !== session.executorId || run.workspacePath !== session.workspacePath) fail()
  if (expected && (session.agentSessionId !== expected.agentSessionId || session.run.runId !== expected.run.runId)) fail()
  member(run.state, ['running', 'exited', 'interrupted'])
  for (const key of ['pid', 'cols', 'rows']) count(run[key], true)
  for (const key of ['observedAt', 'latestOutputBytes']) count(run[key])
  count(run.acceptedInputBytes, true)
  const capabilities = record(p.capabilities)
  if (capabilities.terminal !== true) fail()
  member(capabilities.timeline, ['unavailable', 'complete-events', 'streaming'])
  member(capabilities.permission, ['none', 'observe', 'respond']); bool(capabilities.providerResume)
  member(capabilities.replyCorrelation, ['none', 'native-turn-id', 'acp-turn-id'])
  const observation = record(p.observation)
  if (observation.process !== run.state) fail()
  member(observation.semantic, ['active', 'idle', 'awaiting-input', 'unknown', 'unsupported'])
  member(observation.readiness, ['ready', 'pending', 'unknown']); string(observation.source)
  count(observation.observedAt); bool(observation.stale)
}
function role(value: unknown): Record<string, unknown> {
  const binding = record(value, ['role', 'agentSessionId', 'workspacePath', 'providerId', 'registeredAt'])
  for (const key of ['role', 'agentSessionId', 'workspacePath', 'providerId']) string(binding[key])
  count(binding.registeredAt); return binding
}
function delivery(value: unknown): void {
  const p = record(value, ['state', 'at', 'reason']); if (!isAgentDeliveryState(p.state)) fail(); count(p.at)
  if (p.reason !== undefined) text(p.reason)
}
function message(value: unknown): ReturnType<typeof validateAgentMuxMessageEnvelope> {
  const p = record(value); count(p.sequence); delivery(p.delivery)
  const envelope = validateAgentMuxMessageEnvelope(p.envelope)
  if (p.promptCondition !== undefined && p.promptCondition !== null) validateAgentPromptCondition(p.promptCondition)
  return envelope
}
function dispatch(value: unknown, params: Record<string, unknown>): void {
  const p = record(value, ['sourceMessageId', 'ownerAgentSessionId', 'workerAgentSessionId', 'threadId', 'openedAt', 'originAwaits', 'events'])
  if (p.sourceMessageId !== params.sourceMessageId) fail()
  for (const key of ['sourceMessageId', 'ownerAgentSessionId', 'workerAgentSessionId', 'threadId']) string(p[key])
  count(p.openedAt); bool(p.originAwaits)
  array(p.events, value => { const event = record(value, ['kind', 'replyMessageId', 'at']); assertDispatchEventKind(event.kind); string(event.replyMessageId); count(event.at) })
  if (params.replyMessageId !== undefined && !(p.events as Array<Record<string, unknown>>).some(event => event.replyMessageId === params.replyMessageId && event.kind === params.kind)) fail()
}
function activity(value: unknown): void {
  array(value, item => { const p = record(item, ['goalId', 'message', 'updatedAt']); string(p.goalId); text(p.message); count(p.updatedAt) })
}

/** Finite native DTO consumption. Existing Session, message, Goal and catalog
 * codecs retain their authority; this boundary does not derive Runtime facts. */
export function parseRpcNativeResult(method: AgentMuxRpcMethod, value: unknown, params: unknown,
  credentials?: AgentMuxRpcCredentials): Record<string, unknown> {
  try {
    if (isAgentMuxRpcDeviceMethod(method)) return parseAgentMuxRpcDeviceResult(method, value,
      parseAgentMuxRpcDeviceParams(method, params)) as unknown as Record<string, unknown>
    const p = record(value), input = record(params)
    if (['schemaVersion', 'requestId', 'operation'].some(key => Object.hasOwn(p, key))) fail()
    switch (method) {
      case 'runtime.bootstrap': parseRpcHostedBootstrap(p); break
      case 'runtime.invoke': record(p, ['value']); if (!Object.hasOwn(p, 'value')) fail(); break
      case 'runtime.release-consumer': record(p, ['released']); bool(p.released); break
      case 'agent.inspect': case 'whoami': {
        record(p, method === 'whoami' ? ['session', 'status', 'view', 'topic', 'messaging', 'unavailable'] : ['session', 'status', 'displayName', 'unavailable'])
        const session = parseRpcAgentSession(p.session), target = method === 'whoami' ? { kind: 'self' } : record(input.target)
        if (target.kind === 'agent-session' && !rpcSessionTargetMatches(target.agentSessionId, session.agentSessionId) ||
          target.kind === 'self' && !rpcSessionTargetMatches('self', session.agentSessionId, credentials) ||
          target.kind === 'run' && runRef(target.run).runId !== session.run.runId) fail()
        if (target.kind === 'provider-native' || target.kind === 'acp-native') {
          const handle = session.nativeHandle
          if (!handle || handle.kind !== (target.kind === 'provider-native' ? 'provider' : 'acp') || handle.sessionId !== target.sessionId ||
            ('providerId' in handle ? handle.providerId !== target.providerId : handle.adapterId !== target.adapterId)) fail()
        }
        if (p.status !== null) status(p.status, session); issues(p.unavailable)
        if (method === 'agent.inspect') { const name = record(p.displayName, ['override', 'availability']); if (name.override !== null) text(name.override); member(name.availability, ['observed', 'unavailable']) }
        else { text(p.topic); const messaging = record(p.messaging, ['crossSession', 'source', 'nativeSubagents', 'authenticity'])
          for (const key of ['crossSession', 'source', 'nativeSubagents', 'authenticity']) string(messaging[key])
          const view = record(p.view); bool(view.attached)
          if (view.attached) { record(view, ['attached', 'region']); const region = record(view.region); if (region.agentSessionId !== session.agentSessionId) fail()
            // Reuse the existing presentation codec, including geometry and terminal facts.
            const { parseAgentMuxControlReceipt } = controlCodec
            parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'rpc-whoami-view', operation: 'inspect.region', ok: true, result: { region } })
          } else { member(view.reason, ['no-desktop-view', 'view-unavailable']); if (view.reason === 'view-unavailable') { const error = record(view.error, ['code', 'message']); string(error.code); text(error.message) } }
        }
        break
      }
      case 'agent.reopen': case 'agent.reopen.check': {
        record(p, ['session'])
        const session = parseRpcAgentSession(p.session)
        if (session.agentSessionId !== input.agentSessionId || !session.reopenedFrom ||
          session.reopenedFrom.observedAt !== input.expectedRetiredAt ||
          session.run.runId === session.reopenedFrom.run.runId) fail()
        break
      }
      case 'agent.ls': record(p, ['sessions', 'errors']); array(p.sessions, item => status(item)); array(p.errors, item => { const error = record(item, ['agentSessionId', 'hostId', 'code', 'message']); string(error.agentSessionId, true); if (error.agentSessionId === null || error.hostId !== undefined) string(error.hostId); string(error.code); text(error.message) }); break
      case 'agent.role.ls': record(p, ['bindings']); array(p.bindings, item => role(item)); break
      case 'agent.role.register': case 'agent.role.resolve': { record(p, ['binding']); const binding = role(p.binding)
        if (binding.role !== input.role || input.workspacePath !== undefined && binding.workspacePath !== input.workspacePath ||
          method === 'agent.role.register' && credentials && binding.agentSessionId !== credentials.agentSessionId) fail(); break }
      case 'agent.send': {
        record(p, ['queueId', 'receiptId', 'messageId', 'sequence', 'envelope', 'delivery', 'promptCondition', 'agentSessionId'])
        const envelope = message(p)
        for (const key of ['queueId', 'receiptId', 'messageId']) string(p[key])
        if (p.messageId !== envelope.messageId || input.messageId === undefined && envelope.operationId !== input.operationId || envelope.body !== input.text ||
          input.messageId !== undefined && envelope.messageId !== input.messageId) fail()
        const target = record(input.target)
        if (target.kind === 'agent-session' && !rpcSessionTargetMatches(target.agentSessionId, envelope.recipientSessionId ?? '') ||
          target.kind === 'self' && !rpcSessionTargetMatches('self', envelope.recipientSessionId ?? '', credentials) ||
          p.agentSessionId !== undefined && p.agentSessionId !== envelope.recipientSessionId ||
          credentials && envelope.senderSessionId !== credentials.agentSessionId) fail()
        break
      }
      case 'agent.discuss': record(p, ['threadId', 'delivery', 'targetAgentSessionId']); string(p.threadId); string(p.targetAgentSessionId); if (!isAgentDeliveryState(p.delivery)) fail(); break
      case 'agent.handoff': record(p, ['ownerAgentSessionId', 'originAwaits', 'taskId', 'at']); if (!rpcSessionTargetMatches(input.toAgentSessionId, String(p.ownerAgentSessionId)) || p.taskId !== input.taskId || p.originAwaits !== false) fail(); count(p.at); break
      case 'message.inbox.check': case 'message.inbox.ack': {
        record(p, method.endsWith('.check') ? ['consumerId', 'readerRun', 'generation', 'messages'] : ['consumerId', 'readerRun', 'nextGeneration', 'acknowledgedMessageIds'])
        string(p.consumerId); const run = runRef(p.readerRun)
        if (credentials && p.consumerId !== credentials.agentSessionId || input.readerRun !== undefined && run.runId !== runRef(input.readerRun).runId) fail()
        if (method.endsWith('.check')) { count(p.generation); array(p.messages, item => { const envelope = message(item); if (credentials && envelope.recipientSessionId !== credentials.agentSessionId) fail() }) }
        else { count(p.nextGeneration); array(p.acknowledgedMessageIds, item => string(item)) }
        break
      }
      case 'message.dispatch.open': case 'message.dispatch.inspect': case 'message.dispatch.report': dispatch(p, input); break
      case 'goal.activity': record(p, ['activity']); activity(p.activity); break
      case 'app.snapshot': {
        record(p, ['projects', 'workspaces', 'topics', 'motes', 'spaces', 'zones', 'executors', 'agents', 'sessions', 'goals', 'decisions', 'activity', 'unavailable'])
        controlResult('list.projects', { projects: p.projects }); controlResult('list.agents', { agents: p.executors }); controlResult('list.active-agents', { agents: p.agents })
        parseRpcControlResult('goal.ls', { goals: p.goals })
        parseRpcControlResult('space.ls', { catalog: { spaces: p.spaces, zones: p.zones, tabs: [], regions: [], bindings: [], locations: [] } })
        array(p.sessions, item => status(item)); activity(p.activity); issues(p.unavailable, true)
        array(p.decisions, item => { const d = record(item, ['goalId', 'decisions']); string(d.goalId); parseRpcControlResult('goal.decisions', d, { goalId: d.goalId }) })
        array(p.workspaces, item => { const w = record(item, ['workspaceId', 'hostId', 'name', 'projectId', 'path', 'kind', 'repoPath', 'branch'])
          for (const key of ['workspaceId', 'hostId', 'path', 'kind']) string(w[key]); text(w.name); for (const key of ['projectId', 'repoPath', 'branch']) string(w[key], true) })
        const topic = (item: unknown) => { const t = record(item, ['id', 'topicId', 'workspaceId', 'hostId', 'path', 'spaceId', 'kind', 'directoryPath', 'topicPath', 'title', 'summary', 'readError', 'soul', 'moteArchive', 'collaborators', 'wiki'])
          for (const key of ['id', 'topicId', 'workspaceId', 'hostId', 'path', 'directoryPath', 'topicPath']) string(t[key]); string(t.spaceId, true); text(t.title); text(t.summary); member(t.kind, ['topic', 'mote', 'unknown'])
          array(t.collaborators, item => { const c = record(item, ['fileName', 'providerId', 'sessionId']); for (const key of ['fileName', 'providerId', 'sessionId']) string(c[key]) })
          if (t.readError !== undefined) text(t.readError)
          if (t.soul !== undefined) { const s = record(t.soul, ['path', 'content', 'version']); string(s.path); text(s.content); string(s.version) }
          if (t.wiki !== undefined) { const w = record(t.wiki, ['path', 'content', 'version', 'source', 'enabled', 'updatedAt']); string(w.path); text(w.content); string(w.version); member(w.source, ['default', 'user']); bool(w.enabled)
            if (w.updatedAt !== null && (typeof w.updatedAt !== 'number' || !Number.isFinite(w.updatedAt) || w.updatedAt < 0)) fail() }
          if (t.moteArchive !== undefined) { const a = record(t.moteArchive); member(a.state, ['active', 'archived', 'unknown']); if (a.state === 'unknown') text(a.issue); else string(a.version) } }
        array(p.topics, topic); array(p.motes, topic); break
      }
      case 'space.state':
      case 'space.commit': {
        record(p,['state'])
        if (p.state === null && method === 'space.state') break
        const state = record(p.state,['schemaVersion','revision','graph'])
        if (state.schemaVersion !== 1) fail(); count(state.revision)
        if ((state.revision as number) < 1) fail()
        parseAgentMuxSpatialGraph(state.graph); break
      }
      case 'space.resolve': {
        record(p,['region','locations'])
        const graph = {spaces:[],zones:[],tabs:[],regions:p.region === null ? [] : [p.region],bindings:[],layouts:{},tabLayouts:{},resources:{}}
        parseAgentMuxSpatialGraph(graph)
        if (p.region !== null && record(p.region).tabId !== record(params).tabId) fail()
        array(p.locations,item => { const l = record(item); if (l.tabId !== record(params).tabId || !p.region || l.regionId !== record(p.region).regionId) fail() })
        break
      }
      case 'system.endpoint': { record(p, ['protocol', 'framing', 'endpoint']); if (p.protocol !== 'jsonrpc-2.0' || p.framing !== 'json-lines') fail()
        const endpoint = record(p.endpoint); member(endpoint.transport, ['unix', 'http', 'ssh']); string(endpoint.transport === 'unix' ? endpoint.path : endpoint.transport === 'http' ? endpoint.url : endpoint.host); break }
      case 'system.subscription.cancel': record(p, ['disposed']); bool(p.disposed); break
      case 'system.doctor': {
        record(p, ['ok', 'host', 'runtime', 'runtimeAction', 'runtimeStorage', 'runtimeStorageUnavailable', 'hosts', 'agents', 'integration']); bool(p.ok)
        const host = record(p.host); if (host.kind !== 'local') fail(); bool(host.reachable)
        for (const key of ['hostId', 'buildIdentity', 'runtimeInstanceId', 'error', 'action']) { if (host[key] !== null) text(host[key]) }
        count(host.protocolVersion, true); const hosts = record(p.hosts); member(record(hosts.local).status, ['available', 'unavailable']); if (record(hosts.remote).status !== 'unsupported') fail()
        array(p.agents, item => { const a = record(item); string(a.id); string(a.label); string(a.executable); member(a.probe, ['found', 'missing', 'unverifiable', 'blocked']); record(a.capabilities); record(a.hook); record(a.hookInstallation); record(a.acp) })
        if (record(p.integration).hookIngress !== 'authenticated-loopback') fail()
        for (const key of ['runtimeAction', 'runtimeStorageUnavailable']) if (p[key] !== null) text(p[key])
        for (const key of ['runtime', 'runtimeStorage']) if (p[key] !== null) record(p[key])
        break
      }
      case 'agent.output': fail() // Only subscription initial + ordered notifications are public.
      default: fail()
    }
    return p
  } catch (error) {
    if (error instanceof AgentMuxError && error.code === 'CONTROL_PROTOCOL_ERROR') throw error
    return fail()
  }
}

import * as controlCodec from './control-codec.js'
function controlResult(operation: string, result: Record<string, unknown>): void {
  controlCodec.parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'rpc-core-observation', operation, ok: true, result })
}
