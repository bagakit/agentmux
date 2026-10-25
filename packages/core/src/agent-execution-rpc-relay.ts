import { isDeepStrictEqual } from 'node:util'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createConnection, createServer, type Socket, type Server } from 'node:net'
import { mkdtemp, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter, isAbsolute } from 'node:path'
import type { Transform } from 'node:stream'
import { EXECUTION_FRAME_LIMIT } from './agent-execution-channel.js'
import { AgentMuxError } from './errors.js'
import { createAgentMuxRpcFrameStream } from './agentmux-rpc-stdio.js'
import { parseRpcRequest, rpcFailure, rpcEncode, type JSONRPCRequest } from './public-rpc-frame.js'
import { isAgentMuxRpcDeviceMethod } from './public-rpc-device.js'
import type { AgentMuxRuntimeFence, AgentMuxRuntimeOwnerIdentity } from './hosted-client-contract.js'
import { resolveCoreBinPath } from './runtime-paths.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const secret = () => randomBytes(32).toString('hex')
const sameSecret = (left: unknown, right: string): boolean => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right))
export function agentControlFailureCode(error: unknown): string {
  const code = object(error) ? error.code : undefined
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : 'AGENT_TOOL_REGISTRATION_UNCONFIRMED'
}
const unavailable = () => new AgentMuxError('The original Agent control connection is unavailable; no request was replayed.', 'AGENT_TOOL_CONTEXT_UNAVAILABLE')
const denied = () => new AgentMuxError('This tool connection requires its exact original managed Agent caller.', 'AGENT_CAPABILITY_INVALID')
const capabilityHash = (value: string) => createHash('sha256').update(value).digest('hex')
const sameInvocation = (left: AgentExecutionInvocation, right: AgentExecutionInvocation) => {
  const { capability: first, ...a } = left, { capability: second, ...b } = right
  return isDeepStrictEqual(a, b) && sameSecret(capabilityHash(first), capabilityHash(second))
}
function frameBudget() {
  let bytes = 0
  return { reserve(count: number) {
    if (bytes + count > EXECUTION_FRAME_LIMIT * 2) throw new AgentMuxError('Agent control ingress is backpressured; this connection is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
    bytes += count
  }, release(count: number) { bytes -= count } }
}
const MAX_CONNECTIONS = 128
// Reserve the fixed relay envelope inside the existing helper JSONL frame budget.
const MAX_FRAME_BYTES = EXECUTION_FRAME_LIMIT - 4096
export type AgentExecutionRelaySend = (frame: unknown) => Promise<void>
export interface AgentExecutionInvocation {
  agentSessionId: string
  lifecycleOperationId: string
  capability: string
  endpointPath: string
  runtimeId: string
  ctxmuxInstanceId: string
}
export interface AgentExecutionRelayContext { generation: string; agentSessionId: string; lifecycleOperationId: string; credential: string }

type Caller = { agentSessionId: string; capability: string }
/** Validate every member before forwarding any bytes. Callerless input never becomes a user request. */
export function gateExecutionAgentRpc(value: unknown, expected: Caller, replacement?: Caller, fence?: AgentMuxRuntimeFence): unknown {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_FRAME_BYTES) throw new AgentMuxError('Agent control frame exceeds its connection limit.', 'CONTROL_PROTOCOL_ERROR')
  if (Array.isArray(value) && (!value.length || value.length > 256)) throw denied()
  const requests = (Array.isArray(value) ? value : [value]).map(parseRpcRequest)
  const ids = requests.filter(request => Object.hasOwn(request, 'id')).map(request => JSON.stringify(request.id))
  if (new Set(ids).size !== ids.length) throw new AgentMuxError('RPC batch request IDs must identify distinct original requests.', 'CONTROL_PROTOCOL_ERROR')
  const qualified = requests.map(request => {
    const params = request.params
    if (!object(params) || !object(params.caller) || Object.keys(params.caller).length !== 2 ||
        params.caller.agentSessionId !== expected.agentSessionId || !sameSecret(params.caller.capability, expected.capability) ||
        Object.hasOwn(params, 'runtimeFence') || isAgentMuxRpcDeviceMethod(request.method) || request.method.startsWith('runtime.')) throw denied()
    return { ...request, params: { ...params, caller: { ...(replacement ?? expected) }, ...(fence ? { runtimeFence: { ...fence } } : {}) } }
  })
  return Array.isArray(value) ? qualified : qualified[0]
}
function failure(value: unknown, error: Error): string | undefined {
  let requests: JSONRPCRequest[]
  try { requests = (Array.isArray(value) ? value : [value]).map(parseRpcRequest) } catch { return }
  const responses = requests.filter(request => Object.hasOwn(request, 'id')).map(request => rpcFailure(request.id!, error))
  return responses.length ? rpcEncode(Array.isArray(value) ? responses : responses[0]) : undefined
}
const write = (socket: Socket, bytes: string | Uint8Array): Promise<void> => new Promise((resolve, reject) => {
  if (socket.destroyed) { reject(unavailable()); return }
  socket.write(bytes, error => error ? reject(unavailable()) : resolve())
})
function validInvocation(value: unknown, agentSessionId: string): asserts value is AgentExecutionInvocation {
  const keys = ['agentSessionId', 'lifecycleOperationId', 'capability', 'endpointPath', 'runtimeId', 'ctxmuxInstanceId']
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => typeof value[key] !== 'string' || !value[key] || /[\0\r\n]/u.test(value[key] as string)) ||
      value.agentSessionId !== agentSessionId || !isAbsolute(value.endpointPath as string)) throw denied()
}

