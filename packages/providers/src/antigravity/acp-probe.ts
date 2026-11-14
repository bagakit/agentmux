import { isAbsolute } from 'node:path'
import { JSONRPCErrorException } from 'json-rpc-2.0'
import { acpRecord as record, AntigravityAcpTransportFailure as AcpProbeFailure, initializeAntigravityAcp, launchAntigravityAcp,
  type AcpWireServices, type AcpProbeFailureReason } from './acp-process.js'

type AcpProbeTarget = {
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  workspacePath: string
  signal?: AbortSignal
}

// Bound one observation of this disposable process. A live Agent/Run never uses these deadlines.
const PROBE_STEP_MS = 10_000
const AUTHENTICATION_REQUIRED = -32000

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

export function readAntigravityAcpHandshake(value: unknown) {
  const result = record(value)
  const version = result?.protocolVersion
  if (!result || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new AcpProbeFailure('invalid-response')
  if (version !== 1) throw new AcpProbeFailure('incompatible-protocol')
  const caps = capabilityRecord(result.agentCapabilities)
  const sessions = capabilityRecord(caps?.sessionCapabilities)
  const prompt = capabilityRecord(caps?.promptCapabilities)
  return {
    protocolVersion: version as 1,
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

function failure(error: unknown, fallback: AcpProbeFailureReason) {
  return {
    state: 'unconfirmed' as const,
    reason: error instanceof AcpProbeFailure ? error.reason : error instanceof JSONRPCErrorException ? 'rpc-error' as const : fallback,
    ...(error instanceof JSONRPCErrorException ? { rpcCode: error.code } : {})
  }
}

export function createAntigravityAcpProbe(services: AcpWireServices) {
  return async function probeAntigravityAcp(input: AcpProbeTarget) {
    input.signal?.throwIfAborted()
    let stage: 'launch' | 'initialize' = 'launch'
    const observe = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const timeout = AbortSignal.timeout(PROBE_STEP_MS)
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
      try { return await work(signal) }
      catch (error) {
        input.signal?.throwIfAborted()
        if (timeout.aborted) throw new AcpProbeFailure('response-timeout')
        throw error
      }
    }
    try {
      const child = launchAntigravityAcp(services, { command: input.command, args: input.args, cwd: input.workspacePath, env: { ...process.env, ...input.env } })
      try {
        await observe(signal => services.observeRead(child.ready, signal))
        stage = 'initialize'
        const handshake = readAntigravityAcpHandshake(await observe(signal => initializeAntigravityAcp(child, signal)))
        if (!handshake.sessions.list) return { handshake, service: { state: 'unsupported' as const, stage: 'session/list' as const } }
        try {
          readListResponse(await observe(signal => child.request('session/list', { cwd: input.workspacePath }, signal)))
          return { handshake, service: { state: 'ready' as const, stage: 'session/list' as const } }
        } catch (error) {
          input.signal?.throwIfAborted()
          if (error instanceof JSONRPCErrorException && error.code === AUTHENTICATION_REQUIRED) {
            return { handshake, service: { state: 'authentication-required', stage: 'session/list', rpcCode: AUTHENTICATION_REQUIRED } } as const
          }
          return { handshake, service: { ...failure(error, 'transport-closed'), stage: 'session/list' as const } }
        }
      } finally { await child.close() }
    } catch (error) {
      input.signal?.throwIfAborted()
      return { handshake: null, service: { ...failure(error, stage === 'launch' ? 'spawn-failed' : 'transport-closed'), stage } }
    }
  }
}
