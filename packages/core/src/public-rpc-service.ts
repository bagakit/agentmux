import { createHash, randomUUID } from 'node:crypto'
import type { AgentMuxClient } from './client.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxMessageTargetCandidates,
  type AgentMuxControlHost, type AgentMuxControlRequest, type AgentMuxControlResult,
  type AgentMuxControlCaller, type AgentMuxDemand } from './control.js'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from './control-codec.js'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_AGENT_MESSAGING_RULES } from './agent-messaging-guidance.js'
import { classifySelfViewFailure, SELF_CONTEXT_TOPIC_HINT } from './agent-self-context.js'
import { resolveAgentSessionId } from './agent-session-id.js'
import { readAgentRoleBindings, registerAgentRole, resolveAgentRole } from './agent-role-directory.js'
import { appendGlobalMessage, prepareGlobalMessagePrompt, recordGlobalMessageDelivery,
  recordGlobalMessageDeliveryIssue } from './agent-global-message-queue.js'
import { validateAgentPromptCondition } from './agent-prompt-condition.js'
import { diagnoseAgentMux } from './doctor.js'
import { agentSessionMatches } from './rpc-agent-filter.js'
import { OrderedSessionOutputFollow, type FollowOutput } from './session-output-follow.js'
import { defaultAgentMuxControlSocketPath } from './runtime-paths.js'
import type { AgentMuxHostedRuntimeService } from './hosted-runtime-service.js'
import type { AgentMuxRpcSubscriptionOptions, AgentMuxRpcSubscription } from './public-rpc-client.js'
import { AgentMuxRpcError, rpcFailure } from './public-rpc-frame.js'
import { isAgentMuxRpcDeviceMethod, parseAgentMuxRpcDeviceParams, parseAgentMuxRpcDeviceResult,
  type AgentMuxRpcDeviceAdministration } from './public-rpc-device.js'
import { rpcControlRequest, rpcControlResult, assertControlResultTarget, rpcRecord, rpcString, rpcText, rpcCount } from './rpc-business-codec.js'
import { AGENTMUX_RPC_CONTROL_METHODS, AGENTMUX_RPC_NATIVE_METHODS, type AgentMuxRpcMethod,
  type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcCredentials,
  type AgentMuxRpcSnapshotParams, type AgentMuxRpcSnapshot, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamInitial, type AgentMuxRpcStreamEvent, type AgentMuxRpcUnavailable, type AgentMuxRpcPrincipal } from './public-rpc.js'

/** A structural slice of the original public SDK; hosted clients need no private fields. */
export type AgentMuxRpcCorePort = Pick<AgentMuxClient,
  'readAgentSessions' | 'sessionHistorySources' | 'authorizeRetainedAgentCaller' | 'agentMessageQueuePath' |
  'agentSession' | 'refreshAgentSession' | 'resolveAgentSession' | 'statusAgent' |
  'observeAgentOutput' | 'startDiscussion' | 'checkDeliveries' |
  'ackDeliveryBatch' | 'openDispatch' | 'showDispatch' | 'recordDispatchEvent' |
  'catalog' | 'connect' | 'inspectManagedHooks' | 'probeAgent' | 'probeExecutorAvailability' |
  'runtimeDiagnostics' | 'runtimeIdentity'> & {
    handOff(...args: Parameters<AgentMuxClient['handOff']>):
      Awaited<ReturnType<AgentMuxClient['handOff']>> | Promise<Awaited<ReturnType<AgentMuxClient['handOff']>>>
  }
