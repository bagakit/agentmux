import { describe, expect, it } from 'vitest'
import { normalizeNativeHook } from '../src/hook-normalizer.js'
import { CLAUDE_HOOKS } from '../src/providers/claude.js'

/**
 * Claude reports a resumed conversation on its native SessionStart Hook: a real
 * `claude --resume <id>` sends source "resume" with the resumed session_id, while a fresh start
 * sends "startup". Only that exact fact, from the main conversation, contributes the
 * "context restored" continuity observation Core uses to settle a recovery. Core's acceptance of
 * the fact for the exact recovery Run and native target is shared with Codex and tested there.
 */
const main = { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-original' }
const sessionStart = (payload: Record<string, unknown>) => normalizeNativeHook(CLAUDE_HOOKS, {
  agentSessionId: 'original-session', providerId: 'claude', run: { runId: 'recovery-run' }, receiptId: 'receipt',
  payload: { hook_event_name: 'SessionStart', session_id: 'native-original', ...payload } } as never,
  { nativeHandle: main, processNativeHandle: main } as never)

describe('Claude resumed-context fact', () => {
  it('a main SessionStart with source "resume" reports the resumed native conversation', () => {
    const resumed = sessionStart({ source: 'resume' })
    expect(resumed.mainSubject).toBe(true)
    expect(resumed.continuity).toEqual({ kind: 'context-restored', nativeSessionId: 'native-original' })
  })

  it.each(['startup', 'clear', 'compact', 'fork', undefined])('source %s reports no restored context', source => {
    expect(sessionStart({ source }).continuity).toBeUndefined()
  })

  it('a resume source nested in auxiliary fields, a foreign conversation or a subagent does not count', () => {
    expect(sessionStart({ extra: { source: 'resume' } }).continuity).toBeUndefined()
    expect(sessionStart({ source: 'resume', session_id: 'native-other' }).continuity).toBeUndefined()
    expect(sessionStart({ source: 'resume', agent_id: 'child-agent' }).continuity).toBeUndefined()
  })
})
