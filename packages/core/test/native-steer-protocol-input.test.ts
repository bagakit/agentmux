import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import { runProcess } from '../src/process-runner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
type Phase = 'handshake' | 'verify' | 'read'

// Actual public Client/Coordinator/FileStore/Screen and RPC; only Runtime bytes and Provider facts are controlled.
async function fixture(phase: Phase, execution: 'default' | 'immediate' = 'immediate', memory = false) {
  const root = await mkdtemp(join(tmpdir(), 'amx-observation-continuity-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const record: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId: 'controlled-steer', executorId: 'controlled-steer',
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1 }
  const store = memory ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')); await store.compareAndSwap(null, record)
  const template = new AgentProviderRegistry().get('codex')
  const { providerFork: _fork, ...capabilities } = template.catalog.capabilities
  let cursor = 0, output = 0, text = '', ready = true, closed = false, cols = 80, rows = 24, revision = 0
  let source = 'original-source', pid = 123, fault = '', readCount = 0, verifyCount = 0
  const nativeEvidence = { sourceId: source, id: 'idle', state: 'idle' as const }
  const verifying = defer(), reading = defer()
  let readFailure: (() => Promise<void>) | undefined
  const preparation = vi.fn(async () => { throw new Error('Direct input must not use interrupt preparation.') })
  const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'controlled-steer', capabilities: { ...capabilities, promptExecution: { immediate: 'native-steer' } }, hookStrategy: { kind: 'none' } },
    hook: { rules: [] }, buildArgs: (_, args) => [...args], terminalPromptRender: { frameStart: '\x1b[?2026h', frameEnd: '\x1b[?2026l', activeComposer: '>' },
    planPromptInput: text => ({ kind: 'render-then-submit', payload: text, renderedText: text, submit: '\r' }),
    readPromptExecutionEvidence: async () => { await readFailure?.(); readCount++; if (phase === 'read') { reading.resolve(); await release.promise }
      return nativeEvidence },
    preparePromptExecutionTransport: preparation,
    verifyPromptExecutionTransport: async context => { verifyCount++; if (phase === 'verify') { verifying.resolve(); await release.promise }
      return fault !== 'verify' && context.nativeSourceId === source },
    inspectPromptExecution: snapshot => snapshot.lines[snapshot.cursor.row]?.text.trimEnd() === '>' ? 'idle' : 'unavailable' })
  const client = new AgentMuxClient({ store, providers: [provider] }), owner = client as any
  await owner.registry.load('local'); owner.connected = true
  const entered = defer(), release = defer(), waiting = defer(), listeners: Array<(event: any) => void> = [], writes: string[] = []
  const run = () => ({ nativeService: null, lifecycleOperationId: null, runId: record.run.runId, program: 'controlled-steer', args: [], workspacePath: root, pid,
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
    if (input.data === 'ORIGINAL_BODY') { text = input.data; draw() }
    if (input.data === 'ORIGINAL_BODY' && fault === 'body-ack') throw new AgentMuxError('Original payload ACK unknown.', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown', { disposition: 'unknown', confirmedInputBytes: null })
    if (input.data.startsWith('\x1b[')) {
      if (fault === 'source') { source = 'other-source'; nativeEvidence.sourceId = source }
      if (fault === 'pid') pid++
      if (fault === 'cursor') cursor++
      if (fault === 'unknown') throw new AgentMuxError('Protocol ACK unknown.', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown')
      if (fault === 'partial') return { run: run(), appliedByteRange: { ...range, endByte: range.endByte - 1 } }
    }
    return { run: run(), appliedByteRange: range }
  }
  let observations = 0, scans = 0
  owner.kernel.observeOutput = async (_id: string, _after: number, listener: (event: any) => void, view: string) => {
    expect(_id).toBe(record.run.runId); expect(view).toBe('terminal'); listeners.push(listener); const first = ++observations === 1
    if (first && phase === 'handshake') { entered.resolve(); await release.promise }
    const bytes = frame(), endByte = output
    if (!first) setImmediate(draw) // Controlled Runtime's natural redraw; no Core refresh/input.
    return { run: run(), resizeRevision: revision, gap: null, close: async () => {},
      terminal: !first ? { type: 'basic-vt', checkpoint: { runId: record.run.runId, throughByte: endByte, resizeRevision: revision,
        size: { cols, rows }, restoreSize: { cols, rows }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 }, restoreBytes: bytes, resizes: [] } : { type: 'not-requested' },
      replay: !first ? [] : [...history] }
  }
  owner.kernel.replay = async () => {
    scans++
    return { run: run(), gap: null, replay: [...history] }
  }
  const request = { agentSessionId: record.agentSessionId, expectedRun: record.run, afterSubmissionId: null,
    operationId: 'original-operation', prompt: 'ORIGINAL_BODY', execution, authorHuman: true }
  const send = (signal?: AbortSignal) => client.submitAgentPrompt({ ...request, ...(signal ? { signal } : {}) })
  const resize = async (changed = false) => { await client.resizeAgent(record.agentSessionId, record.run, changed ? 100 : 80, changed ? 30 : 24); release.resolve() }
  return { client, owner, root, store, record, request, entered: entered.promise, verifying: verifying.promise, reading: reading.promise, release, send, resize, writes, draw, preparation,
    readFailure: (read: () => Promise<void>) => { readFailure = read },
    change: (value: string) => { fault = value }, statistics: () => ({ readCount, verifyCount }),
    allow: () => { ready = true }, listener: () => listeners.at(-1)!, counts: () => ({ observations, scans }),
    close: async () => { closed = true; release.resolve(); await client.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }) } }
}



