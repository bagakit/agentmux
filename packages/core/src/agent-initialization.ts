import { AgentMuxError } from './errors.js'
import type { AgentProviderInputInitialization, AgentProviderInputInitializationContext } from './agent-provider.js'
import type { AgentMuxRunRef } from './types.js'

/** Read-only cause attached to the original input wait, never an admission grant. */
export type AgentInputInitializationObservation = AgentProviderInputInitialization & {
  providerId: string
  run: AgentMuxRunRef
  purpose: AgentProviderInputInitializationContext['purpose']
  observedAt: number
  nativeSessionId?: string
}

export function parseProviderInputInitialization(value: unknown): AgentProviderInputInitialization {
  const p = value as AgentProviderInputInitialization
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(key => !['state', 'reason', 'source', 'scope'].includes(key)) ||
      !['pending', 'unknown'].includes(p.state) ||
      !['directory-trust', 'authentication', 'onboarding', 'permission', 'hook-trust', 'upgrade', 'native-input-unconfirmed', 'inspection-unavailable'].includes(p.reason) ||
      !['native-protocol', 'native-configuration', 'unavailable'].includes(p.source) ||
      !['prerequisite', 'request', 'unknown'].includes(p.scope) ||
      p.state === 'pending' && (p.source === 'unavailable' || p.scope === 'unknown') ||
      p.scope === 'request' && p.source !== 'native-protocol' ||
      ['native-input-unconfirmed', 'inspection-unavailable'].includes(p.reason) &&
      (p.state !== 'unknown' || p.source !== 'unavailable' || p.scope !== 'unknown')) {
    throw new AgentMuxError('Provider initialization observation is invalid.', 'INVALID_AGENT_INITIALIZATION')
  }
  return structuredClone(p)
}

export function parseInputInitialization(value: unknown): AgentInputInitializationObservation {
  const invalid = (): never => { throw new AgentMuxError('Original initialization observation is invalid.', 'INVALID_AGENT_INITIALIZATION') }
  const p = value as AgentInputInitializationObservation
  const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !/[\0\r\n]/u.test(v)
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(key =>
      !['state', 'reason', 'source', 'scope', 'providerId', 'run', 'purpose', 'observedAt', 'nativeSessionId'].includes(key)) ||
      !['initial-input', 'resumed-input', 'conversation-start'].includes(p.purpose) ||
      !id(p.providerId) || !p.run || typeof p.run !== 'object' || Array.isArray(p.run) ||
      Object.keys(p.run).some(key => key !== 'runId') || !id(p.run.runId) ||
      !Number.isSafeInteger(p.observedAt) || p.observedAt < 0 || p.nativeSessionId !== undefined && !id(p.nativeSessionId)) invalid()
  parseProviderInputInitialization({ state: p.state, reason: p.reason, source: p.source, scope: p.scope })
  return structuredClone(p)
}
