import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { isAbsolute } from 'node:path'
import { createJSONRPCErrorResponse, JSONRPCClient, JSONRPCErrorException, type JSONRPCResponse } from 'json-rpc-2.0'
import type { AgentProviderAcpHandshake, AgentProviderAcpProbe, AgentProviderAcpProbeContext, AgentProviderAcpProbeFailure } from '../agent-provider-acp-probe.js'
import { observeRead } from '../observation-read.js'
import { AgentMuxRpcLines, isRpcId, rpcEncode } from '../public-rpc-frame.js'

// Bound one observation of this disposable process. A live Agent/Run never uses these deadlines.
const PROBE_STEP_MS = 10_000
const AUTHENTICATION_REQUIRED = -32000

class AcpProbeFailure extends Error {
  constructor(readonly reason: AgentProviderAcpProbeFailure) { super(reason) }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function capabilityRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  const fields = record(value)
  if (!fields) throw new AcpProbeFailure('invalid-response')
  return fields
}

function capabilityFlag(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new AcpProbeFailure('invalid-response')
  return value
}

function readHandshake(value: unknown): AgentProviderAcpHandshake {
  const result = record(value)
  const version = result?.protocolVersion
  if (!result || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new AcpProbeFailure('invalid-response')
  if (version !== 1) throw new AcpProbeFailure('incompatible-protocol')
  const caps = capabilityRecord(result.agentCapabilities)
  const sessions = capabilityRecord(caps?.sessionCapabilities)
  const prompt = capabilityRecord(caps?.promptCapabilities)
  return {
    protocolVersion: version,
    sessions: {
      list: capabilityRecord(sessions?.list) !== undefined,
      load: capabilityFlag(caps?.loadSession),
      resume: capabilityRecord(sessions?.resume) !== undefined,
      close: capabilityRecord(sessions?.close) !== undefined,
      additionalDirectories: capabilityRecord(sessions?.additionalDirectories) !== undefined
    },
    prompt: { image: capabilityFlag(prompt?.image), audio: capabilityFlag(prompt?.audio), embeddedContext: capabilityFlag(prompt?.embeddedContext) }
  }
}

function readListResponse(value: unknown): void {
  const sessions = record(value)?.sessions
  if (!Array.isArray(sessions) || !sessions.every(item => {
    const session = record(item)
    return typeof session?.sessionId === 'string' && session.sessionId.length > 0 &&
      typeof session.cwd === 'string' && isAbsolute(session.cwd)
  })) throw new AcpProbeFailure('invalid-response')
}

function failure(error: unknown, fallback: AgentProviderAcpProbeFailure) {
  return {
    state: 'unconfirmed' as const,
    reason: error instanceof AcpProbeFailure ? error.reason : error instanceof JSONRPCErrorException ? 'rpc-error' as const : fallback,
    ...(error instanceof JSONRPCErrorException ? { rpcCode: error.code } : {})
  }
}

export async function probeAntigravityAcp(input: AgentProviderAcpProbeContext): Promise<AgentProviderAcpProbe> {
  input.signal?.throwIfAborted()
  let stage: 'launch' | 'initialize' = 'launch'
  const transport = new AbortController()
  try {
    const child = spawn(input.command, ['acp', ...input.args], {
      cwd: input.workspacePath,
      env: { ...process.env, ...input.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const unavailable = () => transport.abort(new AcpProbeFailure('transport-closed'))
    const write = (value: unknown) => new Promise<void>((resolve, reject) => {
      child.stdin.write(rpcEncode(value), error => {
        if (error) { unavailable(); reject(error) }
        else resolve()
      })
    })
    const client = new JSONRPCClient(write)
    child.on('error', () => transport.abort(new AcpProbeFailure(stage === 'launch' ? 'spawn-failed' : 'transport-closed')))
    child.stdin.on('error', unavailable)
    child.stdout.on('error', unavailable)
    child.once('close', unavailable)
    const frames = new AgentMuxRpcLines()
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        frames.accept(chunk, value => {
          const message = record(value)
          if (!message || message.jsonrpc !== '2.0') throw new AcpProbeFailure('invalid-response')
          if (typeof message.method === 'string') {
            if (Object.hasOwn(message, 'id') && isRpcId(message.id)) {
              // Negotiation and listing grant no ACP callback capabilities.
              void write(createJSONRPCErrorResponse(message.id, -32601, 'Method not available during the ACP probe.')).catch(unavailable)
            }
            return
          }
          const error = record(message.error)
          if (!Object.hasOwn(message, 'id') || !isRpcId(message.id) || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error') ||
            Object.hasOwn(message, 'error') && (!Number.isSafeInteger(error?.code) || typeof error?.message !== 'string')) {
            throw new AcpProbeFailure('invalid-response')
          }
          client.receive(message as unknown as JSONRPCResponse)
        })
      } catch { transport.abort(new AcpProbeFailure('invalid-response')) }
    })
    child.stdout.once('end', () => {
      try { frames.end(); unavailable() }
      catch { transport.abort(new AcpProbeFailure('invalid-response')) }
    })
    const observe = async <T>(work: () => PromiseLike<T>): Promise<T> => {
      const timeout = AbortSignal.timeout(PROBE_STEP_MS)
      const signal = AbortSignal.any([timeout, transport.signal, ...(input.signal ? [input.signal] : [])])
      signal.throwIfAborted()
      try { return await observeRead(Promise.resolve(work()), signal) }
      catch (error) {
        input.signal?.throwIfAborted()
        if (timeout.aborted) throw new AcpProbeFailure('response-timeout')
        throw error
      }
    }
    try {
      await observe(() => once(child, 'spawn', input.signal ? { signal: input.signal } : undefined))
      stage = 'initialize'
      const handshake = readHandshake(await observe(() => client.request('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agentmux', version: '1' }
      }, undefined)))
      if (!handshake.sessions.list) return { handshake, service: { state: 'unsupported', stage: 'session/list' } }
      try {
        readListResponse(await observe(() => client.request('session/list', { cwd: input.workspacePath }, undefined)))
        return { handshake, service: { state: 'ready', stage: 'session/list' } }
      } catch (error) {
        input.signal?.throwIfAborted()
        if (error instanceof JSONRPCErrorException && error.code === AUTHENTICATION_REQUIRED) {
          return { handshake, service: { state: 'authentication-required', stage: 'session/list', rpcCode: AUTHENTICATION_REQUIRED } }
        }
        return { handshake, service: { ...failure(error, 'transport-closed'), stage: 'session/list' } }
      }
    } finally {
      client.rejectAllPendingRequests('The scoped ACP probe has ended.')
      // EOF first, then terminate only this disposable child if it keeps running.
      child.stdin.end()
      const terminate = setTimeout(() => { child.kill('SIGTERM') }, 500)
      const force = setTimeout(() => { child.kill('SIGKILL') }, 1000)
      child.once('close', () => { clearTimeout(terminate); clearTimeout(force) })
      terminate.unref()
      force.unref()
    }
  } catch (error) {
    input.signal?.throwIfAborted()
    return { handshake: null, service: { ...failure(error, stage === 'launch' ? 'spawn-failed' : 'transport-closed'), stage } }
  }
}