/** B-side registry. Raw invocation capabilities never leave this helper process. */
export class AgentExecutionRpcFrontend {
  private readonly ingress = frameBudget()
  private readonly invocations = new Map<string, { value: AgentExecutionInvocation; token: string; fence: AgentMuxRuntimeFence; generation?: string; credential: string }>()
  private readonly tokens = new Map<string, string>()
  private readonly generations = new Map<string, { value: AgentExecutionInvocation; fence: AgentMuxRuntimeFence; credential: string }>()
  private readonly connections = new Map<string, { socket: Socket; ready: Promise<void>; responses: Transform; pending: Map<string, number>; intentionalClose: boolean }>()
  private readonly closed = new Set<string>()
  private originalOwner: Pick<AgentExecutionInvocation, 'endpointPath' | 'runtimeId' | 'ctxmuxInstanceId'> | undefined
  private pendingBytes = 0
  private currentGeneration: string | undefined
  private controlState: 'unconfigured' | 'unverified' | 'available' | 'unavailable' | undefined
  constructor(private readonly options: { agentSessionId: string; send: AgentExecutionRelaySend; onError(error: Error): void }) {}
  async begin(generation: string, configured: boolean, registrationFailure?: string): Promise<void> {
    this.currentGeneration = generation; this.controlState = undefined
    await this.status(generation, configured || registrationFailure ? 'unverified' : 'unconfigured', registrationFailure)
  }
  private async status(generation: string, state: NonNullable<AgentExecutionRpcFrontend['controlState']>, code?: string): Promise<void> {
    if (generation !== this.currentGeneration || state === this.controlState) return
    this.controlState = state
    await this.options.send({ type: 'agent-control-state', generation, state, ...(code ? { stage: 'invocation-registration', code } : {}) })
  }
  async register(value: unknown): Promise<string> {
    validInvocation(value, this.options.agentSessionId)
    const ownerContext = { endpointPath: value.endpointPath, runtimeId: value.runtimeId, ctxmuxInstanceId: value.ctxmuxInstanceId }
    if (this.originalOwner && !isDeepStrictEqual(this.originalOwner, ownerContext)) throw denied()
    const original = this.invocations.get(value.lifecycleOperationId)
    if (original) {
      if (!sameInvocation(original.value, value)) throw denied()
      return original.token
    }
    const { connectAgentMuxRpc } = await import('./public-rpc-client.js')
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: value.endpointPath } })
    let owner: AgentMuxRuntimeOwnerIdentity
    try { owner = (await rpc.call('runtime.owner.identity', { expectedRuntimeId: value.runtimeId })).owner }
    finally { await rpc.dispose() }
    if (owner.runtimeId !== value.runtimeId || owner.ctxmux?.instanceId !== value.ctxmuxInstanceId || owner.availability !== 'connected') throw unavailable()
    // Recheck after observation: concurrent identical registrations reuse the original receipt.
    const concurrent = this.invocations.get(value.lifecycleOperationId)
    if (concurrent) {
      if (!sameInvocation(concurrent.value, value)) throw denied()
      return concurrent.token
    }
    if (this.originalOwner && !isDeepStrictEqual(this.originalOwner, ownerContext)) throw denied()
    this.originalOwner = ownerContext
    const token = secret()
    this.invocations.set(value.lifecycleOperationId, { value: structuredClone(value), token,
      fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, credential: secret() })
    this.tokens.set(token, value.lifecycleOperationId)
    return token
  }
  available(token: string): boolean { const lifecycle = this.tokens.get(token); return !!lifecycle && !this.invocations.get(lifecycle)?.generation }
  claim(token: string, generation: string): AgentExecutionRelayContext {
    const lifecycle = this.tokens.get(token)
    const original = lifecycle ? this.invocations.get(lifecycle) : undefined
    if (!original || original.generation) throw denied()
    original.generation = generation
    this.generations.set(generation, original)
    return { generation, agentSessionId: original.value.agentSessionId, lifecycleOperationId: original.value.lifecycleOperationId, credential: original.credential }
  }
  private async open(key: string, generation: string, connectionId: string, original: { value: AgentExecutionInvocation; fence: AgentMuxRuntimeFence }): Promise<{ socket: Socket; ready: Promise<void>; responses: Transform; pending: Map<string, number>; intentionalClose: boolean }> {
    if (this.closed.has(key) || this.connections.size >= MAX_CONNECTIONS) throw unavailable()
    const socket = createConnection({ path: original.value.endpointPath }), id = randomUUID()
    let verified = false, resolve!: () => void, reject!: (error: Error) => void
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    void ready.catch(() => {})
    const timer = setTimeout(() => { reject(unavailable()); socket.destroy() }, 5000)
    const responses = createAgentMuxRpcFrameStream(async value => {
      if (!verified) {
        const owner = object(value) && value.id === id && object(value.result) && object(value.result.owner) ? value.result.owner : null
        if (!owner || owner.runtimeId !== original.fence.runtimeId || owner.ownerInstanceId !== original.fence.ownerInstanceId) {
          reject(unavailable()); socket.destroy(); return
        }
        verified = true; clearTimeout(timer); resolve(); return
      }
      const responses = Array.isArray(value) ? value : [value]
      for (const response of responses) if (object(response) && Object.hasOwn(response, 'id')) {
        const key = JSON.stringify(response.id), bytes = connection.pending.get(key)
        if (bytes !== undefined) {
          this.pendingBytes -= bytes; connection.pending.delete(key)
          if (Object.hasOwn(response, 'result')) await this.status(generation, 'available')
        }
      }
      await this.options.send({ type: 'agent-rpc-response', generation, connectionId, payload: value })
    }, this.ingress)
    const connection = { socket, ready, responses, pending: new Map<string, number>(), intentionalClose: false }
    this.connections.set(key, connection)
    const close = () => {
      clearTimeout(timer); reject(unavailable()); for (const bytes of connection.pending.values()) this.pendingBytes -= bytes; connection.pending.clear(); this.connections.delete(key); this.closed.add(key); responses.destroy(); socket.destroy()
      if (!connection.intentionalClose) void this.status(generation, 'unavailable').catch(() => this.options.onError(unavailable()))
      void this.options.send({ type: 'agent-rpc-closed', generation, connectionId }).catch(() => this.options.onError(unavailable()))
    }
    socket.once('close', close); socket.on('error', () => { reject(unavailable()); socket.destroy() })
    responses.on('error', () => { reject(unavailable()); socket.destroy() })
    socket.pipe(responses)
    socket.once('connect', () => {
      void write(socket, rpcEncode({ jsonrpc: '2.0', id, method: 'runtime.owner.identity', params: { expectedRuntimeId: original.fence.runtimeId } })).catch(() => socket.destroy())
    })
    return connection
  }
  async receive(frame: unknown): Promise<boolean> {
    if (!object(frame) || !['agent-rpc-request', 'agent-rpc-close'].includes(String(frame.type))) return false
    if (typeof frame.generation !== 'string' || typeof frame.connectionId !== 'string' || !frame.connectionId || frame.connectionId.length > 128) throw denied()
    const generation = frame.generation, connectionId = frame.connectionId, key = JSON.stringify([generation, connectionId])
    const original = this.generations.get(generation)
    if (!original || !sameSecret(frame.credential, original.credential)) throw denied()
    if (frame.type === 'agent-rpc-close') { this.closed.add(key); const connection = this.connections.get(key); if (connection) { connection.intentionalClose = true; connection.socket.destroy() }; return true }
    const pending = this.connections.get(key)?.pending
    const incoming = (Array.isArray(frame.payload) ? frame.payload : [frame.payload])
    if (pending && incoming.some(value => object(value) && Object.hasOwn(value, 'id') && pending.has(JSON.stringify(value.id)))) {
      await this.options.send({ type: 'agent-rpc-diagnostic', generation, connectionId, code: 'DUPLICATE_PENDING_RPC_ID' })
      return true
    }
    try {
      const payload = gateExecutionAgentRpc(frame.payload, { agentSessionId: original.value.agentSessionId, capability: original.credential },
        { agentSessionId: original.value.agentSessionId, capability: original.value.capability }, original.fence)
      const connection = this.connections.get(key) ?? await this.open(key, generation, connectionId, original)
      await connection.ready
      const ids = ((Array.isArray(payload) ? payload : [payload]) as JSONRPCRequest[]).filter(request => Object.hasOwn(request, 'id')).map(request => JSON.stringify(request.id))
      const bytes = ids.reduce((sum, id) => sum + Buffer.byteLength(id), 0)
      if (connection.pending.size + ids.length > 256 || this.pendingBytes + bytes > MAX_FRAME_BYTES ||
          new Set(ids).size !== ids.length || ids.some(id => connection.pending.has(id))) throw new AgentMuxError('Agent control request capacity or original request ID is unavailable.', 'CONTROL_PROTOCOL_ERROR')
      for (const id of ids) connection.pending.set(id, Buffer.byteLength(id))
      this.pendingBytes += bytes
      const encoded = rpcEncode(payload)
      try { await write(connection.socket, encoded) }
      catch {
        // Bytes may already have reached the original owner. Closing this exact
        // connection preserves an unknown result instead of fabricating a denial.
        this.options.onError(unavailable()); connection.socket.destroy()
      }
    } catch (error) {
      const response = failure(frame.payload, error instanceof Error ? error : denied())
      if (response) await this.options.send({ type: 'agent-rpc-response', generation, connectionId, payload: JSON.parse(response.toString()) })
    }
    return true
  }
  close(): void { for (const connection of this.connections.values()) { connection.intentionalClose = true; connection.socket.destroy() }; this.invocations.clear(); this.tokens.clear(); this.generations.clear() }
}

