import type { AgentObservation } from './agent-status-freshness.js'
import { parseNativeSubagents } from './agent-subagent-state.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxRunRef } from './types.js'

const semantics = ['active', 'idle', 'awaiting-input', 'unknown', 'unsupported']
const sources = ['terminal-output', 'run-process', 'native-hook', 'native-transcript', 'acp', 'user', 'agentmux']
function invalid(): never { throw new AgentMuxError('Invalid original Core Agent observation.', 'CONTROL_PROTOCOL_ERROR') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
function member(value: unknown, values: readonly string[]): void { if (typeof value !== 'string' || !values.includes(value)) invalid() }
function time(value: unknown): void { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid() }
function identity(value: unknown): void { if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) invalid() }

/** The observeAgent wire projection, without inferring or rewriting its separate facts. */
export function parseAgentObservation(value: unknown, expectedRun?: AgentMuxRunRef): AgentObservation {
  const p = record(value, ['process', 'semantic', 'mainSession', 'subagentSessions', 'readiness', 'source', 'observedAt', 'stale', 'reason', 'lastKnownActivity'])
  member(p.process, ['running', 'exited', 'interrupted']); member(p.semantic, semantics)
  member(p.readiness, ['ready', 'pending', 'unknown']); member(p.source, sources)
  time(p.observedAt)
  if (typeof p.stale !== 'boolean') invalid()
  if (p.reason !== undefined) {
    member(p.reason, ['activity-stale', 'activity-unconfirmed'])
    if (p.semantic !== 'unknown' || p.process !== 'running') invalid()
  }
  if (p.mainSession !== undefined) {
    const main = record(p.mainSession, ['semantic', 'source', 'observedAt', 'nativeTurnId'])
    member(main.semantic, semantics); member(main.source, sources); time(main.observedAt)
    if (main.nativeTurnId !== undefined) identity(main.nativeTurnId)
  }
  if (p.lastKnownActivity !== undefined) {
    if (p.reason === undefined) invalid()
    const last = record(p.lastKnownActivity, ['state', 'source', 'observedAt'])
    member(last.state, ['working', 'waiting', 'blocked', 'done', 'error'])
    member(last.source, ['native-hook', 'native-transcript', 'acp']); time(last.observedAt)
  }
  if (p.subagentSessions !== undefined) {
    try {
      const children = parseNativeSubagents(p.subagentSessions)
      if (expectedRun && children.run.runId !== expectedRun.runId) invalid()
    } catch { invalid() }
  }
  return p as unknown as AgentObservation
}
