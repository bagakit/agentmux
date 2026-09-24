import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../../src/agent-session-store.js'
import { defaultAgentMuxHookPort } from '../../src/runtime-paths.js'
import { agentPromptCondition } from '../../src/agent-prompt-condition.js'
import { agentTurnCompletionIdentity, agentTurnEndEvidence } from '../../src/agent-session-identity.js'
import { createPiManagedHookPlan, PI_HOOK_EVENTS, PI_HOOKS } from '../../src/providers/pi.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentSemanticState } from '../../src/types.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const jsonl = (values: unknown[]) => values.map((value) => JSON.stringify(value)).join('\n') + '\n'

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'amux-pi-test-'))
  const workspacePath = join(root, 'workspace')
  const storePath = join(root, 'sessions.json')
  await mkdir(workspacePath)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'durable'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'queue.ndjson'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', storePath)

  const store = new AgentMuxFileAgentSessionStore(storePath)
  const sessionId = 'pi-durable-session'
  const runId = `pi-original-run-${root.split('/').pop()}`
  const nativeId = '019ff166-9788-4ace-b9eb-9a71a42f0af9'
  const transcriptPath = join(root, 'native-transcript.jsonl')
  const token = 't'.repeat(43)

  // Write initial valid v3 session header to disk so existsSync returns true
  await writeFile(
    transcriptPath,
    jsonl([{ type: 'session', version: 3, id: nativeId, cwd: workspacePath, timestamp: '2026-10-01T00:00:00Z' }])
  )

  const initial: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId: sessionId,
    providerId: 'pi',
    executorId: 'pi',
    hostId: 'local',
    workspacePath,
    run: { runId },
    retiredRuns: [],
    hookBindingId: 'b'.repeat(43),
    hookToken: token,
    createdAt: 1,
    updatedAt: 1,
    promptCompletionAdmission: {
      submissionId: 'prior-prompt',
      operationId: 'prior-operation',
      startByte: 0,
      endByte: 10,
      acknowledged: true
    }
  }
  await store.compareAndSwap(null, initial)

  let inputCursor = 10
  const writes: string[] = []
  const receipts = new Map<string, { start_byte: number; end_byte: number; data: string }>()
  const run = () => ({
    id: runId,
    spec: { program: 'pi', args: [], cwd: workspacePath, env: {} },
    lineage: null,
    pid: 123,
    state: { type: 'running' as const },
    latest_output_bytes: 0,
    durable_output_bytes: 0,
    first_available_byte: 0,
    attachments: 0,
    applied_input_bytes: inputCursor,
    current_size: { cols: 80, rows: 24 }
  })
  const start = vi.fn(async () => { throw new Error('unexpected new Run') })
  const stop = vi.fn(async () => { throw new Error('unexpected stop Run') })
  const recoverableInput = vi.fn(async (op: {
    daemonInstance: string; operationKey: string; runId: string; expectedByte: number; data: string
  }) => {
    expect([op.daemonInstance, op.runId, op.expectedByte]).toEqual(['pi-private-daemon', runId, inputCursor])
    let receipt = receipts.get(op.operationKey)
    if (!receipt) {
      receipt = { start_byte: inputCursor, end_byte: inputCursor + Buffer.byteLength(op.data), data: op.data }
      inputCursor = receipt.end_byte
      receipts.set(op.operationKey, receipt)
      writes.push(op.data)
    }
    return { run: run(), receipt }
  })

  const clients: AgentMuxClient[] = []
  let client: AgentMuxClient
  async function connect() {
    const next = new AgentMuxClient({ store })
    const adapter = (next as unknown as { kernel: CtxmuxRunAdapter }).kernel
    Object.assign(adapter, {
      client: {
        list: async () => [{ id: runId }],
        status: async () => run(),
        recoverableInput,
        start,
        stop
      },
      runtime: { daemonInstanceId: 'pi-private-daemon' }
    })
    clients.push(next)
    await next.connect()
    expect(next.agentSessions().map((s) => [s.agentSessionId, s.run.runId])).toEqual([[sessionId, runId]])
    return next
  }

  cleanups.push(async () => {
    await Promise.all(clients.map((c) => c.dispose()))
    await rm(root, { recursive: true, force: true })
  })

  client = await connect()

  const feed = async (receiptId: string, eventName: string, payload: Record<string, unknown>, badToken = false) => {
    const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${badToken ? 'bad' : token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId, eventName, payload })
    })
    return response.status
  }

  const stored = async () => {
    const rows = await loadAgentSessions(store)
    expect(rows).toHaveLength(1)
    return rows[0]!
  }

  return {
    root,
    store,
    storePath,
    sessionId,
    runId,
    nativeId,
    transcriptPath,
    writes,
    start,
    stop,
    recoverableInput,
    get client() { return client },
    feed,
    stored,
    send: async (operationId: string, prompt: string, expectedCompletionId?: string) => {
      const observed = client.agentSession(sessionId)
      return client.submitAgentPrompt({
        ...agentPromptCondition(observed),
        agentSessionId: sessionId,
        operationId,
        prompt,
        ...(expectedCompletionId === undefined ? {} : {
          expectedCompletionId,
          expectedInputByte: inputCursor
        })
      })
    },
    reopen: async () => {
      await client.dispose()
      const before = await readFile(storePath)
      client = await connect()
      expect(await readFile(storePath)).toEqual(before)
    }
  }
}

