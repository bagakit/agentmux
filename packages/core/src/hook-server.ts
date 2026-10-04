import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AgentMuxError } from './errors.js'
import type { AgentProviderId, NativeHookEnvelope } from './types.js'
import { defaultAgentMuxHookPort } from './runtime-paths.js'
import { HOOK_OWNER_TIMEOUT_MS, HOOK_REQUEST_TIMEOUT_MS, HOOK_RETRY_DELAY_MS } from './agent-hook-delivery.js'

const MAX_BODY_BYTES = 128 * 1024
const MAX_BINDINGS = 256
const MAX_PENDING_EVENTS = 8
const MAX_PENDING_DELIVERIES = 8
// Keep completed and unknown receipts for the sender's two-observation retry window.
const RECEIPT_RETRY_WINDOW_MS = 2 * (HOOK_REQUEST_TIMEOUT_MS + HOOK_RETRY_DELAY_MS) + HOOK_RETRY_DELAY_MS
const MAX_RECEIPT_BYTES = MAX_PENDING_DELIVERIES * MAX_BODY_BYTES

// Only ingress can establish that the owner never started. An arbitrary owner
// error (even one with the same code) cannot establish that no mutation committed.
class HookQueueTimeoutError extends AgentMuxError {
  constructor() {
    super('Hook observation expired before owner execution; no work was started.', 'HOOK_QUEUE_TIMEOUT')
  }
}

function withHookDeliveryDeadline(
  delivery: Promise<void>,
  controller: AbortController,
  timeoutMs: number,
  onTimeout: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      controller.abort()
      reject(new AgentMuxError('Hook owner delivery timed out.', 'HOOK_DELIVERY_TIMEOUT'))
    }, timeoutMs)
    delivery.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new AgentMuxError('Hook body exceeds the ingress parsing budget.', 'HOOK_BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function respond(response: ServerResponse, statusCode: number, body = ''): void {
  response.writeHead(statusCode, {
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(statusCode === 429 || statusCode === 503 ? { 'retry-after': String(HOOK_RETRY_DELAY_MS / 1_000) } : {})
  })
  response.end(body)
}

type HookIngressEvent = {
  receiptId: string
  eventName?: string
  payload?: Record<string, unknown>
}

function isIngressEvent(value: unknown): value is HookIngressEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (
    typeof record.receiptId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(record.receiptId)
  ) return false
  if (record.eventName !== undefined && typeof record.eventName !== 'string') return false
  if (
    record.payload !== undefined &&
    (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload))
  ) return false
  return true
}

export type HookServerEndpoint = {
  url: string
  port: number
}

export type AgentHookBinding = {
  bindingId: string
  endpoint: HookServerEndpoint & { token: string }
  bindRun(runId: string): Promise<void>
  close(): Promise<void>
}

type PendingBinding = {
  token: string
  agentSessionId: string
  providerId: AgentProviderId
  runId: string | null
  events: HookIngressEvent[]
  tail: Promise<void>
  pendingDeliveries: number
  accepting: boolean
  closed: boolean
  receipts: Map<string, { fingerprint: string; bytes: number; expiresAt: number; response?: Promise<void> }>
}

export type HookDeliveryFailure = {
  agentSessionId: string
  runId: string | null
  receiptId: string
  code: string
  message?: string
  stage: 'admission' | 'owner'
  accepted: false | 'unknown'
}

export class AgentHookServer {
  private server: Server | null = null
  private endpoint: HookServerEndpoint | null = null
  // `start()` is reached by both cold-start binding restoration and lifecycle operations. Serialize
  // the bind itself: without this, two callers can race, the loser clears `this.server` after its
  // EADDRINUSE, and the winner's healthy listener is then permanently reported as an owner in another
  // process by every later resume attempt.
  private starting: Promise<HookServerEndpoint> | null = null
  private readonly bindings = new Map<string, PendingBinding>()
  private readonly retiring = new Set<Promise<void>>()

  constructor(
    // AgentMux owns this callback. It must settle when signal aborts so Hook
    // shutdown can drain without allowing a timed-out retry to race old work.
    private readonly onEvent: (
      event: NativeHookEnvelope,
      signal: AbortSignal
    ) => void | Promise<void>,
    private readonly port = defaultAgentMuxHookPort(),
    private readonly onFailure?: (failure: HookDeliveryFailure) => void
  ) {}

