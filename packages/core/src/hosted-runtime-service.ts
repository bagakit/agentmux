import type { AgentMuxClient } from './client.js'
import type { AgentMuxClientEvent, AgentMuxRunAttachment, AgentMuxRunRef } from './types.js'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_HOSTED_METHODS, type AgentMuxHostedBootstrap, type AgentMuxHostedInvocation, type AgentMuxHostedMethod,
  type AgentMuxHostedStreamEvent } from './hosted-client-contract.js'
import { decodeHostedValue, encodeHostedValue } from './hosted-value.js'

// These original Core methods deliberately work without a live Run Runtime connection.
const OFFLINE_METHODS = new Set<AgentMuxHostedMethod>([
  'readAgentSessions', 'sessionTimeline', 'sessionHistorySources', 'sessionHistoryPage', 'inspectManagedHooks',
  'authorizeAgentCaller', 'authorizeRetainedAgentCaller', 'authorizeAgentMessage', 'handOff'
])

type RuntimeConsumer = {
  runs: Set<string>
  events?: (event: AgentMuxHostedStreamEvent) => void | Promise<void>
  histories: Set<() => void>
}
function deliver(event: AgentMuxHostedStreamEvent, listener: (event: AgentMuxHostedStreamEvent) => void | Promise<void>,
  failed: () => void): void {
  try {
    const pending = listener(event)
    if (pending) void pending.catch(failed)
  } catch { failed() }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Invalid hosted RPC input.', 'INVALID_CONTROL_REQUEST')
  return value as Record<string, unknown>
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/u.test(value)) throw new AgentMuxError('Invalid Host consumer identity.', 'INVALID_CONTROL_REQUEST')
  return value
}

