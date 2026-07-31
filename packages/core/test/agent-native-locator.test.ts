import { describe, expect, it } from 'vitest'
import {
  MAX_NATIVE_SESSION_ID_BYTES,
  MAX_NATIVE_TRANSCRIPT_PATH_BYTES,
  normalizeNativeSessionId,
  normalizeNativeTranscriptPath
} from '../src/agent-native-locator.js'
import { normalizeStoredAgentSession } from '../src/agent-session-store.js'

function session(nativeHandle: unknown) {
  return {
    kind: 'agent' as const,
    agentSessionId: 'semantic-locator-test',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-locator-test' },
    retiredRuns: [],
    hookBindingId: 'hook-locator-test',
    hookToken: 'token-locator-test',
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1,
    nativeHandle
  }
}

describe('native resume locator contract', () => {
  it('normalizes only bounded, non-option session ids', () => {
    expect(normalizeNativeSessionId(' native-1 ')).toBe('native-1')
    expect(normalizeNativeSessionId('')).toBeUndefined()
    expect(normalizeNativeSessionId(' -resume-me')).toBeUndefined()
    expect(normalizeNativeSessionId('\n native-1')).toBeUndefined()
    expect(normalizeNativeSessionId('native\u001bsession')).toBeUndefined()
    expect(normalizeNativeSessionId('native\u0085session')).toBeUndefined()
    expect(normalizeNativeSessionId('x'.repeat(MAX_NATIVE_SESSION_ID_BYTES + 1))).toBeUndefined()
  })

  it('normalizes only absolute, bounded transcript paths', () => {
    expect(normalizeNativeTranscriptPath(' /tmp/session.jsonl ')).toBe('/tmp/session.jsonl')
    expect(normalizeNativeTranscriptPath('relative/session.jsonl')).toBeUndefined()
    expect(normalizeNativeTranscriptPath('\t/tmp/session.jsonl')).toBeUndefined()
    expect(normalizeNativeTranscriptPath('/tmp/session\t.jsonl')).toBeUndefined()
    expect(normalizeNativeTranscriptPath('/tmp/session\u009f.jsonl')).toBeUndefined()
    expect(normalizeNativeTranscriptPath('x'.repeat(MAX_NATIVE_TRANSCRIPT_PATH_BYTES + 1))).toBeUndefined()
  })

  it('rejects invalid locators when loading durable Session truth', () => {
    for (const nativeHandle of [
      { kind: 'provider', providerId: 'codex', sessionId: '-looks-like-a-flag' },
      { kind: 'provider', providerId: 'codex', sessionId: 'native\u001bsession' },
      { kind: 'provider', providerId: 'codex', sessionId: 'native-1', transcriptPath: 'relative/session.jsonl' },
      { kind: 'provider', providerId: 'codex', sessionId: 'native-1', transcriptPath: '/tmp/session\t.jsonl' },
      { kind: 'acp', adapterId: '-adapter', sessionId: 'acp-1' }
    ]) {
      expect(() => normalizeStoredAgentSession(session(nativeHandle)))
        .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_SESSION_STORE' }))
    }
  })

  it('rejects a native provider locator whose providerId is not the Agent provider', () => {
    // acceptance#3 「providerId/sessionId 不匹配」: a well-formed provider locator that names a
    // different provider than the Agent must be refused, not silently persisted. Every other
    // locator case here is codex↔codex, so this cross-field mismatch was never constructed.
    // The message (not merely the shared code) pins THIS guard: deleting it lets the record
    // normalize cleanly because no other guard inspects nativeHandle.providerId.
    expect(() => normalizeStoredAgentSession(session({
      kind: 'provider',
      providerId: 'claude',
      sessionId: 'native-1'
    }))).toThrowError(expect.objectContaining({
      code: 'INVALID_AGENT_SESSION_STORE',
      message: 'Native session handle provider does not match the Agent.'
    }))
  })

  it('rejects a hook receipt that does not identify its Agent Session', () => {
    // acceptance#2 「Hook 后更新是原子且可重复的」+ objective「Provider hook 到达前后安全 round-trip」:
    // the persisted hook receipt is the hook-after update, so it must name the same provider,
    // Agent Session and Run as the record it rides on — otherwise a stale or foreign hook would
    // corrupt the Session on reload. Each variant violates exactly one arm of the guard, and the
    // message assertion pins this specific guard rather than the code shared across the family.
    const base = {
      id: 'receipt-locator',
      providerId: 'codex',
      agentSessionId: 'semantic-locator-test',
      run: { runId: 'run-locator-test' },
      eventName: 'PostToolUse',
      observedAt: 1
    }
    for (const hookReceipt of [
      { ...base, providerId: 'claude' },
      { ...base, agentSessionId: 'other-session' },
      { ...base, run: { runId: 'other-run' } }
    ]) {
      expect(() => normalizeStoredAgentSession({
        ...session({ kind: 'provider', providerId: 'codex', sessionId: 'native-1' }),
        hookReceipt
      })).toThrowError(expect.objectContaining({
        code: 'INVALID_AGENT_SESSION_STORE',
        message: 'Hook receipt does not match the Agent Session.'
      }))
    }
  })

  it('canonicalizes locator whitespace before persistence', () => {
    const normalized = normalizeStoredAgentSession(session({
      kind: 'provider',
      providerId: ' codex ',
      sessionId: ' native-1 ',
      transcriptPath: ' /tmp/session.jsonl '
    }))
    expect(normalized.nativeHandle).toEqual({
      kind: 'provider',
      providerId: 'codex',
      sessionId: 'native-1',
      transcriptPath: '/tmp/session.jsonl'
    })
  })
})
