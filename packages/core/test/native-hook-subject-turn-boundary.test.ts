import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { OutputChunk, RunEvent } from '@ctxmux/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, agentPromptCondition, createNumberedTerminalInteractionProtocol,
  defineAgentProvider } from '../dist/index.js'
import { agentTurnCompletionIdentity, agentTurnEndBoundary } from '../dist/agent-session-identity.js'
import { normalizeStoredAgentSession } from '../dist/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { defaultAgentMuxHookPort } from '../dist/runtime-paths.js'
import { releaseSubagentRoster } from '../dist/hook-normalizer.js'
import { HOOK_PAYLOAD_USAGE_KEY, parseTurnUsage } from '../dist/agent-usage-transcript.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, AgentTurnUsage } from '../src/types.js'

const isolation = vi.hoisted(() => ({ homedir: '/synthetic/unset-home' }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => isolation.homedir
}))
const exec = promisify(execFile)
const sessionId = 'subject-session', runId = 'subject-run', token = 't'.repeat(43)
const frameStart = '\u001b[?2026h', frameEnd = '\u001b[?2026l'
const modes = ['single-phase', 'render-then-submit'] as const
type Mode = typeof modes[number]
type Payload = Record<string, unknown>

afterEach(() => vi.unstubAllEnvs())

type Shape = 'flat' | 'nested'
function child(shape: Shape): Payload {
  return shape === 'flat' ? { agent_name: 'child' } : { extra: { scope: 'child' } }
}
function cancelled(shape: Shape): [string, Payload] {
  return shape === 'flat' ? ['notice', { reason: 'cancelled' }]
    : ['signal', { extra: { category: 'turn', reason: 'halt' } }]
}
const cases = modes.flatMap(mode => (['flat', 'nested'] as const).map(shape => ({ mode, shape })))
// A physical screen observation may finish while the private fixture reconnects. Compare every
// durable fact except that monotonic observation's progress byte and aggregate updatedAt.
function recoveryFacts(session: AgentMuxStoredAgentSession) {
  const { updatedAt: _updated, terminalPromptReadiness: readiness, ...facts } = session
  if (!readiness) return facts
  const { readyThroughByte: _screenProgress, ...nativeFacts } = readiness
  return { ...facts, terminalPromptReadiness: nativeFacts }
}

