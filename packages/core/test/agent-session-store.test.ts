import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AgentMuxFileAgentSessionStore,
  AgentMuxMemoryAgentSessionStore,
  defaultAgentMuxAgentSessionStorePath,
  loadAgentSessions,
  normalizeStoredAgentSession,
  type AgentMuxAgentSessionStore
} from '../src/agent-session-store.js'
import {
  defaultAgentMuxRuntimeDirectory,
  defaultCtxmuxSocketPath,
  defaultCtxmuxStateDirectory
} from '../src/runtime-paths.js'

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
      readinessSource: 'native-stop' as const,
      readinessId: 'stop-receipt-1',
      readinessOutputCursorBytes: 8,
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
    terminalPromptReadiness: {
      source: 'native-stop' as const,
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
  it('rejects retired File Store schemas without rewriting or migrating them', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-retired-store-')
    try {
      for (const version of [3, 4]) {
        const path = join(root, `sessions-v${version}.json`)
        const retired = `${JSON.stringify({
          version,
          sessions: [],
          reservations: [],
          retiredRuns: [],
          retiredAgentSessions: []
        })}\n`
        await writeFile(path, retired, { mode: 0o600 })
        await expect(new AgentMuxFileAgentSessionStore(path).load())
          .rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
        await expect(readFile(path, 'utf8')).resolves.toBe(retired)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds a user Stop retirement to the exact Agent Session and all of its Runs', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    const current = {
      ...storedSession(),
      retiredRuns: [{ runId: 'daemon-old' }]
    }
    await store.compareAndSwap(null, current)
    const reservation = {
      reservationId: 'stop-reservation',
      ownerId: 'stop-owner',
      ownerPid: process.pid,
      kind: 'stop' as const,
      agentSessionId: current.agentSessionId,
      operationId: 'stop-operation',
      expiresAt: Date.now() + 1_000,
      expectedRun: { ...current.run },
      stopOperation: {
        daemonInstance: 'daemon-instance',
        operationKey: 'stop-operation',
        runId: current.run.runId
      }
    }
    await store.reserveLifecycle(reservation)
    await store.commitLifecycle(reservation, null)

    await expect(store.load()).resolves.toEqual([])
    await expect(store.loadRetiredRuns()).resolves.toEqual([
      { runId: 'daemon-old' },
      { runId: 'daemon-1' }
    ])
    await expect(store.loadRetiredAgentSessions()).resolves.toEqual([
      expect.objectContaining({
        agentSessionId: 'semantic-1',
        hostId: 'local',
        run: { runId: 'daemon-1' },
        source: 'user'
      })
    ])
  })

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
    expect(normalized.terminalPromptReadiness).toEqual(storedSession().terminalPromptReadiness)
    expect(normalized.terminalPromptSubmission).toEqual(storedSession().terminalPromptSubmission)
  })

  it('round-trips the terminal capability unknown/degraded fact and binds it to the current Run', () => {
    const capability = {
      state: 'unknown' as const,
      mode: 'degraded' as const,
      reason: 'handshake-timeout' as const,
      run: { runId: 'daemon-1' },
      observedAt: 200
    }
    const normalized = normalizeStoredAgentSession({
      ...storedSession(),
      terminalCapability: capability
    })
    expect(normalized.terminalCapability).toEqual(capability)
    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalCapability: { ...capability, run: { runId: 'another-run' } }
    })).toThrow('Terminal capability')
    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalCapability: { ...capability, state: 'verified' }
    })).toThrow('Terminal capability')
    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalCapability: { ...capability, observedAt: 201 }
    })).toThrow('Terminal capability state is newer')
  })

  it('round-trips the launch-option posture and fails closed on a malformed selection', async () => {
    // The posture the create fixed must survive persistence so resume can re-resolve the same argv.
    const normalized = normalizeStoredAgentSession({
      ...storedSession(),
      launchOptions: { sandbox: 'read-only', approval: 'never' }
    })
    expect(normalized.launchOptions).toEqual({ sandbox: 'read-only', approval: 'never' })

    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, normalized)
    const reloaded = await loadAgentSessions(store)
    // Assert the round-trip produced exactly the one session before reading it: an empty load would
    // otherwise make the posture assertion below vacuous.
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]!.launchOptions).toEqual({ sandbox: 'read-only', approval: 'never' })

    // A create that narrowed nothing stores no field and resumes on the Provider's own default.
    expect(normalizeStoredAgentSession(storedSession()).launchOptions).toBeUndefined()

    // Fail closed: empty maps and non-string choices never reach a spawn as a posture.
    expect(() => normalizeStoredAgentSession({ ...storedSession(), launchOptions: {} }))
      .toThrow('launchOptions')
    expect(() => normalizeStoredAgentSession({ ...storedSession(), launchOptions: { sandbox: 5 } }))
      .toThrow('launchOptions')
  })

  it('persists semantic status and a recoverable typed interaction response', () => {
    const value = {
      kind: 'permission' as const,
      requestId: 'receipt-1',
      decision: { outcome: 'selected' as const, optionId: 'allow-once' }
    }
    const normalized = normalizeStoredAgentSession({
      ...storedSession(),
      semanticStatus: {
        state: 'waiting',
        source: 'native-hook',
        observedAt: 200,
        detail: 'PermissionRequest'
      },
      pendingInteraction: {
        request: {
          kind: 'permission',
          id: 'receipt-1',
          agentSessionId: 'semantic-1',
          title: 'Allow command?',
          options: [
            { id: 'allow-once', label: 'Allow', kind: 'allow-once' },
            { id: 'reject-once', label: 'Deny', kind: 'reject-once' }
          ],
          evidence: {
            source: 'native-hook',
            observedAt: 200,
            run: { runId: 'daemon-1' },
            hookReceiptId: 'receipt-1'
          }
        },
        response: {
          value,
          responseDigest: createHash('sha256').update(JSON.stringify(value)).digest('base64url'),
          operationId: 'interaction-operation-1',
          inputByteRange: { startByte: 10, endByte: 11 },
          acknowledged: false
        }
      }
    })
    expect(normalized.semanticStatus?.state).toBe('waiting')
    expect(normalized.pendingInteraction?.response?.value).toEqual(value)

    expect(() => normalizeStoredAgentSession({
      ...normalized,
      pendingInteraction: {
        ...normalized.pendingInteraction,
        response: {
          ...normalized.pendingInteraction!.response,
          responseDigest: 'tampered'
        }
      }
    })).toThrow('digest')

    expect(() => normalizeStoredAgentSession({
      ...normalized,
      pendingInteraction: {
        ...normalized.pendingInteraction,
        response: {
          ...normalized.pendingInteraction!.response,
          value: {
            kind: 'permission',
            requestId: 'receipt-1',
            decision: { outcome: 'invented', optionId: 'allow-once' }
          }
        }
      }
    })).toThrow('Permission response is invalid')

    expect(() => normalizeStoredAgentSession({
      ...normalized,
      pendingInteraction: {
        request: {
          ...normalized.pendingInteraction!.request,
          options: [
            { id: 'same', label: 'Allow', kind: 'allow-once' },
            { id: 'same', label: 'Deny', kind: 'reject-once' }
          ]
        }
      }
    })).toThrow('duplicate identifiers')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      pendingInteraction: {
        request: {
          kind: 'question',
          id: 'multi-question',
          agentSessionId: 'semantic-1',
          questions: [
            { id: 'first', prompt: 'First?', options: [{ id: 'a', label: 'A' }] },
            { id: 'second', prompt: 'Second?', options: [{ id: 'b', label: 'B' }] }
          ],
          evidence: {
            source: 'native-hook',
            observedAt: 200,
            run: { runId: 'daemon-1' },
            hookReceiptId: 'receipt-1'
          }
        }
      }
    })).toThrow('Question request is invalid')

    expect(normalizeStoredAgentSession({
      ...normalized,
      hookReceipt: {
        ...normalized.hookReceipt,
        id: 'later-receipt',
        eventName: 'PostToolUse'
      }
    }).pendingInteraction?.request.id).toBe('receipt-1')
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
      terminalPromptReadiness: {
        ...storedSession().terminalPromptReadiness,
        consumedBySubmissionId: 'another-submission'
      }
    })).toThrow('does not identify')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalPromptReadiness: {
        ...storedSession().terminalPromptReadiness,
        source: 'handshake'
      }
    })).toThrow('source is invalid')

    expect(() => normalizeStoredAgentSession({
      ...storedSession(),
      terminalPromptReadiness: {
        source: 'initial-composer',
        id: 'initial-readiness',
        run: { runId: 'daemon-1' },
        outputCursorBytes: 12,
        readyThroughByte: 12
      }
    })).toThrow('does not match its Agent Run boundary')

    const store: AgentMuxAgentSessionStore = {
      async load() { return [storedSession(), storedSession()] },
      async loadRetiredRuns() { return [] },
      async loadRetiredAgentSessions() { return [] },
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

describe('durable session identity root', () => {
  it('round-trips the nativeHandle from a fresh instance and derives agent-timelines from the same root', async () => {
    // Root cause of the reported bug: the nativeHandle (the `claude --resume` / `codex resume` token)
    // must survive a restart. A second instance opened at the same path must read it back intact.
    const root = await mkdtemp(join(tmpdir(), 'agentmux-durable-store-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const writer = new AgentMuxFileAgentSessionStore(path)
      await writer.compareAndSwap(null, storedSession())
      await writer.applyTimelineMutation({
        type: 'append',
        agentSessionId: 'semantic-1',
        item: {
          id: 'timeline-item-1',
          agentSessionId: 'semantic-1',
          kind: 'assistant_message',
          status: 'complete',
          source: 'acp',
          createdAt: 1,
          updatedAt: 1,
          title: 'Must survive restart'
        }
      })

      // A fresh instance simulates the next AgentMux launch reading the persisted identity.
      const reopened = new AgentMuxFileAgentSessionStore(path)
      const sessions = await loadAgentSessions(reopened)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'codex',
        sessionId: 'native-1'
      })

      // agent-timelines derives from dirname(this.path) — one durable root fixes both files.
      const timelineDirectory = join(dirname(path), 'agent-timelines')
      const timelineFiles = await readdir(timelineDirectory)
      expect(timelineFiles.length).toBeGreaterThan(0)
      const reopenedTimeline = await reopened.loadTimeline('semantic-1')
      expect(reopenedTimeline.items.map((item) => item.id)).toEqual(['timeline-item-1'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the ctxmux socket and state in the machine-level runtime temp directory', () => {
    // BOUNDARY: the daemon's socket/state are ephemeral machine-level runtime; moving them would change
    // the daemon adopt path. They must stay under the temp runtime directory, not follow the session file.
    const runtimeDirectory = defaultAgentMuxRuntimeDirectory()
    const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
    expect(runtimeDirectory.startsWith(temporaryRoot)).toBe(true)
    expect(defaultCtxmuxSocketPath().startsWith(runtimeDirectory)).toBe(true)
    expect(defaultCtxmuxStateDirectory().startsWith(runtimeDirectory)).toBe(true)
    // The default (unfixed) session store path is exactly the temp location this task moves off of.
    expect(defaultAgentMuxAgentSessionStorePath().startsWith(runtimeDirectory)).toBe(true)
  })

  it('reads only its own path — no migration, no fallback to the old temp location', async () => {
    // The old temp location's data is deleted by the OS on reboot; reading or dual-writing it would be a
    // compatibility layer for an asset that no longer exists. Plant a session at the exact old temp
    // location (via the runtime-directory override) and prove a fresh durable store never surfaces it.
    const durableRoot = await mkdtemp(join(tmpdir(), 'agentmux-durable-only-'))
    const legacyRuntime = await mkdtemp(join(tmpdir(), 'agentmux-legacy-runtime-'))
    const previousOverride = process.env.AGENTMUX_RUNTIME_DIRECTORY
    process.env.AGENTMUX_RUNTIME_DIRECTORY = legacyRuntime
    try {
      const oldTempPath = defaultAgentMuxAgentSessionStorePath()
      expect(oldTempPath.startsWith(legacyRuntime)).toBe(true)
      const legacy = new AgentMuxFileAgentSessionStore(oldTempPath)
      await legacy.compareAndSwap(null, storedSession())
      await expect(legacy.load()).resolves.toHaveLength(1)

      const durable = new AgentMuxFileAgentSessionStore(join(durableRoot, 'agent-sessions.json'))
      await expect(durable.load()).resolves.toEqual([])
    } finally {
      if (previousOverride === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
      else process.env.AGENTMUX_RUNTIME_DIRECTORY = previousOverride
      await rm(durableRoot, { recursive: true, force: true })
      await rm(legacyRuntime, { recursive: true, force: true })
    }
  })
})