/** Client observation leases over one existing Core owner. No process, Provider or byte truth is copied. */
export class AgentMuxHostedRuntimeService {
  private readonly consumers = new Map<string, RuntimeConsumer>()
  private readonly runOwners = new Map<string, Set<string>>()
  private readonly runTails = new Map<string, Promise<unknown>>()
  private readonly unsubscribe: () => void
  constructor(readonly client: AgentMuxClient, private readonly storePath: string | null = null) {
    this.unsubscribe = client.onEvent(event => this.publish(event))
  }
  private consumer(id: string): RuntimeConsumer {
    const value = this.consumers.get(id)
    if (!value?.events) throw new AgentMuxError('This consumer has no active Host observation connection.', 'CONTROL_UNAVAILABLE')
    return value
  }
  private publish(event: AgentMuxClientEvent): void {
    // Encode bytes only for actual interested readers. Unrelated/absent viewers add no hot-path work.
    if (event.type === 'terminal-output' || event.type === 'terminal-snapshot' || event.type === 'terminal-resized') {
      const owners = this.runOwners.get(event.run.runId)
      if (!owners?.size) return
      const encoded = { type: 'snapshot' as const, data: { event: encodeHostedValue(event) as AgentMuxClientEvent } }
      for (const id of owners) this.deliverConsumer(id, encoded)
      return
    }
    const encoded = { type: 'snapshot' as const, data: { event } }
    for (const id of this.consumers.keys()) this.deliverConsumer(id, encoded)
  }
  private deliverConsumer(id: string, event: AgentMuxHostedStreamEvent): void {
    const consumer = this.consumers.get(id), listener = consumer?.events
    if (!consumer || !listener) return
    // Public progress owns its bounded transport queue. A failing callback closes only
    // this observation; it must not interrupt delivery to another reader of the same bytes.
    deliver(event, listener, () => {
      if (this.consumers.get(id) !== consumer || consumer.events !== listener) return
      void this.releaseConsumer(id).catch(error => this.publish({ type: 'agent-error',
        code: 'HOST_OBSERVATION_RELEASE_UNCONFIRMED',
        message: `A failed reader was removed, but its observation release is unconfirmed. The original Run is retained. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', observedAt: Date.now() } }))
    })
  }
  private async serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runTails.get(runId)
    const next = (previous ?? Promise.resolve()).catch(() => {}).then(operation)
    this.runTails.set(runId, next)
    try { return await next }
    finally { if (this.runTails.get(runId) === next) this.runTails.delete(runId) }
  }
  bootstrap(): AgentMuxHostedBootstrap {
    return { identity: this.client.runtimeIdentity(), storePath: this.storePath, hostProcessId: process.pid, catalog: this.client.catalog(),
      sessions: this.client.agentSessions(), messageQueuePath: this.client.agentMessageQueuePath() }
  }
  async call(method: string, params: unknown, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    const p = record(params), id = identifier(p.consumerId)
    if (method === 'runtime.bootstrap') return this.bootstrap()
    if (method === 'runtime.release-consumer') return { released: await this.releaseConsumer(id) }
    if (method !== 'runtime.invoke') throw new AgentMuxError('Unknown hosted public method.', 'RPC_METHOD_NOT_FOUND')
    const input = record(decodeHostedValue(p.invocation))
    if (typeof input.method !== 'string' || !(AGENTMUX_HOSTED_METHODS as readonly string[]).includes(input.method) || !Array.isArray(input.args)) {
      throw new AgentMuxError('The method is outside the public hosted SDK surface.', 'INVALID_CONTROL_REQUEST')
    }
    const originalConsumer = this.consumer(id)
    const invocation = input as unknown as AgentMuxHostedInvocation
    options.signal?.throwIfAborted()
    // A live Host RPC stream does not prove that Core's ctxmux connection is live. As in the
    // original Desktop connectedClient contract, an explicit business retry reconnects the
    // same Core owner even after its bounded background reconnect has exhausted its budget.
    if (!OFFLINE_METHODS.has(invocation.method)) await this.client.connect()
    options.signal?.throwIfAborted()
    if (this.consumer(id) !== originalConsumer) throw new AgentMuxError('Host consumer changed while reconnecting its original Core.', 'CONTROL_CANCELLED')
    if (options.signal && invocation.method === 'submitAgentPrompt') {
      invocation.args[0] = { ...invocation.args[0], signal: options.signal }
    }
    let value: unknown
    if (invocation.method === 'releaseRunAttachment') {
      await this.releaseRun(id, invocation.args[0]); value = undefined
    } else if (invocation.method === 'reattachAgent' || invocation.method === 'attachTerminal' || invocation.method === 'refreshRunAttachment') {
      const runId = invocation.method === 'reattachAgent' ? this.client.agentSession(invocation.args[0]).run.runId
        : invocation.method === 'attachTerminal' ? invocation.args[0] : invocation.args[0].runId
      const afterByte = invocation.args[1] ?? 0, view = invocation.args[2] ?? 'raw'
      value = await this.serialize(runId, async () => {
        const consumer = this.consumer(id)
        options.signal?.throwIfAborted()
        if (consumer !== originalConsumer) throw new AgentMuxError('Host consumer changed before acquiring its Run observation.', 'CONTROL_CANCELLED')
        let owners = this.runOwners.get(runId)
        if (!owners) { owners = new Set(); this.runOwners.set(runId, owners) }
        const first = owners.size === 0
        const retained = owners.has(id)
        owners.add(id); consumer.runs.add(runId)
        try {
          // Core's initial Agent attachment can already exist; explicit refresh adopts it once.
          // Further readers consume read-only replay, never a second same-client attach.
          const attachment: AgentMuxRunAttachment = invocation.method === 'refreshRunAttachment'
            ? await this.client.refreshRunAttachment({ runId }, afterByte, view, invocation.args[3])
            : first ? await this.client.refreshRunAttachment({ runId }, afterByte, view)
            : await this.client.readRunReplay({ runId }, afterByte, view)
          if (invocation.method === 'reattachAgent') return { session: this.client.agentSession(invocation.args[0]), attachment }
          return attachment
        } catch (error) {
          if (!retained) { owners.delete(id); consumer.runs.delete(runId) }
          if (owners.size === 0) this.runOwners.delete(runId)
          throw error
        }
      })
    } else {
      const operation = this.client[invocation.method] as (...args: unknown[]) => unknown
      value = await operation.apply(this.client, invocation.args)
    }
    return { value: encodeHostedValue(value) }
  }
  async subscribe(method: string, params: unknown, onEvent: (event: AgentMuxHostedStreamEvent) => void | Promise<void>,
    options: { signal?: AbortSignal } = {}): Promise<{ initial: unknown; dispose(): Promise<void> }> {
    const p = record(params), id = identifier(p.consumerId)
    if (method === 'runtime.events') {
      if (this.consumers.has(id)) throw new AgentMuxError('Host consumer already has an event owner.', 'CONTROL_OWNER_BUSY')
      const consumer: RuntimeConsumer = { runs: new Set(), events: onEvent, histories: new Set() }
      this.consumers.set(id, consumer)
      const dispose = async () => { if (this.consumers.get(id) === consumer) await this.releaseConsumer(id) }
      const abort = () => { void dispose().catch(error => this.publish({ type: 'agent-error',
        code: 'HOST_OBSERVATION_RELEASE_UNCONFIRMED',
        message: `A disconnected consumer's observation release is unconfirmed. Its reader was removed; the original Run is retained. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', observedAt: Date.now() } })) }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) { await dispose(); throw new AgentMuxError('Host subscription was cancelled.', 'CONTROL_CANCELLED') }
      return { initial: { bootstrap: this.bootstrap() }, dispose: async () => {
        options.signal?.removeEventListener('abort', abort); await dispose()
      } }
    }
    if (method === 'runtime.history-watch') {
      const consumer = this.consumer(id)
      if (typeof p.agentSessionId !== 'string') throw new AgentMuxError('History watch requires exact Session identity.', 'INVALID_CONTROL_REQUEST')
      let failed = false, released = false, release: (() => void) | undefined
      const deliverHistory = (event: AgentMuxHostedStreamEvent): void => deliver(event, onEvent, () => {
        failed = true; release?.()
      })
      const observer = await this.client.observeSessionHistory(p.agentSessionId, observation => {
        if (!failed && !released && this.consumers.get(id) === consumer && consumer.events) deliverHistory({ type: 'snapshot', data: { observation } })
      }, { ...record(p.options ?? {}), ...(options.signal ? { signal: options.signal } : {}) })
      if (failed || this.consumers.get(id) !== consumer || !consumer.events || options.signal?.aborted) {
        observer.dispose()
        throw new AgentMuxError('History consumer closed while its native observer was being acquired.', 'CONTROL_CANCELLED')
      }
      const releaseObserver = () => {
        if (released) return; released = true
        consumer.histories.delete(releaseObserver); observer.dispose()
        deliverHistory({ type: 'end', data: { reason: 'consumer-released' } })
      }
      release = releaseObserver
      consumer.histories.add(releaseObserver)
      return { initial: { source: observer.source }, dispose: async () => releaseObserver() }
    }
    throw new AgentMuxError('Unknown hosted subscription.', 'RPC_METHOD_NOT_FOUND')
  }
  private async releaseRun(id: string, run: AgentMuxRunRef): Promise<void> {
    await this.serialize(run.runId, async () => {
      const owners = this.runOwners.get(run.runId)
      if (!owners?.delete(id)) return
      this.consumers.get(id)?.runs.delete(run.runId)
      if (owners.size === 0) {
        this.runOwners.delete(run.runId)
        await this.client.releaseRunAttachment(run)
      }
    })
  }
  async releaseConsumer(id: string): Promise<boolean> {
    const consumer = this.consumers.get(id)
    if (!consumer) return false
    // Disable this reader immediately; detaching the last underlying observation can be asynchronous.
    delete consumer.events
    for (const release of [...consumer.histories]) release()
    const releases = await Promise.allSettled([...consumer.runs].map(runId => this.releaseRun(id, { runId })))
    if (this.consumers.get(id) === consumer) this.consumers.delete(id)
    const errors = releases.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Consumer observation release is unconfirmed; its ownership was removed and no Run was stopped.')
    return true
  }
  async dispose(): Promise<void> {
    this.unsubscribe()
    await Promise.all([...this.consumers.keys()].map(id => this.releaseConsumer(id)))
  }
}
