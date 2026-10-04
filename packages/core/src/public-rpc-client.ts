import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateRelayKeyPair } from './rpc-relay-keypair.js'
import { openAgentMuxRpcRelayRequest } from './public-rpc-relay.js'
import { parseConnectionOfferUrl } from '@agentmux/relay/offer'
import { type KeyPair } from '@agentmux/relay/e2ee'
import { randomUUID } from 'node:crypto'
import { openAgentMuxRpcHttpRequest } from './public-rpc-http.js'
import { createConnection } from 'node:net'
import { AgentMuxRpcSshTransport, AGENTMUX_RPC_SSH_TRANSPORT_BUDGET_MS } from './rpc-ssh-transport.js'
import { rpcTransportError as transportError } from './rpc-transport-error.js'
import { JSONRPCClient, type JSONRPCRequest, type JSONRPCResponse } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { isAgentMuxRpcDeviceMethod } from './public-rpc-device.js'
import { agentMuxControlTimeoutMs } from './control.js'
import { defaultAgentMuxControlSocketPath } from './runtime-paths.js'
import { rpcRecord, rpcString } from './rpc-business-codec.js'
import { parseRpcControlResult } from './rpc-business-codec.js'
import { parseRpcNativeResult, parseRpcAgentSession, rpcSessionTargetMatches } from './rpc-native-codec.js'
import { parseMetricsObservation } from './metrics.js'
import { parseToolkitSnapshot } from './toolkit.js'
import { classifyReplayGap } from './ctxmux-replay-gap.js'
import { decodeHostedValue, parseHostedRuntimeOwnerIdentity, parseHostedTransferChunk } from './hosted-value.js'
import { AGENTMUX_HOSTED_RPC_METHODS, type AgentMuxRuntimeFence } from './hosted-client-contract.js'
import { parseTerminalContinuation } from './terminal-continuation.js'
import { parseRpcControlFailure } from './public-rpc-frame.js'
import { parseOutputGapEvidence } from './output-gap-evidence.js'
import { AGENTMUX_RPC_CONTROL_METHODS, AGENTMUX_RPC_NATIVE_METHODS, isAgentMuxRpcStream,
  type AgentMuxRpcEndpoint, type AgentMuxRpcCredentials, type AgentMuxRpcMethod,
  type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamParams, type AgentMuxRpcStreamInitial, type AgentMuxRpcStreamEvent } from './public-rpc.js'
import { AgentMuxRpcLines, AGENTMUX_RPC_MAX_MESSAGE_BYTES, rpcEncode, parseRpcResponse,
  parseRpcRequest, rpcResponseError, rpcFailure, AgentMuxRpcError, type AgentMuxRpcFrame } from './public-rpc-wire.js'