// Synthetic native protocols and SDK receipts are the fixture boundary. The public Client,
// authenticated HTTP ingress, FileStore, input coordinator and xterm screen evidence use built Core.
// No native Agent, Electron, personal config, Session transcript or existing Run is opened.
async function harness(mode: Mode, shape: Shape, tracking = false) {
  const root = await mkdtemp(join(tmpdir(), 'amux-native-subject-'))
  const path = join(root, 'sessions.json'), workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  isolation.homedir = join(root, 'home')
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'queue.ndjson'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', path)
  const providerId = `synthetic-${mode}-${shape}`
  const store = new AgentMuxFileAgentSessionStore(path)
  await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId: sessionId, providerId, executorId: providerId,
    hostId: 'local', workspacePath, run: { runId }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: token, createdAt: 1, updatedAt: 1,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 },
    // Start after the fixture's known prior Input receipt; a cursor alone is not a receipt.
    promptCompletionAdmission: { submissionId: 'prior', operationId: 'prior-input', startByte: 0, endByte: 10,
      acknowledged: true }
  })
  const provider = defineAgentProvider({
    catalog: {
      id: providerId, label: 'Synthetic subject and turn boundary', executable: 'synthetic-agent',
      expectedProcess: 'synthetic-agent', promptDelivery: 'positional-argv',
      readySignal: { kind: 'foreground-process', expectedProcess: 'synthetic-agent' },
      // An unmanaged fixture makes public connect independent of all native configuration.
      hookStrategy: { kind: 'native', installation: 'unmanaged' },
      resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
      capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond',
        providerResume: false, replyCorrelation: 'none' }
    },
    buildArgs: (_prompt, args) => [...args],
    ...(mode === 'render-then-submit' ? {
      terminalPromptRender: { frameStart, frameEnd, activeComposer: '›' },
      planPromptInput: (prompt: string) => ({ kind: 'render-then-submit' as const,
        payload: prompt, renderedText: prompt, submit: '\r' })
    } : {}),
    hook: {
      subagentSubject: p => typeof p.agent_name === 'string' || p.scope === 'child',
      nativeHandle: { sessionIdKeys: ['session_id'], transcriptPathKeys: ['transcript_path'] },
      ...(tracking ? { subagentTracking: { startEvents: ['child_open'], stopEvents: ['child_close'],
        mainStopEvents: ['finish'], idKeys: ['agent_name'] } } : {}),
      rules: [
      { events: ['notice'], state: 'unknown', matches: p => p.reason === 'cancelled', lifecycleEvent: 'turn-end' },
      { events: ['signal'], state: 'unknown', matches: p => p.category === 'turn' && p.reason === 'halt', lifecycleEvent: 'turn-end' },
      { events: ['turn_open'], state: 'working', lifecycleEvent: 'turn-start' },
      { events: ['UserPromptSubmit'], state: 'working' },
      { events: ['prompt_open'], state: 'unknown', lifecycleEvent: 'user-prompt-submit' },
      { events: ['PostToolUse'], state: 'working' },
      { events: ['finish'], state: 'unknown', matches: p => p.phase === 'provisional', lifecycleEvent: null },
      { events: ['finish'], state: 'done', lifecycleEvent: 'turn-end' },
      { events: ['Stop'], state: 'unknown', matches: p => p.phase === 'step' || p.category === 'provisional', lifecycleEvent: null },
      { events: ['Stop'], state: 'done' },
      { events: ['StopFailure'], state: 'unknown' },
      { events: ['ask'], state: 'waiting', toolNames: ['select'] }
    ] },
    interaction: createNumberedTerminalInteractionProtocol({
      questionEvents: ['ask'], questionTools: ['select'], questionCompletionEvents: ['answer-observed'],
      permissionOptions: [
        { id: 'allow', label: 'Allow', kind: 'allow-once', input: '1' },
        { id: 'deny', label: 'Deny', kind: 'reject-once', input: '2' }
      ]
    })
  })
  let cursor = 10, outputCursor = 0
  const writes: string[] = [], chunks: OutputChunk[] = []
  const streams = new Set<{ push(event: RunEvent): void; close(): void }>()
  const run = () => ({
    id: runId, spec: { program: 'synthetic-agent', args: [], cwd: workspacePath, env: {} },
    lineage: null, pid: 123, state: { type: 'running' as const }, latest_output_bytes: outputCursor,
    durable_output_bytes: outputCursor, first_available_byte: 0, attachments: streams.size,
    applied_input_bytes: cursor, current_size: { cols: 80, rows: 24 }
  })
  function output(text: string) {
    const data = new TextEncoder().encode(text)
    const chunk = { start_byte: outputCursor, end_byte: outputCursor + data.byteLength, data }
    outputCursor = chunk.end_byte
    chunks.push(chunk)
    for (const stream of streams) stream.push({ type: 'output', chunk })
  }
  output(`${frameStart}\u001b[22;1H› \u001b[22;3H${frameEnd}`)
  const receipts = new Map<string, { start_byte: number; end_byte: number; data: string }>()
  const recoverableInput = vi.fn(async (op: {
    daemonInstance: string; operationKey: string; runId: string; expectedByte: number; data: string
  }) => {
    expect(op.daemonInstance).toBe('synthetic-daemon')
    expect(op.runId).toBe(runId)
    const existing = receipts.get(op.operationKey)
    if (existing) {
      expect([op.expectedByte, op.data]).toEqual([existing.start_byte, existing.data])
      return { run: run(), receipt: existing }
    }
    expect(op.expectedByte).toBe(cursor)
    const receipt = { start_byte: cursor, end_byte: cursor + Buffer.byteLength(op.data), data: op.data }
    cursor = receipt.end_byte
    receipts.set(op.operationKey, receipt)
    writes.push(op.data)
    if (mode === 'render-then-submit' && op.data !== '\r') {
      output(`${frameStart}\u001b[2J\u001b[22;1H› ${op.data}\u001b[22;${3 + op.data.length}H${frameEnd}`)
    }
    return { run: run(), receipt }
  })
  const attachTerminal = vi.fn(async (id: string) => {
    expect(id).toBe(runId)
    let closed = false, wake: (() => void) | undefined
    const queue: RunEvent[] = []
    const stream = { push(event: RunEvent) { queue.push(event); wake?.() },
      close() { closed = true; wake?.(); streams.delete(stream) } }
    streams.add(stream)
    return {
      snapshot: { run: run(), resize_revision: 0,
        terminal: { type: 'basic_vt', checkpoint: { run_id: runId, through_byte: 0,
          resize_revision: 0, size: { cols: 80, rows: 24 } }, resizes: [] },
        terminal_restore: new TextEncoder().encode('\u001bc'),
        replay: { chunks: [...chunks], first_available_byte: 0,
          latest_output_bytes: outputCursor, truncated: false } },
      async *events() {
        while (!closed) {
          if (queue.length) yield queue.shift()!
          else await new Promise<void>(resolve => { wake = resolve })
        }
      }, detach: async () => stream.close(), close: () => stream.close()
    }
  })
  const start = vi.fn(async () => { throw new Error('Unexpected native Run creation') })
  const stop = vi.fn(async () => { throw new Error('Unexpected native Run stop') })
  const clients: AgentMuxClient[] = [], events: AgentMuxClientEvent[] = []
  const observations: unknown[] = [], ingress: unknown[] = [], submissions: unknown[] = [], restarts: unknown[] = []
  async function connect() {
    const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(path), providers: [provider] })
    // Keep the constructor's adapter object: the coordinator and screen owner already reference it.
    // Control only its SDK transport, never a private admission/Hook/registry method.
    const adapter = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
    Object.assign(adapter, { client: { list: async () => [{ id: runId }],
      status: async () => run(), recoverableInput, attachTerminal, start, stop },
      runtime: { daemonInstanceId: 'synthetic-daemon' } })
    clients.push(client)
    client.onEvent(event => events.push(event))
    await client.connect()
    expect(client.agentSessions().map(s => [s.agentSessionId, s.run.runId])).toEqual([[sessionId, runId]])
    expect((await client.listRuns()).map(r => [r.runId, r.state])).toEqual([[runId, 'running']])
    return client
  }
  let client: AgentMuxClient
  try { client = await connect() } catch (error) {
    for (const c of clients) await c.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  let receiptNumber = 0
  async function feed(eventName: string, payload: Payload = {}, receiptId?: string, badToken = false) {
    const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
      method: 'POST', headers: { authorization: `Bearer ${badToken ? 'wrong' : token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: receiptId ?? `receipt-${++receiptNumber}`, eventName, payload })
    })
    ingress.push({ eventName, payload, receiptId, badToken, status: response.status, body: await response.text() })
    return response.status
  }
  async function stored() {
    const rows = (await new AgentMuxFileAgentSessionStore(path).load()).map(normalizeStoredAgentSession)
    expect(rows).toHaveLength(1)
    observations.push(structuredClone(rows[0]))
    return rows[0]!
  }
  const close = async () => {
    try {
      const evidence = process.env.NATIVE_SUBJECT_EVIDENCE_DIRECTORY
      if (evidence) {
        await mkdir(evidence, { recursive: true })
        await writeFile(join(evidence, `${root.split('/').at(-1)}.json`), JSON.stringify({
          test: expect.getState().currentTestName, mode, shape, tracking, root, pid: process.pid,
          ingress, observations, submissions, restarts, events, writes,
          controls: { starts: start.mock.calls.length, stops: stop.mock.calls.length }
        }, null, 2) + '\n')
      }
    } finally {
      for (const c of clients) await c.dispose()
      for (const stream of streams) stream.close()
      releaseSubagentRoster(runId)
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  }
  // Capture the public condition once per logical intent, including its idempotent retries.
  const promptConditions = new Map<string, ReturnType<typeof agentPromptCondition>>()
  const inputFences = new Map<string, number>()
  return { get client() { return client }, root, feed, stored, writes, events, start, stop, recoverableInput, attachTerminal,
    send: async (operationId: string, prompt: string, expectedCompletionId?: string) => {
      const observed = client.agentSession(sessionId)
      expect(observed.run.runId).toBe(runId)
      let condition = promptConditions.get(operationId)
      if (!condition) {
        condition = agentPromptCondition(observed)
        expect(condition).toEqual({
          expectedRun: observed.run,
          afterSubmissionId: observed.promptCompletionAdmission === undefined
            ? null : observed.promptCompletionAdmission.submissionId
        })
        promptConditions.set(operationId, condition)
      }
      const automatic: Pick<Parameters<AgentMuxClient['submitAgentPrompt']>[0], 'expectedCompletionId' | 'expectedInputByte'> = {}
      if (expectedCompletionId !== undefined) {
        let expectedInputByte = inputFences.get(operationId)
        if (expectedInputByte === undefined) {
          const observedRun = (await client.listRuns()).find(run => run.runId === observed.run.runId)
          expect(observedRun).toBeDefined()
          if (!observedRun) throw new Error('Expected the fixture Run input observation')
          expectedInputByte = observedRun.acceptedInputBytes
          inputFences.set(operationId, expectedInputByte)
        }
        automatic.expectedCompletionId = expectedCompletionId
        automatic.expectedInputByte = expectedInputByte
      }
      try {
        const result = await client.submitAgentPrompt({ agentSessionId: sessionId, operationId, prompt, ...condition, ...automatic })
        submissions.push({ operationId, prompt, expectedCompletionId, condition, automatic, result })
        return result
      } catch (error) {
        submissions.push({ operationId, prompt, expectedCompletionId, condition, automatic,
          error: error instanceof Error ? { message: error.message, code: (error as { code?: string }).code } : String(error) })
        throw error
      }
    },
    async reopen() {
      await client.dispose()
      const expected = (await store.load()).map(normalizeStoredAgentSession)
      expect(expected).toHaveLength(1)
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.startsWith('AGENTMUX_')) delete env[key]
      Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'),
        AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'queue.ndjson'), AGENTMUX_AGENT_SESSION_STORE: path })
      const script = `
        import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
        os.homedir=()=>${JSON.stringify(join(root, 'home'))};syncBuiltinESMExports();
        const {AgentMuxClient,AgentMuxFileAgentSessionStore,defineAgentProvider}=await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
        const store=new AgentMuxFileAgentSessionStore(process.argv[1]);
        const [session]=await store.load();
        const provider=defineAgentProvider({catalog:${JSON.stringify(provider.catalog)},buildArgs:()=>[],hook:{rules:[]}});
        let starts=0,stops=0;
        const client=new AgentMuxClient({store,providers:[provider]});
        Object.assign(client.kernel,{client:{list:async()=>[{id:session.run.runId}],status:async()=>(${JSON.stringify(run())}),
          start:async()=>{starts++;throw Error('Unexpected child Run start')},stop:async()=>{stops++;throw Error('Unexpected child Run stop')}},runtime:{daemonInstanceId:'synthetic-daemon'}});
        await client.connect();
        console.log(JSON.stringify({pid:process.pid,sessions:await store.load(),publicSessions:client.agentSessions(),starts,stops,
          env:Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('AGENTMUX_')))}));
        await client.dispose();`
      const restored = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script, path], { env, timeout: 8000 })).stdout)
      expect(restored.pid).not.toBe(process.pid)
      restarts.push(restored)
      expect(restored.sessions).toHaveLength(1)
      expect(restored.sessions.map(recoveryFacts)).toEqual(expected.map(recoveryFacts))
      expect(restored.publicSessions.map((s: AgentMuxStoredAgentSession) => [s.agentSessionId, s.run.runId])).toEqual([[sessionId, runId]])
      const { hookBindingId: _binding, hookToken: _token, ...publicSession } = recoveryFacts(expected[0]!)
      expect(restored.publicSessions.map(recoveryFacts)).toEqual([publicSession])
      expect([restored.starts, restored.stops]).toEqual([0, 0])
      expect(restored.env).toEqual({ AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'),
        AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'queue.ndjson'), AGENTMUX_AGENT_SESSION_STORE: path })
      client = await connect()
    }, close }
}

function states(h: Awaited<ReturnType<typeof harness>>) {
  return h.events.filter(e => e.type === 'agent-status').map(e => e.state)
}
async function healthy(h: Awaited<ReturnType<typeof harness>>) {
  expect(h.client.agentSessions().map(s => [s.agentSessionId, s.run.runId])).toEqual([[sessionId, runId]])
  expect((await h.client.listRuns()).map(r => [r.runId, r.state])).toEqual([[runId, 'running']])
  expect([h.start.mock.calls.length, h.stop.mock.calls.length]).toEqual([0, 0])
}
const question = { tool_name: 'select', tool_use_id: 'shared-question',
  tool_input: { questions: [{ question: 'Choose?', options: [{ label: 'First' }, { label: 'Second' }] }] } }
async function openMain(h: Awaited<ReturnType<typeof harness>>) {
  expect(await h.feed('turn_open', { session_id: 'owned-main', transcript_path: join(h.root, 'main.jsonl') }, 'main-open')).toBe(204)
  expect((await h.stored()).nativeHandle).toEqual({ kind: 'provider',
    providerId: (await h.stored()).providerId, sessionId: 'owned-main', transcriptPath: join(h.root, 'main.jsonl') })
}

describe('native Hook subject and turn boundary through built public Core', () => {
  it.each(cases)('$mode/$shape persists known main end as unknown, keeps neutral diagnostics and consumes it once after restart', async ({ mode, shape }) => {
    const h = await harness(mode, shape)
    try {
      await openMain(h)
      const [eventName, payload] = cancelled(shape)
      expect(await h.feed(eventName, payload, 'main-cancel', true)).toBe(403)
      expect((await h.stored()).hookReceipt?.id).toBe('main-open')
      expect(await h.feed(eventName, payload, 'main-cancel')).toBe(204)
      const ended = await h.stored()
      expect(ended.semanticStatus).toMatchObject({ state: 'running', source: 'native-hook', detail: eventName,
        observedAt: ended.hookReceipt!.observedAt })
      expect(ended.hookReceipt).toMatchObject({ id: 'main-cancel', eventName, lifecycleEvent: 'turn-end', run: { runId } })
      expect(ended.terminalPromptReadiness).toMatchObject({ source: 'native-stop', id: 'main-cancel', run: { runId },
        observedAt: ended.hookReceipt!.observedAt })
      expect(agentTurnCompletionIdentity(ended)).toBeUndefined()
      expect(agentTurnEndBoundary(ended)?.id).toBe('main-cancel')
      await expect(h.send('automatic-cancel', 'automatic', JSON.stringify([runId, ended.hookReceipt!.observedAt])))
        .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
      expect(h.writes).toEqual([])
      expect(await h.feed('Notification', { message: 'after cancellation' }, 'neutral-after-end')).toBe(204)
      expect(await h.feed('PostToolUse', { tool_name: 'shell', tool_use_id: 'late-main' }, 'late-tool')).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(ended.semanticStatus)
      expect(states(h)).toEqual(['working', 'unknown'])
      await h.reopen()
      expect(h.client.agentSession(sessionId).semanticStatus).toEqual(ended.semanticStatus)
      expect(agentTurnEndBoundary(h.client.agentSession(sessionId))?.id).toBe('main-cancel')
      await h.send('manual-next', 'hello')
      const writes = mode === 'single-phase' ? ['hello\r'] : ['hello', '\r']
      expect(h.writes).toEqual(writes)
      expect((await h.stored()).promptCompletionAdmission?.completionId).toBeUndefined()
      expect((await h.stored()).terminalPromptReadiness?.consumedBySubmissionId).toBe('manual-next')
      await h.send('manual-next', 'hello')
      await expect(h.send('manual-again', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      await h.reopen()
      expect(await h.feed(eventName, payload, 'main-cancel')).toBe(204)
      await expect(h.send('replayed-end', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual(writes)
      const timeline = await h.client.sessionTimeline(sessionId)
      expect(timeline.items.map(item => item.title)).toEqual(['turn_open', eventName, 'Notification', 'shell', 'Prompt'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(modes)('%s durable null forbids an authoritative cursor while keeping the healthy Session', async mode => {
    const h = await harness(mode, 'flat')
    try {
      await openMain(h)
      expect(await h.feed('Stop', { phase: 'step' }, 'no-lifecycle')).toBe(204)
      const current = await h.stored()
      const store = new AgentMuxFileAgentSessionStore(join(h.root, 'sessions.json'))
      await expect(store.compareAndSwap(current, { ...current,
        hookReceipt: { ...current.hookReceipt!, outputCursorBytes: 34 } }))
        .rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
      expect((await h.stored()).hookReceipt).toEqual(current.hookReceipt)
      await h.reopen()
      expect(h.client.agentSession(sessionId).hookReceipt?.lifecycleEvent).toBeNull()
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(cases)('$mode/$shape ordinary unknown notification is neutral for published and durable working state', async ({ mode, shape }) => {
    const h = await harness(mode, shape)
    try {
      await openMain(h)
      const working = (await h.stored()).semanticStatus
      expect(await h.feed('Notification', { message: 'ordinary' }, 'neutral-during-work')).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(working)
      expect((await h.stored()).terminalPromptReadiness).toBeUndefined()
      expect(states(h)).toEqual(['working'])
      await h.reopen()
      await expect(h.send('ordinary-is-not-end', 'hello')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual([])
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual(['turn_open', 'Notification'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(cases)('$mode/$shape explicit lifecycle null survives HTTP and restart without treating a provisional Stop as main end', async ({ mode, shape }) => {
    const h = await harness(mode, shape)
    try {
      await openMain(h)
      const working = (await h.stored()).semanticStatus
      const payload = shape === 'flat' ? { phase: 'step' } : { extra: { category: 'provisional' } }
      expect(await h.feed('Stop', payload, 'provisional-stop')).toBe(204)
      const observed = await h.stored()
      expect(observed.hookReceipt).toMatchObject({ id: 'provisional-stop', eventName: 'Stop', lifecycleEvent: null })
      expect(observed.semanticStatus).toEqual(working)
      expect(observed.terminalPromptReadiness).toBeUndefined()
      expect(agentTurnCompletionIdentity(observed)).toBeUndefined()
      expect(agentTurnEndBoundary(observed)).toBeUndefined()
      expect(states(h)).toEqual(['working'])
      await h.reopen()
      expect(h.client.agentSession(sessionId).hookReceipt).toEqual(observed.hookReceipt)
      expect(await h.feed('PostToolUse', { tool_name: 'shell' }, 'continues-after-step')).toBe(204)
      expect((await h.stored()).semanticStatus?.detail).toBe('PostToolUse')
      expect(states(h)).toEqual(['working', 'working'])
      await expect(h.send('provisional-manual', 'hello')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      await expect(h.send('provisional-automatic', 'hello', JSON.stringify([runId, observed.hookReceipt!.observedAt])))
        .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
      expect(h.writes).toEqual([])
      expect(await h.feed('Stop', {}, 'genuine-stop')).toBe(204)
      const ended = await h.stored()
      expect(ended.hookReceipt).toMatchObject({ id: 'genuine-stop', eventName: 'Stop', lifecycleEvent: 'turn-end' })
      expect(ended.semanticStatus?.state).toBe('done')
      expect(agentTurnEndBoundary(ended)?.id).toBe('genuine-stop')
      await h.reopen()
      await h.send('genuine-success-next', 'hello', agentTurnCompletionIdentity(ended))
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual(['turn_open', 'Stop', 'shell', 'Stop', 'Prompt'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(modes)('%s canonical failure ends the main turn with unknown outcome and permits one manual prompt', async mode => {
    const h = await harness(mode, 'flat')
    try {
      await openMain(h)
      expect(await h.feed('StopFailure', {}, 'failed-main')).toBe(204)
      const ended = await h.stored()
      expect(ended.semanticStatus?.state).toBe('running')
      expect(ended.hookReceipt?.lifecycleEvent).toBe('turn-end')
      expect(agentTurnCompletionIdentity(ended)).toBeUndefined()
      expect(states(h)).toEqual(['working', 'unknown'])
      await h.reopen()
      await h.send('after-failure', 'hello')
      await expect(h.send('failure-once', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(cases)('$mode/$shape child and provisional Stop retain main usage and full tool trace until a real main end', async ({ mode, shape }) => {
    const h = await harness(mode, shape)
    try {
      const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5, observedAt: 1 }
      expect(await h.feed('turn_open', { session_id: 'owned-main', agentmuxUsage: usage }, 'main-usage')).toBe(204)
      const main = await h.stored()
      expect(main.turnUsage).toEqual(usage)
      const childUsage = { inputTokens: 90, outputTokens: 9, totalTokens: 99, observedAt: 1 }
      expect(await h.feed('Stop', { ...child(shape), agentmuxUsage: childUsage }, 'child-stop-with-usage')).toBe(204)
      expect((await h.stored()).turnUsage).toEqual(usage)
      const provisional = shape === 'flat' ? { phase: 'step' } : { extra: { category: 'provisional' } }
      expect(await h.feed('Stop', provisional, 'provisional-with-main-usage')).toBe(204)
      expect((await h.stored()).turnUsage).toEqual(usage)
      expect(await h.feed('PostToolUse', { ...child(shape), tool_name: 'shell', tool_use_id: 'child-tool',
        tool_response: 'child result', text: 'child trace', agentmuxUsage: childUsage }, 'child-tool-result')).toBe(204)
      const childResult = await h.stored()
      expect(childResult.turnUsage).toEqual(usage)
      expect(childResult.semanticStatus).toEqual(main.semanticStatus)
      expect(childResult.nativeHandle).toEqual(main.nativeHandle)
      expect(childResult.terminalPromptReadiness).toBeUndefined()
      const [eventName, payload] = cancelled(shape)
      expect(await h.feed(eventName, payload, 'real-main-end-clears-usage')).toBe(204)
      expect((await h.stored()).turnUsage).toBeUndefined()
      expect(states(h)).toEqual(['working', 'unknown'])
      const trace = await h.client.sessionTimeline(sessionId)
      expect(trace.items.map(item => item.title)).toEqual(['turn_open', 'Stop', 'Stop', 'shell', 'Assistant response', eventName])
      expect(trace.items.filter(item => item.kind === 'tool_call').map(item => [item.toolOutput, item.status]))
        .toEqual([['child result', 'complete']])
      expect(trace.items.filter(item => item.kind === 'assistant_message').map(item => item.content)).toEqual(['child trace'])
      await h.reopen()
      expect(h.client.agentSession(sessionId).turnUsage).toBeUndefined()
      expect(h.client.agentSession(sessionId).semanticStatus?.state).toBe('running')
      expect(agentTurnCompletionIdentity(h.client.agentSession(sessionId))).toBeUndefined()
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(cases)('$mode/$shape child begin, finish and waiting preserve the active main identity, state and interaction', async ({ mode, shape }) => {
    const h = await harness(mode, shape)
    try {
      await openMain(h)
      const main = await h.stored()
      const subject = { ...child(shape), session_id: 'child-native', transcript_path: join(h.root, 'child.jsonl') }
      for (const eventName of ['finish', 'turn_open']) {
        expect(await h.feed(eventName, subject, `child-${eventName}`)).toBe(204)
        const after = await h.stored()
        expect(after.semanticStatus).toEqual(main.semanticStatus)
        expect(after.nativeHandle).toEqual(main.nativeHandle)
        expect(after.terminalPromptReadiness).toBeUndefined()
        expect(after.hookReceipt?.eventName).toBe(eventName)
        expect(agentTurnCompletionIdentity(after)).toBeUndefined()
        expect(agentTurnEndBoundary(after)).toBeUndefined()
      }
      expect(await h.feed('ask', { ...question, ...subject }, 'child-question')).toBe(204)
      expect((await h.stored()).pendingInteraction).toBeUndefined()
      expect((await h.stored()).semanticStatus).toEqual(main.semanticStatus)
      expect(states(h)).toEqual(['working'])
      await expect(h.send('child-does-not-end-main', 'next')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(await h.feed('ask', question, 'main-question')).toBe(204)
      const waiting = await h.stored()
      expect(waiting.semanticStatus?.state).toBe('waiting')
      expect(waiting.pendingInteraction?.request.id).toBe('main-question')
      expect(await h.feed('ask', { ...question, ...subject, tool_use_id: 'child-question' }, 'second-child-question')).toBe(204)
      expect(await h.feed('answer-observed', { ...question, ...subject }, 'child-answer')).toBe(204)
      expect((await h.stored()).pendingInteraction).toEqual(waiting.pendingInteraction)
      expect((await h.stored()).semanticStatus).toEqual(waiting.semanticStatus)
      expect(states(h)).toEqual(['working', 'waiting'])
      await h.reopen()
      expect(h.client.agentSession(sessionId).pendingInteraction).toEqual(waiting.pendingInteraction)
      expect(h.client.agentSession(sessionId).nativeHandle).toEqual(main.nativeHandle)
      expect(await h.feed('answer-observed', question, 'main-answer')).toBe(204)
      expect((await h.stored()).pendingInteraction).toBeUndefined()
      expect(await h.feed('finish', {}, 'main-finish')).toBe(204)
      const completed = await h.stored(), completionId = agentTurnCompletionIdentity(completed)
      expect(completionId).toBe(JSON.stringify([runId, completed.hookReceipt!.observedAt]))
      expect(states(h)).toEqual(['working', 'waiting', 'done'])
      await h.send('successful-automatic', 'hello', completionId)
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
      const timeline = await h.client.sessionTimeline(sessionId)
      expect(timeline.items.map(item => item.title)).toEqual(['turn_open', 'finish', 'turn_open', 'select',
        'select', 'select', 'select', 'select', 'finish', 'Prompt'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(cases)('$mode/$shape child reopening cannot invalidate a completed main boundary across a fresh Client', async ({ mode, shape }) => {
    const h = await harness(mode, shape)
    try {
      await openMain(h)
      expect(await h.feed('finish', {}, 'main-success')).toBe(204)
      const completed = await h.stored()
      const completionId = agentTurnCompletionIdentity(completed)
      expect(completionId).toBe(JSON.stringify([runId, completed.hookReceipt!.observedAt]))
      expect(await h.feed('turn_open', { ...child(shape), session_id: 'child-native' }, 'late-child-open')).toBe(204)
      expect(await h.feed('PostToolUse', { tool_name: 'shell' }, 'late-main-tool')).toBe(204)
      const after = await h.stored()
      expect(after.semanticStatus).toEqual(completed.semanticStatus)
      expect(after.terminalPromptReadiness).toMatchObject(completed.terminalPromptReadiness!)
      expect(after.nativeHandle).toEqual(completed.nativeHandle)
      expect(agentTurnCompletionIdentity(after)).toBe(completionId)
      expect(states(h)).toEqual(['working', 'done'])
      await h.reopen()
      expect(await h.feed('PostToolUse', { tool_name: 'shell' }, 'late-tool-after-restart')).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(completed.semanticStatus)
      await h.send('completed-main-next', 'hello', completionId)
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(modes)('%s a real parent end remains usable while successful aggregation waits for its known roster', async mode => {
    const h = await harness(mode, 'flat', true)
    try {
      await openMain(h)
      const main = await h.stored()
      expect(await h.feed('child_open', { agent_name: 'child' }, 'roster-open')).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(main.semanticStatus)
      expect(await h.feed('child_close', { agent_name: 'unregistered-child' }, 'unknown-roster-close')).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(main.semanticStatus)
      expect(await h.feed('finish', {}, 'parent-pending')).toBe(204)
      const pending = await h.stored()
      expect(pending.semanticStatus?.state).toBe('working')
      expect(pending.hookReceipt?.lifecycleEvent).toBe('turn-end')
      expect(pending.terminalPromptReadiness).toMatchObject({ source: 'native-stop', id: 'parent-pending', run: { runId } })
      expect(agentTurnCompletionIdentity(pending)).toBeUndefined()
      expect(agentTurnEndBoundary(pending)?.id).toBe('parent-pending')
      await expect(h.send('parent-success-still-waiting', 'hello', JSON.stringify([runId, pending.hookReceipt!.observedAt])))
        .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
      expect(await h.feed('child_close', { agent_name: 'child', session_id: 'child-native' }, 'roster-settled')).toBe(204)
      const settled = await h.stored()
      expect(settled.semanticStatus?.state).toBe('done')
      expect(settled.nativeHandle).toEqual(main.nativeHandle)
      expect(settled.hookReceipt).toMatchObject({ eventName: 'child_close', lifecycleEvent: 'turn-end' })
      expect(settled.terminalPromptReadiness).toMatchObject({ source: 'native-stop', id: 'roster-settled', run: { runId } })
      expect(await h.feed('child_close', { agent_name: 'child' }, 'orphan-stop')).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(settled.semanticStatus)
      expect(states(h)).toEqual(['working', 'working', 'done'])
      await h.reopen()
      await h.send('settled-parent-next', 'hello', agentTurnCompletionIdentity(settled))
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual([
        'turn_open', 'child_open', 'child_close', 'finish', 'child_close', 'child_close', 'Prompt'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(modes)('%s a cancelled pending parent cannot become successful when its child later settles', async mode => {
    const h = await harness(mode, 'flat', true)
    try {
      await openMain(h)
      expect(await h.feed('child_open', { agent_name: 'child' }, 'cancel-roster-open')).toBe(204)
      expect(await h.feed('finish', {}, 'cancel-parent-pending')).toBe(204)
      expect((await h.stored()).terminalPromptReadiness).toMatchObject({ source: 'native-stop', id: 'cancel-parent-pending', run: { runId } })
      expect(await h.feed('notice', { reason: 'cancelled' }, 'cancel-pending-parent')).toBe(204)
      const cancelled = await h.stored()
      expect(cancelled.semanticStatus?.state).toBe('running')
      expect(agentTurnEndBoundary(cancelled)?.id).toBe('cancel-pending-parent')
      expect(await h.feed('child_close', { agent_name: 'child' }, 'settles-after-parent-cancel')).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(cancelled.semanticStatus)
      expect((await h.stored()).terminalPromptReadiness).toMatchObject(cancelled.terminalPromptReadiness!)
      expect(agentTurnCompletionIdentity(await h.stored())).toBeUndefined()
      expect(states(h)).toEqual(['working', 'working', 'unknown'])
      await h.reopen()
      await expect(h.send('cancel-parent-automatic', 'hello', JSON.stringify([runId, cancelled.hookReceipt!.observedAt])))
        .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
      await h.send('cancel-parent-manual', 'hello')
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
      await healthy(h)
    } finally { await h.close() }
  })
})

const nextTurns = modes.flatMap(mode => ['UserPromptSubmit', 'turn_open'].map(reopenEvent => ({ mode, reopenEvent })))
describe('frozen candidate independent roster adjacency', () => {
  it.each(nextTurns)('$mode/$reopenEvent old child stop cannot finish a newly-opened main turn', async ({ mode, reopenEvent }) => {
    const h = await harness(mode, 'flat', true)
    try {
      await openMain(h)
      expect(await h.feed('child_open', { agent_name: 'old-child' }, 'old-child-start')).toBe(204)
      expect(await h.feed('finish', {}, 'old-parent-real-end')).toBe(204)
      const pending = await h.stored()
      expect(pending.semanticStatus?.state).toBe('working')
      // User/native raw input uses the public Client and same existing SDK recoverable transport.
      const ack = await h.client.writeAgent({ agentSessionId: sessionId, expectedRun: { runId },
        data: 'native next\r', source: 'user' })
      expect(ack.appliedByteRange).toEqual({ startByte: 10, endByte: 22 })
      expect(h.writes).toEqual(['native next\r'])
      expect(await h.feed(reopenEvent, { session_id: 'owned-main' }, 'next-main-start')).toBe(204)
      const nextMain = await h.stored()
      expect(nextMain.semanticStatus).toMatchObject({ state: 'working', detail: reopenEvent })
      expect(nextMain.hookReceipt?.lifecycleEvent).toBe(reopenEvent === 'UserPromptSubmit' ? 'user-prompt-submit' : 'turn-start')
      await h.reopen()
      expect(await h.feed('child_close', { agent_name: 'old-child' }, 'old-child-late-stop')).toBe(204)
      const afterOldChild = await h.stored()
      await healthy(h)
      expect(afterOldChild.nativeHandle).toEqual(nextMain.nativeHandle)
      // This assertion must go RED if stale parent pending falsely finishes the new main turn.
      expect(afterOldChild.semanticStatus).toEqual(nextMain.semanticStatus)
      expect(afterOldChild.terminalPromptReadiness).toBeUndefined()
      expect(agentTurnCompletionIdentity(afterOldChild)).toBeUndefined()
      expect(agentTurnEndBoundary(afterOldChild)).toBeUndefined()
      await h.reopen()
      expect(h.client.agentSession(sessionId).semanticStatus).toEqual(nextMain.semanticStatus)
      await expect(h.send('late-child-cannot-admit', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual([
        'turn_open', 'child_open', 'finish', reopenEvent, 'child_close'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(modes)('%s declared real parent end permits manual input despite background roster; automatic still waits', async mode => {
    const h = await harness(mode, 'flat', true)
    try {
      await openMain(h)
      expect(await h.feed('child_open', { agent_name: 'background-child' }, 'background-child-start')).toBe(204)
      // This rule explicitly declares real main turn-end; no vendor or child-count availability inference.
      expect(await h.feed('finish', {}, 'main-authoritative-end')).toBe(204)
      const ended = await h.stored()
      expect(ended.semanticStatus?.state).toBe('working')
      expect(agentTurnCompletionIdentity(ended)).toBeUndefined()
      await expect(h.send('automatic-still-waits', 'automatic', JSON.stringify([runId, ended.hookReceipt!.observedAt])))
        .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
      expect(await h.feed('Notification', { message: 'after parent end' }, 'parent-end-notice')).toBe(204)
      expect(await h.feed('PostToolUse', { tool_name: 'shell' }, 'parent-end-late-tool')).toBe(204)
      await h.reopen()
      const freshEnd = agentTurnEndBoundary(h.client.agentSession(sessionId))
      let manualError: unknown
      try { await h.send('manual-after-known-parent-end', 'hello') } catch (error) { manualError = error }
      const afterManual = await h.stored()
      await healthy(h)
      expect(manualError).toBeUndefined()
      expect(freshEnd?.id).toBe('main-authoritative-end')
      expect(ended.hookReceipt?.lifecycleEvent).toBe('turn-end')
      expect(agentTurnEndBoundary(ended)?.id).toBe('main-authoritative-end')
      expect(afterManual.terminalPromptReadiness?.consumedBySubmissionId).toBe('manual-after-known-parent-end')
      const writes = mode === 'single-phase' ? ['hello\r'] : ['hello', '\r']
      expect(h.writes).toEqual(writes)
      await h.send('manual-after-known-parent-end', 'hello')
      await expect(h.send('manual-known-end-twice', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      await h.reopen()
      expect(h.client.agentSession(sessionId).terminalPromptReadiness?.consumedBySubmissionId).toBe('manual-after-known-parent-end')
      await expect(h.send('manual-known-end-after-restart', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual(writes)
      expect(await h.feed('UserPromptSubmit', { session_id: 'owned-main' }, 'manual-next-main-start')).toBe(204)
      expect(await h.feed('child_close', { agent_name: 'background-child' }, 'previous-child-settles')).toBe(204)
      const newMain = await h.stored()
      expect(newMain.semanticStatus).toMatchObject({ state: 'working', detail: 'UserPromptSubmit' })
      expect(newMain.terminalPromptReadiness).toBeUndefined()
      expect(agentTurnCompletionIdentity(newMain)).toBeUndefined()
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual([
        'turn_open', 'child_open', 'finish', 'Notification', 'shell', 'Prompt', 'UserPromptSubmit', 'child_close'])
      await healthy(h)
    } finally { await h.close() }
  })
})

describe('explicit generic producer facts control roster availability', () => {
  it.each(modes)('%s main reopening preserves known live children for later real parent aggregation', async mode => {
    const h = await harness(mode, 'flat', true)
    try {
      await openMain(h)
      expect(await h.feed('child_open', { agent_name: 'first' }, 'live-first')).toBe(204)
      expect(await h.feed('child_open', { agent_name: 'second' }, 'live-second')).toBe(204)
      expect(await h.feed('finish', {}, 'previous-parent-pending')).toBe(204)
      expect(await h.feed('UserPromptSubmit', { session_id: 'owned-main' }, 'current-parent-start')).toBe(204)
      expect(await h.feed('finish', {}, 'current-parent-ended')).toBe(204)
      const pending = await h.stored()
      expect(pending.semanticStatus?.state).toBe('working')
      expect(pending.hookReceipt?.lifecycleEvent).toBe('turn-end')
      expect(agentTurnEndBoundary(pending)?.id).toBe('current-parent-ended')
      expect(agentTurnCompletionIdentity(pending)).toBeUndefined()
      expect(await h.feed('child_close', { agent_name: 'first' }, 'first-settled')).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(pending.semanticStatus)
      await h.reopen()
      expect(agentTurnCompletionIdentity(h.client.agentSession(sessionId))).toBeUndefined()
      expect(await h.feed('child_close', { agent_name: 'second' }, 'last-settled')).toBe(204)
      const settled = await h.stored()
      expect(settled.semanticStatus?.state).toBe('done')
      expect(settled.nativeHandle).toEqual(pending.nativeHandle)
      expect(agentTurnCompletionIdentity(settled)).toBe(JSON.stringify([runId, settled.hookReceipt!.observedAt]))
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual([
        'turn_open', 'child_open', 'child_open', 'finish', 'UserPromptSubmit', 'finish', 'child_close', 'child_close'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(modes)('%s provisional parent observation declares no end; only later real parent end admits next input', async mode => {
    const h = await harness(mode, 'flat', true)
    try {
      await openMain(h)
      const main = await h.stored()
      expect(await h.feed('child_open', { agent_name: 'child' }, 'blocked-child-start')).toBe(204)
      expect(await h.feed('finish', { phase: 'provisional' }, 'explicit-parent-no-end')).toBe(204)
      const observer = await h.stored()
      expect(observer.hookReceipt?.lifecycleEvent).toBeNull()
      expect(observer.semanticStatus).toEqual(main.semanticStatus)
      expect(observer.terminalPromptReadiness).toBeUndefined()
      expect(agentTurnCompletionIdentity(observer)).toBeUndefined()
      expect(agentTurnEndBoundary(observer)).toBeUndefined()
      await expect(h.send('no-end-manual', 'hello')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(await h.feed('child_close', { agent_name: 'child' }, 'child-settles-before-real-parent-end')).toBe(204)
      const settled = await h.stored()
      expect(settled.semanticStatus).toEqual(main.semanticStatus)
      expect(settled.terminalPromptReadiness).toBeUndefined()
      expect(agentTurnCompletionIdentity(settled)).toBeUndefined()
      expect(agentTurnEndBoundary(settled)).toBeUndefined()
      expect(await h.feed('finish', {}, 'real-parent-ended')).toBe(204)
      const ended = await h.stored()
      expect(ended.semanticStatus?.state).toBe('done')
      expect(ended.hookReceipt?.lifecycleEvent).toBe('turn-end')
      expect(agentTurnEndBoundary(ended)?.id).toBe('real-parent-ended')
      await h.send('real-parent-next', 'hello', agentTurnCompletionIdentity(ended))
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual([
        'turn_open', 'child_open', 'finish', 'child_close', 'finish', 'Prompt'])
      await healthy(h)
    } finally { await h.close() }
  })
})

const parentUsage = {
  inputTokens: 137, outputTokens: 29, totalTokens: 166, observedAt: 1790910001111,
  context: { capacityTokens: 200000, usedTokens: 19117 }
} satisfies AgentTurnUsage
const childUsage = {
  inputTokens: 90, outputTokens: 9, totalTokens: 99, observedAt: 1790910002222,
  context: { capacityTokens: 4096, usedTokens: 990 }
} satisfies AgentTurnUsage
const pendingCases = modes.flatMap(mode => [false, true].map(childCarriesUsage => ({ mode, childCarriesUsage })))

describe('main usage subject and real parent roster settlement through public Core', () => {
  it.each(pendingCases)('$mode/childUsage=$childCarriesUsage last known child settlement must retain real parent usage', async ({ mode, childCarriesUsage }) => {
    const h = await harness(mode, 'flat', true)
    try {
      expect(HOOK_PAYLOAD_USAGE_KEY).toBe('agentmuxUsage')
      expect(parseTurnUsage(parentUsage)).toEqual(parentUsage)
      expect(parseTurnUsage(childUsage)).toEqual(childUsage)
      await openMain(h)
      expect(await h.feed('child_open', { agent_name: 'first' }, 'first-child-start')).toBe(204)
      expect(await h.feed('child_open', { agent_name: 'last' }, 'last-child-start')).toBe(204)
      expect(await h.feed('finish', { [HOOK_PAYLOAD_USAGE_KEY]: parentUsage }, 'real-parent-end-with-usage')).toBe(204)
      const parent = await h.stored()
      expect(parent.semanticStatus?.state).toBe('working')
      expect(parent.hookReceipt?.lifecycleEvent).toBe('turn-end')
      expect(parent.turnUsage).toEqual(parentUsage)
      expect(agentTurnCompletionIdentity(parent)).toBeUndefined()
      expect(agentTurnEndBoundary(parent)?.id).toBe('real-parent-end-with-usage')
      await h.reopen()
      expect(h.client.agentSession(sessionId).turnUsage).toEqual(parentUsage)
      const tokens = childCarriesUsage ? { [HOOK_PAYLOAD_USAGE_KEY]: childUsage } : {}
      expect(await h.feed('child_close', { agent_name: 'first', ...tokens }, 'first-child-settled')).toBe(204)
      const stillPending = await h.stored()
      expect(stillPending.semanticStatus).toEqual(parent.semanticStatus)
      expect(stillPending.hookReceipt?.lifecycleEvent).toBeNull()
      expect(stillPending.turnUsage).toEqual(parentUsage)
      expect(await h.feed('child_close', { agent_name: 'last', ...tokens }, 'last-child-settled')).toBe(204)
      const settled = await h.stored()
      expect(settled.semanticStatus?.state).toBe('done')
      expect(settled.hookReceipt).toMatchObject({ id: 'last-child-settled', eventName: 'child_close', lifecycleEvent: 'turn-end' })
      expect(settled.nativeHandle).toEqual(parent.nativeHandle)
      expect(agentTurnCompletionIdentity(settled)).toBe(JSON.stringify([runId, settled.hookReceipt!.observedAt]))
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual([
        'turn_open', 'child_open', 'child_open', 'finish', 'child_close', 'child_close'])
      await h.reopen()
      await healthy(h)
      // Final assertion is the new falsifiable constraint. All actual observations/restarts are
      // captured before it; an empty or invalid sample cannot satisfy the earlier exact assertions.
      expect({ stored: settled.turnUsage, publicFresh: h.client.agentSession(sessionId).turnUsage })
        .toEqual({ stored: parentUsage, publicFresh: parentUsage })
    } finally { await h.close() }
  })

  it.each(modes)('%s nonpending known child is neutral and keeps the preceding real main sample', async mode => {
    const h = await harness(mode, 'flat', true)
    try {
      await openMain(h)
      expect(await h.feed('finish', { [HOOK_PAYLOAD_USAGE_KEY]: parentUsage }, 'preceding-real-main-sample')).toBe(204)
      expect((await h.stored()).turnUsage).toEqual(parentUsage)
      expect(await h.feed('UserPromptSubmit', {}, 'next-main-open')).toBe(204)
      const working = await h.stored()
      expect(working.semanticStatus?.state).toBe('working')
      expect(working.turnUsage).toEqual(parentUsage)
      expect(await h.feed('child_open', { agent_name: 'without-parent-end' }, 'neutral-child-start')).toBe(204)
      expect(await h.feed('child_close', { agent_name: 'without-parent-end', [HOOK_PAYLOAD_USAGE_KEY]: childUsage }, 'neutral-child-stop')).toBe(204)
      const neutral = await h.stored()
      expect(neutral.semanticStatus).toEqual(working.semanticStatus)
      expect(neutral.hookReceipt?.lifecycleEvent).toBeNull()
      expect(neutral.turnUsage).toEqual(parentUsage)
      expect(neutral.terminalPromptReadiness).toBeUndefined()
      expect(agentTurnCompletionIdentity(neutral)).toBeUndefined()
      await h.reopen()
      expect(h.client.agentSession(sessionId).turnUsage).toEqual(parentUsage)
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual([
        'turn_open', 'finish', 'UserPromptSubmit', 'child_open', 'child_close'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(modes)('%s genuine new main end without a sample clears the previous turn usage', async mode => {
    const h = await harness(mode, 'flat', true)
    try {
      await openMain(h)
      expect(await h.feed('finish', { [HOOK_PAYLOAD_USAGE_KEY]: parentUsage }, 'preceding-real-main-sample')).toBe(204)
      expect((await h.stored()).turnUsage).toEqual(parentUsage)
      expect(await h.feed('UserPromptSubmit', {}, 'new-main-open')).toBe(204)
      expect((await h.stored()).turnUsage).toEqual(parentUsage)
      expect(await h.feed('finish', {}, 'real-new-main-end-without-sample')).toBe(204)
      const ended = await h.stored()
      expect(ended.semanticStatus?.state).toBe('done')
      expect(ended.hookReceipt?.lifecycleEvent).toBe('turn-end')
      expect(ended.turnUsage).toBeUndefined()
      expect(agentTurnEndBoundary(ended)?.id).toBe('real-new-main-end-without-sample')
      await h.reopen()
      expect(h.client.agentSession(sessionId).turnUsage).toBeUndefined()
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual([
        'turn_open', 'finish', 'UserPromptSubmit', 'finish'])
      await healthy(h)
    } finally { await h.close() }
  })
})

describe('real main usage updates and absence through public Core', () => {
  it.each(modes)('%s a new real main sample replaces the preceding full token and context sample', async mode => {
    const h = await harness(mode, 'flat', true)
    try {
      await openMain(h)
      expect(await h.feed('finish', { [HOOK_PAYLOAD_USAGE_KEY]: parentUsage }, 'previous-main-sample')).toBe(204)
      expect((await h.stored()).turnUsage).toEqual(parentUsage)
      expect(await h.feed('UserPromptSubmit', {}, 'new-main-start')).toBe(204)
      expect((await h.stored()).turnUsage).toEqual(parentUsage)
      const currentUsage = { inputTokens: 17, outputTokens: 23, totalTokens: 40, observedAt: 1790910003333,
        context: { capacityTokens: 200000, usedTokens: 12000 } } satisfies AgentTurnUsage
      expect(parseTurnUsage(currentUsage)).toEqual(currentUsage)
      expect(await h.feed('finish', { [HOOK_PAYLOAD_USAGE_KEY]: currentUsage }, 'new-real-main-sample')).toBe(204)
      const ended = await h.stored()
      expect(ended.turnUsage).toEqual(currentUsage)
      expect(ended.turnUsage).not.toEqual(parentUsage)
      expect(ended.semanticStatus?.state).toBe('done')
      expect(ended.hookReceipt?.lifecycleEvent).toBe('turn-end')
      expect(agentTurnCompletionIdentity(ended)).toBe(JSON.stringify([runId, ended.hookReceipt!.observedAt]))
      await h.reopen()
      expect(h.client.agentSession(sessionId).turnUsage).toEqual(currentUsage)
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual([
        'turn_open', 'finish', 'UserPromptSubmit', 'finish'])
      await healthy(h)
    } finally { await h.close() }
  })

  it.each(modes)('%s a real new main cancel without usage clears the old sample and keeps manual admission', async mode => {
    const h = await harness(mode, 'flat', true)
    try {
      await openMain(h)
      expect(await h.feed('finish', { [HOOK_PAYLOAD_USAGE_KEY]: parentUsage }, 'previous-main-sample')).toBe(204)
      expect((await h.stored()).turnUsage).toEqual(parentUsage)
      expect(await h.feed('UserPromptSubmit', {}, 'new-main-start')).toBe(204)
      expect((await h.stored()).turnUsage).toEqual(parentUsage)
      expect(await h.feed('notice', { reason: 'cancelled' }, 'new-main-cancel-no-usage')).toBe(204)
      const ended = await h.stored()
      expect(ended.turnUsage).toBeUndefined()
      expect(ended.semanticStatus?.state).toBe('running')
      expect(ended.hookReceipt?.lifecycleEvent).toBe('turn-end')
      expect(agentTurnEndBoundary(ended)?.id).toBe('new-main-cancel-no-usage')
      expect(agentTurnCompletionIdentity(ended)).toBeUndefined()
      expect(states(h)).toEqual(['working', 'done', 'working', 'unknown'])
      await h.reopen()
      expect(h.client.agentSession(sessionId).turnUsage).toBeUndefined()
      expect(h.client.agentSession(sessionId).semanticStatus?.state).toBe('running')
      await h.send('manual-after-cancel-without-usage', 'hello')
      await expect(h.send('cancel-end-used-twice', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
      expect((await h.client.sessionTimeline(sessionId)).items.map(item => item.title)).toEqual([
        'turn_open', 'finish', 'UserPromptSubmit', 'notice', 'Prompt'])
      await healthy(h)
    } finally { await h.close() }
  })
})