  async start(): Promise<HookServerEndpoint> {
    if (this.endpoint) return this.endpoint
    if (this.starting) return await this.starting
    this.starting = this.bind()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async bind(): Promise<HookServerEndpoint> {
    const server = createServer((request, response) => void this.handle(request, response))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.port, '127.0.0.1', () => resolve())
      })
    } catch (error) {
      this.server = null
      server.close()
      throw error
    }
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Hook server did not bind a TCP port')
    this.endpoint = { url: `http://127.0.0.1:${address.port}/v1/events`, port: address.port }
    return this.endpoint
  }

  getEndpoint(): HookServerEndpoint | null {
    return this.endpoint
  }

  isRunning(): boolean {
    return this.endpoint !== null
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {})
    const server = this.server
    this.server = null
    this.endpoint = null
    for (const binding of this.bindings.values()) {
      binding.accepting = false
      binding.closed = true
    }
    const serverClosed = server
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve()
    const tails = [
      ...[...this.bindings.values()].map((binding) => binding.tail),
      ...this.retiring
    ]
    await Promise.allSettled(tails)
    this.bindings.clear()
    this.retiring.clear()
    server?.closeIdleConnections()
    await serverClosed
  }

  createBinding(
    agentSessionId: string,
    providerId: AgentProviderId,
    requestedBindingId?: string,
    requestedToken?: string
  ): AgentHookBinding {
    const endpoint = this.endpoint
    if (!endpoint) throw new AgentMuxError('Hook server is not running.', 'HOOK_SERVER_NOT_RUNNING')
    if (this.bindings.size >= MAX_BINDINGS) {
      throw new AgentMuxError('Hook binding limit reached.', 'HOOK_BINDING_LIMIT')
    }
    const bindingId = requestedBindingId ?? randomBytes(32).toString('base64url')
    const token = requestedToken ?? randomBytes(32).toString('base64url')
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bindingId) || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      throw new AgentMuxError('Hook binding identity is invalid.', 'INVALID_HOOK_BINDING')
    }
    if (this.bindings.has(token)) {
      throw new AgentMuxError('Hook binding already exists.', 'HOOK_BINDING_CONFLICT')
    }
    const binding: PendingBinding = {
      token,
      agentSessionId,
      providerId,
      runId: null,
      events: [],
      tail: Promise.resolve(),
      pendingDeliveries: 0,
      accepting: true,
      closed: false,
      receipts: new Map()
    }
    this.bindings.set(token, binding)
    let closed = false
    return {
      bindingId,
      endpoint: { ...endpoint, token },
      bindRun: async (runId) => {
        if (closed || !binding.accepting || this.bindings.get(token) !== binding) {
          throw new AgentMuxError('Hook binding is closed.', 'HOOK_BINDING_CLOSED')
        }
        if (binding.runId !== null && binding.runId !== runId) {
          throw new AgentMuxError('Hook binding already belongs to another Run.', 'HOOK_RUN_MISMATCH')
        }
        binding.runId = runId
        const events = binding.events.splice(0)
        await Promise.all(events.map((event) => this.enqueue(binding, event)))
      },
      close: async () => {
        if (closed) return await binding.tail
        closed = true
        binding.accepting = false
        binding.closed = true
        if (this.bindings.get(token) === binding) this.bindings.delete(token)
        const drain = binding.tail
        this.retiring.add(drain)
        try {
          await drain
        } finally {
          this.retiring.delete(drain)
        }
      }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/v1/events') {
      respond(response, 404)
      return
    }
    const authorization = request.headers.authorization
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    const binding = token ? this.bindings.get(token) : undefined
    if (!binding) {
      respond(response, 403)
      return
    }
    request.setTimeout(2_000, () => request.destroy())
    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(request))
      request.setTimeout(0)
    } catch (error) {
      const oversized = error instanceof AgentMuxError && error.code === 'HOOK_BODY_TOO_LARGE'
      const code = oversized ? 'HOOK_BODY_TOO_LARGE' : 'INVALID_HOOK_ENVELOPE'
      respond(response, oversized ? 413 : 400, JSON.stringify({ error: code, stage: 'admission', accepted: false,
        retryable: false, recovery: 'Refresh the native Session observation; the Agent and terminal remain available.' }))
      try { this.onFailure?.({ agentSessionId: binding.agentSessionId, runId: binding.runId,
        receiptId: 'unparsed-envelope', code, stage: 'admission', accepted: false }) } catch { /* Diagnostic isolation. */ }
      return
    }
    if (!isIngressEvent(parsed)) {
      respond(response, 400, JSON.stringify({ error: 'invalid_hook_envelope' }))
      return
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ eventName: parsed.eventName, payload: parsed.payload },
      (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)).digest('hex')
    for (const [id, receipt] of binding.receipts) {
      if (receipt.expiresAt < Date.now()) binding.receipts.delete(id)
    }
    const existing = binding.receipts.get(parsed.receiptId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        respond(response, 409, JSON.stringify({ error: 'hook_receipt_conflict', receiptId: parsed.receiptId }))
        return
      }
      if (!existing.response) {
        respond(response, 202, JSON.stringify({ stage: 'pending_run', accepted: 'memory', receiptId: parsed.receiptId }))
        return
      }
      try { await existing.response; respond(response, 204) }
      catch (error) { this.deliveryFailed(response, binding, parsed.receiptId, error) }
      return
    }
    // Backpressure applies to new work. An existing receipt must retain its
    // original owner outcome and conflict checks while aborted work drains.
    if (!binding.accepting) {
      this.fail(response, binding, parsed.receiptId, 'HOOK_BINDING_RECOVERING', 'admission', false)
      return
    }
    // Receipt metadata consumes a bounded part of the existing in-flight byte budget.
    // Do not evict an acknowledged receipt while its original sender can still retry.
    const receiptBytes = Buffer.byteLength(parsed.receiptId) + 256
    const cachedBytes = [...binding.receipts.values()].reduce((size, receipt) => size + receipt.bytes, 0)
    if (cachedBytes + receiptBytes > MAX_RECEIPT_BYTES) {
      this.fail(response, binding, parsed.receiptId, 'HOOK_RECEIPT_BACKPRESSURE', 'admission', false)
      return
    }
    if (binding.runId === null) {
      if (binding.events.length >= MAX_PENDING_EVENTS) {
        this.fail(response, binding, parsed.receiptId, 'HOOK_PENDING_BACKPRESSURE', 'admission', false)
        return
      }
      binding.receipts.set(parsed.receiptId, { fingerprint, bytes: receiptBytes, expiresAt: Infinity })
      binding.events.push(parsed)
      respond(response, 202, JSON.stringify({ stage: 'pending_run', accepted: 'memory', receiptId: parsed.receiptId }))
      return
    }
    if (binding.pendingDeliveries >= MAX_PENDING_DELIVERIES) {
      this.fail(response, binding, parsed.receiptId, 'HOOK_DELIVERY_BACKPRESSURE', 'admission', false)
      return
    }
    binding.receipts.set(parsed.receiptId, { fingerprint, bytes: receiptBytes, expiresAt: Infinity })
    try {
      await this.enqueue(binding, parsed)
      respond(response, 204)
    } catch (error) {
      this.deliveryFailed(response, binding, parsed.receiptId, error)
    }
  }

  private deliveryFailed(response: ServerResponse, binding: PendingBinding, receiptId: string, error: unknown): void {
    const queued = error instanceof HookQueueTimeoutError
    const code = error instanceof AgentMuxError ? error.code : 'HOOK_DELIVERY_FAILED'
    // A custom Provider/Store can put content or credentials in any Error message.
    // Only fixed Store field diagnostics are safe to copy into a public service notice.
    const message = error instanceof AgentMuxError && code === 'INVALID_AGENT_SESSION_STORE' &&
      /^hookReceipt\.toolInvocation(?:\.(?:nativeSessionId|nativeToolCallId|nativeTurnId|nativeTranscriptPath|toolName|toolInput))? is invalid\.$/u.test(error.message)
      ? error.message : undefined
    this.fail(response, binding, receiptId, code, queued ? 'admission' : 'owner', queued ? false : 'unknown',
      message)
  }

  private fail(response: ServerResponse, binding: PendingBinding, receiptId: string, code: string,
    stage: 'admission' | 'owner', accepted: false | 'unknown', message?: string): void {
    const failure = { agentSessionId: binding.agentSessionId, runId: binding.runId, receiptId, code, stage, accepted,
      ...(message === undefined ? {} : { message }) }
    respond(response, stage === 'admission' && binding.accepting ? 429 : 503,
      JSON.stringify({ error: code, receiptId, stage, accepted, ...(message === undefined ? {} : { message }), retryable: !binding.closed,
        recovery: accepted === 'unknown'
          ? 'Retain the original receipt and verify its result against the native Session source; retry observes the same outcome without repeating owner work. The Agent and terminal remain available.'
          : 'Retry the original receipt after backoff; the Agent and terminal remain available.' }))
    try { this.onFailure?.(failure) } catch { /* Diagnostic consumers cannot break ingress. */ }
  }

  private enqueue(binding: PendingBinding, event: HookIngressEvent): Promise<void> {
    binding.pendingDeliveries += 1
    const deadline = Date.now() + HOOK_REQUEST_TIMEOUT_MS
    let expired = false
    let queueTimer: ReturnType<typeof setTimeout>
    const queueTimeout = new Promise<never>((_resolve, reject) => {
      queueTimer = setTimeout(() => {
        expired = true
        reject(new HookQueueTimeoutError())
      }, HOOK_REQUEST_TIMEOUT_MS)
    })
    const started = binding.tail.catch(() => {}).then(() => {
      clearTimeout(queueTimer)
      if (expired || Date.now() >= deadline) throw new HookQueueTimeoutError()
      return this.publish(binding, event, Math.min(HOOK_OWNER_TIMEOUT_MS, deadline - Date.now()))
    })
    const response = Promise.race([queueTimeout, started.then(async (delivery) => await delivery.response)])
    const drain = started.then(async (delivery) => await delivery.drain).finally(() => {
      binding.pendingDeliveries -= 1
      if (!binding.closed && this.bindings.get(binding.token) === binding) binding.accepting = true
    })
    binding.tail = drain.then(() => {}, () => {})
    const receipt = binding.receipts.get(event.receiptId)
    if (receipt) {
      receipt.response = response
      void response.then(() => { receipt.expiresAt = Date.now() + RECEIPT_RETRY_WINDOW_MS }, (error: unknown) => {
        // Keep the original response while work drains. Afterward only the
        // ingress-proven not-started case may execute again. Owner rejection or
        // abort is unknown, so preserve its fingerprint and outcome for retry.
        void binding.tail.then(() => {
          if (binding.receipts.get(event.receiptId) !== receipt) return
          if (error instanceof HookQueueTimeoutError) binding.receipts.delete(event.receiptId)
          else receipt.expiresAt = Date.now() + RECEIPT_RETRY_WINDOW_MS
        })
      })
    }
    return response
  }

  private publish(
    binding: PendingBinding,
    event: HookIngressEvent,
    timeoutMs: number
  ): { response: Promise<void>; drain: Promise<void> } {
    if (binding.runId === null) {
      return { response: Promise.resolve(), drain: Promise.resolve() }
    }
    const envelope: NativeHookEnvelope = {
      receiptId: event.receiptId,
      agentSessionId: binding.agentSessionId,
      runId: binding.runId,
      providerId: binding.providerId,
      ...(event.eventName === undefined ? {} : { eventName: event.eventName }),
      ...(event.payload === undefined ? {} : { payload: event.payload })
    }
    const controller = new AbortController()
    let delivery: void | Promise<void>
    try {
      delivery = this.onEvent(envelope, controller.signal)
    } catch (error) {
      const rejected = Promise.reject(error)
      return { response: rejected, drain: rejected }
    }
    const drain = Promise.resolve(delivery)
    return {
      response: withHookDeliveryDeadline(drain, controller, timeoutMs, () => { binding.accepting = false }),
      drain
    }
  }
}
