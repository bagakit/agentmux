import { describe, expect, it } from 'vitest'
import {
  MAX_NATIVE_SESSION_ID_BYTES,
  MAX_NATIVE_TRANSCRIPT_PATH_BYTES,
  normalizeNativeSessionId,
  normalizeNativeTranscriptPath
} from '../src/agent-native-locator.js'
import { normalizeStoredAgentSession } from '../src/agent-session-store.js'

// Control characters built by code point so the source carries no raw control bytes and no
// ambiguous backslash escapes: ESC (C0), NEL (C1 low via 0x85), DEL (0x7f), C1 high (0x9f), TAB, LF.
const ESC = String.fromCharCode(0x1b)
const NEL = String.fromCharCode(0x85)
const DEL = String.fromCharCode(0x7f)
const C1_HIGH = String.fromCharCode(0x9f)
const TAB = String.fromCharCode(0x09)
const LF = String.fromCharCode(0x0a)

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
    expect(normalizeNativeSessionId(LF + ' native-1')).toBeUndefined()
    expect(normalizeNativeSessionId('native' + ESC + 'session')).toBeUndefined()
    expect(normalizeNativeSessionId('native' + NEL + 'session')).toBeUndefined()
    expect(normalizeNativeSessionId('x'.repeat(MAX_NATIVE_SESSION_ID_BYTES + 1))).toBeUndefined()
  })

  it('rejects a DEL (0x7f) control byte in a session id and a transcript path', () => {
    // Kills: hasUnsafeControlCharacters' lower C1 bound `code >= 0x7f` widened to `code >= 0x80`,
    // which lets a raw DEL byte (0x7f) through to a native resume argv token or a filesystem path.
    // Existing coverage exercises ESC (0x1b), NEL (0x85) and C1 (0x9f) but never 0x7f -- the exact
    // edge the mutation moves. String#trim() does not strip DEL, so a survivor returns the raw
    // string rather than undefined. Blind spot: this pins only 0x7f, not the rest of the C0/C1 range.
    expect(normalizeNativeSessionId('native' + DEL + 'session')).toBeUndefined()
    expect(normalizeNativeTranscriptPath('/tmp/session' + DEL + '.jsonl')).toBeUndefined()
    // Presence self-check: the same locators WITHOUT the DEL byte normalize, so the rejection above
    // is the control byte itself and not the surrounding shape -- otherwise both halves are vacuous.
    expect(normalizeNativeSessionId('nativesession')).toBe('nativesession')
    expect(normalizeNativeTranscriptPath('/tmp/session.jsonl')).toBe('/tmp/session.jsonl')
  })

  it('normalizes only absolute, bounded transcript paths', () => {
    expect(normalizeNativeTranscriptPath(' /tmp/session.jsonl ')).toBe('/tmp/session.jsonl')
    expect(normalizeNativeTranscriptPath('relative/session.jsonl')).toBeUndefined()
    expect(normalizeNativeTranscriptPath(TAB + '/tmp/session.jsonl')).toBeUndefined()
    expect(normalizeNativeTranscriptPath('/tmp/session' + TAB + '.jsonl')).toBeUndefined()
    expect(normalizeNativeTranscriptPath('/tmp/session' + C1_HIGH + '.jsonl')).toBeUndefined()
    expect(normalizeNativeTranscriptPath('x'.repeat(MAX_NATIVE_TRANSCRIPT_PATH_BYTES + 1))).toBeUndefined()
  })

  it('rejects invalid locators when loading durable Session truth', () => {
    for (const nativeHandle of [
      { kind: 'provider', providerId: 'codex', sessionId: '-looks-like-a-flag' },
      { kind: 'provider', providerId: 'codex', sessionId: 'native' + ESC + 'session' },
      { kind: 'provider', providerId: 'codex', sessionId: 'native-1', transcriptPath: 'relative/session.jsonl' },
      { kind: 'provider', providerId: 'codex', sessionId: 'native-1', transcriptPath: '/tmp/session' + TAB + '.jsonl' },
      { kind: 'acp', adapterId: '-adapter', sessionId: 'acp-1' }
    ]) {
      expect(() => normalizeStoredAgentSession(session(nativeHandle)))
        .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_SESSION_STORE' }))
    }
  })

  it('rejects a native provider locator whose providerId is not the Agent provider', () => {
    // acceptance#3: a well-formed provider locator that names a different provider than the Agent
    // must be refused, not silently persisted. Every other locator case here is codex-to-codex, so
    // this cross-field mismatch was never constructed. The message (not merely the shared code) pins
    // THIS guard: deleting it lets the record normalize cleanly because no other guard inspects
    // nativeHandle.providerId.
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
    // acceptance#2 + objective: the persisted hook receipt is the hook-after update, so it must name
    // the same provider, Agent Session and Run as the record it rides on -- otherwise a stale or
    // foreign hook would corrupt the Session on reload. Each variant violates exactly one arm of the
    // guard, and the message assertion pins this specific guard rather than the code shared across it.
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
