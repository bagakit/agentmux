import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { runCompiledObjectCli, objectCliEnvironment } from './helpers/object-cli-rpc.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
type Phase = 'handshake' | 'registered-wait' | 'frame-scan'

// Actual public Client/Coordinator/FileStore/Screen and RPC; only Runtime bytes and Provider facts are controlled.
async function fixture(phase: Phase, execution: 'default' | 'immediate' = 'immediate') {
  const root = await mkdtemp(join(tmpdir(), 'amx-observation-continuity-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const record: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId: 'controlled-steer', executorId: 'controlled-steer',
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1 }
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')); await store.compareAndSwap(null, record)
  const template = new AgentProviderRegistry().get('codex')
  const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'controlled-steer', capabilities: { ...template.catalog.capabilities, promptExecution: { immediate: 'native-steer' } }, hookStrategy: { kind: 'none' } },
    hook: { rules: [] }, buildArgs: (_, args) => [...args], terminalPromptRender: { frameStart: '\x1b[?2026h', frameEnd: '\x1b[?2026l', activeComposer: '>' },
    planPromptInput: text => ({ kind: 'render-then-submit', payload: text, renderedText: text, submit: '\r' }),
    readPromptExecutionEvidence: async () => ({ sourceId: 'original-source', id: 'idle', state: 'idle' }), verifyPromptExecutionTransport: async () => true,
    inspectPromptExecution: snapshot => snapshot.lines[snapshot.cursor.row]?.text.trimEnd() === '>' ? 'idle' : 'unavailable' })
  const client = new AgentMuxClient({ store, providers: [provider] }), owner = client as any
  await owner.registry.load('local'); owner.connected = true
  let cursor = 0, output = 0, text = '', ready = false, closed = false, cols = 80, rows = 24, revision = 0
  const entered = defer(), release = defer(), waiting = defer(), listeners: Array<(event: any) => void> = [], writes: string[] = []
  const run = () => ({ nativeService: null, lifecycleOperationId: null, runId: record.run.runId, program: 'controlled-steer', args: [], workspacePath: root, pid: 123,
    state: { type: 'running' }, cols, rows, firstAvailableByte: 0, latestOutputBytes: output, acceptedInputBytes: cursor })
  const frame = () => Buffer.from(`\x1b[?2026h\x1b[2J\x1b[10;1H${ready ? '> ' + text : 'NOT_READY'}\x1b[10;${ready ? 3 + text.length : 1}H\x1b[?2026l`)
  let current = frame(); output = current.length
  const history = [{ startByte: 0, endByte: output, dataBytes: current }]
  const draw = () => { current = frame(); const startByte = output; output += current.length; history.push({ startByte, endByte: output, dataBytes: current }); for (const accept of listeners) accept({ type: 'data', runId: record.run.runId, startByte, endByte: output, dataBytes: current, data: current.toString() }) }
  owner.kernel.isConnected = () => true
  owner.kernel.identity = () => ({ daemonInstanceId: 'controlled-owner', protocolVersion: 18, buildIdentity: 'controlled' })
  owner.kernel.status = async () => run()
  owner.kernel.disconnect = () => {}; owner.kernel.stop = vi.fn()
  owner.kernel.resize = async (_id: string, c: number, r: number) => { cols = c; rows = r; revision++; ready = true; draw(); return { cols, rows } }
  const receipts = new Map<string, { startByte: number; endByte: number }>()
  owner.kernel.input = async (_id: string, input: { expectedByte: number; operationId: string; data: string }) => {
    const prior = receipts.get(input.operationId); if (prior) return { run: run(), appliedByteRange: prior }
    expect(input.expectedByte).toBe(cursor); writes.push(input.data)
    const range = { startByte: cursor, endByte: cursor + Buffer.byteLength(input.data) }; cursor = range.endByte; receipts.set(input.operationId, range)
    if (input.data !== '\r') text = input.data
    draw(); return { run: run(), appliedByteRange: range }
  }
  let observations = 0, scans = 0
  owner.kernel.observeOutput = async (_id: string, _after: number, listener: (event: any) => void, view: string) => {
    expect(_id).toBe(record.run.runId); expect(view).toBe('terminal'); listeners.push(listener); const first = ++observations === 1
    if (first && phase === 'handshake') { entered.resolve(); await release.promise }
    const bytes = frame(), endByte = output
    if (!first) setImmediate(draw) // Controlled Runtime's natural redraw; no Core refresh/input.
    return { run: run(), resizeRevision: revision, gap: null, close: async () => {},
      terminal: phase === 'frame-scan' || !first ? { type: 'basic-vt', checkpoint: { runId: record.run.runId, throughByte: endByte, resizeRevision: revision,
        size: { cols, rows }, restoreSize: { cols, rows }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 }, restoreBytes: bytes, resizes: [] } : { type: 'not-requested' },
      replay: phase === 'frame-scan' || !first ? [] : [...history] }
  }
  owner.kernel.replay = async () => {
    if (++scans === 1 && phase === 'frame-scan') { entered.resolve(); await release.promise }
    return { run: run(), gap: null, replay: [...history] }
  }
  const originalWait = owner.screenEvidence.wait.bind(owner.screenEvidence)
  owner.screenEvidence.wait = (...args: any[]) => {
    const result = originalWait(...args)
    if (phase === 'registered-wait') {
      const inspect = () => {
        if (closed) return
        const entry = owner.screenEvidence.evidence.get(record.agentSessionId)
        if (entry?.evidence.listeners.size > 1) { entered.resolve(); waiting.resolve() }
        else setImmediate(inspect)
      }; setImmediate(inspect)
    }
    return result
  }
  const request = { agentSessionId: record.agentSessionId, expectedRun: record.run, afterSubmissionId: null,
    operationId: 'original-operation', prompt: 'ORIGINAL_BODY', execution, authorHuman: true }
  const send = (signal?: AbortSignal) => client.submitAgentPrompt({ ...request, ...(signal ? { signal } : {}) })
  const resize = async (changed = false) => { await client.resizeAgent(record.agentSessionId, record.run, changed ? 100 : 80, changed ? 30 : 24); release.resolve() }
  return { client, owner, root, record, request, entered: entered.promise, release, send, resize, writes, draw,
    allow: () => { ready = true }, listener: () => listeners.at(-1)!, counts: () => ({ observations, scans }),
    close: async () => { closed = true; release.resolve(); await client.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }) } }
}

