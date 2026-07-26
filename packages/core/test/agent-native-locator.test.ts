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