export type AgentMuxRpcSubscriptionOptions<M extends AgentMuxRpcStreamMethod> = {
  onInitial(initial: AgentMuxRpcStreamInitial<M>): void
  onEvent(event: AgentMuxRpcStreamEvent<M>): void
  onFrame?(frame: AgentMuxRpcFrame): void
  onEnd?(error?: Error): void
  signal?: AbortSignal
  runtimeFence?: AgentMuxRuntimeFence
}
export type AgentMuxRpcSubscription = { subscriptionId: string; dispose(): Promise<void> }
export interface AgentMuxRpcClient {
  call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, options?: AgentMuxRpcCallOptions): Promise<AgentMuxRpcResult<M>>
  subscribe<M extends AgentMuxRpcStreamMethod>(method: M, params: AgentMuxRpcStreamParams<M>,
    options: AgentMuxRpcSubscriptionOptions<M>): Promise<AgentMuxRpcSubscription>
  dispose(): Promise<void>
}
export type AgentMuxRpcCallOptions = { signal?: AbortSignal; credentials?: AgentMuxRpcCredentials; runtimeFence?: AgentMuxRuntimeFence }
export function agentMuxRpcEndpoint(selector?: string, env: Readonly<Record<string, string | undefined>> = process.env): AgentMuxRpcEndpoint {
  const value = selector ?? env.AGENTMUX_RPC_ENDPOINT
  if (!value) return { transport: 'unix', path: defaultAgentMuxControlSocketPath(env) }
  if (value.startsWith('unix:')) {
    const path = value.slice(5)
    if (!path.startsWith('/') || /[\0\r\n]/u.test(path)) throw new AgentMuxError('Unix RPC endpoint requires an absolute socket path.', 'INVALID_CLI_ARGUMENT')
    return { transport: 'unix', path }
  }
  let url: URL
  try { url = new URL(value) } catch { throw new AgentMuxError('Invalid RPC endpoint URI.', 'INVALID_CLI_ARGUMENT') }
  if (url.hash.startsWith('#offer=')) {
    try { const offer = parseConnectionOfferUrl(value); if (offer) return { transport: 'relay', offer } }
    catch (error) { throw new AgentMuxError(error instanceof Error ? error.message : 'Invalid Relay offer.', 'INVALID_CLI_ARGUMENT') }
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (url.username || url.password || url.hash || url.pathname !== '/' || url.search) throw new AgentMuxError('HTTP RPC endpoint must identify its root service.', 'INVALID_CLI_ARGUMENT')
    return { transport: 'http', url: url.href, ...(env.AGENTMUX_RPC_HTTP_TOKEN ? { token: env.AGENTMUX_RPC_HTTP_TOKEN } : {}) }
  }
  if (url.protocol === 'ssh:') {
    if (!url.hostname || url.password || url.hash || url.pathname !== '/' && url.pathname !== '') throw new AgentMuxError('Invalid SSH RPC endpoint.', 'INVALID_CLI_ARGUMENT')
    const params = url.searchParams
    if ([...params.keys()].some(key => !['socket', 'command'].includes(key)) || params.getAll('socket').length > 1 || params.getAll('command').length > 1) {
      throw new AgentMuxError('SSH RPC endpoint contains an unknown or repeated option.', 'INVALID_CLI_ARGUMENT')
    }
    return { transport: 'ssh', host: url.hostname, ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
      ...(url.port ? { port: Number(url.port) } : {}), ...(params.has('socket') ? { socketPath: params.get('socket')! } : {}),
      ...(params.has('command') ? { command: params.get('command')! } : {}) }
  }
  throw new AgentMuxError('RPC endpoint must be unix, http, ssh or a Relay connection-offer URL.', 'INVALID_CLI_ARGUMENT')
}
function timeout(method: AgentMuxRpcMethod): number {
  return Object.hasOwn(AGENTMUX_RPC_CONTROL_METHODS, method)
    ? agentMuxControlTimeoutMs(AGENTMUX_RPC_CONTROL_METHODS[method as keyof typeof AGENTMUX_RPC_CONTROL_METHODS])
    : AGENTMUX_RPC_NATIVE_METHODS[method as keyof typeof AGENTMUX_RPC_NATIVE_METHODS] === 'long' ? 60_000 : 2_000
}
function quoteShell(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'" }
export function agentMuxRpcSshArguments(endpoint: Extract<AgentMuxRpcEndpoint, { transport: 'ssh' }>): string[] {
  const host = rpcString(endpoint.host, 'SSH Host')
  if (host.startsWith('-')) throw new AgentMuxError('Invalid SSH Host.', 'INVALID_CONTROL_REQUEST')
  const destination = endpoint.user ? `${rpcString(endpoint.user, 'SSH user')}@${host}` : host
  const command = rpcString(endpoint.command ?? 'agentmux', 'Remote CLI command')
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes']
  if (endpoint.port !== undefined) {
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new AgentMuxError('Invalid SSH port.', 'INVALID_CONTROL_REQUEST')
    args.push('-p', String(endpoint.port))
  }
  if (endpoint.identityFile) args.push('-i', rpcString(endpoint.identityFile, 'SSH identity file'))
  const remote = [command]
  if (endpoint.socketPath) remote.push('--endpoint', `unix:${rpcString(endpoint.socketPath, 'Remote socket')}`)
  remote.push('system', 'endpoint', '--stdio')
  return [...args, '--', destination, remote.map(quoteShell).join(' ')]
}
type Reader = { dispose(): Promise<void> }
async function openRequest(endpoint: AgentMuxRpcEndpoint, request: JSONRPCRequest, onFrame: (frame: unknown) => void,
  onEnd: (error?: Error) => void, signal: AbortSignal, relayKeyPair?: KeyPair): Promise<Reader> {
  if (endpoint.transport === 'relay') return await openAgentMuxRpcRelayRequest({ offer: endpoint.offer, ...(relayKeyPair ? { keyPair: relayKeyPair } : {}) }, request, onFrame, onEnd, signal)
  const encoded = rpcEncode(request)
  if (endpoint.transport === 'http') {
    if (!endpoint.token) throw new AgentMuxError('HTTP RPC requires explicit authorization.', 'AGENT_CAPABILITY_INVALID')
    return await openAgentMuxRpcHttpRequest(endpoint, request, onFrame, onEnd, signal)
  }
  if (endpoint.transport !== 'unix') throw new AgentMuxError('SSH requests require their shared stdio transport.', 'CONTROL_PROTOCOL_ERROR')
  const lines = new AgentMuxRpcLines()
  let closed = false
  const socket = createConnection({ path: endpoint.path, signal })
  const input = socket, output = socket
  const finish = (error?: Error) => { if (closed) return; closed = true
    socket.destroy(); onEnd(error) }
  const abort = () => finish(new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED'))
  signal.addEventListener('abort', abort, { once: true })
  input.on('data', (chunk: Buffer) => { if (closed) return
    try { lines.accept(chunk, onFrame) } catch (error) { finish(transportError(error)) } })
  input.once('end', () => { try { lines.end(); finish() } catch (error) { finish(transportError(error)) } })
  input.once('error', error => finish(transportError(error)))
  output.once('error', error => finish(transportError(error)))
  socket.once('connect', () => output.write(encoded))
  if (signal.aborted) abort()
  return { dispose: async () => { signal.removeEventListener('abort', abort); if (closed) return
    closed = true; socket.destroy() } }
}
function resultBody(method: AgentMuxRpcMethod, value: unknown, params: unknown, credentials?: AgentMuxRpcCredentials): unknown {
  if (Object.hasOwn(AGENTMUX_RPC_CONTROL_METHODS, method)) {
    return parseRpcControlResult(method as keyof typeof AGENTMUX_RPC_CONTROL_METHODS, value, params)
  }
  if (Object.hasOwn(AGENTMUX_HOSTED_RPC_METHODS, method)) {
    if (method === 'runtime.owner.identity' || method === 'runtime.owner.shutdown') {
      const result = rpcRecord(value, method === 'runtime.owner.identity' ? ['owner'] : ['owner', 'accepted'], 'CONTROL_PROTOCOL_ERROR')
      parseHostedRuntimeOwnerIdentity(result.owner)
      if (method === 'runtime.owner.shutdown' && result.accepted !== true) throw new AgentMuxError('Runtime shutdown lacks its original acknowledgement.', 'CONTROL_PROTOCOL_ERROR')
      return result
    }
  }
  return parseRpcNativeResult(method, value, params, credentials)
}
function streamInitial(method: AgentMuxRpcStreamMethod, value: unknown, params: Record<string, unknown>, credentials?: AgentMuxRpcCredentials): unknown {
  const p = rpcRecord(value, undefined, 'CONTROL_PROTOCOL_ERROR')
  if (method === 'runtime.events' || method === 'runtime.history-watch' ||
    method === 'runtime.attachment-watch' || method === 'runtime.replay-watch') {
    rpcRecord(p, method === 'runtime.history-watch' ? ['owner', 'source'] : ['owner', 'transferId'], 'CONTROL_PROTOCOL_ERROR')
    const owner = parseHostedRuntimeOwnerIdentity(p.owner)
    const fence = rpcRecord(params.fence, ['runtimeId', 'ownerInstanceId'], 'CONTROL_PROTOCOL_ERROR')
    if (owner.runtimeId !== fence.runtimeId || owner.ownerInstanceId !== fence.ownerInstanceId) {
      throw new AgentMuxError('Runtime observation belongs to another semantic owner.', 'CONTROL_PROTOCOL_ERROR')
    }
    if (method === 'runtime.history-watch') {
      const source = rpcRecord(p.source, ['providerId', 'nativeSessionId'], 'CONTROL_PROTOCOL_ERROR')
      if (typeof source.providerId !== 'string' || !source.providerId || typeof source.nativeSessionId !== 'string' || !source.nativeSessionId) {
        throw new AgentMuxError('History opening lacks its original native source.', 'CONTROL_PROTOCOL_ERROR')
      }
    } else if (typeof p.transferId !== 'string' || !p.transferId) throw new AgentMuxError('Runtime opening lacks its snapshot transfer identity.', 'CONTROL_PROTOCOL_ERROR')
    return p
  }
  if (method === 'system.metrics.watch') return { observation: parseMetricsObservation(p.observation) }
  if (method === 'toolkit.watch') {
    rpcRecord(p, ['toolId'], 'CONTROL_PROTOCOL_ERROR')
    if (p.toolId !== params.toolId) throw new AgentMuxError('Toolkit opening belongs to another tool.', 'CONTROL_PROTOCOL_ERROR')
  } else if (method === 'browser.follow') {
    const parsed = parseRpcControlResult('browser.follow', p)
    if (parsed.runOperation && (parsed.runOperation as Record<string, unknown>).id !== params.operationId) throw new AgentMuxError('Browser opening belongs to another operation.', 'CONTROL_PROTOCOL_ERROR')
    return parsed
  } else {
    rpcRecord(p, ['session', 'run', 'gap', 'terminal', 'resizeRevision'], 'CONTROL_PROTOCOL_ERROR')
    const session = parseRpcAgentSession(p.session), run = rpcRecord(p.run, undefined, 'CONTROL_PROTOCOL_ERROR')
    if (!rpcSessionTargetMatches(params.agentSessionId, session.agentSessionId, credentials) || session.run.runId !== run.runId ||
      typeof run.runId !== 'string' || !run.runId || !['running', 'exited', 'interrupted'].includes(String(run.state))) {
      throw new AgentMuxError('Output opening belongs to another Session or Run.', 'CONTROL_PROTOCOL_ERROR')
    }
    if (p.gap !== null) {
      const gap = rpcRecord(p.gap, ['requestedAfterByte', 'firstAvailableByte'], 'CONTROL_PROTOCOL_ERROR')
      if (!Number.isSafeInteger(gap.requestedAfterByte) || !Number.isSafeInteger(gap.firstAvailableByte) ||
        (gap.requestedAfterByte as number) < 0 || (gap.firstAvailableByte as number) < 0 ||
        gap.requestedAfterByte !== (params.afterByte ?? 0) || !classifyReplayGap({ truncated: true,
          requestedAfterByte: gap.requestedAfterByte as number, firstAvailableByte: gap.firstAvailableByte as number })) {
        throw new AgentMuxError('Output Gap does not match the original requested byte cursor.', 'CONTROL_PROTOCOL_ERROR')
      }
    }
    try {
      const terminal = parseTerminalContinuation(decodeHostedValue(p.terminal), {
        run: { runId: run.runId as string, latestOutputBytes: run.latestOutputBytes as number },
        resizeRevision: p.resizeRevision as number
      })
      return { ...p, terminal }
    } catch { throw new AgentMuxError('Output opening lacks a valid original terminal continuation or resize revision.', 'CONTROL_PROTOCOL_ERROR') }
  }
  return p
}
function streamEvent(method: AgentMuxRpcStreamMethod, value: unknown, initial: unknown, afterByte: number,
  params: Record<string, unknown>): Record<string, unknown> {
  const event = rpcRecord(value, undefined, 'CONTROL_PROTOCOL_ERROR')
  if (event.type === 'end') { rpcRecord(event, ['type', 'data'], 'CONTROL_PROTOCOL_ERROR'); return event }
  if (event.type === 'error') {
    rpcRecord(event, ['type', 'error'], 'CONTROL_PROTOCOL_ERROR')
    const error = rpcRecord(event.error, ['code', 'message', 'detail', 'details', 'candidates', 'controlFailure', 'evidence'], 'CONTROL_PROTOCOL_ERROR')
    if (typeof error.code !== 'string' || !error.code || typeof error.message !== 'string' ||
      error.detail !== undefined && typeof error.detail !== 'string') throw new AgentMuxError('Invalid reader error.', 'CONTROL_PROTOCOL_ERROR')
    if (error.controlFailure !== undefined) parseRpcControlFailure(error.controlFailure)
    if (error.evidence !== undefined) {
      const evidence = parseOutputGapEvidence(error.evidence)
      if (method === 'agent.output' && evidence.run && evidence.run.runId !== (initial as import('./public-rpc.js').AgentMuxRpcOutputInitial).run.runId) {
        throw new AgentMuxError('Output diagnostic belongs to another Run.', 'CONTROL_PROTOCOL_ERROR')
      }
    }
    return event
  }
  rpcRecord(event, ['type', 'data'], 'CONTROL_PROTOCOL_ERROR')
  if ((method === 'runtime.events' || method === 'runtime.history-watch' ||
    method === 'runtime.attachment-watch' || method === 'runtime.replay-watch') && event.type === 'snapshot') {
    return { ...event, data: parseHostedTransferChunk(event.data) }
  }
  if (method === 'system.metrics.watch' && event.type === 'snapshot') return { ...event, data: parseMetricsObservation(event.data) }
  if (method === 'toolkit.watch' && event.type === 'snapshot') {
    const data = parseToolkitSnapshot(event.data)
    if (data.toolId !== (initial as { toolId: string }).toolId) throw new AgentMuxError('Toolkit event belongs to another tool.', 'CONTROL_PROTOCOL_ERROR')
    return { ...event, data }
  }
  if (method === 'browser.follow' && event.type === 'progress') {
    const p = rpcRecord(event.data, ['sequence', 'event'], 'CONTROL_PROTOCOL_ERROR')
    if (!Number.isSafeInteger(p.sequence) || (p.sequence as number) < 0 || !Object.hasOwn(p, 'event')) throw new AgentMuxError('Invalid Browser progress cursor.', 'CONTROL_PROTOCOL_ERROR')
    return event
  }
  if (method === 'agent.output' && event.type === 'output') {
    const p = rpcRecord(event.data, ['runId', 'replay', 'startByte', 'endByte', 'dataBase64'], 'CONTROL_PROTOCOL_ERROR')
    if (p.runId !== (initial as AgentMuxRpcStreamInitial<'agent.output'>).run.runId || typeof p.replay !== 'boolean' ||
      !Number.isSafeInteger(p.startByte) || !Number.isSafeInteger(p.endByte) || (p.startByte as number) < afterByte ||
      (p.endByte as number) <= (p.startByte as number) || typeof p.dataBase64 !== 'string' ||
      Buffer.from(p.dataBase64, 'base64').toString('base64') !== p.dataBase64 ||
      Buffer.from(p.dataBase64, 'base64').byteLength !== (p.endByte as number) - (p.startByte as number)) {
      throw new AgentMuxError('Output bytes do not match their ordered Run cursor.', 'CONTROL_PROTOCOL_ERROR')
    }
    return event
  }
  throw new AgentMuxError('Reader received an event from another domain.', 'CONTROL_PROTOCOL_ERROR')
}
class RpcClient implements AgentMuxRpcClient {
  private readonly readers = new Set<Reader>()
  private ssh: AgentMuxRpcSshTransport | undefined
  private closed = false
  constructor(private readonly endpoint: AgentMuxRpcEndpoint, private readonly credentials?: AgentMuxRpcCredentials,
    private readonly runtimeFence?: AgentMuxRuntimeFence, private readonly relayKeyPair?: KeyPair) {}
  private async exchange<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>,
    handlers?: AgentMuxRpcSubscriptionOptions<AgentMuxRpcStreamMethod>, signal?: AbortSignal, options: AgentMuxRpcCallOptions = {}): Promise<{ response: JSONRPCResponse; reader: Reader; subscriptionId?: string }> {
    if (this.closed) throw new AgentMuxError('RPC client is disposed.', 'CONTROL_CANCELLED')
    const body = rpcRecord(params)
    if (Object.hasOwn(body, 'caller') || Object.hasOwn(body, 'runtimeFence')) throw new AgentMuxError('RPC caller is a connection credential, not business input.', 'INVALID_CONTROL_REQUEST')
    const credentials = options.credentials ?? this.credentials, runtimeFence = options.runtimeFence ?? this.runtimeFence
    if (credentials) { rpcRecord(credentials, ['agentSessionId', 'capability']); rpcString(credentials.agentSessionId, 'Caller Session ID'); rpcString(credentials.capability, 'Caller capability') }
    const request: JSONRPCRequest = { jsonrpc: '2.0', id: randomUUID(), method,
      params: { ...body, ...(credentials ? { caller: credentials } : {}), ...(runtimeFence ? { runtimeFence } : {}) } }
    const controller = new AbortController()
    let opened = false, responseSeen = false, responseDelivered = false, subscriptionId: string | undefined, sequence = 0
    let initial: unknown, outputCursor = typeof body.afterByte === 'number' ? body.afterByte : 0
    let reader: Reader | undefined, finalReader: Reader | undefined, opening: Promise<Reader> | undefined
    let finished = false
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    let deadline: ReturnType<typeof setTimeout> | undefined
    const deviceRecovery = () => 'Read agentmux device ls and inspect the original device facts before another explicit mutation. Never automatically replay a write.'
    const armDeadline = () => {
      // Finite intents remain with their admitted owner until its receipt, an
      // explicit cancellation or transport failure. Only reader opening is timed.
      if (!handlers) return
      deadline = setTimeout(() => end(new AgentMuxError('RPC reader opening timed out; its owner and Runs are preserved.', 'CONTROL_TIMEOUT')),
        timeout(method) + (this.endpoint.transport === 'ssh' ? AGENTMUX_RPC_SSH_TRANSPORT_BUDGET_MS : 0))
    }
    const end = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(deadline); signal?.removeEventListener('abort', abort)
      controller.abort(); if (finalReader) this.readers.delete(finalReader); if (reader) void reader.dispose()
      if (!responseDelivered) {
        let failure = error ?? new AgentMuxError('RPC ended before its response.', 'CONTROL_PROTOCOL_ERROR')
        if (isAgentMuxRpcDeviceMethod(method) && failure instanceof AgentMuxError) {
          failure = new AgentMuxError(failure.message + ' ' + deviceRecovery(), failure.code, failure.detail, failure.controlFailure)
        }
        rpc.receive(rpcFailure(request.id!, failure))
      }
      else if (opened) handlers?.onEnd?.(error)
    }
    const receive = (value: unknown) => {
      if (finished) return
      try {
        if (!responseSeen) {
          const response = parseRpcResponse(value)
          if (response.id !== request.id) throw new AgentMuxError('RPC response ID does not match the request.', 'CONTROL_PROTOCOL_ERROR')
          responseSeen = true; clearTimeout(deadline)
          if (!response.error && handlers) {
            const result = rpcRecord(response.result, ['subscriptionId', 'method', 'initial'], 'CONTROL_PROTOCOL_ERROR')
            if (typeof result.subscriptionId !== 'string' || !result.subscriptionId || result.method !== method) throw new AgentMuxError('Subscription response belongs to another reader.', 'CONTROL_PROTOCOL_ERROR')
            initial = streamInitial(method as AgentMuxRpcStreamMethod, result.initial, body, credentials)
            subscriptionId = result.subscriptionId; opened = true
            // A validated opening establishes the original lease even when the
            // caller releases it inside its first callback.
            responseDelivered = true; rpc.receive(response)
            handlers.onFrame?.(response)
            if (!finished) handlers.onInitial(initial as AgentMuxRpcStreamInitial<AgentMuxRpcStreamMethod>)
          } else { handlers?.onFrame?.(response)
            if (finished) return
            responseDelivered = true; rpc.receive(response) }
        } else {
          if (!opened) throw new AgentMuxError('A regular RPC request received a second response.', 'CONTROL_PROTOCOL_ERROR')
          const notification = parseRpcRequest(value)
          if (notification.id !== undefined || notification.method !== 'system.subscription.event') throw new AgentMuxError('Expected an RPC subscription notification.', 'CONTROL_PROTOCOL_ERROR')
          const p = rpcRecord(notification.params, ['subscriptionId', 'method', 'sequence', 'event'], 'CONTROL_PROTOCOL_ERROR')
          if (p.subscriptionId !== subscriptionId || p.method !== method || p.sequence !== sequence + 1) throw new AgentMuxError('Subscription notification identity or sequence is invalid.', 'CONTROL_PROTOCOL_ERROR')
          sequence++
          const event = streamEvent(method as AgentMuxRpcStreamMethod, p.event, initial, outputCursor, rpcRecord(params))
          if (event.type === 'output') outputCursor = (event.data as { endByte: number }).endByte
          handlers!.onFrame?.(notification)
          if (finished) return
          handlers!.onEvent(event as AgentMuxRpcStreamEvent<AgentMuxRpcStreamMethod>)
          if (event.type === 'end') end()
          if (event.type === 'error') { const failure = event.error as { code: string; message: string; detail?: string; details?: unknown; candidates?: unknown; controlFailure?: unknown };
            end(new AgentMuxRpcError(failure.message, failure.code, -32000, failure.details, failure.candidates, failure.detail,
              failure.controlFailure === undefined ? undefined : parseRpcControlFailure(failure.controlFailure))) }
        }
      } catch (error) { end(transportError(error)) }
    }
    const rpc = new JSONRPCClient(async payload => {
      try {
        if (this.endpoint.transport === 'ssh') {
          if (!this.ssh) this.ssh = new AgentMuxRpcSshTransport(agentMuxRpcSshArguments(this.endpoint), () => { this.ssh = undefined })
          opening = this.ssh.open(payload, receive, end, controller.signal, armDeadline)
        } else { armDeadline(); opening = openRequest(this.endpoint, payload, receive, end, controller.signal, this.relayKeyPair) }
        reader = await opening
      } catch (error) { end(transportError(error)); return }
      finalReader = { dispose: async () => { end(new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED')); await reader!.dispose() } }
      if (finished) await reader.dispose(); else this.readers.add(finalReader)
    })
    if (signal?.aborted) controller.abort()
    let response: JSONRPCResponse
    try { response = await rpc.requestAdvanced(request, undefined)
      if (opening) await opening.catch(() => {})
      const error = rpcResponseError(response); if (error) throw error
    } catch (error) { end(transportError(error)); throw error }
    return { response, reader: finalReader!, ...(subscriptionId === undefined ? {} : { subscriptionId }) }
  }
  async call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, options: AgentMuxRpcCallOptions = {}): Promise<AgentMuxRpcResult<M>> {
    if (isAgentMuxRpcDeviceMethod(method) && method !== 'device.hello' && this.endpoint.transport !== 'unix') {
      throw new AgentMuxError('Device management requires the local Unix endpoint and a local user. Nothing was connected or submitted.', 'CONTROL_PERMISSION_DENIED')
    }
    if (isAgentMuxRpcStream(method, rpcRecord(params))) throw new AgentMuxError('This method returns a subscription; use subscribe().', 'INVALID_CONTROL_REQUEST')
    const exchange = await this.exchange(method, params, undefined, options.signal, options)
    try { return resultBody(method, exchange.response.result, params, options.credentials ?? this.credentials) as AgentMuxRpcResult<M> } finally { await exchange.reader.dispose(); this.readers.delete(exchange.reader) }
  }
  async subscribe<M extends AgentMuxRpcStreamMethod>(method: M, params: AgentMuxRpcStreamParams<M>, handlers: AgentMuxRpcSubscriptionOptions<M>): Promise<AgentMuxRpcSubscription> {
    const exchange = await this.exchange(method, params, handlers as AgentMuxRpcSubscriptionOptions<AgentMuxRpcStreamMethod>, handlers.signal, handlers.runtimeFence === undefined ? {} : { runtimeFence: handlers.runtimeFence })
    return { subscriptionId: exchange.subscriptionId!, dispose: async () => { await exchange.reader.dispose(); this.readers.delete(exchange.reader) } }
  }
  async dispose(): Promise<void> { if (this.closed) return; this.closed = true
    this.ssh?.dispose(); this.ssh = undefined
    await Promise.all([...this.readers].map(reader => reader.dispose())); this.readers.clear() }
}
export async function connectAgentMuxRpc(options: { endpoint?: AgentMuxRpcEndpoint; credentials?: AgentMuxRpcCredentials; runtimeFence?: AgentMuxRuntimeFence; relayKeyPair?: KeyPair } = {}): Promise<AgentMuxRpcClient> {
  if (options.credentials) { rpcRecord(options.credentials, ['agentSessionId', 'capability']); rpcString(options.credentials.agentSessionId, 'Caller Session ID'); rpcString(options.credentials.capability, 'Caller capability') }
  const endpoint = options.endpoint ?? agentMuxRpcEndpoint()
  const relayKeyPair = endpoint.transport === 'relay' ? options.relayKeyPair ?? await loadOrCreateRelayKeyPair(join(homedir(), '.agentmux', 'relay-client-keypair.json')) : undefined
  return new RpcClient(endpoint, options.credentials, options.runtimeFence, relayKeyPair)
}
