import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../../src/agent-session-store.js'
import { defaultAgentMuxHookPort } from '../../src/runtime-paths.js'
import { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentNativeSessionHandle } from '../../src/types.js'

type DroidFixtureOptions = {
  sessionId?: string
  transcriptPath?: string
}

const fixtures: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})

const jsonl = (values: unknown[]) => values.map((value) => JSON.stringify(value)).join('\n') + '\n'

async function createDroidTestFixture(
  data: string | Buffer,
  options: DroidFixtureOptions = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-droid-history-'))
  const sessionId = options.sessionId ?? '00000000-0000-4000-8000-000000000001'
  const path = options.transcriptPath ?? join(root, `${sessionId}.jsonl`)
  await writeFile(path, data)
  const storePath = join(root, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId: 'droid-agent-session-1',
    providerId: 'droid',
    executorId: 'droid',
    hostId: 'local',
    workspacePath: root,
    run: { runId: 'healthy-droid-live-run' },
    retiredRuns: [],
    createdAt: 1000,
    updatedAt: 1000,
    hookBindingId: 'droid-binding',
    hookToken: 'droid-token',
    nativeHandle: {
      kind: 'provider',
      providerId: 'droid',
      sessionId,
      transcriptPath: path
    }
  }
  await store.compareAndSwap(null, session)
  const before = {
    native: await readFile(path),
    store: await readFile(storePath)
  }

  const physicalReads: Array<Promise<readonly unknown[]>> = []
  const read = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => {
    const reading = read()
    physicalReads.push(reading)
    return reading
  })

  const client = new AgentMuxClient({ store })
  const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) =>
    vi.spyOn(kernel, name as 'start')
  )

  const fixture = {
    root,
    path,
    storePath,
    store,
    session,
    client,
    controls,
    before,
    bytes: async () => ({
      native: await readFile(path),
      store: await readFile(storePath)
    }),
    close: async () => {
      await client.dispose()
      await Promise.allSettled(physicalReads)
      await rm(root, { recursive: true, force: true })
    }
  }
  fixtures.push(fixture)
  return fixture
}

