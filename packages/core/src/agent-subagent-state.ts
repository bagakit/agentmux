import { AgentMuxError } from './errors.js'
import type { AgentMuxRunRef, AgentNativeSessionHandle, AgentProviderId } from './types.js'

export type AgentSubagentSession = {
  nativeAgentId: string
  hookReceiptId: string
  nativeTurnId?: string
  sourceId?: string
  sequence?: number
  state: 'working' | 'waiting' | 'done' | 'error' | 'unknown'
  /** Native request kind; only waiting proves pending input, unknown retains the observation without that claim. */
  waitingFor?: 'permission' | 'question'
  outcome?: 'completed' | 'interrupted' | 'failed' | 'refused'
  phase: 'running' | 'ended'
  observedAt: number
}

/** One original Session's child facts, persisted with its metadata, never a second Store. */
export type AgentNativeSubagents = {
  run: AgentMuxRunRef
  providerId: AgentProviderId
  nativeSessionId: string
  sourceId?: string
  unconfirmed: boolean
  sessions: AgentSubagentSession[]
}

export function subagentScopeMatches(value: AgentNativeSubagents | undefined, target: {
  run: AgentMuxRunRef; providerId: AgentProviderId; nativeHandle?: AgentNativeSessionHandle
}): value is AgentNativeSubagents {
  return value !== undefined && value.run.runId === target.run.runId && value.providerId === target.providerId &&
    target.nativeHandle?.kind === 'provider' && value.nativeSessionId === target.nativeHandle.sessionId
}

export function agentHasActiveSubagents(value: AgentNativeSubagents | undefined): boolean {
  return value?.sessions.some(item => item.phase === 'running') === true
}

export function agentSubagentActivityUnconfirmed(value: AgentNativeSubagents | undefined, sourceId?: string): boolean {
  return value !== undefined && (value.unconfirmed || sourceId !== undefined && value.sourceId !== undefined && sourceId !== value.sourceId)
}

/** A known source gap withdraws only affected current declarations, never identities or history clocks. */
export function invalidateSubagentSource(value: AgentNativeSubagents,
  source?: { sourceId: string; sequence: number }): AgentNativeSubagents | undefined {
  let changed = false
  const sessions = value.sessions.map(child => {
    if (child.phase !== 'running' || child.state === 'unknown' || source &&
        (child.sourceId !== source.sourceId || child.sequence !== undefined && child.sequence >= source.sequence)) return child
    changed = true
    return { ...child, state: 'unknown' as const }
  })
  return changed ? { ...value, sessions } : undefined
}

/** Shared durable/wire parser. Missing facts stay absent; no default identity is manufactured. */
export function parseNativeSubagents(value: unknown): AgentNativeSubagents {
  const invalid = (): never => { throw new AgentMuxError('Native child observations are malformed.', 'INVALID_AGENT_SUBAGENTS') }
  const object = (v: unknown, keys: string[]): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) invalid()
    return v as Record<string, unknown>
  }
  const id = (v: unknown): string => { if (typeof v !== 'string' || !v.trim() || /[\0\r\n]/u.test(v)) invalid(); return v as string }
  const count = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 0) invalid(); return v as number }
  const p = object(value, ['run', 'providerId', 'nativeSessionId', 'sourceId', 'unconfirmed', 'sessions'])
  const run = object(p.run, ['runId'])
  if (typeof p.unconfirmed !== 'boolean' || !Array.isArray(p.sessions)) invalid()
  const seen = new Set<string>()
  const sessions = (p.sessions as unknown[]).map(value => {
    const s = object(value, ['nativeAgentId', 'hookReceiptId', 'nativeTurnId', 'sourceId', 'sequence', 'state', 'phase', 'observedAt', 'outcome', 'waitingFor'])
    const nativeAgentId = id(s.nativeAgentId)
    if (seen.has(nativeAgentId) || !['working', 'waiting', 'done', 'error', 'unknown'].includes(String(s.state)) ||
        !['running', 'ended'].includes(String(s.phase)) || s.sequence !== undefined && count(s.sequence) === 0) invalid()
    if (s.outcome !== undefined && (s.phase !== 'ended' || !['completed', 'interrupted', 'failed', 'refused'].includes(String(s.outcome)))) invalid()
    if (s.phase === 'running' && ['done', 'error'].includes(String(s.state)) ||
        s.phase === 'ended' && ['working', 'waiting'].includes(String(s.state)) ||
        s.outcome === 'completed' && s.state !== 'done' || s.outcome === 'failed' && s.state !== 'error' ||
        ['interrupted', 'refused'].includes(String(s.outcome)) && s.state !== 'unknown') invalid()
    if (s.waitingFor !== undefined && (s.phase !== 'running' || !['waiting', 'unknown'].includes(String(s.state)) ||
        !['permission', 'question'].includes(String(s.waitingFor)))) invalid()
    seen.add(nativeAgentId)
    return { nativeAgentId, hookReceiptId: id(s.hookReceiptId), ...(s.waitingFor === undefined ? {} : { waitingFor: s.waitingFor as NonNullable<AgentSubagentSession['waitingFor']> }), ...(s.outcome === undefined ? {} : { outcome: s.outcome as NonNullable<AgentSubagentSession['outcome']> }), state: s.state as AgentSubagentSession['state'], phase: s.phase as AgentSubagentSession['phase'],
      observedAt: count(s.observedAt), ...(s.nativeTurnId === undefined ? {} : { nativeTurnId: id(s.nativeTurnId) }),
      ...(s.sourceId === undefined ? {} : { sourceId: id(s.sourceId) }), ...(s.sequence === undefined ? {} : { sequence: count(s.sequence) }) }
  })
  return { run: { runId: id(run.runId) }, providerId: id(p.providerId), nativeSessionId: id(p.nativeSessionId),
    unconfirmed: p.unconfirmed as boolean, sessions, ...(p.sourceId === undefined ? {} : { sourceId: id(p.sourceId) }) }
}
