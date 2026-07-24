import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AgentMuxError } from './errors.js'
import type { AgentId, NativeHookEnvelope } from './types.js'
import { defaultAgentMuxHookPort } from './runtime-paths.js'

const MAX_BODY_BYTES = 128 * 1024
const MAX_BINDINGS = 256
const MAX_PENDING_EVENTS = 8
const MAX_PENDING_DELIVERIES = 8
const HOOK_DELIVERY_TIMEOUT_MS = 2_000

function withHookDeliveryDeadline(
  delivery: Promise<void>,
  controller: AbortController
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new AgentMuxError('Hook owner delivery timed out.', 'HOOK_DELIVERY_TIMEOUT'))
    }, HOOK_DELIVERY_TIMEOUT_MS)
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
    if (size > MAX_BODY_BYTES) throw new Error('Hook body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function respond(response: ServerResponse, statusCode: number, body = ''): void {
  response.writeHead(statusCode, body ? { 'content-type': 'application/json' } : undefined)
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
  agentId: AgentId
  runId: string | null
  events: HookIngressEvent[]
  tail: Promise<void>
  pendingDeliveries: number
  accepting: boolean
  closed: boolean
}

export class AgentHookServer {
  private server: Server | null = null
  private endpoint: HookServerEndpoint | null = null
  private readonly bindings = new Map<string, PendingBinding>()
  private readonly retiring = new Set<Promise<void>>()

  constructor(
    // AgentMux owns this callback. It must settle when signal aborts so Hook
    // shutdown can drain without allowing a timed-out retry to race old work.
    private readonly onEvent: (
      event: NativeHookEnvelope,
      signal: AbortSignal
    ) => void | Promise<void>,
    private readonly port = defaultAgentMuxHookPort()
  ) {}

  async start(): Promise<HookServerEndpoint> {
    if (this.endpoint) return this.endpoint
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
    agentId: AgentId,
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
      agentId,
      runId: null,
      events: [],
      tail: Promise.resolve(),
      pendingDeliveries: 0,
      accepting: true,
      closed: false
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
    } catch {
      respond(response, 400, JSON.stringify({ error: 'invalid_hook_envelope' }))
      return
    }
    if (!isIngressEvent(parsed)) {
      respond(response, 400, JSON.stringify({ error: 'invalid_hook_envelope' }))
      return
    }
    if (!binding.accepting) {
      respond(response, 503, JSON.stringify({ error: 'hook_binding_closed' }))
      return
    }
    if (binding.runId === null) {
      if (binding.events.length >= MAX_PENDING_EVENTS) {
        respond(response, 429, JSON.stringify({ error: 'hook_binding_pending_limit' }))
        return
      }
      binding.events.push(parsed)
      respond(response, 204)
      return
    }
    if (binding.pendingDeliveries >= MAX_PENDING_DELIVERIES) {
      respond(response, 429, JSON.stringify({ error: 'hook_binding_delivery_limit' }))
      return
    }
    try {
      await this.enqueue(binding, parsed)
      respond(response, 204)
    } catch {
      respond(response, 503, JSON.stringify({ error: 'hook_delivery_failed' }))
    }
  }

  private enqueue(binding: PendingBinding, event: HookIngressEvent): Promise<void> {
    binding.pendingDeliveries += 1
    const started = binding.tail.catch(() => {}).then(() => this.publish(binding, event))
    const response = started.then(async (delivery) => await delivery.response).catch((error) => {
      if (error instanceof AgentMuxError && error.code === 'HOOK_DELIVERY_TIMEOUT') {
        binding.accepting = false
      }
      throw error
    })
    const drain = started.then(async (delivery) => await delivery.drain).finally(() => {
      binding.pendingDeliveries -= 1
      if (!binding.closed && this.bindings.get(binding.token) === binding) binding.accepting = true
    })
    binding.tail = drain.then(() => {}, () => {})
    return response
  }

  private publish(
    binding: PendingBinding,
    event: HookIngressEvent
  ): { response: Promise<void>; drain: Promise<void> } {
    if (binding.runId === null) {
      return { response: Promise.resolve(), drain: Promise.resolve() }
    }
    const envelope: NativeHookEnvelope = {
      receiptId: event.receiptId,
      agentSessionId: binding.agentSessionId,
      runId: binding.runId,
      agentId: binding.agentId,
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
      response: withHookDeliveryDeadline(drain, controller),
      drain
    }
  }
}