/** A-side private local socket. It has no access to the original B capability. */
export class AgentExecutionRpcResource {
  private readonly ingress = frameBudget()
  private pendingBytes = 0
  private readonly generations = new Map<string, { context: AgentExecutionRelayContext; server: Server; directory: string; endpointPath: string }>()
  private readonly connections = new Map<string, { socket: Socket; context: AgentExecutionRelayContext; decoder: Transform; pending: Map<string, number> }>()
  constructor(private readonly agentSessionId: string, private readonly onError: (error: Error) => void) {}
  async receive(frame: unknown, send: AgentExecutionRelaySend): Promise<boolean> {
    if (!object(frame) || !['agent-rpc-context', 'agent-rpc-response', 'agent-rpc-closed'].includes(String(frame.type))) return false
    if (typeof frame.generation !== 'string') throw denied()
    if (frame.type === 'agent-rpc-context') {
      if (frame.agentSessionId !== this.agentSessionId || typeof frame.lifecycleOperationId !== 'string' || typeof frame.credential !== 'string' || !/^[a-f0-9]{64}$/u.test(frame.credential)) throw denied()
      const context: AgentExecutionRelayContext = { generation: frame.generation, agentSessionId: frame.agentSessionId, lifecycleOperationId: frame.lifecycleOperationId, credential: frame.credential }
      const original = this.generations.get(frame.generation)
      if (original) { if (JSON.stringify(original.context) !== JSON.stringify(context)) throw denied(); return true }
      const directory = await mkdtemp(join(tmpdir(), 'amux-agent-rpc-')); await chmod(directory, 0o700)
      const endpointPath = join(directory, 'rpc.sock')
      const server = createServer(socket => {
        if (this.connections.size >= MAX_CONNECTIONS) { socket.destroy(); return }
        const connectionId = randomUUID(), key = JSON.stringify([context.generation, connectionId])
        const pending = new Map<string, number>()
        const decoder = createAgentMuxRpcFrameStream(async value => {
          const members = Array.isArray(value) ? value : [value]
          if (members.some(member => object(member) && Object.hasOwn(member, 'id') && pending.has(JSON.stringify(member.id)))) {
            await send({ type: 'agent-rpc-diagnostic', generation: context.generation, connectionId, code: 'DUPLICATE_PENDING_RPC_ID' })
            return
          }
          let payload: unknown
          try {
            payload = gateExecutionAgentRpc(value, { agentSessionId: context.agentSessionId, capability: context.credential })
            if (pending.size + members.length > 256 || this.pendingBytes + members.reduce((sum, member) => sum + (object(member) && Object.hasOwn(member, 'id') ? Buffer.byteLength(JSON.stringify(member.id)) : 0), 0) > MAX_FRAME_BYTES) throw new AgentMuxError('Agent control connection is backpressured.', 'CONTROL_PROTOCOL_ERROR')
          } catch (error) {
            const response = failure(value, error instanceof Error ? error : denied())
            if (response) await write(socket, response)
            return
          }
          for (const member of members) if (object(member) && Object.hasOwn(member, 'id')) { const id = JSON.stringify(member.id), bytes = Buffer.byteLength(id); pending.set(id, bytes); this.pendingBytes += bytes }
          try { await send({ type: 'agent-rpc-request', generation: context.generation, connectionId, credential: context.credential, payload }) }
          catch { this.onError(unavailable()) } // A write failure is not proof that the original request was unapplied.
        }, this.ingress)
        this.connections.set(key, { socket, context, decoder, pending })
        socket.pipe(decoder)
        decoder.on('error', () => socket.destroy()); socket.on('error', () => socket.destroy())
        socket.once('close', () => {
          decoder.destroy(); for (const bytes of pending.values()) this.pendingBytes -= bytes; pending.clear(); this.connections.delete(key)
          void send({ type: 'agent-rpc-close', generation: context.generation, connectionId, credential: context.credential }).catch(() => this.onError(unavailable()))
        })
      })
      try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpointPath, resolve) }); await chmod(endpointPath, 0o600) }
      catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error }
      server.on('error', () => this.onError(unavailable()))
      this.generations.set(frame.generation, { context, server, directory, endpointPath })
      return true
    }
    if (typeof frame.connectionId !== 'string') throw denied()
    const connection = this.connections.get(JSON.stringify([frame.generation, frame.connectionId]))
    if (!connection) return true
    if (frame.type === 'agent-rpc-closed') connection.socket.destroy()
    else {
      await write(connection.socket, rpcEncode(frame.payload))
      for (const response of Array.isArray(frame.payload) ? frame.payload : [frame.payload]) if (object(response) && Object.hasOwn(response, 'id')) { const id = JSON.stringify(response.id); this.pendingBytes -= connection.pending.get(id) ?? 0; connection.pending.delete(id) }
    }
    return true
  }
  environment(generation: string): NodeJS.ProcessEnv | undefined {
    const original = this.generations.get(generation)
    if (!original) return
    const cli = resolveCoreBinPath('amux')
    return { AGENTMUX_TOOL_CONTEXT: undefined, AGENTMUX_CLI: cli, PATH: [dirname(cli), process.env.PATH].filter(Boolean).join(delimiter),
      AGENTMUX_RPC_ENDPOINT: `unix:${original.endpointPath}`, AGENTMUX_AGENT_SESSION_ID: original.context.agentSessionId, AGENTMUX_AGENT_CAPABILITY: original.context.credential }
  }
  async close(): Promise<void> {
    for (const connection of this.connections.values()) connection.socket.destroy()
    for (const value of this.generations.values()) {
      await new Promise<void>(resolve => value.server.close(() => resolve()))
      await rm(value.directory, { recursive: true, force: true })
    }
    this.generations.clear()
  }
}

/** Direct private loopback registration: no raw invocation secret enters Run Replay. */
export async function registerAgentExecutionInvocation(url: string, value: AgentExecutionInvocation): Promise<string> {
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname === '/') throw denied()
  endpoint.protocol = 'http:'; endpoint.pathname += '/invocation'
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  const result: unknown = await response.json()
  if (!response.ok) throw new AgentMuxError('Original Agent control invocation registration was not confirmed.', agentControlFailureCode(result))
  if (!object(result) || typeof result.token !== 'string' || !/^[a-f0-9]{64}$/u.test(result.token)) throw unavailable()
  const native = new URL(url); native.pathname += '/' + result.token
  return native.href
}
