import { AgentMuxError } from './errors.js'
import type { AgentMuxRunRef } from './types.js'

/** The original actor's native bootstrap, independent of TUI attachment and input delivery. */
export type AgentTerminalInitialization = {
  lifecycleOperationId: string
  phase: 'preparing' | 'creating' | 'ready' | 'failed' | 'unknown'
  native: { state: 'not-created' } | { state: 'confirmed'; sessionId: string } | { state: 'unknown' }
  failure?: { step: 'connection' | 'preflight' | 'native-session' | 'frontend'; code?: string | number; message: string }
}
export type AgentTerminalFrontendRecoveryRequest = {
  operationId: string
  expectedFrontendId: string
  target: { kind: 'native-session'; nativeSessionId: string } | { kind: 'initialization'; lifecycleOperationId: string }
}

/** Provider-owned managed child facts, independent of Runtime and native turn state. */
export type AgentTerminalFrontendObservation = {
  frontendId: string
  state: 'starting' | 'attached' | 'detached' | 'unknown'
  backendState: 'running' | 'stopping' | 'exited' | 'unknown'
  source: 'managed-process'
  observedAt: number
  exitCode?: number
  exitSignal?: string
  message?: string
  initialization?: AgentTerminalInitialization
}
export type AgentTerminalFrontend = AgentTerminalFrontendObservation & { run: AgentMuxRunRef }

export function parseTerminalFrontendObservation(value: unknown): AgentTerminalFrontendObservation {
  const p = value as Record<string, unknown>
  const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\0\r\n]/u.test(v)
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k =>
    !['frontendId', 'state', 'backendState', 'source', 'observedAt', 'exitCode', 'exitSignal', 'message', 'initialization'].includes(k)) ||
    !id(p.frontendId) || !['starting', 'attached', 'detached', 'unknown'].includes(String(p.state)) ||
    !['running', 'stopping', 'exited', 'unknown'].includes(String(p.backendState)) || p.source !== 'managed-process' ||
    !Number.isSafeInteger(p.observedAt) || (p.observedAt as number) < 0 ||
    p.exitCode !== undefined && !Number.isSafeInteger(p.exitCode) || p.exitSignal !== undefined && !id(p.exitSignal) ||
    p.message !== undefined && (typeof p.message !== 'string' || p.message.length > 4096)) {
    throw new AgentMuxError('The managed terminal frontend observation is invalid.', 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
  }
  if (p.initialization !== undefined) {
    const initialization = p.initialization as AgentTerminalInitialization, native = initialization?.native
    const failure = initialization?.failure
    if (!initialization || typeof initialization !== 'object' || Array.isArray(initialization) ||
      Object.keys(initialization).some(key => !['lifecycleOperationId', 'phase', 'native', 'failure'].includes(key)) ||
      !id(initialization.lifecycleOperationId) || !['preparing', 'creating', 'ready', 'failed', 'unknown'].includes(initialization.phase) ||
      !native || typeof native !== 'object' || Array.isArray(native) ||
      Object.keys(native).some(key => !['state', 'sessionId'].includes(key)) ||
      !['not-created', 'confirmed', 'unknown'].includes(native.state) ||
      (native.state === 'confirmed' ? !id(native.sessionId) : Object.hasOwn(native, 'sessionId')) ||
      initialization.phase === 'ready' && native.state !== 'confirmed' ||
      failure !== undefined && (!failure || typeof failure !== 'object' || Array.isArray(failure) ||
        Object.keys(failure).some(key => !['step', 'code', 'message'].includes(key)) ||
        !['connection', 'preflight', 'native-session', 'frontend'].includes(failure.step) ||
        typeof failure.message !== 'string' || !failure.message || failure.message.length > 4096 ||
        failure.code !== undefined && (typeof failure.code === 'number' ? !Number.isSafeInteger(failure.code) : !id(failure.code)))) {
      throw new AgentMuxError('The original native initialization observation is invalid.', 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
    }
  }
  return structuredClone(p) as AgentTerminalFrontendObservation
}
export function parseTerminalFrontend(value: unknown, run: AgentMuxRunRef): AgentTerminalFrontend {
  const { run: target, ...observation } = value as AgentTerminalFrontend
  if (!target || Object.keys(target).some(k => k !== 'runId') || target.runId !== run.runId) {
    throw new AgentMuxError('The terminal frontend belongs to another Run.', 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
  }
  return { ...parseTerminalFrontendObservation(observation), run: { ...run } }
}