export type AgentMuxRpcCoreClient = { hostId: string; client: AgentMuxRpcCorePort }
export type AgentMuxRpcServiceOptions = Partial<AgentMuxControlHost> & {
  endpoint?: import('./public-rpc.js').AgentMuxRpcEndpoint
  /** Borrow existing SDK clients. Their lifecycle remains with their host. */
  coreClients?(): readonly AgentMuxRpcCoreClient[] | Promise<readonly AgentMuxRpcCoreClient[]>
  /** Client-owned real filesystem/config observations, not a second registry. */
  snapshot?(params: AgentMuxRpcSnapshotParams): Promise<Partial<AgentMuxRpcSnapshot>>
  /** Original Host Authority and native confirmation owner; never constructed here. */
  deviceAdministration?: AgentMuxRpcDeviceAdministration
  /** Borrow the Host's original SDK business owner; never connect a second Runtime. */
  hostedRuntime?(): Pick<AgentMuxHostedRuntimeService, 'call' | 'subscribe'> |
    Promise<Pick<AgentMuxHostedRuntimeService, 'call' | 'subscribe'>>
  /** Forward canonical GUI work before its original business orchestration begins. */
  forwardControl?<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>,
    context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>>
  forwardSubscription?<M extends AgentMuxRpcStreamMethod>(method: M, params: import('./public-rpc.js').AgentMuxRpcStreamParams<M>,
    handlers: AgentMuxRpcSubscriptionOptions<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcSubscription>
}
export type AgentMuxRpcCallContext = { caller?: AgentMuxRpcCredentials; signal?: AbortSignal; principal?: AgentMuxRpcPrincipal;
  /** Actual receiving hop, supplied only by the transport owner. */
  transport?: 'unix' | 'http' }
export type AgentMuxRpcServiceSubscription<M extends AgentMuxRpcStreamMethod = AgentMuxRpcStreamMethod> = {
  initial: AgentMuxRpcStreamInitial<M>; start?(): void | Promise<void>; dispose(): void | Promise<void>
}
const NATIVE_FIELDS = {
  'runtime.bootstrap': ['consumerId'], 'runtime.invoke': ['consumerId', 'invocation'],
  'runtime.release-consumer': ['consumerId'], 'runtime.events': ['consumerId'],
  'runtime.history-watch': ['consumerId', 'agentSessionId', 'options'],
  whoami: [], 'agent.ls': ['agentSessionId', 'executorId', 'status', 'since', 'limit'],
  'agent.inspect': ['target'], 'agent.role.ls': ['workspacePath'],
  'agent.role.register': ['role', 'providerId'], 'agent.role.resolve': ['role', 'workspacePath'],
  'agent.send': ['target', 'text', 'messageId', 'threadId', 'correlationId', 'replyTo', 'operationId'],
  'agent.discuss': ['executorId', 'providerId', 'text', 'operationId'],
  'agent.handoff': ['toAgentSessionId', 'taskId'], 'agent.output': ['agentSessionId', 'afterByte', 'follow'],
  'message.inbox.check': ['limit'], 'message.inbox.ack': ['generation', 'readerRun'],
  'message.dispatch.open': ['sourceMessageId'], 'message.dispatch.inspect': ['sourceMessageId'],
  'message.dispatch.report': ['sourceMessageId', 'replyMessageId', 'kind'],
  'app.snapshot': ['projectId', 'workspaceId', 'topicId', 'agentSessionId', 'goalId', 'executorId', 'status', 'since', 'limit', 'include'],
  'goal.activity': ['goalId', 'projectId', 'agentSessionId', 'executorId', 'status', 'since', 'limit'],
  'system.doctor': ['workspacePath'], 'system.endpoint': [],
  'system.subscription.cancel': ['subscriptionId']
} as const satisfies Record<Exclude<keyof typeof AGENTMUX_RPC_NATIVE_METHODS, import('./public-rpc-device.js').AgentMuxRpcDeviceMethod>, readonly string[]>

function cause(error: unknown, fallback = 'CONTROL_FAILED') {
  return { code: error instanceof AgentMuxError ? error.code : fallback,
    message: error instanceof Error ? error.message : String(error) }
}
function readerError(error: unknown): Extract<AgentMuxRpcStreamEvent<AgentMuxRpcStreamMethod>, { type: 'error' }>['error'] {
  const failure = rpcFailure(null, error).error!
  return { ...rpcRecord(failure.data), message: failure.message } as Extract<AgentMuxRpcStreamEvent<AgentMuxRpcStreamMethod>, { type: 'error' }>['error']
}
function unavailable(error: unknown): AgentMuxRpcUnavailable {
  return { ...cause(error), recovery: 'Read this exact object again after its original owner is available.' }
}
function bytes({ dataBytes, ...range }: FollowOutput) {
  return { ...range, dataBase64: Buffer.from(dataBytes).toString('base64') }
}
function validateFilters(p: Record<string, unknown>): void {
  for (const field of ['projectId', 'workspaceId', 'topicId', 'agentSessionId', 'goalId', 'executorId', 'status']) {
    if (p[field] !== undefined) rpcString(p[field], field)
  }
  if (p.since !== undefined) rpcCount(p.since, 0)
  if (p.limit !== undefined) rpcCount(p.limit, 100, 1000)
}

/** All business orchestration lives here; transports carry messages, clients parse argv. */
export class AgentMuxRpcService {
  private local: Promise<AgentMuxClient> | undefined
  constructor(private readonly ports: AgentMuxRpcServiceOptions = {}) {}

  private async hosted(method: AgentMuxRpcMethod, params: unknown, context: AgentMuxRpcCallContext) {
    // Native SDK writes are authorized as a user/device by the transport. An
    // Agent capability remains confined to agent.* and cannot mint source:user.
    if (context.caller !== undefined || !context.principal ||
      !['user', 'device'].includes(context.principal.kind)) {
      throw new AgentMuxError('The runtime domain requires a transport-approved user or device, without a managed Agent caller.', 'AGENT_CAPABILITY_INVALID')
    }
    const principalId = rpcString(context.principal.id, 'Transport principal')
    const p = rpcRecord(params, NATIVE_FIELDS[method as keyof typeof NATIVE_FIELDS])
    const consumer = rpcString(p.consumerId, 'Host consumer ID')
    const consumerId = createHash('sha256').update(context.principal.kind + '\0' + principalId + '\0' + consumer).digest('hex')
    if (method === 'runtime.history-watch') {
      rpcString(p.agentSessionId, 'History Session ID')
      if (p.options !== undefined) rpcRecord(p.options, ['commandOverride', 'args', 'env'])
    }
    if (method === 'runtime.invoke' && p.invocation === undefined) throw new AgentMuxError('An SDK invocation is required.', 'INVALID_CONTROL_REQUEST')
    if (!this.ports.hostedRuntime) throw new AgentMuxError('The borrowed Runtime Host business owner is unavailable. Existing Runs are retained.', 'CONTROL_UNAVAILABLE')
    return { owner: await this.ports.hostedRuntime(), params: { ...p, consumerId } }
  }

  private async clients(): Promise<readonly AgentMuxRpcCoreClient[]> {
    if (this.ports.coreClients) return await this.ports.coreClients()
    this.local ??= import('./runtime-client.js').then(({ connectLocalAgentMux }) => connectLocalAgentMux())
    return [{ hostId: 'local', client: await this.local }]
  }
  async dispose(): Promise<void> {
    // A borrowed SDK client belongs to RuntimeController. Only close this service's
    // own SDK connection; closing a reader/connection does not stop an Agent Run.
    const local = this.local; this.local = undefined
    if (local) { try { await (await local).dispose() } catch { /* The owner reports Runtime availability separately. */ } }
  }
  private async owner(id: string) {
    const clients = await this.clients()
    const observed = await Promise.allSettled(clients.map(async ({ hostId, client }) => {
      const [sessions, identities] = await Promise.all([client.readAgentSessions(), client.sessionHistorySources()])
      return { entries: sessions.filter(session => session.hostId === hostId)
        .map(session => ({ hostId, client, session, agentSessionId: session.agentSessionId })),
        identities: identities.filter(session => session.hostId === hostId).map(session => session.agentSessionId) }
    }))
    const entries = observed.flatMap(item => item.status === 'fulfilled' ? item.value.entries : [])
    const issues = observed.flatMap((item, index) => item.status === 'rejected'
      ? [unavailable(new AgentMuxError(`Session facts on Host ${clients[index]!.hostId} are unconfirmed: ${cause(item.reason).message}`, 'AGENT_SESSION_STORE_READ_UNCONFIRMED'))] : [])
    // An exact retained identity has its original Host owner. An unread Host
    // cannot be silently excluded when admitting an otherwise unique prefix.
    if (issues.length && !entries.some(entry => entry.agentSessionId === id)) {
      throw new AgentMuxError('Session prefix or absence cannot be confirmed while a Host store is unreadable. Existing Runs are kept.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
    }
    const identities = observed.flatMap(item => item.status === 'fulfilled' ? item.value.identities : [])
    const agentSessionId = resolveAgentSessionId(id, identities)
    const owners = entries.filter(entry => entry.agentSessionId === agentSessionId)
    if (!owners.length) throw new AgentMuxError('Agent Session identity is retired or unknown.', 'UNKNOWN_AGENT_SESSION')
    if (owners.length !== 1) throw new AgentMuxError('Agent Session has multiple authoritative owners.', 'AMBIGUOUS_AGENT_SESSION')
    return { ...owners[0]!, unavailable: issues }
  }
  private async authenticated(context: AgentMuxRpcCallContext) {
    if (!context.caller) return undefined
    const caller = rpcRecord(context.caller, ['agentSessionId', 'capability'])
    const agentSessionId = rpcString(caller.agentSessionId, 'Caller Session ID')
    const capability = rpcString(caller.capability, 'Caller capability')
    const owner = await this.owner(agentSessionId)
    // The claim must be exact. A capability cannot authenticate an ambiguous/prefix identity.
    if (owner.agentSessionId !== agentSessionId) throw new AgentMuxError('Caller Session ID must be exact.', 'AGENT_CAPABILITY_INVALID')
    const session = await owner.client.authorizeRetainedAgentCaller(capability, agentSessionId)
    return { ...owner, capability, session }
  }
  private requireCaller<T>(caller: T | undefined): T {
    if (!caller) throw new AgentMuxError('This method requires an authenticated managed Agent.', 'MANAGED_AGENT_CONTEXT_REQUIRED')
    return caller
  }
  private async execute(request: AgentMuxControlRequest): Promise<AgentMuxControlResult> {
    if (!this.ports.execute) throw new AgentMuxError('The original Desktop business owner is unavailable.', 'CONTROL_UNAVAILABLE')
    const result = await this.ports.execute(request)
    if (result.operation !== request.operation) throw new AgentMuxError('Business owner returned another operation.', 'CONTROL_PROTOCOL_ERROR')
    const { operation, ...body } = result
    const parsed = parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: request.requestId, operation, ok: true, result: body })
    if (!parsed.ok) throw new AgentMuxError('Business owner returned an invalid result.', 'CONTROL_PROTOCOL_ERROR')
    const validated = { operation, ...parsed.result } as AgentMuxControlResult
    assertControlResultTarget(request, validated)
    return validated
  }
  private request(operation: AgentMuxControlRequest['operation'], body: Record<string, unknown> = {}) {
    return parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: randomUUID(), operation, ...body })
  }
  async call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>,
    context: AgentMuxRpcCallContext = {}): Promise<AgentMuxRpcResult<M>> {
    if (isAgentMuxRpcDeviceMethod(method)) {
      // Unix provenance permits a request, never substitutes for Host OS confirmation.
      if (context.caller !== undefined || context.transport !== 'unix' || context.principal?.kind !== 'user' ||
        !context.principal.id || context.principal.id.includes('\0')) {
        throw new AgentMuxError('Device management requires a local Unix user request and original Host confirmation. Nothing was submitted.', 'CONTROL_PERMISSION_DENIED')
      }
      const input = parseAgentMuxRpcDeviceParams(method, params)
      if (!this.ports.deviceAdministration) throw new AgentMuxError('The original Host device administration owner is unavailable.', 'CONTROL_UNAVAILABLE')
      context.signal?.throwIfAborted()
      return parseAgentMuxRpcDeviceResult(method, await this.ports.deviceAdministration.call(method, input, context), input) as AgentMuxRpcResult<M>
    }
    if (method === 'runtime.bootstrap' || method === 'runtime.invoke' || method === 'runtime.release-consumer') {
      const hosted = await this.hosted(method, params, context)
      return await hosted.owner.call(method, hosted.params, { ...(context.signal ? { signal: context.signal } : {}) }) as AgentMuxRpcResult<M>
    }
    if (method === 'runtime.events' || method === 'runtime.history-watch') throw new AgentMuxError('Runtime observations require a subscription.', 'INVALID_CONTROL_REQUEST')
    const caller = await this.authenticated(context)
    const p = rpcRecord(params)
    let result: unknown
    if (Object.hasOwn(AGENTMUX_RPC_CONTROL_METHODS, method)) {
      if (this.ports.forwardControl) return await this.ports.forwardControl(method, params, context)
      let body = p
      if (method === 'space.inspect') {
        const target = rpcRecord(p.target)
        if (!Object.hasOwn(target, 'operationId') && (target.regionId || target.tabId)) {
          const field = target.regionId ? 'region' : 'tab', id = target[`${field}Id`]
          const presentation: import('./public-rpc.js').AgentMuxRpcSpacePresentation = { region: null, tab: null, unavailable: [] }
          try {
            if (id === 'self') this.requireCaller(caller)
            const observed = await this.execute(this.request(`inspect.${field}`, {
              target: id === 'self' ? { kind: 'self' } : { kind: field, [`${field}Id`]: id },
              ...(caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {})
            }))
            if (observed.operation === 'inspect.region') presentation.region = observed.region
            if (observed.operation === 'inspect.tab') presentation.tab = observed.tab
            if (id === 'self') body = { ...p, target: { ...target, [`${field}Id`]: (presentation[field] as { regionId?: string; tabId: string })[`${field}Id`] } }
          } catch (error) {
            if (id === 'self') throw error
            presentation.unavailable.push(unavailable(error))
          }
          const request = rpcControlRequest('space.inspect', body)
          return { ...rpcControlResult(method, await this.execute(request)), presentation } as AgentMuxRpcResult<M>
        }
      }
      if (method === 'goal.ls') {
        const goals = await this.goals(p)
        return rpcControlResult(method, { operation: 'demand.list', demands: goals }) as AgentMuxRpcResult<M>
      }
      if (method === 'goal.create' || method === 'goal.update') {
        const { risk, confirmation, wikiVersion, ...input } = p
        if (method === 'goal.create' || input.decision !== undefined) {
          const decision = input.decision === undefined ? {} : rpcRecord(input.decision,
            ['input', 'candidates', 'selectedProjectId', 'risk', 'confirmation', 'wikiVersion'])
          input.decision = { input: input.title ?? (input.patch as Record<string, unknown> | undefined)?.title ?? 'Goal update',
            candidates: [], selectedProjectId: input.projectId ?? null,
            risk: risk ?? 'unknown', confirmation: confirmation ?? 'pending', wikiVersion: wikiVersion ?? null,
            ...decision, recordedAt: Date.now(), sourceSessionId: caller?.agentSessionId ?? null }
        }
        body = input
      }
      const internalCaller: AgentMuxControlCaller | undefined = caller
        ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined
      const request = rpcControlRequest(method as keyof typeof AGENTMUX_RPC_CONTROL_METHODS, body, internalCaller)
      if ((request.operation === 'interrupt' || request.operation === 'resume' || request.operation === 'stop') && request.target.kind === 'agent-session') {
        request.target = { kind: 'agent-session', agentSessionId: (await this.owner(request.target.agentSessionId)).agentSessionId }
      }
      if ((request.operation === 'demand.start' || request.operation === 'demand.handoff' || request.operation === 'demand.link-session') && request.sessionId !== undefined) {
        request.sessionId = (await this.owner(request.sessionId)).agentSessionId
      }
      if (request.operation === 'toolkit.run' || request.operation === 'toolkit.stop') {
        if (request.toolId !== 'performance' && (request.operation === 'toolkit.run' ? !request.input : request.executionId === undefined)) {
          const current = await this.toolkit(this.request('toolkit.get', { toolId: request.toolId }), context.signal)
          if (current.operation !== 'toolkit.get' || current.snapshot.kind !== 'script' || current.snapshot.toolId !== request.toolId) {
            throw new AgentMuxError('Toolkit baseline belongs to another tool.', 'CONTROL_PROTOCOL_ERROR')
          }
          const snapshot = current.snapshot
          if (request.operation === 'toolkit.run') request.input = { invocationId: request.requestId,
            expectedRevision: snapshot.definition.revision,
            expectedLatestExecutionId: snapshot.admission?.executionId ?? snapshot.latestConfirmed?.executionId ?? null }
          else request.executionId = snapshot.admission?.executionId ?? null
        }
      }
      result = request.operation.startsWith('toolkit.') ? await this.toolkit(request, context.signal)
        : request.operation === 'metrics.get' ? { operation: 'metrics.get', observation: await this.metrics(context.signal) }
        : await this.execute(request)
      return rpcControlResult(method, result as AgentMuxControlResult) as AgentMuxRpcResult<M>
    }
    const fields = NATIVE_FIELDS[method as keyof typeof NATIVE_FIELDS]
    if (!fields) throw new AgentMuxError('Unknown RPC method.', 'RPC_METHOD_NOT_FOUND')
    rpcRecord(p, fields)
    switch (method) {
      case 'system.endpoint': result = { protocol: 'jsonrpc-2.0', framing: 'json-lines',
        endpoint: this.ports.endpoint ?? { transport: 'unix', path: defaultAgentMuxControlSocketPath() } }; break
      case 'system.doctor': {
        const client = caller?.client ?? (await this.clients())[0]?.client
        if (!client) throw new AgentMuxError('No Core client owner is available.', 'CONTROL_UNAVAILABLE')
        const workspacePath = p.workspacePath === undefined ? caller?.session.workspacePath : rpcString(p.workspacePath, 'Workspace path')
        result = await diagnoseAgentMux({ client, ...(workspacePath === undefined ? {} : { workspacePath }) }); break
      }
      case 'agent.ls': result = await this.sessions(p); break
      case 'agent.inspect': {
        const target = rpcRecord(p.target)
        if (target.kind === 'self') { this.requireCaller(caller); rpcRecord(target, ['kind']) }
        const clients = await this.clients()
        const sessions: Array<{ client: AgentMuxRpcCorePort; session: ReturnType<AgentMuxClient['agentSession']> }> = []
        const selected = target.kind === 'self' ? caller! : target.kind === 'agent-session' ? await this.owner(rpcString(target.agentSessionId, 'Session ID')) : null
        const lookup = selected ? { kind: 'agent-session' as const, agentSessionId: selected.agentSessionId } : target
        const allowed = lookup.kind === 'agent-session' ? ['kind', 'agentSessionId'] : lookup.kind === 'run' ? ['kind', 'run']
          : lookup.kind === 'provider-native' ? ['kind', 'providerId', 'sessionId'] : lookup.kind === 'acp-native' ? ['kind', 'adapterId', 'sessionId'] : []
        rpcRecord(target, target.kind === 'self' ? ['kind'] : allowed)
        if (!allowed.length) throw new AgentMuxError('Agent inspection target is invalid.', 'INVALID_CONTROL_REQUEST')
        if (selected) sessions.push({ client: selected.client, session: selected.session })
        else for (const { client } of clients) {
            try { sessions.push({ client, session: client.resolveAgentSession(lookup as Parameters<AgentMuxClient['resolveAgentSession']>[0]) }) }
            catch (error) { if (!(error instanceof AgentMuxError) || error.code !== 'UNKNOWN_AGENT_SESSION') throw error }
        }
        if (sessions.length !== 1) throw new AgentMuxError('Session lookup is unknown or ambiguous.', sessions.length ? 'AMBIGUOUS_AGENT_SESSION' : 'UNKNOWN_AGENT_SESSION')
        const { client, session } = sessions[0]!
        const issues: AgentMuxRpcUnavailable[] = [...(selected?.unavailable ?? [])]
        let status: Awaited<ReturnType<AgentMuxClient['statusAgent']>> | null = null
        try {
          await client.refreshAgentSession(session.agentSessionId, session.run)
          status = await client.statusAgent(session.agentSessionId)
          if (status.session.run.runId !== session.run.runId) throw new AgentMuxError('Session changed during inspection.', 'STALE_AGENT_SESSION')
        } catch (error) { status = null; issues.push(unavailable(error)) }
        let displayName: { override: string | null; availability: 'observed' | 'unavailable' } = { override: null, availability: 'unavailable' }
        try {
          const alias = await this.execute(this.request('agent.inspect', { agentSessionId: session.agentSessionId }))
          if (alias.operation !== 'agent.inspect') throw new AgentMuxError('Agent alias result is mismatched.', 'CONTROL_PROTOCOL_ERROR')
          displayName = { override: alias.override, availability: 'observed' }
        } catch (error) { issues.push(unavailable(error)) }
        result = { session, status, displayName, unavailable: issues }; break
      }
      case 'whoami': {
        if (this.ports.forwardControl) {
          try { return await this.ports.forwardControl(method, params, context) }
          catch (error) { if (!(error instanceof AgentMuxError) || error instanceof AgentMuxRpcError || error.code !== 'CONTROL_UNAVAILABLE') throw error }
        }
        const owner = this.requireCaller(caller), issues: AgentMuxRpcUnavailable[] = []
        let status: Awaited<ReturnType<AgentMuxClient['statusAgent']>> | null = null
        try {
          await owner.client.refreshAgentSession(owner.agentSessionId, owner.session.run)
          status = await owner.client.statusAgent(owner.agentSessionId)
          if (status.session.run.runId !== owner.session.run.runId) throw new AgentMuxError('Session changed during inspection.', 'STALE_AGENT_SESSION')
        } catch (error) { status = null; issues.push(unavailable(error)) }
        let view: unknown
        try { const observed = await this.execute(this.request('inspect.region', {
          target: { kind: 'self' }, caller: { agentSessionId: owner.agentSessionId, capability: owner.capability } }))
          view = observed.operation === 'inspect.region' ? { attached: true, region: observed.region } : null
        } catch (error) { view = classifySelfViewFailure(error); issues.push(unavailable(error)) }
        result = { session: owner.session, status, view, topic: SELF_CONTEXT_TOPIC_HINT,
          messaging: AGENTMUX_AGENT_MESSAGING_RULES, unavailable: issues }; break
      }
      case 'agent.role.ls': case 'agent.role.resolve': case 'agent.role.register': {
        const scope = caller?.session.workspacePath ?? rpcString(p.workspacePath, 'Explicit role Workspace path')
        if (p.workspacePath !== undefined && caller && p.workspacePath !== scope) {
          throw new AgentMuxError('Role scope does not match the authenticated execution directory.', 'AGENT_CAPABILITY_INVALID')
        }
        if (method === 'agent.role.ls') result = { bindings: await readAgentRoleBindings(scope) }
        else if (method === 'agent.role.register') {
          const owner = this.requireCaller(caller)
          if (p.providerId !== undefined && p.providerId !== owner.session.providerId) {
            throw new AgentMuxError('Role Provider does not match the authoritative Session.', 'INVALID_CONTROL_REQUEST')
          }
          result = { binding: await registerAgentRole({ role: rpcString(p.role, 'Role'),
            agentSessionId: owner.agentSessionId, workspacePath: scope, providerId: owner.session.providerId }) }
        } else {
          const binding = await resolveAgentRole({ workspacePath: scope, role: rpcString(p.role, 'Role'),
            sessionExists: async id => { try { await this.owner(id); return true } catch (error) {
              if (error instanceof AgentMuxError && error.code === 'UNKNOWN_AGENT_SESSION') return false
              throw error
            } } })
          if (!binding) throw new AgentMuxError('Role is unresolved or stale.', 'MAINTAINER_TARGET_UNRESOLVED')
          result = { binding }
        } break
      }
      case 'agent.discuss': {
        const owner = this.requireCaller(caller)
        const discussion = await owner.client.startDiscussion({ capability: owner.capability,
          callerAgentSessionId: owner.agentSessionId, executorId: rpcString(p.executorId, 'Executor ID'),
          providerId: p.providerId === undefined ? rpcString(p.executorId, 'Executor ID') : rpcString(p.providerId, 'Provider ID'),
          workspacePath: owner.session.workspacePath, body: rpcText(p.text, 'Discussion text'),
          operationId: rpcString(p.operationId, 'Operation ID') })
        result = { threadId: discussion.thread.threadId, delivery: discussion.thread.delivery.state,
          targetAgentSessionId: discussion.session.agentSessionId }; break
      }
      case 'agent.handoff': {
        const owner = this.requireCaller(caller)
        result = await owner.client.handOff({ capability: owner.capability, callerAgentSessionId: owner.agentSessionId,
          toAgentSessionId: (await this.owner(rpcString(p.toAgentSessionId, 'Recipient Session ID'))).agentSessionId,
          taskId: rpcString(p.taskId, 'Task ID') }); break
      }
      case 'message.inbox.check': case 'message.inbox.ack':
      case 'message.dispatch.open': case 'message.dispatch.inspect': case 'message.dispatch.report': {
        const owner = this.requireCaller(caller)
        const auth = { capability: owner.capability, callerAgentSessionId: owner.agentSessionId }
        if (method === 'message.inbox.check') result = await owner.client.checkDeliveries({ ...auth, limit: rpcCount(p.limit, 100, 1000) })
        else if (method === 'message.inbox.ack') result = await owner.client.ackDeliveryBatch({ ...auth,
          generation: rpcCount(p.generation, -1), readerRun: { runId: rpcString(rpcRecord(p.readerRun, ['runId']).runId, 'Reader Run ID') } })
        else {
          const input = { ...auth, sourceMessageId: rpcString(p.sourceMessageId, 'Source message ID') }
          result = method === 'message.dispatch.open' ? await owner.client.openDispatch(input)
            : method === 'message.dispatch.inspect' ? await owner.client.showDispatch(input)
            : await owner.client.recordDispatchEvent({ ...input, replyMessageId: rpcString(p.replyMessageId, 'Reply message ID'),
              kind: p.kind as Parameters<AgentMuxClient['recordDispatchEvent']>[0]['kind'] })
        } break
      }
      case 'agent.send': result = this.ports.forwardControl
        ? await this.ports.forwardControl(method, params, context) : await this.send(p, caller); break
      case 'agent.output': throw new AgentMuxError('Agent output is a bounded byte subscription.', 'INVALID_CONTROL_REQUEST')
      case 'goal.activity': {
        if (this.ports.forwardControl) {
          try { return await this.ports.forwardControl(method, params, context) }
          catch (error) { if (!(error instanceof AgentMuxError) || error instanceof AgentMuxRpcError || error.code !== 'CONTROL_UNAVAILABLE') throw error }
        }
        const goals = await this.goals(p)
        const limit = rpcCount(p.limit, 100, 1000)
        result = { activity: goals.flatMap(goal => (goal.activityLog ?? []).map(message => ({
          goalId: goal.id, message, updatedAt: goal.updatedAt
        }))).slice(-limit) }; break
      }
      case 'app.snapshot': {
        if (this.ports.forwardControl) {
          try { return await this.ports.forwardControl(method, params, context) }
          catch (error) { if (!(error instanceof AgentMuxError) || error instanceof AgentMuxRpcError || error.code !== 'CONTROL_UNAVAILABLE') throw error }
        }
        result = await this.snapshot(p); break
      }
      case 'system.subscription.cancel': throw new AgentMuxError('A subscription belongs to its transport connection.', 'INVALID_CONTROL_REQUEST')
      default: throw new AgentMuxError('RPC method is not implemented.', 'RPC_METHOD_NOT_FOUND')
    }
    return result as AgentMuxRpcResult<M>
  }

  private async toolkit(request: AgentMuxControlRequest, signal?: AbortSignal) {
    if (!this.ports.toolkit) throw new AgentMuxError('Toolkit owner is unavailable.', 'TOOLKIT_UNSUPPORTED')
    const { isToolkitRequest, parseToolkitResult, assertToolkitResultTarget } = await import('./toolkit.js')
    if (!isToolkitRequest(request)) throw new AgentMuxError('Toolkit request is invalid.', 'INVALID_CONTROL_REQUEST')
    const raw = rpcRecord(await this.ports.toolkit.execute(request, signal ?? new AbortController().signal), undefined, 'CONTROL_PROTOCOL_ERROR')
    const { operation, ...body } = raw
    if (operation !== request.operation) throw new AgentMuxError('Toolkit operation mismatch.', 'CONTROL_PROTOCOL_ERROR')
    const result = parseToolkitResult(request.operation, body)
    assertToolkitResultTarget(request, result); return result
  }
  private async metrics(signal?: AbortSignal): Promise<import('./metrics.js').MetricsObservation> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    let resolve!: (value: import('./metrics.js').MetricsObservation) => void, reject!: (error: unknown) => void
    const first = new Promise<import('./metrics.js').MetricsObservation>((yes, no) => { resolve = yes; reject = no })
    void first.catch(() => {})
    controller.signal.addEventListener('abort', () => reject(new AgentMuxError('Metrics reader was cancelled.', 'CONTROL_CANCELLED')), { once: true })
    if (!this.ports.metrics) throw new AgentMuxError('Metrics owner is unavailable.', 'METRICS_UNSUPPORTED')
    const sub = await this.ports.metrics.subscribe(resolve, error => reject(error ?? new AgentMuxError('Metrics ended before a snapshot.', 'CONTROL_UNAVAILABLE')), controller.signal)
    try { return await first } finally { signal?.removeEventListener('abort', abort); controller.abort(); sub.dispose() }
  }
  private async sessions(filters: Record<string, unknown>) {
    rpcRecord(filters, NATIVE_FIELDS['agent.ls'])
    validateFilters(filters)
    const clients = await this.clients()
    const scopes = await Promise.allSettled(clients.map(async ({ hostId, client }) => await Promise.all((await client.readAgentSessions()).filter(session => session.hostId === hostId).map(async session => {
      try {
        await client.refreshAgentSession(session.agentSessionId, session.run)
        const observed = await client.statusAgent(session.agentSessionId)
        if (observed.session.run.runId !== session.run.runId) throw new AgentMuxError('Session changed during inspection.', 'STALE_AGENT_SESSION')
        return { session: observed }
      }
      catch (error) { return { error: { agentSessionId: session.agentSessionId as string | null, ...cause(error, 'LIST_SESSION_FAILED') } } }
    }))))
    const results = scopes.flatMap((scope, index) => scope.status === 'fulfilled' ? scope.value
      : [{ error: { agentSessionId: null, hostId: clients[index]!.hostId, ...cause(scope.reason, 'AGENT_SESSION_STORE_READ_UNCONFIRMED') } }])
    const sessions = results.flatMap(item => item.session ? [item.session] : []).filter(item =>
      agentSessionMatches(item, { sessionId: filters.agentSessionId as string | undefined, status: filters.status as string | undefined,
        since: filters.since === undefined ? undefined : rpcCount(filters.since, 0) }) &&
      (!filters.executorId || item.session.executorId === filters.executorId) &&
      true)
      .slice(0, rpcCount(filters.limit, 100, 1000))
    return { sessions, errors: results.flatMap(item => item.error ? [item.error] : []) }
  }
  private async goals(filters: Record<string, unknown>): Promise<AgentMuxDemand[]> {
    rpcRecord(filters, NATIVE_FIELDS['goal.activity'])
    validateFilters(filters)
    const result = await this.execute(this.request('demand.list'))
    if (result.operation !== 'demand.list') throw new AgentMuxError('Goal list is mismatched.', 'CONTROL_PROTOCOL_ERROR')
    return result.demands.filter(goal => (!filters.goalId || goal.id === filters.goalId) &&
      (!filters.projectId || goal.projectId === filters.projectId) &&
      (!filters.agentSessionId || goal.sessionIds.includes(String(filters.agentSessionId))) &&
      (!filters.executorId || goal.assigneeExecutorId === filters.executorId) &&
      (!filters.status || goal.status === filters.status) &&
      (filters.since === undefined || goal.updatedAt >= rpcCount(filters.since, 0)))
      .slice(0, rpcCount(filters.limit, 100, 1000))
  }
  private async send(p: Record<string, unknown>, caller: Awaited<ReturnType<AgentMuxRpcService['authenticated']>>) {
    const target = rpcRecord(p.target)
    const operationId = rpcString(p.operationId, 'Operation ID'), text = rpcText(p.text, 'Message text')
    let recipientId: string
    if (target.kind === 'self') { rpcRecord(target, ['kind']); recipientId = this.requireCaller(caller).agentSessionId }
    else if (target.kind === 'agent-session') {
      rpcRecord(target, ['kind', 'agentSessionId'])
      recipientId = (await this.owner(rpcString(target.agentSessionId, 'Recipient Session ID'))).agentSessionId
    } else if (target.kind === 'region' || target.kind === 'tab') {
      rpcRecord(target, ['kind', target.kind === 'region' ? 'regionId' : 'tabId'])
      const inspected = await this.execute(this.request(target.kind === 'region' ? 'inspect.region' : 'inspect.tab', { target }))
      const regions = inspected.operation === 'inspect.region' ? [inspected.region]
        : inspected.operation === 'inspect.tab' ? inspected.tab.regions : []
      const candidates = agentMuxMessageTargetCandidates(regions)
      if (candidates.length !== 1) throw Object.assign(new AgentMuxError('Target has no unique Agent Session.',
        candidates.length ? 'MESSAGE_TARGET_NOT_UNIQUE' : 'MESSAGE_TARGET_NOT_AGENT'), { candidates })
      recipientId = candidates[0]!.agentSessionId
    } else throw new AgentMuxError('Message target is invalid.', 'INVALID_CONTROL_REQUEST')
    const recipientOwner = await this.owner(recipientId)
    const durable = (await recipientOwner.client.readAgentSessions()).find(session => session.agentSessionId === recipientId)
    if (!durable) throw new AgentMuxError('Recipient Session is no longer retained.', 'UNKNOWN_AGENT_SESSION')
    const recipient = await recipientOwner.client.refreshAgentSession(recipientId, durable.run)
    const messageId = p.messageId === undefined ? 'message-' + createHash('sha256').update(operationId).digest('hex') : rpcString(p.messageId, 'Message ID')
    const queuePath = (caller?.client ?? recipientOwner.client).agentMessageQueuePath()
    const envelope = { operationId, createdAt: Date.now(),
      sender: caller ? { kind: 'agent-session' as const, agentSessionId: caller.agentSessionId }
        : { kind: 'human' as const, principal: 'local-cli' as const },
      recipient: { kind: 'agent-session' as const, agentSessionId: recipientId },
      threadId: p.threadId === undefined ? messageId : rpcString(p.threadId, 'Thread ID'),
      correlationId: p.correlationId === undefined ? messageId : rpcString(p.correlationId, 'Correlation ID'),
      replyTo: p.replyTo === undefined ? null : rpcString(p.replyTo, 'Reply message ID'), workspaceId: null,
      senderSessionId: caller?.agentSessionId ?? null, senderRunId: caller?.session.run.runId ?? null,
      recipientSessionId: recipientId, recipientRunId: recipient.run.runId, body: text }
    // Both participant bindings came from their current Core owners. Public
    // inputs cannot supply sender or Run facts; rechecking a cached registry here
    // would reject a valid capability rotation or a recipient on another Host.
    const queued = await appendGlobalMessage({ ...envelope, messageId }, queuePath)
    if (queued.delivery.state === 'delivered') return queued
    // An admitted envelope with an unconfirmed previous attempt is not a licence
    // to repeat input. Read its persisted receipt, preserving the current Run.
    if (queued.delivery.reason) throw Object.assign(new AgentMuxError('Message delivery remains unconfirmed; inspect the original receipt without repeating input.', 'AGENT_PROMPT_UNCONFIRMED'), { details: queued })
    try {
      const promptCondition = await prepareGlobalMessagePrompt(queued.messageId, async recorded => {
        if (recorded.recipientRunId !== recipient.run.runId || recorded.recipientSessionId !== recipientId) {
          throw new AgentMuxError('Queued recipient Run changed.', 'MESSAGE_RECIPIENT_MISMATCH')
        }
        const active = await this.execute(this.request('list.active-agents', { agentSessionId: recipientId }))
        if (active.operation !== 'list.active-agents') throw new AgentMuxError('Prompt facts are unavailable.', 'CONTROL_PROTOCOL_ERROR')
        return validateAgentPromptCondition(active.agents.find(agent => agent.agentSessionId === recipientId)?.promptCondition)
      }, queuePath)
      const exactTarget = target.kind === 'agent-session' || target.kind === 'self'
        ? { kind: 'agent-session', agentSessionId: recipientId } : target
      await this.execute(this.request('send', { requestId: operationId, target: exactTarget, text, promptCondition,
        message: queued.envelope, ...(caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}) }))
      return { ...await recordGlobalMessageDelivery(queued.messageId, 'delivered', Date.now(), undefined, queuePath), agentSessionId: recipientId }
    } catch (error) {
      await recordGlobalMessageDeliveryIssue(queued.messageId, 'Delivery is unconfirmed: ' + cause(error).message, Date.now(), queuePath).catch(() => {})
      throw error
    }
  }

  private async snapshot(p: Record<string, unknown>): Promise<AgentMuxRpcSnapshot> {
    validateFilters(p)
    const filters = p as AgentMuxRpcSnapshotParams
    const observation: AgentMuxRpcSnapshot = { projects: [], workspaces: [], topics: [], motes: [],
      spaces: [], zones: [], executors: [], agents: [], sessions: [], goals: [], decisions: [], activity: [], unavailable: [] }
    const sources = [
      ['projects', 'list.projects'], ['executors', 'list.agents'], ['agents', 'list.active-agents'], ['goals', 'demand.list'], ['spaces', 'space.ls']
    ] as const
    const include = p.include === undefined ? null : p.include
    if (include !== null && (!Array.isArray(include) || include.some(key => typeof key !== 'string' || !Object.hasOwn(observation, key) || key === 'unavailable'))) {
      throw new AgentMuxError('Snapshot inclusion is invalid.', 'INVALID_CONTROL_REQUEST')
    }
    const wanted = (name: string) => include === null || (include as string[]).includes(name)
    await Promise.all(sources.map(async ([source, operation]) => {
      if (!wanted(source) && !(source === 'spaces' && ['zones', 'workspaces'].some(wanted)) &&
        !(source === 'goals' && ['decisions', 'activity'].some(wanted))) return
      try {
        const result = await this.execute(this.request(operation, operation === 'space.ls' ? { target: {} } : {}))
        if (result.operation === 'list.projects') observation.projects = result.projects.filter(project => !p.projectId || project.projectId === p.projectId)
        if (result.operation === 'list.agents') observation.executors = result.agents.filter(agent => !p.executorId || agent.executorId === p.executorId)
        if (result.operation === 'list.active-agents') observation.agents = result.agents.filter(agent =>
          (!p.agentSessionId || agent.agentSessionId === p.agentSessionId) && (!p.projectId || agent.projectId === p.projectId) &&
          (!p.executorId || agent.executorId === p.executorId) && (!p.status || agent.status === p.status))
        if (result.operation === 'demand.list') {
          const goals = result.demands.filter(goal => (!p.goalId || goal.id === p.goalId) && (!p.projectId || goal.projectId === p.projectId) &&
            (!p.agentSessionId || goal.sessionIds.includes(String(p.agentSessionId))) && (!p.executorId || goal.assigneeExecutorId === p.executorId) &&
            (!p.status || goal.status === p.status) && (p.since === undefined || goal.updatedAt >= rpcCount(p.since, 0)))
          observation.goals = rpcControlResult('goal.ls', { operation: 'demand.list', demands: goals }).goals as AgentMuxRpcSnapshot['goals']
          observation.activity = goals.flatMap(goal => (goal.activityLog ?? []).map(message => ({ goalId: goal.id, message, updatedAt: goal.updatedAt })))
          for (const goal of wanted('decisions') ? goals : []) {
            try { const decisions = await this.execute(this.request('demand.decision-log', { demandId: goal.id }))
              if (decisions.operation === 'demand.decision-log') observation.decisions.push({ goalId: goal.id, decisions: decisions.decisions })
            } catch (error) { observation.unavailable.push({ source: 'decisions', ...unavailable(error) }) }
          }
        }
        if (result.operation === 'space.ls') {
          observation.spaces = result.catalog.spaces.filter(space => (!p.projectId || space.projectId === p.projectId) && (!p.topicId || space.topicId === p.topicId))
          const ids = new Set((observation.spaces as typeof result.catalog.spaces).map(space => space.spaceId))
          const zones = result.catalog.zones.filter(zone => (!p.workspaceId || zone.workspaceId === p.workspaceId) &&
            (!p.topicId && !p.projectId || result.catalog.bindings.some(binding => binding.zoneId === zone.zoneId && ids.has(binding.spaceId))))
          observation.zones = zones
          // Zone bindings are not a Workspace metadata source. Keep that fact
          // unavailable unless the original config/filesystem port supplies it.
        }
      } catch (error) { observation.unavailable.push({ source, ...unavailable(error) }) }
    }))
    if (wanted('sessions')) {
      try { const sessions = await this.sessions({ agentSessionId: p.agentSessionId, executorId: p.executorId,
        status: p.status, since: p.since, limit: p.limit })
        observation.sessions = sessions.sessions
        observation.unavailable.push(...sessions.errors.map(error => ({ source: 'sessions', ...unavailable(new AgentMuxError(error.message, error.code)) })))
      } catch (error) { observation.unavailable.push({ source: 'sessions', ...unavailable(error) }) }
    }
    if (this.ports.snapshot) {
      try { const extra = await this.ports.snapshot(filters)
        for (const [key, value] of Object.entries(extra)) if (key === 'unavailable') observation.unavailable.push(...value as AgentMuxRpcSnapshot['unavailable'])
          else if (Object.hasOwn(observation, key) && wanted(key)) (observation as unknown as Record<string, unknown>)[key] = value
      } catch (error) { observation.unavailable.push({ source: 'filesystem', ...unavailable(error) }) }
    } else for (const source of ['topics', 'motes', 'workspaces']) if (wanted(source)) observation.unavailable.push({ source,
      code: 'FILESYSTEM_SCOPE_UNAVAILABLE', message: 'The original filesystem/config discovery owner is unavailable.',
      recovery: 'Connect the client-owned filesystem/config observation port.' })
    const limit = rpcCount(p.limit, 100, 1000)
    for (const key of Object.keys(observation)) if (key !== 'unavailable') {
      (observation as unknown as Record<string, unknown>)[key] = wanted(key)
        ? (observation as unknown as Record<string, unknown[]>)[key]!.slice(0, limit) : []
    }
    return observation
  }

  async subscribe<M extends AgentMuxRpcStreamMethod>(method: M, params: Record<string, unknown>,
    onEvent: (event: AgentMuxRpcStreamEvent<M>) => void | Promise<void>, context: AgentMuxRpcCallContext = {}): Promise<AgentMuxRpcServiceSubscription<M>> {
    if (method === 'runtime.events' || method === 'runtime.history-watch') {
      const hosted = await this.hosted(method, params, context)
      return await hosted.owner.subscribe(method, hosted.params, onEvent as (event: import('./hosted-client-contract.js').AgentMuxHostedStreamEvent) => void | Promise<void>,
        { ...(context.signal ? { signal: context.signal } : {}) }) as AgentMuxRpcServiceSubscription<M>
    }
    const caller = await this.authenticated(context)
    if (this.ports.forwardSubscription && (method === 'browser.follow' || method === 'toolkit.watch' || method === 'system.metrics.watch')) {
      let initial: AgentMuxRpcStreamInitial<M> | undefined
      const subscription = await this.ports.forwardSubscription(method, params as import('./public-rpc.js').AgentMuxRpcStreamParams<M>, {
        onInitial: value => { initial = value }, onEvent: event => { void onEvent(event) },
        onEnd: error => { void onEvent(error ? { type: 'error', error: readerError(error) } : { type: 'end', data: {} }) },
        ...(context.signal ? { signal: context.signal } : {})
      }, context)
      if (initial === undefined) { await subscription.dispose(); throw new AgentMuxError('Forwarded observation returned without its opening response.', 'CONTROL_PROTOCOL_ERROR') }
      return { initial, dispose: () => subscription.dispose() }
    }
    const controller = new AbortController()
    const aborted = () => { controller.abort(); void dispose().catch(() => {}) }
    context.signal?.addEventListener('abort', aborted, { once: true })
    
    let closed = false, cleaned = false, cleanup: (() => void | Promise<void>) | undefined
    const dispose = async () => { closed = true; controller.abort();
      context.signal?.removeEventListener('abort', aborted); if (cleanup && !cleaned) { cleaned = true; await cleanup() } }
    if (context.signal?.aborted) await dispose()
    const emit = (event: unknown) => { if (!closed) return onEvent(event as AgentMuxRpcStreamEvent<M>) }
    try {
      let initial: unknown, start: (() => void | Promise<void>) | undefined
      if (method === 'agent.output') {
        rpcRecord(params, NATIVE_FIELDS['agent.output'])
        if (params.follow !== undefined && typeof params.follow !== 'boolean') throw new AgentMuxError('Output follow must be boolean.', 'INVALID_CONTROL_REQUEST')
        const id = rpcString(params.agentSessionId, 'Session ID')
        const owner = id === 'self' ? this.requireCaller(caller) : await this.owner(id)
        const cursor = rpcCount(params.afterByte, 0)
        const current = await owner.client.refreshAgentSession(owner.agentSessionId, owner.session.run), runId = current.run.runId
        const ordered = new OrderedSessionOutputFollow(runId, cursor,
          async event => { for (let offset = 0; offset < event.dataBytes.length && !closed; offset += 128 * 1024) {
            const dataBytes = event.dataBytes.subarray(offset, offset + 128 * 1024), startByte = event.startByte + offset
            await emit({ type: 'output', data: bytes({ ...event, dataBytes, startByte, endByte: startByte + dataBytes.length }) })
          } }, event => { void emit({ type: 'end', data: { runId, ...event } }) },
          error => { void Promise.resolve(emit({ type: 'error', error: readerError(error) })).finally(dispose).catch(() => {}) })
        let attached: Awaited<ReturnType<AgentMuxClient['observeAgentOutput']>> | undefined
        cleanup = async () => { if (attached) await attached.close() }
        attached = await owner.client.observeAgentOutput(owner.agentSessionId, cursor, event => {
          if (event.type === 'agent-error') { void emit({ type: 'error', error: { code: event.code, message: event.message } }); return }
          if (params.follow === true) ordered.accept(event)
        })
        if (attached.session.run.runId !== runId || attached.attachment.run.runId !== runId) {
          throw new AgentMuxError('Session changed before output observation completed. Its Run is kept.', 'STALE_AGENT_SESSION')
        }
        initial = { session: attached.session, run: attached.attachment.run, gap: attached.attachment.gap,
          terminal: attached.attachment.terminal, resizeRevision: attached.attachment.resizeRevision }
        start = async () => {
          try { await ordered.finishReplayAsync(attached!.attachment.replay) }
          catch (error) { await emit({ type: 'error', error: readerError(error) }); await dispose(); return }
          if (params.follow !== true || attached!.attachment.run.state !== 'running') await emit({ type: 'end',
            data: { runId, state: attached!.attachment.run.state, reason: params.follow === true ? 'owner-ended' : 'replay-complete' } })
        }
      } else if (method === 'browser.follow') {
        const request = rpcControlRequest(method, params, caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined)
        if (request.operation !== 'browser.subscribe' || !this.ports.subscribeBrowserOperation) throw new AgentMuxError('Browser subscriptions are unavailable.', 'BROWSER_SUBSCRIBE_UNSUPPORTED')
        const sub = await this.ports.subscribeBrowserOperation(request, event => emit({ type: 'progress', data: event }))
        initial = { runOperation: sub.runOperation, gap: sub.gap }; cleanup = () => sub.dispose()
      } else if (method === 'toolkit.watch') {
        const request = rpcControlRequest(method, params)
        if (request.operation !== 'toolkit.watch' || !this.ports.toolkit) throw new AgentMuxError('Toolkit subscriptions are unavailable.', 'TOOLKIT_UNSUPPORTED')
        const sub = await this.ports.toolkit.subscribe(request.toolId, data => emit({ type: 'snapshot', data }),
          error => emit(error ? { type: 'error', error: readerError(error) } : { type: 'end', data: {} }), controller.signal)
        initial = { toolId: request.toolId }; cleanup = () => sub.dispose()
      } else {
        rpcRecord(params, [])
        if (!this.ports.metrics) throw new AgentMuxError('Metrics subscriptions are unavailable.', 'METRICS_UNSUPPORTED')
        let resolve!: (value: import('./metrics.js').MetricsObservation) => void, reject!: (error: unknown) => void
        const first = new Promise<import('./metrics.js').MetricsObservation>((yes, no) => { resolve = yes; reject = no })
        void first.catch(() => {})
        controller.signal.addEventListener('abort', () => reject(new AgentMuxError('Metrics reader was cancelled.', 'CONTROL_CANCELLED')), { once: true })
        if (controller.signal.aborted) reject(new AgentMuxError('Metrics reader was cancelled.', 'CONTROL_CANCELLED'))
        let observed = false
        const sub = await this.ports.metrics.subscribe(data => { if (!observed) { observed = true; resolve(data) }
          else emit({ type: 'snapshot', data }) }, error => { if (!observed) reject(error ?? new AgentMuxError('Metrics ended without a snapshot.', 'CONTROL_UNAVAILABLE'))
          else emit(error ? { type: 'error', error: readerError(error) } : { type: 'end', data: {} }) }, controller.signal)
        cleanup = () => sub.dispose(); initial = { observation: await first }
      }
      if (controller.signal.aborted) { await dispose(); throw new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED') }
      return { initial: initial as AgentMuxRpcStreamInitial<M>, ...(start ? { start } : {}), dispose }
    } catch (error) { await dispose(); throw error }
  }
}
