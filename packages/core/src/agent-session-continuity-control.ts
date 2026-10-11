import { AgentMuxError } from './errors.js'
import type { AgentMuxAgentSession, AgentMuxRunRef } from './types.js'
import type { AgentMuxContinuitySupervision } from './agent-session-continuity.js'

export type AgentMuxContinuityControlInput = {
  agentSessionId: string
  intentOperationId: string
  expectedRun: AgentMuxRunRef
  operationId: string
} & ({ action: 'cancel'; additionalAttempts?: never } | { action: 'continue'; additionalAttempts: number })

/** Immutable metadata admission, independent of subsequent Runtime or task progress. */
export type AgentMuxContinuityControlReceipt = {
  request: AgentMuxContinuityControlInput
  outcome: 'continued' | 'cancelled' | 'unchanged'
  reason: 'explicit-continue' | 'explicit-cancel' | 'already-active' | 'already-settled' | 'already-cancelled'
  activeAttemptOperationId: string
  attemptCount: number
  attemptLimitBefore: number
  attemptLimitAfter: number
  phaseAtCommit: AgentMuxContinuitySupervision['phase']
  observedAt: number
}
export type AgentMuxContinuityControlRetirement = {
  agentSessionId: string; hostId: string; run: AgentMuxRunRef; source: 'user'; observedAt: number
}
export type AgentMuxContinuityControlResult = { receipt: AgentMuxContinuityControlReceipt } & (
  { state: 'active'; session: AgentMuxAgentSession } |
  { state: 'retired'; retirement: AgentMuxContinuityControlRetirement }
)

function invalid(): never {
  throw new AgentMuxError('The exact original recovery control packet is invalid.', 'INVALID_AGENT_CONTINUITY_CONTROL')
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).byteLength > 512 || /[\0\r\n]/u.test(value)) invalid()
  return value
}
function count(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid()
  return value as number
}
function run(value: unknown): AgentMuxRunRef {
  return { runId: id(record(value, ['runId']).runId) }
}

export function parseAgentContinuityControlInput(value: unknown): AgentMuxContinuityControlInput {
  const p = record(value, ['agentSessionId', 'intentOperationId', 'expectedRun', 'operationId', 'action', 'additionalAttempts'])
  const common = { agentSessionId: id(p.agentSessionId), intentOperationId: id(p.intentOperationId),
    expectedRun: run(p.expectedRun), operationId: id(p.operationId) }
  if (p.action === 'continue') return { ...common, action: 'continue', additionalAttempts: count(p.additionalAttempts, 1) }
  if (p.action !== 'cancel' || Object.hasOwn(p, 'additionalAttempts')) invalid()
  return { ...common, action: 'cancel' }
}

export function sameAgentContinuityControlInput(a: AgentMuxContinuityControlInput, b: AgentMuxContinuityControlInput): boolean {
  return a.agentSessionId === b.agentSessionId && a.intentOperationId === b.intentOperationId &&
    a.expectedRun.runId === b.expectedRun.runId && a.operationId === b.operationId &&
    a.action === b.action && a.additionalAttempts === b.additionalAttempts
}

export function parseAgentContinuityControlReceipt(value: unknown): AgentMuxContinuityControlReceipt {
  const p = record(value, ['request', 'outcome', 'reason', 'activeAttemptOperationId', 'attemptCount', 'attemptLimitBefore',
    'attemptLimitAfter', 'phaseAtCommit', 'observedAt'])
  const request = parseAgentContinuityControlInput(p.request)
  if (typeof p.outcome !== 'string' || !['continued', 'cancelled', 'unchanged'].includes(p.outcome) ||
    typeof p.reason !== 'string' || !['explicit-continue', 'explicit-cancel', 'already-active', 'already-settled', 'already-cancelled'].includes(p.reason) ||
    typeof p.phaseAtCommit !== 'string' || !['observing', 'retry-wait', 'paused', 'settled', 'cancelled'].includes(p.phaseAtCommit)) invalid()
  const before = count(p.attemptLimitBefore, 1), after = count(p.attemptLimitAfter, 1), attemptCount = count(p.attemptCount)
  if (attemptCount > before) invalid()
  if (p.outcome === 'continued' ? request.action !== 'continue' || !Number.isSafeInteger(before + request.additionalAttempts) ||
      after !== before + request.additionalAttempts || p.phaseAtCommit !== 'observing' || p.reason !== 'explicit-continue'
    : after !== before || (p.outcome === 'cancelled' ? request.action !== 'cancel' || p.phaseAtCommit !== 'cancelled' || p.reason !== 'explicit-cancel'
      : p.reason === 'already-active' ? ['settled', 'cancelled'].includes(p.phaseAtCommit)
        : request.action !== 'cancel' || (p.reason === 'already-settled' ? p.phaseAtCommit !== 'settled'
          : p.reason !== 'already-cancelled' || p.phaseAtCommit !== 'cancelled'))) invalid()
  return { request, outcome: p.outcome as AgentMuxContinuityControlReceipt['outcome'],
    reason: p.reason as AgentMuxContinuityControlReceipt['reason'], activeAttemptOperationId: id(p.activeAttemptOperationId),
    attemptCount, attemptLimitBefore: before, attemptLimitAfter: after,
    phaseAtCommit: p.phaseAtCommit as AgentMuxContinuitySupervision['phase'], observedAt: count(p.observedAt) }
}

/** Original records are data, not permission to reopen an intent or send its old input. */
export function parseAgentContinuityControlReceipts(value: unknown, agentSessionId: string,
  intentOperationId?: string): Record<string, AgentMuxContinuityControlReceipt> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const receipt = parseAgentContinuityControlReceipt(item)
    if (receipt.request.operationId !== key || receipt.request.agentSessionId !== agentSessionId ||
      intentOperationId !== undefined && receipt.request.intentOperationId !== intentOperationId) invalid()
    return [key, receipt]
  }))
}

export function parseAgentContinuityControlResult(value: unknown, input: AgentMuxContinuityControlInput): AgentMuxContinuityControlResult {
  const p = record(value, ['receipt', 'state', 'session', 'retirement']), receipt = parseAgentContinuityControlReceipt(p.receipt)
  if (!sameAgentContinuityControlInput(receipt.request, input)) invalid()
  if (p.state === 'active' && !Object.hasOwn(p, 'retirement')) {
    const session = p.session as AgentMuxAgentSession
    if (!session || session.kind !== 'agent' || session.agentSessionId !== input.agentSessionId) invalid()
    id(session.hostId); run(session.run)
    return { receipt, state: 'active', session: structuredClone(session) }
  }
  if (p.state !== 'retired' || Object.hasOwn(p, 'session')) invalid()
  const t = record(p.retirement, ['agentSessionId', 'hostId', 'run', 'source', 'observedAt'])
  if (t.agentSessionId !== input.agentSessionId || t.source !== 'user') invalid()
  return { receipt, state: 'retired', retirement: { agentSessionId: id(t.agentSessionId), hostId: id(t.hostId),
    run: run(t.run), source: 'user', observedAt: count(t.observedAt) } }
}