describe('Droid session analysis and native history', () => {
  it('exports readSessionHistoryPage on Droid provider in registry', () => {
    const providers = new AgentProviderRegistry()
    const droid = providers.get('droid')
    expect(droid.readSessionHistoryPage).toBeTypeOf('function')
  })

  it('reads exact source-derived native fixture with ordered trace and correct item kinds', async () => {
    const fixturePath = join(__dirname, 'droid-fixtures', 'source-derived-native-session.jsonl')
    const rawFixture = await readFile(fixturePath)
    const sessionId = '00000000-0000-4000-8000-000000000001'

    const f = await createDroidTestFixture(rawFixture, { sessionId })
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId)

    expect(page.source).toEqual({ providerId: 'droid', nativeSessionId: sessionId })
    expect(page.items.length).toBe(10)

    // Expected kinds matching fixture-meaning.json oracle:
    // 0: session_start -> activity
    // 1: user-1 -> user-message
    // 2: assistant-1 -> assistant-message
    // 3: tool-1 (user role with tool_result) -> activity
    // 4: hook-1 (visibility: user_only) -> activity
    // 5: injection-1 (visibility: llm_only) -> activity
    // 6: assistant-2 -> assistant-message
    // 7: agent_turn_outcome -> activity
    // 8: document-1 -> user-message
    // 9: compaction_state -> activity
    const expectedKinds = [
      'activity',
      'user-message',
      'assistant-message',
      'activity',
      'activity',
      'activity',
      'assistant-message',
      'activity',
      'user-message',
      'activity'
    ]
    expect(page.items.map((i) => i.kind)).toEqual(expectedKinds)

    // 0: session_start
    const sessionStart = page.items[0]!
    expect(sessionStart.title).toBe('Droid session start')
    expect(sessionStart.contentParts).toEqual([
      { kind: 'text', text: 'Session started: Source-derived session fixture' }
    ])

    // 1: user-1 (genuine human speech)
    const userMsg = page.items[1]!
    expect(userMsg.id).toBe('user-1')
    expect(userMsg.kind).toBe('user-message')
    expect(userMsg.contentParts).toEqual([
      { kind: 'text', text: 'Inspect the build' }
    ])

    // 2: assistant-1 (text + thinking + thinking metadata + tool_use)
    const assistantMsg = page.items[2]!
    expect(assistantMsg.id).toBe('assistant-1')
    expect(assistantMsg.kind).toBe('assistant-message')
    expect(assistantMsg.contentParts).toEqual([
      { kind: 'text', text: 'I will inspect the build.' },
      { kind: 'reasoning', text: 'Read the build output first.' },
      { kind: 'text', text: JSON.stringify({ signature: '', signatureProvider: 'google' }) },
      { kind: 'tool-call', name: 'Execute', input: JSON.stringify({ command: 'pnpm test' }), callId: 'call-1' }
    ])

    // 3: tool-1 (native disk compressed non-assistant role to user, but contains tool_result)
    const toolMsg = page.items[3]!
    expect(toolMsg.id).toBe('tool-1')
    expect(toolMsg.kind).toBe('activity')
    expect(toolMsg.title).toBe('Droid tool result')
    expect(toolMsg.contentParts).toEqual([
      { kind: 'tool-result', output: 'One test failed.', callId: 'call-1', failed: true },
      { kind: 'resource', resourceType: 'image', reference: 'data:image/png;base64,iVBORw==' }
    ])

    // 4: hook-1 (visibility: user_only, empty content, PostToolUse audit results)
    const hookMsg = page.items[4]!
    expect(hookMsg.id).toBe('hook-1')
    expect(hookMsg.kind).toBe('activity')
    expect(hookMsg.title).toBe('Droid hook · PostToolUse')
    expect(hookMsg.contentParts.length).toBeGreaterThan(0)
    expect((hookMsg.contentParts[0] as { text: string }).text).toContain('audit output')

    // 5: injection-1 (visibility: llm_only, automated injected context)
    const injectMsg = page.items[5]!
    expect(injectMsg.id).toBe('injection-1')
    expect(injectMsg.kind).toBe('activity')
    expect(injectMsg.title).toBe('Droid injected context')
    expect(injectMsg.contentParts).toEqual([
      { kind: 'text', text: 'Provider injected context' }
    ])

    // 6: assistant-2 (chatCompletionReasoningContent + text speech)
    const assistant2 = page.items[6]!
    expect(assistant2.id).toBe('assistant-2')
    expect(assistant2.kind).toBe('assistant-message')
    expect(assistant2.contentParts).toEqual([
      { kind: 'reasoning', text: 'Inspect the assertion.' },
      { kind: 'text', text: 'The test failed.' }
    ])

    // 7: agent_turn_outcome
    const outcomeMsg = page.items[7]!
    expect(outcomeMsg.kind).toBe('activity')
    expect(outcomeMsg.title).toBe('Droid turn outcome')
    expect(outcomeMsg.turnId).toBe('user-1')
    expect(outcomeMsg.contentParts).toEqual([
      { kind: 'text', text: 'Outcome: completed' },
      { kind: 'text', text: JSON.stringify({ resultKind: 'text' }, null, 2) }
    ])

    // 8: document-1 (user-message with document attachment containing parsed text and file resource)
    const docMsg = page.items[8]!
    expect(docMsg.id).toBe('document-1')
    expect(docMsg.kind).toBe('user-message')
    expect(docMsg.contentParts).toEqual([
      { kind: 'text', text: 'Parsed document excerpt' },
      { kind: 'resource', resourceType: 'file', reference: '/fixture/report.pdf', label: 'report.pdf' }
    ])

    // 9: compaction_state
    const compactMsg = page.items[9]!
    expect(compactMsg.id).toBe('compact-1')
    expect(compactMsg.kind).toBe('activity')
    expect(compactMsg.title).toBe('Droid compaction')
    expect(compactMsg.contentParts).toEqual([
      { kind: 'text', text: 'Native summary' }
    ])

    // Zero Run controls called
    for (const control of f.controls) {
      expect(control).not.toHaveBeenCalled()
    }

    // Bytes untouched
    const currentBytes = await f.bytes()
    expect(currentBytes.native).toEqual(f.before.native)
    expect(currentBytes.store).toEqual(f.before.store)
  })

  describe('Negative fixtures and boundary validation', () => {
    it('rejects transcript missing required native session_start header', async () => {
      const sessionId = 'droid-missing-header'
      // First line is a message instead of session_start
      const records = [
        { type: 'message', id: 'msg-1', timestamp: '2026-10-02T00:00:00.000Z', message: { role: 'user', content: 'hello' } }
      ]

      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
    })

    it('rejects transcript with foreign session_start id', async () => {
      const records = [
        { type: 'session_start', id: 'other-session-uuid', title: 'Foreign' },
        { type: 'message', id: 'msg-1', timestamp: '2026-10-02T00:00:00.000Z', message: { role: 'user', content: 'hello' } }
      ]

      const f = await createDroidTestFixture(jsonl(records), { sessionId: 'my-expected-session-id' })
      await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
    })

    it('keeps messages with missing or unexpected nested role as neutral activity', async () => {
      const sessionId = 'droid-missing-role'
      const records = [
        { type: 'session_start', id: sessionId, title: 'No role test' },
        { type: 'message', id: 'msg-norole', timestamp: '2026-10-02T00:00:00.000Z', message: { content: 'Where is the role?' } }
      ]

      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)

      expect(page.items.length).toBe(2)
      const noRoleItem = page.items[1]!
      expect(noRoleItem.kind).toBe('activity')
      expect(noRoleItem.title).toBe('Droid message')
    })

    it('preserves flat stream-only rows as neutral activity without role or completion inference', async () => {
      const sessionId = 'droid-flat-rows'
      const records = [
        { type: 'session_start', id: sessionId, title: 'Flat rows' },
        { type: 'completion', finalText: 'Exec stdout completion', usage: { input_tokens: 10, output_tokens: 5 } },
        { type: 'system', model: 'claude-3-5-sonnet', cwd: '/repo' }
      ]

      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)

      expect(page.items.length).toBe(3)
      // Both should be neutral activities, NOT assistant messages
      expect(page.items[1]!.kind).toBe('activity')
      expect(page.items[2]!.kind).toBe('activity')
    })

    it('rejects when durable transcript locator path is unavailable', async () => {
      const sessionId = 'droid-missing-loc'
      const records = [{ type: 'session_start', id: sessionId, title: 'Test' }]
      const f = await createDroidTestFixture(jsonl(records), { sessionId })

      const session = (await loadAgentSessions(f.store))[0]!
      await f.store.compareAndSwap(session, {
        ...session,
        updatedAt: 2000,
        nativeHandle: { kind: 'provider', providerId: 'droid', sessionId }
      })

      await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE'
      })
    })

    it('excludes partial trailing append without failure', async () => {
      const sessionId = 'droid-partial-tail'
      const complete = jsonl([
        { type: 'session_start', id: sessionId, title: 'Tail test' },
        { type: 'message', id: 'msg-1', timestamp: '2026-10-02T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'complete message' }] } }
      ])
      const brokenData = Buffer.concat([
        Buffer.from(complete),
        Buffer.from('{"type":"message","id":"msg-partial","message":{"role":"assistant')
      ])

      const f = await createDroidTestFixture(brokenData, { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)

      expect(page.items.length).toBe(2)
      expect(page.items[1]!.kind).toBe('user-message')
    })

    it('exceeding byte budget rejects with AGENT_SESSION_HISTORY_TOO_LARGE', async () => {
      const sessionId = 'droid-large'
      const largeText = 'A'.repeat(150 * 1024)
      const records: Record<string, unknown>[] = Array.from({ length: 35 }, (_, i) => ({
        type: 'message',
        id: `large-${i}`,
        timestamp: '2026-10-02T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: largeText }]
        }
      }))
      records.unshift({ type: 'session_start', id: sessionId, title: 'Large test' })

      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
      })
    })
  })

  describe('Paging and client recovery', () => {
    it('paginates backwards without gaps or duplicated items', async () => {
      const sessionId = 'droid-session-paged'
      const records: Record<string, unknown>[] = Array.from({ length: 7 }, (_, i) => ({
        type: 'message',
        id: `msg-${i}`,
        timestamp: `2026-10-02T00:0${i}:00.000Z`,
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: `Turn ${i} content` }]
        }
      }))
      records.unshift({
        type: 'session_start',
        id: sessionId,
        title: 'Paged task',
        cwd: '/repo',
        timestamp: '2026-10-02T00:00:00.000Z'
      })

      const f = await createDroidTestFixture(jsonl(records), { sessionId })

      // Page 1: newest 3 items
      const page1 = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 3 })
      expect(page1.items.length).toBe(3)
      expect(page1.items.map((i) => i.id)).toEqual(['msg-4', 'msg-5', 'msg-6'])
      expect(page1.nextCursor).not.toBeNull()

      // Page 2: next 3 items
      const page2 = await f.client.sessionHistoryPage(f.session.agentSessionId, {
        limit: 3,
        cursor: page1.nextCursor!
      })
      expect(page2.items.length).toBe(3)
      expect(page2.items.map((i) => i.id)).toEqual(['msg-1', 'msg-2', 'msg-3'])
      expect(page2.nextCursor).not.toBeNull()

      // Page 3: remaining items (msg-0 and session_start)
      const page3 = await f.client.sessionHistoryPage(f.session.agentSessionId, {
        limit: 3,
        cursor: page2.nextCursor!
      })
      expect(page3.items.length).toBe(2)
      expect(page3.items.map((i) => i.id)).toEqual(['droid-session-start:0', 'msg-0'])
      expect(page3.nextCursor).toBeNull()

      const allIds = [
        ...page3.items.map((i) => i.id),
        ...page2.items.map((i) => i.id),
        ...page1.items.map((i) => i.id)
      ]
      expect(new Set(allIds).size).toBe(8)
    })

    it('recovers identically on a fresh AgentMuxClient instance without store modification', async () => {
      const sessionId = 'droid-fresh-client'
      const records = [
        { type: 'session_start', id: sessionId, title: 'Recovery', timestamp: '2026-10-02T00:00:00.000Z' },
        { type: 'message', id: 'msg-u', timestamp: '2026-10-02T00:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Persisted turn' }] } },
        { type: 'message', id: 'msg-a', timestamp: '2026-10-02T00:00:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Persisted answer' }] } }
      ]

      const f = await createDroidTestFixture(jsonl(records), { sessionId })

      const firstResult = await f.client.sessionHistoryPage(f.session.agentSessionId)
      expect(firstResult.items.length).toBe(3)

      const freshClient = new AgentMuxClient({ store: f.store })
      try {
        const secondResult = await freshClient.sessionHistoryPage(f.session.agentSessionId)
        expect(secondResult).toEqual(firstResult)
      } finally {
        await freshClient.dispose()
      }
    })

    it('proves production Hook SessionStart normalization to durable handle and client read', async () => {
      const root = await mkdtemp(join(tmpdir(), 'agentmux-droid-hook-prod-'))
      const sessionId = '00000000-0000-4000-8000-000000000001'
      const transcriptPath = join(root, `${sessionId}.jsonl`)
      const fixtureSource = join(__dirname, 'droid-fixtures', 'source-derived-native-session.jsonl')
      await writeFile(transcriptPath, await readFile(fixtureSource))

      const providers = new AgentProviderRegistry()
      const droid = providers.get('droid')

      // Normalize a native SessionStart hook payload as emitted by Droid CLI
      const normalized = droid.normalizeHook({
        receiptId: 'r-start',
        agentSessionId: 'prod-session-1',
        runId: 'prod-run-1',
        providerId: 'droid',
        eventName: 'SessionStart',
        payload: {
          hook_event_name: 'SessionStart',
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: '/fixture/workspace'
        }
      }, {})

      expect(normalized.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'droid',
        sessionId,
        transcriptPath
      })

      if (!normalized.nativeHandle) {
        throw new Error('Expected normalized native handle to be present for main SessionStart')
      }
      const nativeHandle: AgentNativeSessionHandle = normalized.nativeHandle

      // Store in durable FileStore and query via public AgentMuxClient
      const storePath = join(root, 'agent-sessions.json')
      const store = new AgentMuxFileAgentSessionStore(storePath)
      const session: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId: 'prod-session-1',
        providerId: 'droid',
        executorId: 'droid',
        hostId: 'local',
        workspacePath: root,
        run: { runId: 'prod-run-1' },
        retiredRuns: [],
        createdAt: 1000,
        updatedAt: 1000,
        hookBindingId: 'prod-binding',
        hookToken: 'prod-token',
        nativeHandle
      }
      await store.compareAndSwap(null, session)

      const client = new AgentMuxClient({ store })
      try {
        const history = await client.sessionHistoryPage('prod-session-1')
        expect(history.items.length).toBe(10)
        expect(history.items[1]!.kind).toBe('user-message')
        expect(history.items[2]!.kind).toBe('assistant-message')
      } finally {
        await client.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })

    it('proves public connect, authenticated HTTP hook dispatch, cancellation vs ordinary notification, and child identity isolation', async () => {
      const root = await mkdtemp(join(tmpdir(), 'agentmux-droid-http-'))
      const mainSessionId = '00000000-0000-4000-8000-000000000001'
      const transcriptPath = join(root, `${mainSessionId}.jsonl`)
      const fixtureSource = join(__dirname, 'droid-fixtures', 'source-derived-native-session.jsonl')
      await writeFile(transcriptPath, await readFile(fixtureSource))

      const agentSessionId = 'http-droid-session'
      const runId = 'http-droid-run'
      const token = 'droid-token-'.padEnd(43, 'x')
      const storePath = join(root, 'agent-sessions.json')
      const store = new AgentMuxFileAgentSessionStore(storePath)

      const initialSession: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId,
        providerId: 'droid',
        executorId: 'droid',
        hostId: 'local',
        workspacePath: root,
        run: { runId },
        retiredRuns: [],
        createdAt: 1000,
        updatedAt: 1000,
        hookBindingId: 'b'.repeat(43),
        hookToken: token
      }
      await store.compareAndSwap(null, initialSession)

      vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
      vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'queue.ndjson'))

      const run = {
        id: runId,
        spec: { program: 'droid', args: [], cwd: root, env: {} },
        lineage: null,
        pid: 999,
        state: { type: 'running' as const },
        latest_output_bytes: 4200,
        durable_output_bytes: 4200,
        first_available_byte: 0,
        attachments: 0,
        applied_input_bytes: 0,
        current_size: { cols: 80, rows: 24 }
      }

      const status = vi.fn(async (id: string) => {
        expect(id).toBe(runId)
        return run
      })
      const create = vi.fn(async () => { throw new Error('Unexpected Run creation') })
      const input = vi.fn(async () => { throw new Error('Unexpected Agent input') })
      const stop = vi.fn(async () => { throw new Error('Unexpected Run stop') })

      const adapter = new CtxmuxRunAdapter()
      Object.assign(adapter, {
        client: { list: async () => [{ id: runId }], status, start: create, input, stop },
        runtime: { daemonInstanceId: 'synthetic-daemon' }
      })

      const providers = new AgentProviderRegistry()
      const client = new AgentMuxClient({ store, providers: [providers.get('droid')] })
      Object.assign(client, { kernel: adapter })

      let receipts = 0
      const feed = async (eventName: string, payload: Record<string, unknown>, badToken = false) => {
        const port = defaultAgentMuxHookPort()
        const res = await fetch(`http://127.0.0.1:${port}/v1/events`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${badToken ? 'bad-token' : token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ receiptId: `receipt-${++receipts}`, eventName, payload })
        })
        return res.status
      }

      try {
        await client.connect()

        // 1. Unauthenticated event rejected
        expect(await feed('SessionStart', { hook_event_name: 'SessionStart' }, true)).toBe(403)

        // 2. Main SessionStart promotes nativeHandle to durable store
        const startStatus = await feed('SessionStart', {
          hook_event_name: 'SessionStart',
          session_id: mainSessionId,
          transcript_path: transcriptPath,
          cwd: root
        })
        expect(startStatus).toBe(204)

        const afterStart = (await loadAgentSessions(store))[0]!
        expect(afterStart.nativeHandle).toEqual({
          kind: 'provider',
          providerId: 'droid',
          sessionId: mainSessionId,
          transcriptPath
        })
        expect(afterStart.semanticStatus?.state).toBe('working')

        // 3. Child SessionStart with calling_session_id does NOT replace main nativeHandle
        const childStatus = await feed('SessionStart', {
          hook_event_name: 'SessionStart',
          calling_session_id: mainSessionId,
          session_id: 'child-session-999',
          transcript_path: '/tmp/child.jsonl',
          cwd: root
        })
        expect(childStatus).toBe(204)

        const afterChild = (await loadAgentSessions(store))[0]!
        // Verified child fence: nativeHandle remains the main session's identity
        expect(afterChild.nativeHandle).toEqual({
          kind: 'provider',
          providerId: 'droid',
          sessionId: mainSessionId,
          transcriptPath
        })

        // 4. Ordinary Notification (e.g. permission) leaves lifecycleEvent undefined and does NOT mark done
        const ordinaryStatus = await feed('Notification', {
          hook_event_name: 'Notification',
          notification_type: 'permission',
          message: 'Permission required'
        })
        expect(ordinaryStatus).toBe(204)

        const afterOrdinary = (await loadAgentSessions(store))[0]!
        expect(afterOrdinary.hookReceipt?.lifecycleEvent).toBeUndefined()
        expect(afterOrdinary.semanticStatus?.state).not.toBe('done')

        // 5. Predecision Stop sets lifecycleEvent: null, state is NOT done, no prompt readiness
        const stopStatus = await feed('Stop', {
          hook_event_name: 'Stop',
          stop_hook_active: false
        })
        expect(stopStatus).toBe(204)
        const afterStop = (await loadAgentSessions(store))[0]!
        expect(afterStop.semanticStatus?.state).not.toBe('done')
        expect(afterStop.hookReceipt?.lifecycleEvent).toBeNull()
        expect(afterStop.terminalPromptReadiness).toBeUndefined()

        // 随后真实支持的 working event (e.g. PreToolUse) 可以继续更新同一个 Session
        const nextWorkStatus = await feed('PreToolUse', {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'echo 1' }
        })
        expect(nextWorkStatus).toBe(204)
        const afterWork = (await loadAgentSessions(store))[0]!
        expect(afterWork.semanticStatus?.state).toBe('working')

        // 6. Cancellation Notification (idle_prompt) sets lifecycleEvent to turn-end and does NOT mark done
        status.mockClear()
        const cancelStatus = await feed('Notification', {
          hook_event_name: 'Notification',
          notification_type: 'idle_prompt',
          message: 'Waiting for input after cancellation'
        })
        expect(cancelStatus).toBe(204)
        expect(status).toHaveBeenCalledExactlyOnceWith(runId)

        const afterCancel = (await loadAgentSessions(store))[0]!
        expect(afterCancel.hookReceipt?.lifecycleEvent).toBe('turn-end')
        expect(afterCancel.hookReceipt?.outputCursorBytes).toBe(4200)
        // Honest cancellation: NOT fake done or automatic success
        expect(afterCancel.semanticStatus?.state).not.toBe('done')

        // 7. Fresh AgentMuxClient recovers durable session and reads exact native history
        const freshClient = new AgentMuxClient({ store })
        try {
          const page = await freshClient.sessionHistoryPage(agentSessionId)
          expect(page.items.length).toBe(10)
          expect(page.items[1]!.kind).toBe('user-message')
          expect(page.items[2]!.kind).toBe('assistant-message')
        } finally {
          await freshClient.dispose()
        }

        // 8. Verify zero kernel Run controls were invoked during reading
        expect(create).not.toHaveBeenCalled()
        expect(input).not.toHaveBeenCalled()
        expect(stop).not.toHaveBeenCalled()
      } finally {
        await client.dispose()
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  describe('First-party current Droid producer schema invariants (D1-D4)', () => {
    it('preserves ordered text/image/text within a native tool result without reordering (D1)', async () => {
      const sessionId = '00000000-0000-4000-8000-000000000901'
      const records = [
        { type: 'session_start', id: sessionId, title: 'Ordered tool test' },
        {
          type: 'message',
          id: 'owner-message',
          seq: 1,
          timestamp: '2026-10-02T01:00:00.000Z',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'ordered-tool',
              is_error: true,
              content: [
                { type: 'text', text: 'OWNER_FIRST_TEXT' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'T1dORVJfTUlERExFX0lNQUdF' } },
                { type: 'text', text: 'OWNER_LAST_TEXT' }
              ]
            }]
          }
        }
      ]
      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
      const projected = JSON.stringify(page.items)
      const first = projected.indexOf('OWNER_FIRST_TEXT')
      const image = projected.indexOf('T1dORVJfTUlERExFX0lNQUdF')
      const last = projected.indexOf('OWNER_LAST_TEXT')
      expect(first).toBeGreaterThan(-1)
      expect(image).toBeGreaterThan(first)
      expect(last).toBeGreaterThan(image)
      expect(page.items.flatMap((item) => item.contentParts).some((part) => part.kind === 'tool-result' && part.failed === true)).toBe(true)
    })

    it('retains original source.data base64 data URI for unparsed PDF without source.path (D1)', async () => {
      const sessionId = '00000000-0000-4000-8000-000000000901'
      const base64Pdf = 'JVBERi0xLjQKdW5wYXJzZWQ='
      const records = [
        { type: 'session_start', id: sessionId, title: 'Unparsed PDF' },
        {
          type: 'message',
          id: 'unparsed-pdf-msg',
          seq: 1,
          timestamp: '2026-10-02T01:00:00.000Z',
          message: {
            role: 'user',
            content: [{
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64Pdf,
                name: 'unparsed.pdf'
              }
            }]
          }
        }
      ]
      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
      const docItem = page.items[1]!
      expect(docItem.contentParts).toEqual([
        {
          kind: 'resource',
          resourceType: 'file',
          reference: `data:application/pdf;base64,${base64Pdf}`,
          label: 'unparsed.pdf'
        }
      ])
    })

    it('retains parsed_data as text and source.data as base64 data URI for parsed PDF without source.path (D1)', async () => {
      const sessionId = '00000000-0000-4000-8000-000000000901'
      const base64Pdf = 'JVBERi0xLjQKcGFyc2Vk'
      const records = [
        { type: 'session_start', id: sessionId, title: 'Parsed PDF' },
        {
          type: 'message',
          id: 'parsed-pdf-msg',
          seq: 1,
          timestamp: '2026-10-02T01:00:00.000Z',
          message: {
            role: 'user',
            content: [{
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64Pdf,
                parsed_data: 'Extracted PDF text body',
                name: 'parsed.pdf'
              }
            }]
          }
        }
      ]
      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
      const docItem = page.items[1]!
      expect(docItem.contentParts).toEqual([
        { kind: 'text', text: 'Extracted PDF text body' },
        {
          kind: 'resource',
          resourceType: 'file',
          reference: `data:application/pdf;base64,${base64Pdf}`,
          label: 'parsed.pdf'
        }
      ])
    })

    it('processes document appearing within tool_result in arrival order via same projection (D1)', async () => {
      const sessionId = '00000000-0000-4000-8000-000000000901'
      const base64Pdf = 'JVBERi0xLjQKZG9j'
      const records = [
        { type: 'session_start', id: sessionId, title: 'Document in tool' },
        {
          type: 'message',
          id: 'tool-with-doc',
          seq: 1,
          timestamp: '2026-10-02T01:00:00.000Z',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'call-doc',
              content: [
                { type: 'text', text: 'Prefix output' },
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: base64Pdf,
                    parsed_data: 'Document inside tool',
                    name: 'tool-doc.pdf'
                  }
                },
                { type: 'text', text: 'Suffix output' }
              ]
            }]
          }
        }
      ]
      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
      const toolItem = page.items[1]!
      expect(toolItem.contentParts).toEqual([
        { kind: 'tool-result', output: 'Prefix output', callId: 'call-doc' },
        { kind: 'tool-result', output: 'Document inside tool', callId: 'call-doc' },
        {
          kind: 'resource',
          resourceType: 'file',
          reference: `data:application/pdf;base64,${base64Pdf}`,
          label: 'tool-doc.pdf'
        },
        { kind: 'tool-result', output: 'Suffix output', callId: 'call-doc' }
      ])
    })

    it('retains text/plain document source.data and inline resource with name as label rather than filename only (D2)', async () => {
      const sessionId = '00000000-0000-4000-8000-000000000901'
      const bodyWithUnicode = 'OWNER_DOCUMENT_BODY\n第一行正文\n第二行内容 🚀\n'
      const base64Data = Buffer.from(bodyWithUnicode, 'utf8').toString('base64')
      const records = [
        { type: 'session_start', id: sessionId, title: 'Document test' },
        {
          type: 'message',
          id: 'owner-message',
          seq: 1,
          timestamp: '2026-10-02T01:00:00.000Z',
          message: {
            role: 'user',
            content: [{
              type: 'document',
              source: { type: 'text', mediaType: 'text/plain', data: bodyWithUnicode, name: 'private.txt', mime: 'text/plain' }
            }]
          }
        }
      ]
      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
      const docItem = page.items[1]!

      // 精确非空 contentParts：正文、UTF8 可还原 inline resource、原 name 作为 label 须同时存在，reference 不能是 filename
      expect(docItem.contentParts).toEqual([
        { kind: 'text', text: bodyWithUnicode },
        {
          kind: 'resource',
          resourceType: 'file',
          reference: `data:text/plain;base64,${base64Data}`,
          label: 'private.txt'
        }
      ])
      const resPart = docItem.contentParts[1] as { reference: string; label?: string }
      expect(resPart.reference).not.toBe('private.txt')
      const recovered = Buffer.from(resPart.reference.replace('data:text/plain;base64,', ''), 'base64').toString('utf8')
      expect(recovered).toBe(bodyWithUnicode)
      expect(resPart.label).toBe('private.txt')
    })

    it('processes text document appearing within tool_result in arrival order with text and inline resource (D2)', async () => {
      const sessionId = '00000000-0000-4000-8000-000000000901'
      const textDocBody = 'Tool output notes\n附加说明 📄\n'
      const base64Doc = Buffer.from(textDocBody, 'utf8').toString('base64')
      const records = [
        { type: 'session_start', id: sessionId, title: 'Document in tool' },
        {
          type: 'message',
          id: 'tool-with-text-doc',
          seq: 1,
          timestamp: '2026-10-02T01:00:00.000Z',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'call-text-doc',
              content: [
                { type: 'text', text: 'Step 1 output' },
                {
                  type: 'document',
                  source: {
                    type: 'text',
                    mediaType: 'text/plain',
                    data: textDocBody,
                    name: 'notes.txt'
                  }
                },
                { type: 'text', text: 'Step 2 output' }
              ]
            }]
          }
        }
      ]
      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
      const toolItem = page.items[1]!
      expect(toolItem.contentParts).toEqual([
        { kind: 'tool-result', output: 'Step 1 output', callId: 'call-text-doc' },
        { kind: 'tool-result', output: textDocBody, callId: 'call-text-doc' },
        {
          kind: 'resource',
          resourceType: 'file',
          reference: `data:text/plain;base64,${base64Doc}`,
          label: 'notes.txt'
        },
        { kind: 'tool-result', output: 'Step 2 output', callId: 'call-text-doc' }
      ])
    })

    it('retains structured turn outcome payload and schema fingerprint (D3)', async () => {
      const sessionId = '00000000-0000-4000-8000-000000000901'
      const records = [
        { type: 'session_start', id: sessionId, title: 'Structured outcome test' },
        {
          type: 'agent_turn_outcome',
          turnId: 'owner-turn',
          reason: 'completed',
          resultKind: 'structured',
          result: { receipt: 'OWNER_STRUCTURED_RESULT' },
          schemaFingerprint: 'OWNER_SCHEMA_FINGERPRINT'
        }
      ]
      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
      const projected = JSON.stringify(page.items)
      expect(projected).toContain('OWNER_STRUCTURED_RESULT')
      expect(projected).toContain('OWNER_SCHEMA_FINGERPRINT')
    })

    it('retains each of the three real outcome resultKinds (structured, text, null) (D3)', async () => {
      const sessionId = '00000000-0000-4000-8000-000000000901'
      const records = [
        { type: 'session_start', id: sessionId, title: 'Three-way outcome' },
        {
          type: 'agent_turn_outcome',
          turnId: 'turn-struct',
          reason: 'completed',
          resultKind: 'structured',
          result: { ok: true },
          schemaFingerprint: 'fp-xyz'
        },
        {
          type: 'agent_turn_outcome',
          turnId: 'turn-text',
          reason: 'completed',
          resultKind: 'text'
        },
        {
          type: 'agent_turn_outcome',
          turnId: 'turn-null',
          reason: 'cancelled',
          resultKind: 'null'
        }
      ]
      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
      expect(page.items.length).toBe(4)

      // structured
      expect(page.items[1]!.contentParts).toEqual([
        { kind: 'text', text: 'Outcome: completed' },
        { kind: 'text', text: JSON.stringify({ resultKind: 'structured', result: { ok: true }, schemaFingerprint: 'fp-xyz' }, null, 2) }
      ])
      // text
      expect(page.items[2]!.contentParts).toEqual([
        { kind: 'text', text: 'Outcome: completed' },
        { kind: 'text', text: JSON.stringify({ resultKind: 'text' }, null, 2) }
      ])
      // null
      expect(page.items[3]!.contentParts).toEqual([
        { kind: 'text', text: 'Outcome: cancelled' },
        { kind: 'text', text: JSON.stringify({ resultKind: 'null' }, null, 2) }
      ])
    })

    it('retains native thinking signatures and tool namespace/execution metadata (D4)', async () => {
      const sessionId = '00000000-0000-4000-8000-000000000901'
      const records = [
        { type: 'session_start', id: sessionId, title: 'Metadata test' },
        {
          type: 'message',
          id: 'owner-message',
          seq: 1,
          timestamp: '2026-10-02T01:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Private reasoning', signature: 'OWNER_THINKING_SIGNATURE', durationMs: 3 },
              {
                type: 'tool_use',
                id: 'private-tool',
                name: 'Read',
                input: { file_path: 'private.txt' },
                namespace: 'OWNER_TOOL_NAMESPACE',
                thought_signature: 'OWNER_TOOL_SIGNATURE',
                script_execution: { run_id: 'OWNER_SCRIPT_RUN', outer_tool_use_id: 'OWNER_OUTER_TOOL' }
              }
            ]
          }
        }
      ]
      const f = await createDroidTestFixture(jsonl(records), { sessionId })
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
      const projected = JSON.stringify(page.items)
      for (const marker of ['OWNER_THINKING_SIGNATURE', 'OWNER_TOOL_NAMESPACE', 'OWNER_TOOL_SIGNATURE', 'OWNER_SCRIPT_RUN', 'OWNER_OUTER_TOOL']) {
        expect(projected).toContain(marker)
      }
    })
  })
})