it.each(['\x1b[?1;2c', '\x1b[1;1R'])('continues the original direct request after protocol %j during its current-pane read', async reply => {
  const f = await fixture('handshake')
  try {
    const original = structuredClone(f.request), sent = f.send().then(() => null, error => error)
    await f.entered
    const protocol = f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: reply, source: 'terminal-protocol' })
    f.release.resolve(); await protocol; expect(await sent).toBeNull()
    expect(f.writes).toEqual([reply, 'ORIGINAL_BODY', '\r'])
    expect(f.request).toEqual(original); expect(f.preparation).not.toHaveBeenCalled()
    expect(f.statistics().readCount).toBe(1)
    const state = f.client.agentSession(f.record.agentSessionId)
    expect(state.promptCompletionAdmission).toMatchObject({ submissionId: original.operationId, acknowledged: true,
      intent: { prompt: original.prompt, execution: 'immediate', run: original.expectedRun } })
    await f.send(); expect(f.statistics().readCount).toBe(1)
    expect(f.writes).toEqual([reply, 'ORIGINAL_BODY', '\r'])
  } finally { await f.close() }
})

it('releases the lane for protocol ACK while the final verifier waits for that reply', async () => {
  const f = await fixture('verify')
  try {
    const sent = f.send(); await f.verifying
    await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: '\x1b[0n', source: 'terminal-protocol' })
    f.release.resolve(); await sent
    expect(f.statistics()).toEqual({ readCount: 1, verifyCount: 2 })
    expect(f.writes).toEqual(['\x1b[0n', 'ORIGINAL_BODY', '\r'])
    expect(f.preparation).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it.each(['source', 'pid', 'cursor', 'verify', 'unknown', 'partial'])('keeps body absent after a protocol ACK with %s failure', async fault => {
  const f = await fixture('verify')
  try {
    const sent = f.send().then(() => null, error => error); await f.verifying; f.change(fault)
    await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: '\x1b[0n', source: 'terminal-protocol' }).catch(() => {})
    f.release.resolve()
    expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(f.writes).toEqual(['\x1b[0n']); expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission).toBeUndefined()
  } finally { await f.close() }
})

it.each(['user', 'caller', 'disconnect'])('retains the real %s cancellation and lets raw input remain usable', async kind => {
  const f = await fixture('verify'), cancel = new AbortController()
  try {
    const sent = f.send(cancel.signal).then(() => null, error => error); await f.verifying
    if (kind === 'user') await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'HUMAN', source: 'user' })
    else if (kind === 'caller') cancel.abort(new AgentMuxError('Original caller cancelled.', 'ORIGINAL_CALLER_CANCELLED'))
    else f.client.disconnect()
    const error = await sent
    expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(error.detail).toContain(kind === 'user' ? 'terminal-user' : kind === 'caller' ? 'ORIGINAL_CALLER_CANCELLED' : 'client-disconnect')
    expect(f.writes).toEqual(kind === 'user' ? ['HUMAN'] : [])
    expect((await f.client.readDeliveryAttempt(error.logId)).availability).toBe('found')
    f.release.resolve()
    if (kind !== 'disconnect') {
      await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'RAW_AFTER_FAILURE', source: 'user' })
      expect(f.writes.at(-1)).toBe('RAW_AFTER_FAILURE')
    } else expect(f.owner.connected).toBe(false)
  } finally { await f.close() }
})

it('retains human cancellation across a protocol yield before the original claim', async () => {
  const f = await fixture('verify')
  try {
    const sent = f.send().then(() => null, error => error); await f.verifying
    const protocol = f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: '\x1b[0n', source: 'terminal-protocol' })
    const human = f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'HUMAN_AFTER_PROTOCOL', source: 'user' })
    await protocol; await human; f.release.resolve()
    expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
    expect(f.writes).toEqual(['\x1b[0n', 'HUMAN_AFTER_PROTOCOL'])
  } finally { await f.close() }
})

