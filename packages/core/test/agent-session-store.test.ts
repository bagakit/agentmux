import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgentMuxFileAgentSessionStore,
  loadAgentSessions,
  normalizeStoredAgentSession,
  type AgentMuxAgentSessionStore
} from '../src/agent-session-store.js'

function storedSession() {
  return {
    kind: 'agent' as const,
    agentSessionId: 'semantic-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    run: { runId: 'daemon-1' },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',
    outputCursorBytes: 12,
    createdAt: 100,
    updatedAt: 200,
    terminalHandshake: {
      run: { runId: 'daemon-1' },
      operationId: 'terminal-handshake-1',
      inputByteRange: { startByte: 0, endByte: 5 },
      acknowledged: true
    },
    terminalPromptSubmission: {
      run: { runId: 'daemon-1' },
      submissionId: 'prompt-submit-1',
      promptDigest: 'prompt-digest-1',
      stopReceiptId: 'stop-receipt-1',
      stopOutputCursorBytes: 8,
      readyThroughByte: 12,
      outputCursorBytes: 12,
      payload: {
        operationId: 'prompt-payload-1',
        inputByteRange: { startByte: 5, endByte: 9 },
        acknowledged: true
      },
      submit: {
        operationId: 'prompt-submit-phase-1',
        inputByteRange: { startByte: 9, endByte: 10 },
        acknowledged: true
      }
    },
    terminalStopReceipt: {
      id: 'stop-receipt-1',
      run: { runId: 'daemon-1' },
      outputCursorBytes: 8,
      readyThroughByte: 12,
      consumedBySubmissionId: 'prompt-submit-1'
    },
    nativeHandle: {
      kind: 'provider' as const,
      providerId: 'codex',
      sessionId: 'native-1'
    },
    hookReceipt: {
      id: 'receipt-1',
      providerId: 'codex',
      agentSessionId: 'semantic-1',
      run: { runId: 'daemon-1' },
      eventName: 'SessionStart',
      observedAt: 200
    }
  }
}

describe('semantic session persistence boundary', () => {
  it('selects only semantic identity, run reference, native handle, receipt, and cursor fields', () => {
    const normalized = normalizeStoredAgentSession({
      ...storedSession(),
      pid: 123,
      terminalSnapshot: 'secret terminal bytes',
      replay: ['unbounded']
    }) as unknown as Record<string, unknown>
    expect(normalized.pid).toBeUndefined()
    expect(normalized.terminalSnapshot).toBeUndefined()
    expect(normalized.replay).toBeUndefined()
    expect(normalized.terminalHandshake).toEqual(storedSession().terminalHandshake)
    expect(normalized.terminalPromptSubmission).toEqual(storedSession().terminalPromptSubmission)
  })

  it('rejects mismatched receipts and duplicate semantic identities', async () => {
    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      run: { runId: 'daemon-1', generation: 'retired-identity' }
    })).toThrow('only runId')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalHandshake: {
        ...storedSession().terminalHandshake,
        run: { runId: 'another-run' }
      }
    })).toThrow('does not match')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      hookReceipt: {
        ...storedSession().hookReceipt,
        run: { runId: 'another-run' }
      }
    })).toThrow('does not match')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalStopReceipt: {
        ...storedSession().terminalStopReceipt,
        consumedBySubmissionId: 'another-submission'
      }
    })).toThrow('does not identify')

    const store: AgentMuxAgentSessionStore = {
      async load() { return [storedSession(), storedSession()] },
      async loadRetiredRuns() { return [] },
      async compareAndSwap() {},
      async reserveLifecycle() {},
      async claimStaleLifecycles() { return [] },
      async releaseLifecycle() {},
      async retireRuns() {},
      async commitLifecycle() {},
      async loadTimeline(agentSessionId) {
        return { agentSessionId, revision: 0, items: [] }
      },
      async applyTimelineMutation(mutation) {
        return {
          agentSessionId: mutation.agentSessionId,
          revision: 0,
          changed: false,
          mutation
        }
      }
    }
    await expect(loadAgentSessions(store)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
  })

  it('does not commit a Timeline mutation after an aborted lock wait', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-store-abort-')
    const path = join(root, 'sessions.json')
    try {
      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())
      await writeFile(`${path}.lock`, `${process.pid}\n`, { mode: 0o600 })
      const controller = new AbortController()
      const pending = store.applyTimelineMutation(
        {
          type: 'append',
          agentSessionId: 'semantic-1',
          item: {
            id: 'late-item',
            agentSessionId: 'semantic-1',
            kind: 'assistant_message',
            status: 'complete',
            source: 'acp',
            createdAt: 1,
            updatedAt: 1,
            title: 'Must not commit'
          }
        },
        controller.signal
      )
      setTimeout(() => controller.abort(), 20)

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await unlink(`${path}.lock`)
      await new Promise((resolve) => setTimeout(resolve, 40))
      await expect(new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-1'))
        .resolves.toEqual({ agentSessionId: 'semantic-1', revision: 0, items: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not commit a Session write after an aborted lock wait', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-store-abort-')
    const path = join(root, 'sessions.json')
    try {
      await writeFile(`${path}.lock`, `${process.pid}\n`, { mode: 0o600 })
      const controller = new AbortController()
      const pending = new AgentMuxFileAgentSessionStore(path).compareAndSwap(
        null,
        storedSession(),
        controller.signal
      )
      setTimeout(() => controller.abort(), 20)

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
