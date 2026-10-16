import { AgentMuxError } from './errors.js'
import type { AgentMuxRunRef } from './types.js'

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
}
export type AgentTerminalFrontend = AgentTerminalFrontendObservation & { run: AgentMuxRunRef }

export function parseTerminalFrontendObservation(value: unknown): AgentTerminalFrontendObservation {
  const p = value as Record<string, unknown>
  const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\0\r\n]/u.test(v)
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k =>
    !['frontendId', 'state', 'backendState', 'source', 'observedAt', 'exitCode', 'exitSignal', 'message'].includes(k)) ||
    !id(p.frontendId) || !['starting', 'attached', 'detached', 'unknown'].includes(String(p.state)) ||
    !['running', 'stopping', 'exited', 'unknown'].includes(String(p.backendState)) || p.source !== 'managed-process' ||
    !Number.isSafeInteger(p.observedAt) || (p.observedAt as number) < 0 ||
    p.exitCode !== undefined && !Number.isSafeInteger(p.exitCode) || p.exitSignal !== undefined && !id(p.exitSignal) ||
    p.message !== undefined && (typeof p.message !== 'string' || p.message.length > 4096)) {
    throw new AgentMuxError('The managed terminal frontend observation is invalid.', 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
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
