import { sanitizeHostedInputInvocation } from './performance-diagnostics.js'
import { randomUUID } from 'node:crypto'
import type { AgentMuxControlEndpointState } from './control-endpoint-state.js'
import type { AgentMuxClient } from './client.js'
import type { AgentMuxClientEvent, AgentMuxRunAttachment, AgentMuxRunRef } from './types.js'
import { AgentMuxError } from './errors.js'
import { parseAgentMuxCreationTrustInput } from './agent-creation-admission.js'
import { rpcString } from './rpc-business-codec.js'
import { AGENTMUX_HOSTED_METHODS, AGENTMUX_HOSTED_RUNTIME_METHODS, AGENTMUX_HOSTED_RPC_FIELDS, type AgentMuxHostedRuntimeMethod, type AgentMuxHostedBootstrap, type AgentMuxHostedInvocation,
  type AgentMuxHostedMethod, type AgentMuxHostedStreamEvent, type AgentMuxHostedTransferChunk,
  type AgentMuxRuntimeOwnerIdentity, type AgentMuxRuntimeFence, type AgentMuxHostedAttachmentTarget } from './hosted-client-contract.js'
import { decodeHostedValue, encodeHostedValue, hostedTransfer, AGENTMUX_HOSTED_TRANSFER_MAX_BYTES } from './hosted-value.js'

const OFFLINE_METHODS = new Set<AgentMuxHostedMethod>([
  'listNativeAgentSessions', 'listHostNativeAgentSessions', 'readNativeAgentHistory', 'readHostNativeAgentHistory', 'readNativeAgentHistoryResource', 'readHostNativeAgentHistoryResource',
  'clientPerformanceDiagnostics', 'respondAgentInteraction', 'inspectAgentInteractionOperation',
  'listHostExecutors', 'configureHostExecutor',
  'readDeliveryAttempt', 'inspectAgentPromptSubmission', 'inspectAgentInput', 'stopAgentInputWaiting', 'rejoinAgentInputWaiting', 'resolveAgentCreationSessionId',
  'readAgentSessions', 'readAgentFuturePromptIntent', 'listAgentFuturePromptIntents', 'sessionTimeline', 'readAgentSessionHistory', 'conversationCheckpoint', 'readConversationChanges', 'sessionHistorySources', 'sessionHistoryPage', 'sessionHistoryResource', 'inspectManagedHooks',
  'checkDeliveries', 'ackDeliveryBatch',
  'authorizeAgentCaller', 'authorizeRetainedAgentCaller', 'authorizeAgentMessage', 'handOff', 'readMessage', 'readDispatch', 'listDispatches'
])
// These exact Run capabilities have no Session-observation prerequisite. Semantic methods keep connect().
const RUNTIME_METHODS = new Set<AgentMuxHostedMethod>(AGENTMUX_HOSTED_RUNTIME_METHODS)
type Emit = (event: AgentMuxHostedStreamEvent) => void | Promise<void>
type Context = { principal?: import('./public-rpc.js').AgentMuxRpcPrincipal; caller?: unknown; sourceDevice?: undefined | import('./types.js').AgentOperationDevice;
  assertCurrent?(): void | Promise<void>;
  recordDeviceOperation?: (source: import('./types.js').AgentOperationDevice, method: string, args: unknown[], result: 'confirmed' | 'failed' | 'unknown', operationId: string) => Promise<void>; signal?: AbortSignal; afterResponse?: Array<() => void | Promise<void>> }
type Reader = { enqueue(chunks: AgentMuxHostedTransferChunk[], metadata?: AgentMuxClientEvent): void; fail(error: unknown): void;
  start(): Promise<void>; close(): void;
  readonly initialId: string; readonly closed: boolean; readonly eventDestination?: Reader }
type InitialReader = Reader & { metadataIds(): readonly string[]; coverMetadata(id: string, retain: (queued: readonly AgentMuxClientEvent[]) => AgentMuxClientEvent | null): void;
  begin(initial: unknown): void; readonly opening: boolean }