it('keeps one original eight-second deadline across protocol yielding and late verification', async () => {
  const f = await fixture('verify', 'immediate', true)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const sent = f.send().then(() => null, error => error); await f.verifying
    vi.setSystemTime(Date.now() + 7_000)
    await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: '\x1b[0n', source: 'terminal-protocol' })
    vi.setSystemTime(Date.now() + 1_001); f.release.resolve()
    expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
    expect(f.writes).toEqual(['\x1b[0n'])
  } finally { vi.useRealTimers(); await f.close() }
})

it('expires an original preparation queued behind protocol input and never adds late body', async () => {
  const f = await fixture('read'), ack = defer(), inputEntered = defer()
  const input = f.owner.kernel.input.bind(f.owner.kernel)
  f.owner.kernel.input = async (...args: any[]) => { inputEntered.resolve(); await ack.promise; return await input(...args) }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    const sent = f.send().then(() => null, error => error); await f.reading
    const protocol = f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: '\x1b[0n', source: 'terminal-protocol' })
    await inputEntered.promise; f.release.resolve()
    while (![...f.owner.agentInputTails.get(f.record.agentSessionId).renderObservations].some((o: any) => o.protocolInput?.preclaim)) await new Promise(done => setImmediate(done))
    await vi.advanceTimersByTimeAsync(8_001)
    expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
    ack.resolve(); await protocol; await new Promise(done => setImmediate(done))
    expect(f.writes).toEqual(['\x1b[0n']); expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission).toBeUndefined()
  } finally { ack.resolve(); vi.useRealTimers(); await f.close() }
})

it('never reports preclaim timeout once claim persistence has started', async () => {
  const f = await fixture('read', 'immediate', true), claimed = defer(), persist = defer()
  const cas = f.store.compareAndSwap.bind(f.store)
  f.store.compareAndSwap = async (expected, next) => {
    if (!expected?.promptCompletionAdmission && next?.promptCompletionAdmission) { claimed.resolve(); await persist.promise }
    return await cas(expected, next)
  }
  try {
    const sent = f.send().then(() => null, error => error); await f.reading; f.release.resolve(); await claimed.promise
    await new Promise(done => setTimeout(done, 8_050)); persist.resolve()
    // After claim, a late receipt remains owned by the original operation.
    expect(await sent).toBeNull(); expect(f.writes).toEqual(['ORIGINAL_BODY', '\r'])
  } finally { persist.resolve(); await f.close() }
}, 12_000)

it('keeps an actual Runner cancellation cause and its exact logid queryable through public SDK and RPC', async () => {
  const f = await fixture('read'), cancel = new AbortController()
  const reason = new AgentMuxError('Original observation was explicitly cancelled.', 'ORIGINAL_OBSERVATION_CANCELLED', 'readonly-observer')
  cancel.abort(reason)
  f.readFailure(async () => { await runProcess(fixturePath("must-not-launch"), [], { signal: cancel.signal }) })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    const error = await f.send().then(() => null, error => error)
    expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(JSON.parse(error.detail)).toMatchObject({ code: 'COMMAND_ABORTED' })
    expect(JSON.parse(JSON.parse(error.detail).detail)).toMatchObject({ code: reason.code, detail: reason.detail })
    expect(error.logId).toMatch(/^delivery-/)
    const sdk = await f.client.readDeliveryAttempt(error.logId)
    expect(sdk).toMatchObject({ availability: 'found', record: { logId: error.logId, operationId: f.request.operationId, source: 'core' } })
    expect(JSON.stringify(sdk)).toContain(reason.code)
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } })
    expect(await rpc.call('message.delivery.inspect', { hostId: 'local', logId: error.logId })).toEqual(sdk)
    const cli = await runCompiledObjectCli(['message', 'delivery', 'inspect', '--logid', error.logId], objectCliEnvironment(f.root))
    expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(sdk)
    expect(f.writes).toEqual([]); expect(f.owner.kernel.stop).not.toHaveBeenCalled()
  } finally { await rpc?.dispose(); await server.stop(); await f.close() }
})

it('bounds the readonly owner refresh between a protocol yield and the next lane entry', async () => {
  const f = await fixture('verify', 'immediate', true), refreshing = defer(), refreshed = defer()
  const refresh = f.owner.registry.refresh.bind(f.owner.registry)
  let afterProtocol = false
  f.owner.registry.refresh = async (...args: any[]) => { if (afterProtocol) { refreshing.resolve(); await refreshed.promise } return await refresh(...args) }
  try {
    const sent = f.send().then(() => null, error => error); await f.verifying
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); afterProtocol = true
    const protocol = f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: '\x1b[0n', source: 'terminal-protocol' })
    await refreshing.promise
    await vi.advanceTimersByTimeAsync(8_001)
    expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
    refreshed.resolve(); f.release.resolve(); await protocol
    expect(f.writes).toEqual(['\x1b[0n']); expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission).toBeUndefined()
  } finally { refreshed.resolve(); vi.useRealTimers(); await f.close() }
})
