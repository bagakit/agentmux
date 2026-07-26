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
import type { AgentTimelineItem } from '../src/types.js'
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

// ---------------------------------------------------------------------------
// f-23q8faabh / T-003：Timeline 落盘改 JSONL 追加。热路径一条 mutation 只追加一行，
// 不整写全文件；加载容忍崩溃撕裂的尾行；越过阈值时 compaction 成单行快照且语义不变。
// ---------------------------------------------------------------------------

describe('timeline JSONL 追加与 compaction', () => {
  function timelineItem(id: string): AgentTimelineItem {
    return {
      id,
      agentSessionId: 'semantic-1',
      kind: 'assistant_message' as const,
      status: 'complete' as const,
      source: 'acp' as const,
      createdAt: 1,
      updatedAt: 1,
      title: `Item ${id}`
    }
  }

  async function timelineFile(path: string): Promise<{ content: string; lines: string[] }> {
    const directory = join(dirname(path), 'agent-timelines')
    const entries = await readdir(directory)
    const file = entries.find((entry) => entry.endsWith('.jsonl'))
    expect(file).toBeDefined()
    const content = await readFile(join(directory, file!), 'utf8')
    return { content, lines: content.split('\n').filter((line) => line !== '') }
  }

  async function timelineFilePath(path: string): Promise<string> {
    const directory = join(dirname(path), 'agent-timelines')
    const entries = await readdir(directory)
    return join(directory, entries.find((entry) => entry.endsWith('.jsonl'))!)
  }

  it('热路径追加一行而不整写：已有内容保持字节级前缀', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-timeline-jsonl-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())
      await store.applyTimelineMutation({
        type: 'append',
        agentSessionId: 'semantic-1',
        item: timelineItem('item-1')
      })
      const afterFirst = await timelineFile(path)
      expect(afterFirst.lines).toHaveLength(1)

      await store.applyTimelineMutation({
        type: 'append',
        agentSessionId: 'semantic-1',
        item: timelineItem('item-2')
      })
      const afterSecond = await timelineFile(path)
      // 全量 rewrite 基线下这里的前缀会被重排；追加路径必须保持旧内容原封不动。
      expect(afterSecond.content.startsWith(afterFirst.content)).toBe(true)
      expect(afterSecond.lines).toHaveLength(2)

      const reopened = await new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-1')
      expect(reopened.revision).toBe(2)
      expect(reopened.items.map((item) => item.id)).toEqual(['item-1', 'item-2'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('崩溃撕裂的尾行被容忍，之前的行照常加载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-timeline-torn-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())
      for (const id of ['item-1', 'item-2', 'item-3']) {
        await store.applyTimelineMutation({
          type: 'append',
          agentSessionId: 'semantic-1',
          item: timelineItem(id)
        })
      }
      const filePath = await timelineFilePath(path)
      const content = await readFile(filePath, 'utf8')
      await writeFile(filePath, content.slice(0, content.length - 12), { mode: 0o600 })

      const reopened = await new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-1')
      expect(reopened.items.map((item) => item.id)).toEqual(['item-1', 'item-2'])
      expect(reopened.revision).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('坏在中间的行是数据损坏，fail-closed 而不是静默丢弃', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-timeline-corrupt-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())
      for (const id of ['item-1', 'item-2', 'item-3']) {
        await store.applyTimelineMutation({
          type: 'append',
          agentSessionId: 'semantic-1',
          item: timelineItem(id)
        })
      }
      const filePath = await timelineFilePath(path)
      const lines = (await readFile(filePath, 'utf8')).split('\n')
      lines[1] = lines[1]!.slice(0, 10)
      await writeFile(filePath, lines.join('\n'), { mode: 0o600 })

      await expect(new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-1'))
        .rejects.toMatchObject({ code: 'INVALID_AGENT_TIMELINE_STORE' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('越过行数阈值触发 compaction：文件收敛为单行快照且语义不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-timeline-compact-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const store = new AgentMuxFileAgentSessionStore(path)
      await store.compareAndSwap(null, storedSession())
      await store.applyTimelineMutation({
        type: 'append',
        agentSessionId: 'semantic-1',
        item: timelineItem('item-1')
      })
      // 快照 1 行 + 256 条追加 mutation：正好到 compaction 阈值边缘。
      for (let step = 1; step <= 256; step += 1) {
        await store.applyTimelineMutation({
          type: 'update',
          agentSessionId: 'semantic-1',
          itemId: 'item-1',
          updatedAt: 1 + step,
          content: `revision ${step}`
        })
      }
      const beforeCompaction = await timelineFile(path)
      expect(beforeCompaction.lines).toHaveLength(257)

      const compacting = await store.applyTimelineMutation({
        type: 'update',
        agentSessionId: 'semantic-1',
        itemId: 'item-1',
        updatedAt: 500,
        content: 'after compaction'
      })
      const afterCompaction = await timelineFile(path)
      expect(afterCompaction.lines).toHaveLength(1)

      const reopened = await new AgentMuxFileAgentSessionStore(path).loadTimeline('semantic-1')
      expect(reopened.revision).toBe(compacting.revision)
      expect(reopened.items).toHaveLength(1)
      expect(reopened.items[0]!.content).toBe('after compaction')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('并发写同一份 store 的锁竞争', () => {
  // 这条守的是「多个 Owner 同时落盘不会有人被饿死」。它曾经真的会：写入改走 durable write
  // （fsync 文件 + fsync 父目录，实测约 10ms/次）之后，持锁时长和当时的定长 10ms 退避成了同一个
  // 量级，所有等待者同步醒来一起抢，形成惊群——并发 60 时约 15% 的写入耗尽重试预算抛 BUSY。
  //
  // 断言落在**可观察结果**（一个都不许失败、每条记录都在）而不是常量值上：把退避改回定长、
  // 或把 durableWriteFile 改慢，这条都会红；而单纯调整常量数值不会误红。
  it('并发落盘不会有人被饿死，也不会互相覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-store-race-'))
    const path = join(root, 'agent-sessions.json')
    try {
      const writers = Array.from({ length: 48 }, () => new AgentMuxFileAgentSessionStore(path))
      // 每个 writer 抢一次 lifecycle reservation：走的是同一把文件锁，但各占各的槽位，互不覆盖。
      const outcomes = await Promise.allSettled(writers.map(async (writer, index) => {
        await writer.reserveLifecycle({
          reservationId: `race-reservation-${index}`,
          ownerId: `race-owner-${index}`,
          ownerPid: process.pid,
          kind: 'create',
          agentSessionId: `race-${index}`,
          operationId: `race-operation-${index}`,
          expiresAt: 4_000_000_000_000
        })
      }))

      const rejected = outcomes.flatMap((outcome) => (
        outcome.status === 'rejected' ? [outcome.reason] : []
      ))
      expect(rejected.map((error) => (error as { code?: string })?.code ?? String(error))).toEqual([])

      // 不只是「没抛错」——每个槽位都得真的落在盘上，证明锁确实轮转过而不是有人被跳过。
      const reader = new AgentMuxFileAgentSessionStore(path)
      const claimed = await reader.claimStaleLifecycles({
        ownerId: 'race-auditor',
        ownerPid: process.pid,
        now: 5_000_000_000_000,
        expiresAt: 5_000_060_000_000
      })
      expect([...claimed.map((entry) => entry.reservationId)].sort()).toEqual(
        writers.map((_writer, index) => `race-reservation-${index}`).sort()
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
