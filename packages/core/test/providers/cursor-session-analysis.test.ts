import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry,
  agentPromptCondition, defaultAgentMuxHookPort, loadAgentSessions } from '../../dist/index.js'
import { agentTurnCompletionIdentity, agentTurnEndEvidence } from '../../src/agent-session-identity.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'

const isolation = vi.hoisted(() => ({ homedir: '/synthetic/cursor-unset' }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(),
  homedir: () => isolation.homedir }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// The current first-party Hook shape and the SDK transport are controlled inputs.
// Public connect, authenticated HTTP ingress, FileStore, normalization and input admission
// execute built Core. No native CLI, model, user App, personal configuration or real Run is used.
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'amux-cursor-hook-'))
  const workspacePath = join(root, 'workspace'), storePath = join(root, 'sessions.json')
  await mkdir(workspacePath)
  isolation.homedir = join(root, 'home')
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'durable'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'queue.ndjson'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', storePath)
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const sessionId = 'cursor-durable-session', runId = `cursor-original-run-${root.split('/').pop()}`
  const nativeId = '019ff166-9788-4ace-b9eb-9a71a42f0af9'
  const transcriptPath = join(root, 'native-transcript.jsonl'), token = 't'.repeat(43)
  const initial: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: sessionId, providerId: 'cursor', executorId: 'cursor',
    hostId: 'local', workspacePath, run: { runId }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: token, createdAt: 1, updatedAt: 1,
    promptCompletionAdmission: { submissionId: 'prior-prompt', operationId: 'prior-operation',
      startByte: 0, endByte: 10, acknowledged: true }
  }
  await store.compareAndSwap(null, initial)
  let inputCursor = 10
  const writes: string[] = []
  const receipts = new Map<string, { start_byte: number; end_byte: number; data: string }>()
  const run = () => ({ native_service: null, id: runId,
    spec: { program: 'cursor-agent', args: [], cwd: workspacePath, env: {} },
    lineage: null, pid: 123, state: { type: 'running' as const }, latest_output_bytes: 0,
    durable_output_bytes: 0, first_available_byte: 0, attachments: 0,
    applied_input_bytes: inputCursor, current_size: { cols: 80, rows: 24 } })
  const start = vi.fn(async () => { throw new Error('unexpected new Run') })
  const stop = vi.fn(async () => { throw new Error('unexpected stop Run') })
  const recoverableInput = vi.fn(async (op: {
    daemonInstance: string; operationKey: string; runId: string; expectedByte: number; data: string
  }) => {
    expect([op.daemonInstance, op.runId, op.expectedByte]).toEqual(['cursor-private-daemon', runId, inputCursor])
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
    Object.assign(adapter, { client: {
      list: async () => [{ id: runId }], status: async () => run(), recoverableInput, start, stop
    }, runtime: { daemonInstanceId: 'cursor-private-daemon' } })
    clients.push(next)
    await next.connect()
    expect(next.agentSessions().map(s => [s.agentSessionId, s.run.runId])).toEqual([[sessionId, runId]])
    return next
  }
  cleanups.push(async () => {
    await Promise.all(clients.map(c => c.dispose()))
    await rm(root, { recursive: true, force: true })
  })
  client = await connect()
  const feed = async (receiptId: string, eventName: string, payload: Record<string, unknown>, badToken = false) => {
    const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
      method: 'POST', headers: { authorization: `Bearer ${badToken ? 'bad' : token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId, eventName, payload })
    })
    return response.status
  }
  const stored = async () => {
    const rows = await loadAgentSessions(store)
    expect(rows).toHaveLength(1)
    return rows[0]!
  }
  return { root, store, storePath, sessionId, runId, nativeId, transcriptPath, writes, start, stop, recoverableInput,
    get client() { return client }, feed, stored,
    send: async (operationId: string, prompt: string, expectedCompletionId?: string) => {
      const observed = client.agentSession(sessionId)
      return client.submitAgentPrompt({ ...agentPromptCondition(observed), agentSessionId: sessionId,
        operationId, prompt, ...(expectedCompletionId === undefined ? {} : {
          expectedCompletionId, expectedInputByte: inputCursor
        }) })
    },
    reopen: async () => {
      await client.dispose()
      const before = await readFile(storePath)
      client = await connect()
      expect(await readFile(storePath)).toEqual(before)
    }
  }
}

async function establish(h: Awaited<ReturnType<typeof harness>>) {
  expect((await h.stored()).nativeHandle).toBeUndefined()
  expect(await h.feed('birth', 'beforeSubmitPrompt', {
    conversation_id: h.nativeId, transcript_path: h.transcriptPath, prompt: 'native first prompt'
  })).toBe(204)
  expect((await h.stored()).nativeHandle).toEqual({ kind: 'provider', providerId: 'cursor',
    sessionId: h.nativeId, transcriptPath: h.transcriptPath })
}

describe('Cursor native identity and completion through built public Core', () => {
  it('acquires main native identity through authenticated ingress, preserves it across child/foreign records and fresh Client', async () => {
    const h = await harness()
    expect(await h.feed('forged', 'beforeSubmitPrompt', { conversation_id: 'forged' }, true)).toBe(403)
    await establish(h)
    const main = (await h.stored()).nativeHandle
    const body = { conversation_id: h.nativeId, transcript_path: '/synthetic/child.jsonl', subagent_id: 'child-native-id' }
    expect(await h.feed('child-start', 'subagentStart', body)).toBe(204)
    expect(await h.feed('child-stop', 'stop', { ...body, status: 'completed' })).toBe(204)
    expect((await h.stored()).nativeHandle).toEqual(main)
    expect(agentTurnCompletionIdentity(await h.stored())).toBeUndefined()
    expect(await h.feed('foreign-stop', 'stop', { conversation_id: 'different-root', status: 'completed' })).toBe(204)
    expect((await h.stored()).nativeHandle).toEqual(main)
    expect(agentTurnCompletionIdentity(await h.stored())).toBeUndefined()
    await h.reopen()
    expect(h.client.agentSession(h.sessionId).nativeHandle).toEqual(main)
    const launch = new AgentProviderRegistry().get('cursor').buildResumeLaunch({
      workspacePath: h.client.agentSession(h.sessionId).workspacePath,
      nativeHandle: main!, args: [], env: {}, prompt: 'continue'
    })
    expect(launch).toMatchObject({ command: 'cursor-agent', args: ['--resume', h.nativeId, 'continue'] })
    expect(h.writes).toEqual([])
    expect(h.start).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('adopts nonempty native lifecycle, assistant response and failed tool trace through the public timeline caller', async () => {
    const h = await harness()
    await establish(h)
    expect(await h.feed('assistant', 'afterAgentResponse', { conversation_id: h.nativeId, text: 'native answer' })).toBe(204)
    expect(await h.feed('tool-pre', 'preToolUse', {
      conversation_id: h.nativeId, tool_use_id: 'call-1', tool_name: 'Shell', tool_input: { command: 'private-test' }
    })).toBe(204)
    expect(await h.feed('tool-failure', 'postToolUseFailure', {
      conversation_id: h.nativeId, tool_use_id: 'call-1', tool_name: 'Shell',
      tool_input: { command: 'private-test' }, error_message: 'private fixture failure', failure_type: 'tool_error'
    })).toBe(204)
    const timeline = await h.client.sessionTimeline(h.sessionId)
    expect(timeline.items.map(item => ({ kind: item.kind, content: item.content, toolName: item.toolName,
      toolInput: item.toolInput, toolOutput: item.toolOutput, status: item.status }))).toEqual([
      { kind: 'lifecycle', content: undefined, toolName: undefined,
        toolInput: undefined, toolOutput: undefined, status: 'complete' },
      { kind: 'assistant_message', content: 'native answer', toolName: undefined,
        toolInput: undefined, toolOutput: undefined, status: 'complete' },
      { kind: 'tool_call', content: undefined, toolName: 'Shell', toolInput: '{\"command\":\"private-test\"}',
        toolOutput: 'private fixture failure', status: 'failed' }
    ])
    expect(h.writes).toEqual([])
    expect(h.start).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('preserves the known child roster across a foreign stop and settles only the previously ended successful parent', async () => {
    const h = await harness()
    await establish(h)
    expect(await h.feed('child-born', 'subagentStart', {
      conversation_id: h.nativeId, subagent_id: 'known-child', transcript_path: '/synthetic/child.jsonl'
    })).toBe(204)
    expect(await h.feed('parent-ended', 'stop', { conversation_id: h.nativeId, status: 'completed' })).toBe(204)
    const waiting = await h.stored()
    expect(waiting.semanticStatus?.state).toBe('working')
    expect(agentTurnEndEvidence(waiting)).toBeDefined()
    expect(agentTurnCompletionIdentity(waiting)).toBeUndefined()
    expect(await h.feed('foreign-ended', 'stop', { conversation_id: 'foreign-main', status: 'error' })).toBe(204)
    expect((await h.stored()).semanticStatus?.state).toBe('working')
    expect(await h.feed('child-finished', 'subagentStop', {
      conversation_id: h.nativeId, subagent_id: 'known-child', transcript_path: '/synthetic/child.jsonl'
    })).toBe(204)
    const complete = await h.stored()
    expect(complete.semanticStatus?.state).toBe('done')
    expect(agentTurnCompletionIdentity(complete)).toBeTypeOf('string')
    expect(complete.nativeHandle).toEqual({ kind: 'provider', providerId: 'cursor',
      sessionId: h.nativeId, transcriptPath: h.transcriptPath })
    expect((await h.client.sessionTimeline(h.sessionId)).items.map(item => item.id)).toHaveLength(4)
    expect(h.writes).toEqual([])
    expect(h.start).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('restores the same durable native identity and resume target through two separate Node processes', async () => {
    const h = await harness()
    await h.client.dispose()
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('AGENTMUX_') && key !== 'NODE_OPTIONS'))
    const runWorker = async (generation: string) => {
      const { stdout } = await promisify(execFile)(process.execPath, [
        join(import.meta.dirname, '../fixtures/cursor-hook-restart-worker.mjs'),
        h.root, generation, h.nativeId, h.transcriptPath
      ], { env })
      return JSON.parse(stdout.trim())
    }
    const first = await runWorker('birth')
    const afterBirth = await readFile(h.storePath)
    const second = await runWorker('restore')
    expect(second.pid).not.toBe(first.pid)
    expect([first.sessionId, second.sessionId]).toEqual([h.sessionId, h.sessionId])
    expect([first.run, second.run]).toEqual([{ runId: h.runId }, { runId: h.runId }])
    const expected = { kind: 'provider', providerId: 'cursor', sessionId: h.nativeId, transcriptPath: h.transcriptPath }
    expect([first.nativeHandle, second.nativeHandle]).toEqual([expected, expected])
    expect([first.resume, second.resume]).toEqual([
      ['--resume', h.nativeId, 'continue'], ['--resume', h.nativeId, 'continue']
    ])
    expect([first.controls, second.controls]).toEqual([0, 0])
    expect(second.storeUnchanged).toBe(true)
    expect(await readFile(h.storePath)).toEqual(afterBirth)
  })

  it.each(['error', 'aborted'])('keeps %s turn-end honest, rejects automatic input with zero writes, admits manual next turn on the same Run', async status => {
    const h = await harness()
    await establish(h)
    expect(await h.feed('native-end', 'stop', { conversation_id: h.nativeId, status })).toBe(204)
    const ended = await h.stored()
    expect(ended.semanticStatus?.state).toBe(status === 'error' ? 'error' : 'running')
    expect(agentTurnEndEvidence(ended)).toBeDefined()
    expect(agentTurnCompletionIdentity(ended)).toBeUndefined()
    await expect(h.send('automatic', 'automatic next', 'stale-completion')).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
    expect(h.writes).toEqual([])
    await h.send('manual', 'manual next')
    expect(h.writes).toEqual(['manual next\r'])
    expect((await h.stored()).run).toEqual({ runId: h.runId })
    expect((await h.stored()).promptCompletionAdmission).toMatchObject({
      submissionId: 'manual', acknowledged: true, startByte: 10, endByte: 22
    })
    expect(h.start).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('grants successful completion only for completed and delivers one conditional automatic input with a real SDK receipt', async () => {
    const h = await harness()
    await establish(h)
    expect(await h.feed('success', 'stop', { conversation_id: h.nativeId, status: 'completed' })).toBe(204)
    const completion = agentTurnCompletionIdentity(await h.stored())
    expect(completion).toBeTypeOf('string')
    await h.send('automatic-success', 'next', completion)
    expect(h.writes).toEqual(['next\r'])
    expect(h.recoverableInput).toHaveBeenCalledOnce()
    expect((await h.stored()).promptCompletionAdmission).toMatchObject({
      submissionId: 'automatic-success', completionId: completion, acknowledged: true, startByte: 10, endByte: 15
    })
    expect(h.start).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it.each([undefined, 'cancelled', 'unrecognized'])('retains unknown stop %s without inventing an end or completion', async status => {
    const h = await harness()
    await establish(h)
    expect(await h.feed('unknown', 'stop', { conversation_id: h.nativeId, ...(status === undefined ? {} : { status }) })).toBe(204)
    const unknown = await h.stored()
    expect(unknown.semanticStatus?.state).toBe('working')
    expect(unknown.terminalPromptReadiness).toBeUndefined()
    expect(agentTurnCompletionIdentity(unknown)).toBeUndefined()
    expect(agentTurnEndEvidence(unknown)).toBeUndefined()
    await expect(h.send('unconfirmed-manual', 'keep my prompt')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    expect(h.writes).toEqual([])
    expect(h.start).not.toHaveBeenCalled()
    expect(h.stop).not.toHaveBeenCalled()
  })
})