function reader(emit: Emit, initial: unknown, onFailure: () => void, opening = false): InitialReader {
  const initialId = randomUUID()
  let closed = false, started = false, pumping = false, queuedBytes = 0, initialReady = false
  const queue: Array<{ chunks: AgentMuxHostedTransferChunk[]; metadata?: AgentMuxClientEvent | undefined }> = []
  const metadataId = (event?: AgentMuxClientEvent) => event?.type === 'agent-session' ? event.session.agentSessionId
    : event?.type === 'run-removed' ? event.agentSessionId : undefined
  const size = (chunks: AgentMuxHostedTransferChunk[]) => chunks.reduce((sum, chunk) => sum + chunk.dataBase64.length, 0)
  const pump = async () => {
    if (closed || !started || !initialReady || pumping) return
    pumping = true
    try {
      while (!closed && queue.length) {
        const { chunks } = queue.shift()!
        queuedBytes -= size(chunks)
        for (const data of chunks) { if (closed) break; await emit({ type: 'snapshot', data }) }
      }
    } catch (error) { output.fail(error) }
    finally { pumping = false }
  }
  const output: InitialReader = {
    initialId, get closed() { return closed }, get opening() { return !initialReady },
    metadataIds() { return [...new Set(queue.flatMap(entry => metadataId(entry.metadata) ? [metadataId(entry.metadata)!] : []))] },
    coverMetadata(id, retain) {
      if (closed) return
      if (initialReady) throw new AgentMuxError('Metadata coverage belongs to the opening reader only.', 'CONTROL_PROTOCOL_ERROR')
      const matching = queue.filter(entry => metadataId(entry.metadata) === id)
      const observation = retain(matching.map(entry => entry.metadata!))
      let insertion = queue.length
      for (let index = queue.length - 1; index >= 0; index--) if (metadataId(queue[index]!.metadata) === id) {
        queuedBytes -= size(queue[index]!.chunks); queue.splice(index, 1)
        insertion = index
      }
      if (observation) {
        const chunks = hostedTransfer({ kind: 'event', event: observation }, randomUUID())
        queuedBytes += size(chunks); queue.splice(insertion, 0, { chunks, metadata: observation })
      }
    },
    begin(value) {
      if (closed) return
      if (initialReady) throw new AgentMuxError('This reader already owns its initial cut.', 'CONTROL_PROTOCOL_ERROR')
      const chunks = hostedTransfer({ kind: 'initial', value }, initialId)
      queuedBytes += size(chunks); queue.unshift({ chunks }); initialReady = true
      if (queuedBytes > AGENTMUX_HOSTED_TRANSFER_MAX_BYTES * 2) {
        output.fail(new AgentMuxError('This reader fell behind while opening; the original owner and Run remain live.', 'RUNTIME_READER_BUDGET_EXCEEDED'))
      } else void pump()
    },
    enqueue(chunks, metadata) {
      if (closed) return
      queuedBytes += size(chunks)
      if (queuedBytes > AGENTMUX_HOSTED_TRANSFER_MAX_BYTES * 2) {
        output.fail(new AgentMuxError('This reader fell behind; reattach from its last observed cursor. The Run remains live.', 'RUNTIME_READER_BUDGET_EXCEEDED'))
        return
      }
      queue.push({ chunks, metadata }); void pump()
    },
    fail(error) {
      if (closed) return
      closed = true; queue.length = 0; queuedBytes = 0
      const failure = { code: error instanceof AgentMuxError ? error.code : 'RUNTIME_ATTACHMENT_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error) }
      void Promise.resolve().then(() => emit({ type: 'error', error: failure }))
        .then(() => emit({ type: 'end', data: { reason: 'reader-failed' } })).catch(() => {})
      onFailure()
    },
    async start() { started = true; await pump() },
    close() { closed = true; queue.length = 0; queuedBytes = 0 }
  }
  if (!opening) output.begin(initial)
  return output
}
function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Invalid hosted RPC input.', 'INVALID_CONTROL_REQUEST')
  if (fields && Object.keys(value).some(key => !fields.includes(key))) throw new AgentMuxError('Unknown hosted RPC field.', 'INVALID_CONTROL_REQUEST')
  return value as Record<string, unknown>
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/u.test(value)) throw new AgentMuxError('Invalid Host consumer identity.', 'INVALID_CONTROL_REQUEST')
  return value
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AgentMuxError('Invalid byte cursor.', 'INVALID_CONTROL_REQUEST')
  return value
}
/** Release a readonly wait without claiming cancellation of its original Native operation. */
async function observe<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await operation
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new AgentMuxError('The original observation reader was cancelled; its Run and admitted operations are retained.', 'CONTROL_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
type Consumer = { events?: InitialReader; histories: Set<() => void>; readers: Set<() => Promise<void>>; runs: Map<string, () => Promise<void>>; pending: number }
type RunReaders = { readers: Set<Reader>; open: Promise<AgentMuxRunAttachment>; closing?: Promise<void> }

/** One semantic owner and one matching-Run dispatch index. Readers never own a Run's lifecycle. */
export class AgentMuxHostedRuntimeService {
  private readonly consumers = new Map<string, Consumer>()
  private readonly runs = new Map<string, RunReaders>()
  private readonly unsubscribe: () => void
  private disposed = false
  private endpointState?: Extract<AgentMuxClientEvent, { type: 'control-endpoint-state' }>
  private connection: Extract<AgentMuxClientEvent, { type: 'connection-state' }> | null = null
  constructor(readonly client: AgentMuxClient, private readonly storePath: string | null,
    private readonly identity: () => AgentMuxRuntimeOwnerIdentity, private readonly shutdown?: () => void | Promise<void>) {
    this.unsubscribe = client.onEvent(event => {
      if (event.type === 'connection-state' && event.observationOrigin?.boundary === 'core-ctxmux') this.connection = structuredClone(event)
      this.publish(event)
    })
  }
  publishControlEndpointState(state: AgentMuxControlEndpointState): void {
    this.endpointState = { ...state, type: 'control-endpoint-state', evidence: { source: 'agentmux', observedAt: Date.now() } }
    this.publish(this.endpointState)
  }
  private owner(expectedRuntimeId?: unknown): AgentMuxRuntimeOwnerIdentity {
    if (this.disposed) throw new AgentMuxError('The original semantic owner is unavailable.', 'RUNTIME_UNAVAILABLE')
    const owner = this.identity()
    if (expectedRuntimeId !== undefined && (typeof expectedRuntimeId !== 'string' || expectedRuntimeId !== owner.runtimeId)) {
      throw new AgentMuxError('This endpoint belongs to another semantic Runtime; existing Sessions were retained.', 'RUNTIME_OWNER_MISMATCH')
    }
    return owner
  }
  assertFence(value: unknown): void {
    const p = record(value), owner = this.owner(p.runtimeId)
    if (Object.keys(p).length !== 2 || typeof p.runtimeId !== 'string' || typeof p.ownerInstanceId !== 'string') throw new AgentMuxError('Invalid Runtime owner fence.', 'INVALID_CONTROL_REQUEST')
    if (p.ownerInstanceId !== owner.ownerInstanceId) throw new AgentMuxError('The semantic owner process changed; reconnect before issuing another intent.', 'RUNTIME_OWNER_CHANGED')
  }
  private observationConsumer(id: string): Consumer {
    let consumer = this.consumers.get(id)
    if (!consumer) { consumer = { histories: new Set(), readers: new Set(), runs: new Map(), pending: 0 }; this.consumers.set(id, consumer) }
    return consumer
  }
  private pruneConsumer(id: string, value: Consumer): void {
    if (!value.pending && !value.events && !value.histories.size && !value.readers.size && !value.runs.size && this.consumers.get(id) === value) this.consumers.delete(id)
  }
  private releaseUnconfirmed(error: unknown): void {
    this.publish({ type: 'agent-error', code: 'HOST_OBSERVATION_RELEASE_UNCONFIRMED',
      message: `This reader was removed, but releasing its observation is unconfirmed. The original Run is retained. ${error instanceof Error ? error.message : String(error)}`,
      evidence: { source: 'agentmux', observedAt: Date.now() } })
  }
  private publish(event: AgentMuxClientEvent): void {
    const terminal = event.type === 'terminal-output' || event.type === 'terminal-snapshot' || event.type === 'terminal-resized'
    const runId = 'run' in event ? event.run.runId : 'evidence' in event ? event.evidence.run?.runId : undefined
    const matching = runId ? this.runs.get(runId)?.readers : undefined
    if ((!matching || !matching.size) && (terminal || !this.consumers.size)) return
    const recipients = new Set<Reader>(matching ? [...matching].map(reader => reader.eventDestination ?? reader) : [])
    if (!terminal) for (const consumer of this.consumers.values()) if (consumer.events && !consumer.events.closed) recipients.add(consumer.events)
    if (!recipients.size) return
    let chunks: AgentMuxHostedTransferChunk[]
    try { chunks = hostedTransfer({ kind: 'event', event: event,
      ...(event.type === 'connection-state' && event.state === 'restored' ? { owner: this.owner() } : {}) }, randomUUID()) }
    catch (error) { for (const reader of recipients) reader.fail(error); return }
    for (const reader of recipients) {
      // The initial snapshot takes the current connection cut synchronously with begin().
      // Replaying an earlier retrying/lost afterward could revoke a now-confirmed Native.
      if ('opening' in reader && reader.opening && event.type === 'connection-state') continue
      reader.enqueue(chunks, event.type === 'agent-session' || event.type === 'run-removed' ? event : undefined)
    }
  }
  async bootstrap(): Promise<AgentMuxHostedBootstrap> {
    const sessions = await this.client.readAgentSessions()
    return this.bootstrapSnapshot(sessions)
  }
  private bootstrapSnapshot(sessions: AgentMuxHostedBootstrap['sessions']): AgentMuxHostedBootstrap {
    return { owner: this.owner(), connection: structuredClone(this.connection), storePath: this.storePath,
      hostProcessId: process.pid, catalog: this.client.catalog(), sessions,
      messageQueuePath: this.client.agentMessageQueuePath() }
  }
  async call(method: 'runtime.owner.identity', params: unknown, context?: Context): Promise<{ owner: AgentMuxRuntimeOwnerIdentity }>
  async call(method: string, params: unknown, context?: Context): Promise<unknown>
  async call(method: string, params: unknown, context: Context = {}): Promise<unknown> {
    if (!Object.hasOwn(AGENTMUX_HOSTED_RPC_FIELDS, method)) throw new AgentMuxError('Unknown hosted public method.', 'RPC_METHOD_NOT_FOUND')
    const p = record(params, AGENTMUX_HOSTED_RPC_FIELDS[method as AgentMuxHostedRuntimeMethod])
    if (method === 'runtime.owner.identity') return { owner: this.owner(p.expectedRuntimeId) }
    this.assertFence(p.fence)
    if (method === 'runtime.owner.shutdown') {
      if (!this.shutdown || !context.afterResponse) throw new AgentMuxError('This service has no shutdown owner.', 'RUNTIME_SHUTDOWN_UNAVAILABLE')
      context.afterResponse.push(() => this.shutdown!())
      return { owner: this.owner(), accepted: true }
    }
    const id = identifier(p.consumerId)
    if (method === 'runtime.bootstrap') return await observe(this.bootstrap(), context.signal)
    if (method === 'runtime.release-consumer') return { released: await this.releaseConsumer(id) }
    if (method !== 'runtime.invoke') throw new AgentMuxError('Unknown hosted public method.', 'RPC_METHOD_NOT_FOUND')
    const input = record(decodeHostedValue(sanitizeHostedInputInvocation(p.invocation)), ['method', 'args'])
    if (typeof input.method !== 'string' || !(AGENTMUX_HOSTED_METHODS as readonly string[]).includes(input.method) || !Array.isArray(input.args) || input.args.length > 12) {
      throw new AgentMuxError('The method is outside the finite SDK surface.', 'INVALID_CONTROL_REQUEST')
    }
    if (input.method === 'trustCreationSource') {
      if (input.args.length !== 1 || context.caller !== undefined || context.principal?.kind !== 'user') {
        throw new AgentMuxError('Creation-source trust requires one input and a transport-approved user.', 'CONTROL_PERMISSION_DENIED')
      }
      const trust = parseAgentMuxCreationTrustInput(record(input.args[0], ['sourceRuntimeId', 'publicKey', 'targetRuntimeId', 'targetKeyFingerprint']))
      context.signal?.throwIfAborted()
      return { value: encodeHostedValue(await this.client.trustCreationSource(trust,
        { kind: 'user', id: rpcString(context.principal.id, 'Transport principal') })) }
    }
    const invocation = input as unknown as AgentMuxHostedInvocation
    const controlledInput = invocation.method === 'submitAgentPrompt' || invocation.method === 'submitAgentMessage' || invocation.method === 'rejoinAgentInputWaiting' || invocation.method === 'respondAgentInteraction'
    if (controlledInput && invocation.args.length !== 1) throw new AgentMuxError('Input call context is supplied only by the original Host, never by wire arguments.', 'INVALID_CONTROL_REQUEST')
    const attachment = invocation.method === 'reattachAgent' || invocation.method === 'attachTerminal' || invocation.method === 'refreshRunAttachment'
    // Direct attachment invocations borrow an existing exact event destination;
    // an unattached invocation must not manufacture a consumer with no owner.
    const original = this.consumers.get(id)
    context.signal?.throwIfAborted()
    if (RUNTIME_METHODS.has(invocation.method)) await observe(this.client.connectRuntime(), context.signal)
    else if (!OFFLINE_METHODS.has(invocation.method) && !(
      (invocation.method === 'submitAgentPrompt' || invocation.method === 'submitAgentMessage') &&
      (invocation.args[0] as { admissionIntent?: { kind?: string } } | undefined)?.admissionIntent?.kind === 'manual-actor')) await observe(this.client.connect(), context.signal)
    context.signal?.throwIfAborted(); this.assertFence(p.fence)
    if (attachment && this.consumers.get(id) !== original) throw new AgentMuxError('Attachment observation changed while reconnecting its original Core.', 'CONTROL_CANCELLED')
    if (invocation.method === 'submitAgentPrompt') {
      const { signal: _wireSignal, ...prompt } = invocation.args[0]
      invocation.args[0] = { ...prompt, ...(prompt.admissionIntent?.kind !== 'manual-actor' && context.signal ? { signal: context.signal } : {}) }
    }
    if (context.signal && invocation.method === 'replySessionQuestion') invocation.args[0] = { ...invocation.args[0], signal: context.signal }
    if (context.signal && (invocation.method === 'sessionHistoryPage' || invocation.method === 'sessionHistoryResource' || invocation.method === 'conversationCheckpoint' || invocation.method === 'readConversationChanges')) invocation.args[1] = { ...invocation.args[1], signal: context.signal }
    if (context.signal && invocation.method === 'readAgentSessionHistory') invocation.args[1] = { signal: context.signal }
    if (context.signal && (invocation.method === 'readNativeAgentHistory' || invocation.method === 'readHostNativeAgentHistory' ||
      invocation.method === 'readNativeAgentHistoryResource' || invocation.method === 'readHostNativeAgentHistoryResource')) invocation.args[0] = { ...invocation.args[0], signal: context.signal }
    if (context.signal && invocation.method === 'clientPerformanceDiagnostics') invocation.args[0] = { signal: context.signal }
    const source = context.sourceDevice
    // Wire arguments cannot assert authenticated provenance. The original Host supplies it.
    for (const arg of invocation.args) if (arg && typeof arg === 'object' && 'sourceDevice' in arg)
      throw new AgentMuxError('Device origin is supplied by the authenticated Host.', 'INVALID_CONTROL_REQUEST')
    const modifying = /^(submit|reply|respond|write|paste|resize|signal|stop|remove|create|resume|reopen|respawn|setAgent|saveAgent|answer|cancel)/.test(invocation.method)
    const first = invocation.args[0] as unknown
    // Match the public human question-reply owner. Only transport-approved
    // user/device intent supplies human authorship; a wire claim cannot name an Agent.
    if (invocation.method === 'replySessionQuestion' && context.caller === undefined && context.principal &&
        ['user', 'device'].includes(context.principal.kind)) {
      if (invocation.args.length !== 1 || !first || typeof first !== 'object' || 'authorAgentSessionId' in first || 'caller' in first) {
        throw new AgentMuxError('A human question reply cannot assert an Agent author or caller.', 'INVALID_CONTROL_REQUEST')
      }
      rpcString(context.principal.id, 'Transport principal')
      invocation.args[0] = { ...invocation.args[0], authorHuman: true }
    }
    if (source && (invocation.method === 'submitAgentPrompt' || invocation.method === 'submitAgentMessage' || invocation.method === 'replySessionQuestion')) invocation.args[0] = { ...invocation.args[0], sourceDevice: source }
    if (source && invocation.method === 'saveAgentFuturePromptIntent') invocation.args[0] = { ...invocation.args[0], sourceDevice: source }
    const operationId = first && typeof first === 'object' && 'operationId' in first ? String(first.operationId) : randomUUID()
    const recordActivity = async (result: 'confirmed' | 'failed' | 'unknown') => {
      if (!source || !modifying) return
      try { await context.recordDeviceOperation?.(source, invocation.method, invocation.args, result, operationId) } catch { /* Recording failure cannot disable the original input capability. */ }
    }
    await recordActivity('unknown')
    let value: unknown
    try {
    if (invocation.method === 'releaseRunAttachment') {
      const release = original?.runs.get(invocation.args[0].runId)
      original?.runs.delete(invocation.args[0].runId); await release?.()
      if (original) this.pruneConsumer(id, original)
    } else if (invocation.method === 'reattachAgent' || invocation.method === 'attachTerminal' || invocation.method === 'refreshRunAttachment') {
      const target: AgentMuxHostedAttachmentTarget = invocation.method === 'reattachAgent'
        ? { kind: 'agent-session', agentSessionId: invocation.args[0] }
        : { kind: 'terminal-run', runId: invocation.method === 'attachTerminal' ? invocation.args[0] : invocation.args[0].runId }
      const runId = target.kind === 'agent-session' ? (await observe(this.client.metadata.resolveRaw(target.agentSessionId), context.signal)).run.runId : target.runId
      const events = original?.events
      if (!events || events.closed) throw new AgentMuxError('This invocation needs an output destination. Open the exact Attachment reader; general Session observation is optional.', 'CONTROL_UNAVAILABLE')
      const previous = original!.runs.get(runId)
      const destination: Reader = { initialId: '', eventDestination: events, get closed() { return events.closed },
        enqueue: chunks => events.enqueue(chunks), fail: error => events.fail(error),
        start: async () => {}, close: () => {} }
      const attached = await this.acquire(target, invocation.args[1] ?? 0, invocation.args[2] ?? 'raw',
        invocation.method === 'refreshRunAttachment', invocation.method === 'refreshRunAttachment' ? invocation.args[3] : undefined,
        destination, p.fence as AgentMuxRuntimeFence, context.signal)
      if (this.consumers.get(id) !== original || events.closed) { await attached.dispose(); throw new AgentMuxError('The original observation closed during admission.', 'CONTROL_CANCELLED') }
      original!.runs.set(runId, attached.dispose); await previous?.()
      value = attached.value
    } else {
      const operation = this.client[invocation.method] as (...args: unknown[]) => unknown
      value = await operation.apply(this.client, controlledInput ? [...invocation.args, {
        ...(context.signal ? { requestSignal: context.signal } : {}),
        ...(context.assertCurrent ? { assertCurrent: context.assertCurrent } : {})
      } satisfies import('./agent-input-wait.js').AgentInputCallContext] : invocation.args)
    }
    } catch (error) { await recordActivity('unknown'); throw error }
    if (invocation.method === 'sessionHistoryResource') {
      context.signal?.throwIfAborted(); this.assertFence(p.fence)
    }
    await recordActivity('confirmed')
    return { value: encodeHostedValue(value) }
  }
  private async acquire(target: AgentMuxHostedAttachmentTarget, afterByte: number, view: 'raw' | 'terminal',
    refresh: boolean, operationId: string | undefined, destination: Reader, fence: AgentMuxRuntimeFence, signal?: AbortSignal) {
    const session = target.kind === 'agent-session' ? await observe(this.client.metadata.resolveRaw(target.agentSessionId), signal) : undefined
    signal?.throwIfAborted(); this.assertFence(fence)
    const runId = session?.run.runId ?? (target as { runId: string }).runId
    if (!runId || target.runId !== undefined && target.runId !== runId) throw new AgentMuxError('The Session now refers to another Run.', 'STALE_AGENT_SESSION_BINDING')
    let entry = this.runs.get(runId)
    while (entry?.closing) { await observe(entry.closing, signal); this.assertFence(fence); entry = this.runs.get(runId) }
    const first = entry === undefined
    if (!entry) {
      entry = { readers: new Set(), open: Promise.resolve().then(async () => {
        if (session && this.client.agentSession(session.agentSessionId).run.runId !== runId) throw new AgentMuxError('Session changed while its previous observation closed.', 'STALE_AGENT_SESSION_BINDING')
        return await this.client.refreshRunAttachment({ runId }, afterByte, view, ...(refresh && operationId !== undefined ? [operationId] : []))
      }) }
      this.runs.set(runId, entry)
    }
    const current = entry
    current.readers.add(destination)
    let released = false
    const dispose = async () => {
      if (released) return; released = true
      current.readers.delete(destination)
      if (!current.readers.size && this.runs.get(runId) === current) {
        current.closing ??= Promise.resolve().then(async () => {
          try { await current.open.catch(() => {}); await this.client.releaseRunAttachment({ runId }) }
          finally { if (this.runs.get(runId) === current) this.runs.delete(runId) }
        })
        await current.closing
      }
    }
    try {
      const initial = await observe(current.open, signal)
      const attachment = first ? initial : refresh
        ? await observe(this.client.refreshRunAttachment({ runId }, afterByte, view, operationId), signal)
        : await observe(this.client.readRunReplay({ runId }, afterByte, view), signal)
      signal?.throwIfAborted(); this.assertFence(fence)
      return { value: session ? { session: this.client.agentSession(session.agentSessionId), attachment } : attachment, dispose }
    } catch (error) {
      const cleanup = dispose().catch(failure => this.releaseUnconfirmed(failure))
      // Cancelling a reader removes its destination now. The exact RunReaders owner
      // retains late opening/detach cleanup; that receipt cannot hold the reader open.
      if (signal?.aborted) void cleanup
      else await cleanup
      throw error
    }
  }
  async subscribe(method: string, params: unknown, emit: Emit, context: Context = {}): Promise<{ initial: unknown; start?(): Promise<void>; dispose(): Promise<void> }> {
    if (!Object.hasOwn(AGENTMUX_HOSTED_RPC_FIELDS, method)) throw new AgentMuxError('Unknown hosted subscription.', 'RPC_METHOD_NOT_FOUND')
    const p = record(params, AGENTMUX_HOSTED_RPC_FIELDS[method as AgentMuxHostedRuntimeMethod]), id = identifier(p.consumerId)
    this.assertFence(p.fence)
    const owner = this.owner()
    if (method === 'runtime.events') {
      const consumer = this.observationConsumer(id)
      if (consumer.events && !consumer.events.closed) throw new AgentMuxError('Host consumer already has an event owner.', 'CONTROL_OWNER_BUSY')
      let events: InitialReader
      const dispose = async () => {
        events.close()
        if (consumer.events !== events) return
        delete consumer.events
        // Legacy attachments deliver into this event destination. Independent
        // Attachment and history readers own their own output and remain open.
        const releases = [...consumer.runs.values()]; consumer.runs.clear()
        this.pruneConsumer(id, consumer)
        await Promise.all(releases.map(release => release()))
      }
      try { events = reader(emit, undefined, () => { void dispose().catch(error => this.releaseUnconfirmed(error)) }, true) }
      catch (error) { this.pruneConsumer(id, consumer); throw error }
      consumer.events = events
      if (this.endpointState) events.enqueue(hostedTransfer({ kind: 'event', event: this.endpointState }, randomUUID()))
      const abort = () => { void dispose().catch(error => this.releaseUnconfirmed(error)) }
      context.signal?.addEventListener('abort', abort, { once: true })
      if (context.signal?.aborted) { await dispose(); throw new AgentMuxError('Host subscription was cancelled.', 'CONTROL_CANCELLED') }
      try {
        const sessions = new Map((await observe(this.client.readAgentSessions(), context.signal)).map(session => [session.agentSessionId, session]))
        // Only identities with queued publications or an in-flight metadata turn
        // need a scoped cut. Each callback runs inside that existing SID queue:
        // older events are covered, and later writes remain after the initial.
        const ids = new Set([...events.metadataIds(), ...this.client.metadata.pendingIds()])
        for (const id of ids) await observe(this.client.metadata.read(id, session => {
          if (events.closed || consumer.events !== events) return
          if (session) sessions.set(id, session)
          else sessions.delete(id)
          events.coverMetadata(id, queued => this.client.metadata.retainObservation(session, queued))
        }, context.signal), context.signal)
        context.signal?.throwIfAborted(); this.assertFence(p.fence)
        if (events.closed || consumer.events !== events) throw new AgentMuxError('Host opening was released.', 'CONTROL_CANCELLED')
        events.begin(this.bootstrapSnapshot([...sessions.values()]))
      } catch (error) { context.signal?.removeEventListener('abort', abort); await dispose(); throw error }
      return { initial: { owner, transferId: events.initialId }, start: () => events.start(), dispose: async () => {
        context.signal?.removeEventListener('abort', abort); await dispose()
      } }
    }
    const original = this.observationConsumer(id)
    original.pending++
    try {
    if (method === 'runtime.history-watch') {
      if (typeof p.agentSessionId !== 'string') throw new AgentMuxError('History watch requires exact Session identity.', 'INVALID_CONTROL_REQUEST')
      let stopped = false, observer: Awaited<ReturnType<AgentMuxClient['observeSessionHistory']>> | undefined
      let consumer!: Reader
      let observerReleased = false
      const releaseObserver = (value: NonNullable<typeof observer>) => {
        if (observerReleased) return
        observerReleased = true
        try { value.dispose() } catch (error) { this.releaseUnconfirmed(error) }
      }
      const stop = () => {
        if (stopped) return
        stopped = true; if (observer) releaseObserver(observer)
        original.histories.delete(stop); this.pruneConsumer(id, original)
        const ended = consumer.closed; consumer.close()
        if (!ended) { try { void Promise.resolve(emit({ type: 'end', data: { reason: 'consumer-released' } })).catch(() => {}) } catch { /* One observer callback cannot retain another lease. */ } }
      }
      consumer = reader(emit, {}, stop)
      const opening = this.client.observeSessionHistory(p.agentSessionId, observation => {
        if (stopped || this.consumers.get(id) !== original) return
        try { consumer.enqueue(hostedTransfer({ kind: 'history', observation }, randomUUID())) } catch (error) { consumer.fail(error) }
      }, { ...record(decodeHostedValue(p.options ?? {})), ...(context.signal ? { signal: context.signal } : {}) })
      // The Provider/Core may still finish acquiring after this reader is cancelled.
      // Its exact late handle is released once without retaining Consumer.pending.
      const trackedOpening = opening.then(value => {
        observer = value
        if (stopped) releaseObserver(value)
        return value
      })
      try { observer = await observe(trackedOpening, context.signal) }
      catch (error) { stop(); throw error }
      if (stopped || this.consumers.get(id) !== original || context.signal?.aborted) {
        releaseObserver(observer); throw new AgentMuxError('History consumer closed while its native observer was acquired.', 'CONTROL_CANCELLED')
      }
      original.histories.add(stop)
      return { initial: { owner, source: observer.source }, start: () => consumer.start(), dispose: async () => stop() }
    }
    if (method !== 'runtime.attachment-watch' && method !== 'runtime.replay-watch') throw new AgentMuxError('Unknown hosted subscription.', 'RPC_METHOD_NOT_FOUND')
    await observe(this.client.connectRuntime(), context.signal)
    this.assertFence(p.fence)
    const target = record(p.target) as AgentMuxHostedAttachmentTarget, afterByte = count(p.afterByte)
    if (p.view !== 'raw' && p.view !== 'terminal' || target.kind !== 'agent-session' && target.kind !== 'terminal-run') throw new AgentMuxError('Invalid Attachment target or view.', 'INVALID_CONTROL_REQUEST')
    if (target.kind === 'agent-session' && typeof target.agentSessionId !== 'string' || target.kind === 'terminal-run' && typeof target.runId !== 'string') throw new AgentMuxError('Invalid Attachment identity.', 'INVALID_CONTROL_REQUEST')
    if (method === 'runtime.replay-watch') {
      const session = target.kind === 'agent-session' ? await observe(this.client.metadata.resolveRaw(target.agentSessionId), context.signal) : undefined
      context.signal?.throwIfAborted(); this.assertFence(p.fence)
      const runId = session?.run.runId ?? target.runId!
      if (target.runId !== undefined && runId !== target.runId) throw new AgentMuxError('The Session now refers to another Run.', 'STALE_AGENT_SESSION_BINDING')
      const attachment = await observe(this.client.readRunReplay({ runId }, afterByte, p.view), context.signal)
      context.signal?.throwIfAborted(); this.assertFence(p.fence)
      if (this.consumers.get(id) !== original) throw new AgentMuxError('Replay consumer closed during observation admission.', 'CONTROL_CANCELLED')
      let consumer!: Reader
      const dispose = async () => { consumer.close(); original.readers.delete(dispose); this.pruneConsumer(id, original) }
      consumer = reader(emit, session ? { session: session, attachment } : attachment, () => { void dispose() })
      original.readers.add(dispose)
      return { initial: { owner, transferId: consumer.initialId }, start: async () => {
        await consumer.start(); if (!consumer.closed) await emit({ type: 'end', data: { runId, reason: 'replay-complete' } })
      }, dispose }
    }
    const pending: AgentMuxHostedTransferChunk[][] = []
    let bytes = 0, failed: unknown, output: Reader | undefined, acquired: Awaited<ReturnType<AgentMuxHostedRuntimeService['acquire']>> | undefined
    const destination: Reader = { initialId: '', get closed() { return output?.closed ?? failed !== undefined },
      enqueue(chunks) {
        if (output) output.enqueue(chunks)
        else if (failed === undefined) {
          bytes += chunks.reduce((sum, chunk) => sum + chunk.dataBase64.length, 0)
          if (bytes > AGENTMUX_HOSTED_TRANSFER_MAX_BYTES * 2) { failed = new AgentMuxError('This initial reader fell behind; its Run remains live.', 'RUNTIME_READER_BUDGET_EXCEEDED'); pending.length = 0 }
          else pending.push(chunks)
        }
      }, fail(error) { if (output) output.fail(error); else { failed = error; pending.length = 0 } }, start: async () => {}, close() { pending.length = 0; output?.close() } }
    let released = false
    const dispose = async () => { if (released) return; released = true; destination.close(); original.readers.delete(dispose); this.pruneConsumer(id, original); await acquired?.dispose() }
    try {
      acquired = await this.acquire(target, afterByte, p.view, p.refresh === true,
        typeof p.operationId === 'string' ? p.operationId : undefined, destination, p.fence as AgentMuxRuntimeFence, context.signal)
      if (failed !== undefined) throw failed
      if (this.consumers.get(id) !== original || original.events?.closed) throw new AgentMuxError('Consumer closed during Attachment admission.', 'CONTROL_CANCELLED')
      output = reader(emit, acquired.value, () => { void dispose().catch(error => this.releaseUnconfirmed(error)) })
      for (const chunks of pending) output.enqueue(chunks)
      pending.length = 0; original.readers.add(dispose)
      return { initial: { owner, transferId: output.initialId }, start: () => output!.start(), dispose }
    } catch (error) { await dispose().catch(failure => this.releaseUnconfirmed(failure)); throw error }
    } finally { original.pending--; this.pruneConsumer(id, original) }
  }
  async releaseConsumer(id: string): Promise<boolean> {
    const consumer = this.consumers.get(id)
    if (!consumer) return false
    consumer.events?.close()
    for (const release of [...consumer.histories]) release()
    const releases = await Promise.allSettled([...consumer.readers, ...consumer.runs.values()].map(release => release()))
    if (this.consumers.get(id) === consumer) this.consumers.delete(id)
    const errors = releases.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Consumer observation release is unconfirmed; no Run was stopped.')
    return true
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.unsubscribe()
    await Promise.all([...this.consumers.keys()].map(id => this.releaseConsumer(id)))
  }
}
