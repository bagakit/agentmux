import { AgentMuxError } from './errors.js'
import { normalizeNativeSessionId, normalizeNativeTranscriptPath } from './agent-native-locator.js'
import type { AgentMuxNativeSessionConfirmationInput, AgentNativeSessionHandle } from './types.js'

function invalid(): never { throw new AgentMuxError('Native confirmation requires the exact Session, Run, old locator and observed candidate.', 'INVALID_AGENT_NATIVE_CONFIRMATION') }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
export function parseNativeConfirmationHandle(value: unknown): Extract<AgentNativeSessionHandle, { kind: 'provider' }> {
  const p = object(value, ['kind', 'providerId', 'sessionId', 'transcriptPath'])
  if (p.kind !== 'provider' || typeof p.providerId !== 'string' || !p.providerId || /[\0\r\n]/u.test(p.providerId) ||
      normalizeNativeSessionId(p.sessionId) !== p.sessionId || p.sessionId === undefined ||
      (p.transcriptPath !== undefined && normalizeNativeTranscriptPath(p.transcriptPath) !== p.transcriptPath)) invalid()
  return { kind: 'provider', providerId: p.providerId, sessionId: p.sessionId as string,
    ...(p.transcriptPath === undefined ? {} : { transcriptPath: p.transcriptPath as string }) }
}
export function parseAgentNativeSessionConfirmation(value: unknown): AgentMuxNativeSessionConfirmationInput {
  const p = object(value, ['agentSessionId', 'expectedRun', 'expectedNativeHandle', 'candidateNativeHandle', 'expectedObservationAt', 'operationId'])
  const run = object(p.expectedRun, ['runId'])
  for (const value of [p.agentSessionId, p.operationId, run.runId]) if (typeof value !== 'string' || !value || value.length > 256 || /[\0\r\n]/u.test(value)) invalid()
  if (!Number.isSafeInteger(p.expectedObservationAt) || (p.expectedObservationAt as number) < 1) invalid()
  const expectedNativeHandle = parseNativeConfirmationHandle(p.expectedNativeHandle)
  const candidateNativeHandle = parseNativeConfirmationHandle(p.candidateNativeHandle)
  if (candidateNativeHandle.providerId !== expectedNativeHandle.providerId || candidateNativeHandle.sessionId === expectedNativeHandle.sessionId) invalid()
  return { agentSessionId: p.agentSessionId as string, expectedRun: { runId: run.runId as string }, expectedNativeHandle,
    candidateNativeHandle, expectedObservationAt: p.expectedObservationAt as number, operationId: p.operationId as string }
}