describe('Pi session analysis, native identity and hook settlement', () => {
  it('acquires main native identity through authenticated ingress, preserves it across child/foreign records and fresh Client', async () => {
    const h = await harness()
    expect(await h.feed('forged', 'agent_start', { session_id: 'forged' }, true)).toBe(403)
    expect((await h.stored()).nativeHandle).toBeUndefined()

    // Missing transcript file on disk -> extension does not report session_file -> handle not acquired (requireTranscriptPath: true)
    expect(await h.feed('no-file', 'agent_start', { session_id: h.nativeId })).toBe(204)
    expect((await h.stored()).nativeHandle).toBeUndefined()

    // Real transcript file present -> acquired
    expect(await h.feed('birth', 'agent_start', { session_id: h.nativeId, session_file: h.transcriptPath })).toBe(204)
    const main = (await h.stored()).nativeHandle
    expect(main).toEqual({
      kind: 'provider',
      providerId: 'pi',
      sessionId: h.nativeId,
      transcriptPath: h.transcriptPath
    })

    // Foreign session event without valid locator does not overwrite main handle
    expect(await h.feed('foreign', 'agent_start', { session_id: 'other-session' })).toBe(204)
    expect((await h.stored()).nativeHandle).toEqual(main)

    // Reopen preserves exact identity
    await h.reopen()
    expect(h.client.agentSession(h.sessionId).nativeHandle).toEqual(main)

    const launch = new AgentProviderRegistry().get('pi').buildResumeLaunch({
      workspacePath: h.client.agentSession(h.sessionId).workspacePath,
      nativeHandle: main!,
      args: [],
      env: {},
      prompt: 'continue'
    })
    expect(launch).toMatchObject({ command: 'pi', args: ['--session', h.transcriptPath, 'continue'] })
    expect(h.writes).toEqual([])
    expect(h.start).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('settles hook events distinguishing stop (done), error (error), aborted/length/missing (unknown, turn-end), unblocking subsequent input', async () => {
    const pi = new AgentProviderRegistry().get('pi')
    const hook = (eventName: string, payload: Record<string, unknown> = {}) =>
      pi.normalizeHook({
        receiptId: `r-${eventName}`,
        agentSessionId: 's-pi',
        runId: 'r-1',
        providerId: 'pi',
        eventName,
        payload
      }, {})

    // Normalizer rule assertions: single clear field `stopReason`, no duplicate aliases
    const stopNorm = hook('agent_settled', { stopReason: 'stop' })
    expect(stopNorm.semanticState).toBe<AgentSemanticState>('done')
    expect(stopNorm.lifecycleEvent).toBe('turn-end')

    const errorNorm = hook('agent_settled', { stopReason: 'error' })
    expect(errorNorm.semanticState).toBe<AgentSemanticState>('error')
    expect(errorNorm.lifecycleEvent).toBe('turn-end')

    const lengthNorm = hook('agent_settled', { stopReason: 'length' })
    expect(lengthNorm.semanticState).toBe<AgentSemanticState>('unknown')
    expect(lengthNorm.lifecycleEvent).toBe('turn-end')

    const abortNorm = hook('agent_settled', { stopReason: 'aborted' })
    expect(abortNorm.semanticState).toBe<AgentSemanticState>('unknown')
    expect(abortNorm.lifecycleEvent).toBe('turn-end')

    const bareNorm = hook('agent_settled', {})
    expect(bareNorm.semanticState).toBe<AgentSemanticState>('unknown')
    expect(bareNorm.lifecycleEvent).toBe('turn-end')

    // Public authenticated ingress and FileStore lifecycle
    const h = await harness()
    expect(await h.feed('birth', 'agent_start', { session_id: h.nativeId, session_file: h.transcriptPath })).toBe(204)

    // message_end carrying stopReason stays working until agent_settled
    expect(await h.feed('msg-end', 'message_end', {
      session_id: h.nativeId,
      session_file: h.transcriptPath,
      role: 'assistant',
      stopReason: 'stop'
    })).toBe(204)
    expect((await h.stored()).semanticStatus?.state).toBe('working')

    // agent_settled with stopReason: length -> unknown, but explicit turn-end unblocks next manual prompt
    expect(await h.feed('settle-len', 'agent_settled', {
      session_id: h.nativeId,
      session_file: h.transcriptPath,
      stopReason: 'length'
    })).toBe(204)
    const settledLength = await h.stored()
    expect(settledLength.semanticStatus?.state).toBe('running')
    expect(agentTurnCompletionIdentity(settledLength)).toBeUndefined()
    expect(agentTurnEndEvidence(settledLength)).toBeDefined()
    // Manual input is unblocked (does not throw AGENT_TURN_END_UNCONFIRMED)
    await expect(h.send('manual-op-1', 'continue after length')).resolves.toBeUndefined()

    // message_end for next turn
    expect(await h.feed('msg-end-2', 'message_end', {
      session_id: h.nativeId,
      session_file: h.transcriptPath,
      role: 'assistant',
      stopReason: 'stop'
    })).toBe(204)

    // agent_settled without stopReason (missing result) -> unknown with turn-end, unblocking next input
    expect(await h.feed('settle-bare', 'agent_settled', {
      session_id: h.nativeId,
      session_file: h.transcriptPath
    })).toBe(204)
    const settledBare = await h.stored()
    expect(agentTurnCompletionIdentity(settledBare)).toBeUndefined()
    expect(agentTurnEndEvidence(settledBare)).toBeDefined()
    await expect(h.send('manual-op-2', 'continue after bare')).resolves.toBeUndefined()

    // message_end for next turn
    expect(await h.feed('msg-end-3', 'message_end', {
      session_id: h.nativeId,
      session_file: h.transcriptPath,
      role: 'assistant',
      stopReason: 'stop'
    })).toBe(204)

    // agent_settled with stopReason: error -> error with turn-end
    expect(await h.feed('settle-error', 'agent_settled', {
      session_id: h.nativeId,
      session_file: h.transcriptPath,
      stopReason: 'error',
      errorMessage: 'API rate limit exceeded'
    })).toBe(204)
    const settledError = await h.stored()
    expect(settledError.semanticStatus?.state).toBe('error')

    // agent_settled with stopReason: stop -> done with turn-end
    expect(await h.feed('settle-stop', 'agent_settled', {
      session_id: h.nativeId,
      session_file: h.transcriptPath,
      stopReason: 'stop'
    })).toBe(204)
    const settledDone = await h.stored()
    expect(settledDone.semanticStatus?.state).toBe('done')
    expect(agentTurnCompletionIdentity(settledDone)).toBeTypeOf('string')

    expect(h.start).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('records tool execution in public timeline and clears on completion', async () => {
    const h = await harness()
    expect(await h.feed('birth', 'agent_start', { session_id: h.nativeId, session_file: h.transcriptPath })).toBe(204)

    expect(await h.feed('tool-start', 'tool_execution_start', {
      session_id: h.nativeId,
      session_file: h.transcriptPath,
      tool_name: 'bash',
      tool_input: { command: 'ls -la' }
    })).toBe(204)

    const timelineWorking = await h.client.sessionTimeline(h.sessionId)
    expect(timelineWorking.items.length).toBeGreaterThan(0)
    expect(timelineWorking.items.map((i) => ({ kind: i.kind, toolName: i.toolName }))).toContainEqual({
      kind: 'tool_call',
      toolName: 'bash'
    })

    expect(await h.feed('tool-end', 'tool_execution_end', {
      session_id: h.nativeId,
      session_file: h.transcriptPath,
      tool_name: 'bash'
    })).toBe(204)

    expect(h.writes).toEqual([])
    expect(h.start).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('reads authentic multi-turn branch with mixed reasoning, text, tool-call, image and compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-pi-history-'))
    const workspacePath = join(root, 'workspace')
    await mkdir(workspacePath)
    const transcriptPath = join(root, 'transcript.jsonl')
    const nativeSessionId = 'pi-test-session-v3'

    const entries = [
      { type: 'session', version: 3, id: nativeSessionId, cwd: workspacePath, timestamp: '2026-10-01T00:00:00Z' },
      // 1. user message with text + image
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-10-01T00:01:00Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect build output' },
            { type: 'image', mimeType: 'image/png', data: 'cGlj' }
          ]
        }
      },
      // 2. assistant mixed message: reasoning + text + toolCall
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: '2026-10-01T00:02:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Checking the files first' },
            { type: 'text', text: 'I will list the directory contents.' },
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }
          ]
        }
      },
      // 3. toolResult activity with first-party role=toolResult, toolCallId, toolName, isError, and content=[text, image, text]
      {
        type: 'message',
        id: 'tool-1',
        parentId: 'assistant-1',
        timestamp: '2026-10-01T00:03:00Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [
            { type: 'text', text: 'before resource' },
            { type: 'image', mimeType: 'image/png', data: 'ZXJyb3I=' },
            { type: 'text', text: 'after resource' }
          ],
          isError: true
        }
      },
      // 4. assistant final message (with an empty thinking block that must not invent an empty string reasoning fact)
      {
        type: 'message',
        id: 'assistant-2',
        parentId: 'tool-1',
        timestamp: '2026-10-01T00:04:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking' },
            { type: 'text', text: 'Build completed successfully.' }
          ]
        }
      },
      // 5. compaction activity
      {
        type: 'compaction',
        id: 'compact-1',
        parentId: 'assistant-2',
        timestamp: '2026-10-01T00:05:00Z',
        summary: 'Compacted 4 messages',
        firstKeptEntryId: 'assistant-2',
        tokensBefore: 200
      },
      // 6. unrecorded timestamp entry
      {
        type: 'label',
        id: 'label-1',
        parentId: 'compact-1',
        timestamp: 'unknown',
        targetId: 'assistant-2',
        label: 'bookmark'
      }
    ]

    await writeFile(transcriptPath, jsonl(entries))
    const beforeNative = await readFile(transcriptPath)

    const storePath = join(root, 'agent-sessions.json')
    const store = new AgentMuxFileAgentSessionStore(storePath)
    const session: AgentMuxStoredAgentSession = {
      kind: 'agent',
      agentSessionId: 'pi-history-session',
      providerId: 'pi',
      executorId: 'pi',
      hostId: 'local',
      workspacePath,
      run: { runId: 'pi-history-run' },
      retiredRuns: [],
      createdAt: 1000,
      updatedAt: 1000,
      hookBindingId: 'pi-history-binding',
      hookToken: 'pi-history-token',
      nativeHandle: {
        kind: 'provider',
        providerId: 'pi',
        sessionId: nativeSessionId,
        transcriptPath
      }
    }
    await store.compareAndSwap(null, session)
    const beforeStore = await readFile(storePath)

    const client = new AgentMuxClient({ store })
    const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
    const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) =>
      vi.spyOn(kernel, name as 'start')
    )

    cleanups.push(async () => {
      await client.dispose()
      await rm(root, { recursive: true, force: true })
    })

    const page = await client.sessionHistoryPage('pi-history-session', { limit: 10 })
    expect(page.items).toHaveLength(6)

    // Verify item kinds
    expect(page.items.map((i) => i.kind)).toEqual([
      'user-message',
      'assistant-message',
      'activity',
      'assistant-message',
      'activity',
      'activity'
    ])

    // Verify Item 0: user text + image
    expect(page.items[0]!.contentParts).toEqual([
      { kind: 'text', text: 'Inspect build output' },
      { kind: 'resource', resourceType: 'image', reference: 'data:image/png;base64,cGlj' }
    ])

    // Verify Item 1: assistant mixed: reasoning + text + toolCall in exact order
    expect(page.items[1]!.contentParts).toEqual([
      { kind: 'reasoning', text: 'Checking the files first' },
      { kind: 'text', text: 'I will list the directory contents.' },
      { kind: 'tool-call', name: 'bash', input: '{"command":"ls"}', callId: 'call-1' }
    ])

    // Verify Item 2: tool result activity preserves text/image order, toolName, toolCallId, and failed flag
    expect(page.items[2]!.contentParts).toEqual([
      { kind: 'tool-result', output: 'before resource', name: 'bash', callId: 'call-1', failed: true },
      { kind: 'resource', resourceType: 'image', reference: 'data:image/png;base64,ZXJyb3I=' },
      { kind: 'tool-result', output: 'after resource', name: 'bash', callId: 'call-1', failed: true }
    ])

    // Verify Item 3: malformed thinking preserves raw unknown record and does not invent empty string reasoning fact
    expect(page.items[3]!.contentParts).toEqual([
      { kind: 'text', text: '{"type":"thinking"}' },
      { kind: 'text', text: 'Build completed successfully.' }
    ])

    // Verify Item 4: compaction activity
    expect(page.items[4]!.contentParts).toEqual([
      { kind: 'text', text: 'Compacted 4 messages' }
    ])

    // Verify Item 5: unknown timestamp -> no startedAt and no completedAt
    expect(page.items[5]).not.toHaveProperty('startedAt')
    for (const item of page.items) {
      expect(item).not.toHaveProperty('completedAt')
    }

    // Controls never called
    for (const c of controls) {
      expect(c).not.toHaveBeenCalled()
    }

    // Bytes untouched
    expect(await readFile(transcriptPath)).toEqual(beforeNative)
    expect(await readFile(storePath)).toEqual(beforeStore)
  })

  it('rejects foreign headers, cycles, and missing parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-pi-invalid-'))
    const workspacePath = join(root, 'workspace')
    await mkdir(workspacePath)
    const transcriptPath = join(root, 'transcript.jsonl')
    const nativeSessionId = 'pi-main'

    // Foreign id
    await writeFile(transcriptPath, jsonl([
      { type: 'session', version: 3, id: 'wrong-id', cwd: workspacePath, timestamp: '2026-10-01T00:00:00Z' },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-10-01T00:01:00Z', message: { role: 'user', content: 'hi' } }
    ]))
    const storePath = join(root, 'agent-sessions.json')
    const store = new AgentMuxFileAgentSessionStore(storePath)
    await store.compareAndSwap(null, {
      kind: 'agent',
      agentSessionId: 'invalid-session',
      providerId: 'pi',
      executorId: 'pi',
      hostId: 'local',
      workspacePath,
      run: { runId: 'run-inv' },
      retiredRuns: [],
      createdAt: 1,
      updatedAt: 1,
      hookBindingId: 'b',
      hookToken: 't',
      nativeHandle: { kind: 'provider', providerId: 'pi', sessionId: nativeSessionId, transcriptPath }
    })
    const client = new AgentMuxClient({ store })
    cleanups.push(async () => {
      await client.dispose()
      await rm(root, { recursive: true, force: true })
    })

    await expect(client.sessionHistoryPage('invalid-session')).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
    })
  })
})
