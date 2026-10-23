import { parseAgentContinuityControlInput, type AgentMuxContinuityControlInput } from '@agentmux/core/agent-session-recovery'

/** User authorization awaiting its original owner, never a second Core receipt or supervisor. */
export type ContinuityControlIntents = Record<string, Record<string, ContinuityControlIntent>>
export type ContinuityControlIntent = { hostId: string; request: AgentMuxContinuityControlInput; issue?: string; rejection?: { code: string; message: string } }
export const continuityControlKey = (hostId: string, sessionId: string): string => JSON.stringify([hostId, sessionId])

/** Keep unreadable authored bytes in the existing durable record; never guess a replacement packet. */
export function readContinuityControlIntent(value: unknown, hostId: string, sessionId: string, operationId: string): { intent?: ContinuityControlIntent; issue?: string } {
  if (value === undefined) return {}
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid original control record')
    const record = value as ContinuityControlIntent, request = parseAgentContinuityControlInput(record.request)
    if (record.hostId !== hostId || request.agentSessionId !== sessionId || request.operationId !== operationId) throw new Error('Original control target differs')
    return { intent: { hostId, request, ...(typeof record.issue === 'string' ? { issue: record.issue } : {}),
      ...(record.rejection && terminalContinuityControlRejection(record.rejection) ? { rejection: record.rejection } : {}) } }
  } catch { return { issue: 'The original recovery control packet could not be read. Its saved bytes and Session are kept. Re-read the original owner before choosing another control.' } }
}

/** Visit only this original Host/Session scope, never the fleet or another Session's requests. */
export function continuityControlRequests(value: unknown, hostId: string, sessionId: string) {
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ operationId: 'unreadable-original', issue: 'The original saved control scope is unreadable. Its bytes are kept; cancellation and original Session reads remain available.' }]
  return Object.entries(value).map(([operationId, record]) => ({ operationId, ...readContinuityControlIntent(record, hostId, sessionId, operationId) }))
}

/** Typed original-owner refusals precede metadata admission; transport/observation failures stay unknown. */
export function terminalContinuityControlRejection(error: unknown): { code: string; message: string } | undefined {
  const value = error as { code?: unknown; message?: unknown } | null
  return value && typeof value.code === 'string' && typeof value.message === 'string' &&
    ['STALE_AGENT_SESSION', 'AGENT_CONTINUITY_SUPERSEDED', 'INVALID_AGENT_CONTINUITY_CONTROL', 'UNKNOWN_AGENT_SESSION', 'AGENT_SESSION_RETIRED'].includes(value.code)
    ? { code: value.code, message: value.message } : undefined
}