for (const phase of ['handshake', 'registered-wait', 'frame-scan'] as const) {
  it.each(['default', 'immediate'] as const)(`continues one public %s submission after ${phase} invalidation`, async execution => {
    const f = await fixture(phase, execution)
    try {
      const original = structuredClone(f.request), sent = f.send(); await f.entered
      await f.resize(phase !== 'registered-wait')
      const result = await sent.then(() => ({ delivered: true }), error => ({ error }))
      expect(result).toEqual({ delivered: true })
      expect(f.writes).toEqual(['ORIGINAL_BODY', '\r']); expect(f.request).toEqual(original)
      const stored = f.owner.registry.get(f.record.agentSessionId)
      expect(stored.terminalPromptSubmission.submit.acknowledged).toBe(true)
      expect(stored.promptCompletionAdmission.intent).toMatchObject({ execution, prompt: 'ORIGINAL_BODY', run: f.record.run })
      expect(f.owner.kernel.stop).not.toHaveBeenCalled(); expect(f.counts().observations).toBeGreaterThan(1)
      await f.send(); expect(f.writes).toEqual(['ORIGINAL_BODY', '\r'])
    } finally { await f.close() }
  })
}

it.each(['signal', 'human', 'disconnect', 'unknown', 'run-replaced', 'gap', 'error', 'exit'] as const)('keeps %s after a known resize truthful with no input', async source => {
  const f = await fixture('handshake'), signal = new AbortController()
  try {
    const sent = f.send(signal.signal).then(() => null, error => error); await f.entered
    await f.client.resizeAgent(f.record.agentSessionId, f.record.run, 80, 24)
    if (source === 'signal') signal.abort(new AgentMuxError('Explicit original cancellation', 'ORIGINAL_CANCEL', 'source-owned'))
    else if (source === 'human') await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'HUMAN', source: 'user' })
    else if (source === 'disconnect') f.client.disconnect()
    else if (source === 'unknown') f.owner.screenEvidence.discard(f.record.agentSessionId)
    else if (source === 'run-replaced') f.owner.screenEvidence.discard(f.record.agentSessionId, { source: 'run-replaced', runId: 'different-run' })
    else f.listener()({ type: source, ...(source === 'error' ? { error: new AgentMuxError('Actual observation error', 'ORIGINAL_SCREEN_ERROR') } : {}) })
    f.release.resolve(); const error = await sent
    expect(error).toBeTruthy(); expect(f.writes).toEqual(source === 'human' ? ['HUMAN'] : [])
    if (source === 'signal') expect(error.detail).toContain('ORIGINAL_CANCEL')
    if (source === 'human') expect(error.detail).toContain('terminal-user')
    if (source === 'unknown' || source === 'run-replaced') expect(error.detail).toContain(source === 'unknown' ? 'discard' : 'run-replaced')
  } finally { await f.close() }
})

