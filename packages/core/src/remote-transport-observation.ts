import { AgentMuxError } from './errors.js'

/** The observer's existing Runtime RPC carrier, never configuration or Agent health. */
export type RemoteTransportObservation = {
  state: 'unopened' | 'connecting' | 'connected' | 'disconnected'
  /** Connected: current carrier. Disconnected: last used carrier, if confirmed. */
  transport: 'ssh' | 'tailcat' | null
  /** True only after SSH establishment failed and Tailcat was selected. */
  fallback: boolean
  /** Successful endpoint probe time, retained as history after disconnect. */
  establishedAt: number | null
  /** Local getter read time; this does not perform or date a network probe. */
  observedAt: number
}

/** Browser-safe strict projection: addresses, argv, keys and raw errors never enter it. */
export function parseRemoteTransportObservation(value: unknown): RemoteTransportObservation {
  const invalid = (): never => { throw new AgentMuxError('Remote transport observation is malformed.', 'CONTROL_PROTOCOL_ERROR') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const p = value as Record<string, unknown>
  const keys = ['state', 'transport', 'fallback', 'establishedAt', 'observedAt']
  if (Object.keys(p).length !== keys.length || Object.keys(p).some(key => !keys.includes(key)) ||
      !['unopened', 'connecting', 'connected', 'disconnected'].includes(p.state as string) ||
      p.transport !== null && p.transport !== 'ssh' && p.transport !== 'tailcat' || typeof p.fallback !== 'boolean' ||
      !Number.isSafeInteger(p.observedAt) || (p.observedAt as number) < 0 ||
      p.establishedAt !== null && (!Number.isSafeInteger(p.establishedAt) || (p.establishedAt as number) < 0)) invalid()
  if ((p.state === 'unopened' || p.state === 'connecting') && (p.transport !== null || p.establishedAt !== null || p.fallback) ||
      p.state === 'connected' && (p.transport === null || p.establishedAt === null) ||
      (p.transport === null) !== (p.establishedAt === null) || p.fallback && p.transport !== 'tailcat') invalid()
  return { state: p.state, transport: p.transport, fallback: p.fallback,
    establishedAt: p.establishedAt, observedAt: p.observedAt } as RemoteTransportObservation
}
