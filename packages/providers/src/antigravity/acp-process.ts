import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createJSONRPCErrorResponse, JSONRPCClient, type JSONRPCID } from 'json-rpc-2.0'
export type AcpProbeFailureReason = 'spawn-failed' | 'transport-closed' | 'response-timeout' |
  'invalid-response' | 'incompatible-protocol' | 'rpc-error'

export type AcpWireServices = {
  observeRead<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T>
  isRpcId(value: unknown): value is JSONRPCID
  rpcEncode(value: unknown): string
  AgentMuxRpcLines: new () => {
    accept(chunk: Buffer, onFrame: (value: unknown) => void): void
    end(): void
  }
}

export class AntigravityAcpTransportFailure extends Error {
  constructor(readonly reason: AcpProbeFailureReason) { super(reason) }
}

export function acpRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** This holds the sole ACP pipes for one original child. Losing a consumer does not close them. */
export function launchAntigravityAcp({ observeRead, AgentMuxRpcLines, isRpcId, rpcEncode }: AcpWireServices, options: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(options.command, ['acp', ...options.args], {
    cwd: options.cwd, env: { ...options.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, stdio: ['pipe', 'pipe', 'ignore']
  })
  const transport = new AbortController()
  const failure = (reason: AcpProbeFailureReason) => transport.abort(new AntigravityAcpTransportFailure(reason))
  const unavailable = () => failure('transport-closed')
  let started = false
  const ready = once(child, 'spawn').then(() => { started = true })
  void ready.catch(() => {})
  const closed = once(child, 'close').then(([code, signal]) => ({ code: code as number | null, signal: signal as NodeJS.Signals | null }))
  void closed.catch(() => {})
  child.on('error', () => failure(started ? 'transport-closed' : 'spawn-failed'))
  child.stdin.on('error', unavailable)
  child.stdout.on('error', unavailable)
  child.once('close', unavailable)
  const write = (value: unknown) => new Promise<void>((resolve, reject) => {
    child.stdin.write(rpcEncode(value), error => {
      if (error) { unavailable(); reject(error) }
      else resolve()
    })
  })
  const client = new JSONRPCClient(write)
  const frames = new AgentMuxRpcLines()
  child.stdout.on('data', (chunk: Buffer) => {
    if (transport.signal.aborted) return
    try {
      frames.accept(chunk, value => {
        const message = acpRecord(value)
        if (!message || message.jsonrpc !== '2.0') throw new AntigravityAcpTransportFailure('invalid-response')
        if (typeof message.method === 'string') {
          if (Object.hasOwn(message, 'id') && isRpcId(message.id)) {
            // The initialized capability set grants this client no request callbacks.
            void write(createJSONRPCErrorResponse(message.id, -32601, 'ACP client method is unavailable.')).catch(unavailable)
          }
          return
        }
        if (!Object.hasOwn(message, 'id') || !isRpcId(message.id) || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) {
          throw new AntigravityAcpTransportFailure('invalid-response')
        }
        if (Object.hasOwn(message, 'result')) client.receive({ jsonrpc: '2.0', id: message.id, result: message.result })
        else {
          const error = acpRecord(message.error)
          if (typeof error?.code !== 'number' || !Number.isSafeInteger(error.code) || typeof error.message !== 'string') {
            throw new AntigravityAcpTransportFailure('invalid-response')
          }
          // Error bodies can contain account details or credentials.
          client.receive(createJSONRPCErrorResponse(message.id, error.code, 'The original ACP request was refused.'))
        }
      })
    } catch { failure('invalid-response') }
  })
  child.stdout.once('end', () => {
    try { frames.end(); unavailable() }
    catch { failure('invalid-response') }
  })
  const request = async (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const lifetime = signal ? AbortSignal.any([signal, transport.signal]) : transport.signal
    lifetime.throwIfAborted()
    return await observeRead(Promise.resolve(client.request(method, params, undefined)), lifetime)
  }
  let shutdown: Promise<void> | undefined
  return { ready, closed, request, close: () => shutdown ??= (async () => {
    unavailable()
    client.rejectAllPendingRequests('The scoped ACP client has closed.')
    child.stdin.end()
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
    const terminate = setTimeout(() => { child.kill('SIGTERM') }, 500)
    const force = setTimeout(() => { child.kill('SIGKILL') }, 1000)
    try { await closed } finally { clearTimeout(terminate); clearTimeout(force) }
  })() }
}

export async function initializeAntigravityAcp(process: Pick<ReturnType<typeof launchAntigravityAcp>, 'request'>, signal?: AbortSignal): Promise<unknown> {
  return await process.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agentmux', version: '1' } }, signal)
}