it('continues a same-Run evidence rebuild without recreating the public input intent', async () => {
  const f = await fixture('registered-wait')
  try {
    const sent = f.send(); await f.entered; f.allow(); f.draw()
    await f.owner.screenEvidence.wait(f.owner.registry.get(f.record.agentSessionId), 0, false, () => true,
      { timeoutMs: 500, timeoutMessage: 'rebuild deadline', terminalMessage: 'exit', checkpointFrameFence: { outputByte: 0, resizeRevision: 0 } })
    await sent; expect(f.writes).toEqual(['ORIGINAL_BODY', '\r'])
  } finally { await f.close() }
})

it('preserves an unknown invalidation cause and logid through SDK, Unix RPC and actual CLI, then retries only the original tuple', async () => {
  const f = await fixture('handshake'), server = new AgentMuxControlServer({ socketPath: join(f.root, 'readonly.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'readonly.sock') } })
  try {
    const sent = f.send().then(() => null, error => error); await f.entered
    await f.client.resizeAgent(f.record.agentSessionId, f.record.run, 80, 24)
    f.owner.screenEvidence.discard(f.record.agentSessionId); f.release.resolve()
    const error = await sent; expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(error.logId).toMatch(/^delivery-/u)
    const cause = JSON.parse(error.detail); expect(cause.code).toBe('AGENT_PROMPT_READINESS_CANCELLED')
    expect(JSON.parse(cause.detail)).toMatchObject({ source: 'discard', runId: 'original-run', phase: 'handshake', recoverableFromGeneration: null })
    const sdk = await f.client.readDeliveryAttempt(error.logId)
    expect(sdk.record).toMatchObject({ operationId: f.request.operationId, expectedRunId: f.request.expectedRun.runId, execution: f.request.execution, afterSubmissionId: null, error: { detail: error.detail } })
    const rpcResult = await rpc.call('message.delivery.inspect', { hostId: 'local', logId: error.logId })
    expect(rpcResult.record).toEqual(sdk.record)
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + join(f.root, 'readonly.sock'), 'message', 'delivery', 'inspect', '--logid', error.logId, '--host-id', 'local'], objectCliEnvironment(f.root))
    expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.record).toEqual(sdk.record)
    expect(f.writes).toEqual([]); await f.send(); expect(f.writes).toEqual(['ORIGINAL_BODY', '\r'])
    expect((await f.client.readDeliveryAttempt(error.logId)).record).toEqual(sdk.record)
    if (process.env.AGENTMUX_SCREEN_CONTINUITY_FACTS) {
      await mkdir(process.env.AGENTMUX_SCREEN_CONTINUITY_FACTS, { recursive: true })
      await writeFile(join(process.env.AGENTMUX_SCREEN_CONTINUITY_FACTS, 'public-failure-query.json'), JSON.stringify({ request: f.request,
        error: { code: error.code, detail: error.detail, controlFailure: error.controlFailure, logId: error.logId }, sdk, rpcResult, cli,
        originalTupleRetried: true, writes: f.writes }, null, 2) + '\n')
    }
  } finally { await rpc.dispose(); await server.stop(); await f.close() }
})

