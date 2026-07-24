import { describe, expect, it } from 'vitest'
import {
  loadSemanticSessions,
  normalizeStoredSemanticSession,
  type AgentMuxSemanticStore
} from '../src/semantic-store.js'

function storedSession() {
  return {
    kind: 'agent' as const,
    semanticSessionId: 'semantic-1',
    agentId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    daemonSession: { sessionId: 'daemon-1', incarnationId: 'incarnation-1' },
    outputCursor: 12,
    createdAt: 100,
    updatedAt: 200,
    nativeHandle: {
      kind: 'provider' as const,
      providerId: 'codex',
      sessionId: 'native-1'
    },
    hookReceipt: {
      id: 'receipt-1',
      agentId: 'codex',
      semanticSessionId: 'semantic-1',
      daemonSession: { sessionId: 'daemon-1', incarnationId: 'incarnation-1' },
      eventName: 'SessionStart',
      observedAt: 200
    }
  }
}

describe('semantic session persistence boundary', () => {
  it('selects only semantic identity, run reference, native handle, receipt, and cursor fields', () => {
    const normalized = normalizeStoredSemanticSession({
      ...storedSession(),
      pid: 123,
      terminalSnapshot: 'secret terminal bytes',
      replay: ['unbounded']
    }) as unknown as Record<string, unknown>
    expect(normalized.pid).toBeUndefined()
    expect(normalized.terminalSnapshot).toBeUndefined()
    expect(normalized.replay).toBeUndefined()
  })

  it('rejects mismatched receipts and duplicate semantic identities', async () => {
    expect(() => normalizeStoredSemanticSession({
      ...storedSession(),
      hookReceipt: {
        ...storedSession().hookReceipt,
        daemonSession: { sessionId: 'another-run', incarnationId: 'incarnation-1' }
      }
    })).toThrow('does not match')

    const store: AgentMuxSemanticStore = {
      async load() { return [storedSession(), storedSession()] },
      async put() {},
      async delete() {}
    }
    await expect(loadSemanticSessions(store)).rejects.toMatchObject({ code: 'INVALID_SEMANTIC_STORE' })
  })
})