it('preserves the exact shared build error for both original screen waiters', async () => {
  let reject!: (error: Error) => void
  const pending = new Promise<never>((_resolve, fail) => { reject = fail })
  const error = new AgentMuxError('Actual shared attachment failed', 'ACTUAL_ATTACHMENT_FAILURE')
  const frame = Buffer.from('\x1b[?2026h\x1b[2J\x1b[10;1H> \x1b[10;3H\x1b[?2026l')
  let observations = 0
  const store = new AgentScreenEvidenceStore({ providers: new AgentProviderRegistry(), kernel: {
    observeOutput: async () => {
      if (++observations === 1) return await pending
      return { run: { runId: 'same-run', cols: 80, rows: 24, latestOutputBytes: frame.length }, resizeRevision: 0, gap: null,
        terminal: { type: 'not-requested' }, replay: [{ startByte: 0, endByte: frame.length, dataBytes: frame }], close: async () => {} }
    }
  } } as never)
  const session = { agentSessionId: 'same-session', providerId: 'codex', run: { runId: 'same-run' } } as any
  const wait = () => store.wait(session, 0, false, () => true,
    { timeoutMs: 300, timeoutMessage: 'original deadline', terminalMessage: 'exit', requireCompleteFrame: true }).then(() => null, caught => caught)
  const first = wait(), second = wait()
  await new Promise(resolve => setImmediate(resolve)); reject(error)
  try {
    const results = await Promise.all([first, second])
    expect(results[0]).toBe(error); expect(results[1]).toBe(error)
    expect(observations).toBe(1)
  } finally { store.discardAll() }
})

it('does not retry an unowned READINESS_CANCELLED error that claims resize in text', async () => {
  const f = await fixture('handshake')
  try {
    const observe = vi.fn(async () => { throw new AgentMuxError('resize', 'AGENT_PROMPT_READINESS_CANCELLED', JSON.stringify({ source: 'resize', runId: 'original-run' })) })
    f.owner.kernel.observeOutput = observe
    await expect(f.send()).rejects.toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
    expect(observe).toHaveBeenCalledOnce(); expect(f.writes).toEqual([])
  } finally { await f.close() }
})

it('uses one absolute deadline during rapid same-Run invalidation without starving timers', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000), timers = vi.spyOn(globalThis, 'setTimeout')
  const session = { agentSessionId: 'storm', providerId: 'codex', run: { runId: 'storm-run' } } as any
  let reads = 0, store: AgentScreenEvidenceStore
  store = new AgentScreenEvidenceStore({ providers: new AgentProviderRegistry(), kernel: { observeOutput: async () => {
    reads++; store.discard('storm', { source: 'resize', runId: 'storm-run' }); if (reads === 3) now.mockReturnValue(2_000)
    return { run: { runId: 'storm-run', cols: 80, rows: 24 }, resizeRevision: 0, gap: null, replay: [], terminal: { type: 'not-requested' }, close: async () => {} }
  } } as never })
  try {
    await expect(store.wait(session, 0, false, () => true, { timeoutMs: 50, timeoutMessage: 'original deadline', terminalMessage: 'exit' }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_RENDER_TIMEOUT', message: 'original deadline' })
    expect(reads).toBe(3); expect(timers.mock.calls.filter(call => call[1] === 50)).toHaveLength(1)
  } finally { store.discardAll(); now.mockRestore(); timers.mockRestore() }
})

it('lets the original timer terminate a rebuild storm and an unresolved attachment close', async () => {
  for (const hangClose of [false, true]) {
    const session = { agentSessionId: 'bounded', providerId: 'codex', run: { runId: 'bounded-run' } } as any
    let reads = 0, store: AgentScreenEvidenceStore; const closing = defer()
    store = new AgentScreenEvidenceStore({ providers: new AgentProviderRegistry(), kernel: { observeOutput: async () => {
      reads++; store.discard('bounded', { source: 'resize', runId: 'bounded-run' })
      return { run: { runId: 'bounded-run', cols: 80, rows: 24 }, resizeRevision: 0, gap: null, replay: [], terminal: { type: 'not-requested' }, close: () => hangClose ? closing.promise : Promise.resolve() }
    } } as never })
    try {
      await expect(store.wait(session, 0, false, () => true, { timeoutMs: 20, timeoutMessage: 'original timer', terminalMessage: 'exit' }))
        .rejects.toMatchObject({ code: 'AGENT_PROMPT_RENDER_TIMEOUT' })
      expect(reads).toBeGreaterThan(0); if (hangClose) expect(reads).toBe(1)
    } finally { closing.resolve(); store.discardAll() }
  }
})
