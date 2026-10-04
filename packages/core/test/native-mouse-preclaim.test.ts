import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import { runProcess } from '../src/process-runner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
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
  const inspectedPanes: string[] = []
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
    inspectPromptExecution: snapshot => { const row = snapshot.lines[snapshot.cursor.row]?.text.trimEnd() ?? ''; inspectedPanes.push(row); return row === '>' ? 'idle' : 'unavailable' } })
  const client = new AgentMuxClient({ store, providers: [provider] }), owner = client as any
  await owner.registry.load('local'); owner.connected = true
  const entered = defer(), release = defer(), waiting = defer(), listeners: Array<(event: any) => void> = [], writes: Array<string | Uint8Array> = []
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
  const inputCalls: Array<{ runId: string; operationId: string; expectedByte: number; data: string | Uint8Array }> = []
  const receipts = new Map<string, { startByte: number; endByte: number }>()
  owner.kernel.input = async (_id: string, input: { expectedByte: number; operationId: string; data: string | Uint8Array }) => {
    inputCalls.push({ runId: _id, ...input });
    const prior = receipts.get(input.operationId); if (prior) return { run: run(), appliedByteRange: prior }
    expect(input.expectedByte).toBe(cursor); writes.push(input.data)
    const range = { startByte: cursor, endByte: cursor + Buffer.byteLength(input.data) }; cursor = range.endByte; receipts.set(input.operationId, range)
    if (input.data === 'ORIGINAL_BODY') { text = input.data; draw() }
    if (input.data === 'ORIGINAL_BODY' && fault === 'body-ack') throw new AgentMuxError('Original payload ACK unknown.', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown', { disposition: 'unknown', confirmedInputBytes: null })
    if (typeof input.data === 'string' ? input.data.startsWith('\x1b[') : input.data[0] === 27 && input.data[1] === 91) {
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
  return { client, owner, root, store, record, request, entered: entered.promise, verifying: verifying.promise, reading: reading.promise, release, send, resize, writes, inputCalls, draw, preparation,
    readFailure: (read: () => Promise<void>) => { readFailure = read },
    change: (value: string) => { fault = value }, statistics: () => ({ readCount, verifyCount }),
    unready: () => { ready = false; draw() }, inspectedPanes, allow: () => { ready = true }, listener: () => listeners.at(-1)!, counts: () => ({ observations, scans }),
    close: async () => { closed = true; release.resolve(); await client.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }) } }
}



const mouse = '\x1b[<0;100;20M'
const releaseMouse = '\x1b[<0;100;20m'
const wheel = '\x1b[<64;100;20M'
const legacy = '\x1b[M !"'
const binaryLegacy = new Uint8Array([27, 91, 77, 32, 200, 255])
const cases: Array<[string, string | Uint8Array]> = [
  ['SGR press', mouse], ['SGR release', releaseMouse], ['SGR wheel', wheel], ['legacy', legacy],
  ['binary legacy', binaryLegacy], ['SGR batch', mouse + releaseMouse + wheel],
  ['mixed batch', Buffer.concat([Buffer.from(mouse), binaryLegacy, Buffer.from(legacy + wheel)])],
  ['long batch', (mouse + wheel).repeat(4096)]
]
it.each(cases)('continues original preclaim after whole %s and exact ACK', async (_name, data) => {
  const f = await fixture('verify')
  try {
    const original = structuredClone(f.request), sent = f.send().then(() => null, error => error)
    await f.verifying
    const ack = await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data, source: 'user' })
    expect(ack).toMatchObject({ runId: f.record.run.runId, appliedByteRange: { startByte: 0, endByte: Buffer.byteLength(data) }, acceptedThroughByte: Buffer.byteLength(data) })
    f.release.resolve(); expect(await sent).toBeNull()
    expect(f.writes).toEqual([data, 'ORIGINAL_BODY', '\r'])
    expect(f.statistics()).toEqual({ readCount: 1, verifyCount: 2 })
    expect(f.request).toEqual(original); expect(f.preparation).not.toHaveBeenCalled()
    expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission).toMatchObject({ submissionId: original.operationId, acknowledged: true,
      intent: { prompt: original.prompt, execution: original.execution, run: original.expectedRun } })
    await f.send(); expect(f.writes).toEqual([data, 'ORIGINAL_BODY', '\r'])
  } finally { await f.close() }
})
it('preserves the outside-lane initial observation for a whole mouse ACK', async () => {
  const f = await fixture('handshake')
  try {
    const sent = f.send().then(() => null, error => error); await f.entered
    await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: mouse, source: 'user' })
    f.release.resolve(); expect(await sent).toBeNull()
    expect(f.writes).toEqual([mouse, 'ORIGINAL_BODY', '\r'])
  } finally { await f.close() }
})
const invalid: Array<[string, string | Uint8Array]> = [
  ['text prefix', 'BODY' + mouse], ['text suffix', mouse + 'BODY'], ['mixed middle', mouse + 'BODY' + wheel],
  ['truncated SGR', mouse + '\x1b[<0;1;'], ['truncated legacy', '\x1b[M !'],
  ['overflow button', '\x1b[<256;1;1M'], ['zero coordinate', '\x1b[<0;0;1M'],
  ['overflow coordinate', '\x1b[<0;9007199254740992;1M'], ['unsupported terminator', '\x1b[<0;1;1x'],
  ['nonmouse escape', mouse + '\x1b[0n'], ['UTF8 legacy string', '\x1b[M \u00c8\u00ff'],
  ['legacy zero coordinate', new Uint8Array([27, 91, 77, 32, 32, 33])]
]
it.each(invalid)('keeps %s as original user-source cancellation', async (_name, data) => {
  const f = await fixture('verify')
  try {
    const sent = f.send().then(() => null, error => error); await f.verifying
    await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data, source: 'user' })
    f.release.resolve(); const error = await sent
    expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(error.detail).toContain('terminal-user'); expect(f.writes).toEqual([data])
    const attempt = await f.client.readDeliveryAttempt(error.logId)
    expect(attempt.availability).toBe('found'); expect(JSON.stringify(attempt)).toContain('before-input-lane')
    expect(JSON.stringify(attempt)).toContain('eventualOutcome')
    expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission).toBeUndefined()
  } finally { await f.close() }
})
it('never treats paste as a mouse-control exemption', async () => {
  const f = await fixture('verify')
  try {
    const sent = f.send().then(() => null, error => error); await f.verifying
    await f.client.pasteAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, text: mouse, terminalData: mouse })
    f.release.resolve(); const error = await sent
    expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' }); expect(error.detail).toContain('terminal-user')
    expect(f.writes).toEqual([mouse])
  } finally { await f.close() }
})
it.each(['source', 'pid', 'cursor', 'verify', 'unknown', 'partial'])('refuses original body after mouse with %s failure', async fault => {
  const f = await fixture('verify')
  try {
    const sent = f.send().then(() => null, error => error); await f.verifying; f.change(fault)
    await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: mouse, source: 'user' }).catch(() => {})
    f.release.resolve(); expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(f.writes).toEqual([mouse]); expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission).toBeUndefined()
  } finally { await f.close() }
})
it.each(['caller', 'disconnect', 'text'])('preserves %s cancellation after a mouse yield', async kind => {
  const f = await fixture('verify'), cancel = new AbortController()
  try {
    const sent = f.send(cancel.signal).then(() => null, error => error); await f.verifying
    const raw = f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: mouse, source: 'user' })
    if (kind === 'caller') cancel.abort(new AgentMuxError('Exact caller cancellation.', 'EXACT_CALLER_CANCELLED'))
    else if (kind === 'disconnect') f.client.disconnect()
    else await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'HUMAN', source: 'user' })
    await raw.catch(() => {}); f.release.resolve(); const error = await sent
    expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(error.detail).toContain(kind === 'caller' ? 'EXACT_CALLER_CANCELLED' : kind === 'disconnect' ? 'client-disconnect' : 'terminal-user')
    expect(f.writes).not.toContain('ORIGINAL_BODY'); expect(f.writes).not.toContain('\r')
  } finally { await f.close() }
})
it('keeps the original deadline through mouse ACK and revalidation', async () => {
  const f = await fixture('verify', 'immediate', true)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const sent = f.send().then(() => null, error => error); await f.verifying
    vi.setSystemTime(Date.now() + 7000)
    await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: mouse, source: 'user' })
    vi.setSystemTime(Date.now() + 1001); f.release.resolve()
    expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' }); expect(f.writes).toEqual([mouse])
  } finally { vi.useRealTimers(); await f.close() }
})
it('expires while the mouse ACK is pending and adds no late body', async () => {
  const f = await fixture('read', 'immediate', true), ack = defer(), inputEntered = defer()
  const input = f.owner.kernel.input.bind(f.owner.kernel)
  f.owner.kernel.input = async (...args: any[]) => { inputEntered.resolve(); await ack.promise; return await input(...args) }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    const sent = f.send().then(() => null, error => error); await f.reading
    const raw = f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: mouse, source: 'user' })
    await inputEntered.promise; f.release.resolve()
    while (![...f.owner.agentInputTails.get(f.record.agentSessionId).renderObservations].some((o: any) => o.protocolInput?.preclaim)) await new Promise(done => setImmediate(done))
    await vi.advanceTimersByTimeAsync(8001)
    expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
    ack.resolve(); await raw; await new Promise(done => setImmediate(done)); expect(f.writes).toEqual([mouse])
  } finally { ack.resolve(); vi.useRealTimers(); await f.close() }
})
it('does not preserve mouse cancellation once the durable claim starts', async () => {
  const f = await fixture('read', 'immediate', true), claimed = defer(), persist = defer()
  const cas = f.store.compareAndSwap.bind(f.store)
  f.store.compareAndSwap = async (expected, next) => {
    if (!expected?.promptCompletionAdmission && next?.promptCompletionAdmission) { claimed.resolve(); await persist.promise }
    return await cas(expected, next)
  }
  try {
    const sent = f.send().then(() => null, error => error); await f.reading; f.release.resolve(); await claimed.promise
    const raw = f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: mouse, source: 'user' })
    const observations = [...f.owner.agentInputTails.get(f.record.agentSessionId).renderObservations] as any[]
    expect(observations.some(observation => observation.controller.signal.aborted &&
      observation.controller.signal.reason?.detail?.includes('terminal-user'))).toBe(true)
    persist.resolve(); expect(await sent).toBeNull(); await raw
    // The already claimed plan settles once by the original owner; no CF0/replay is invented.
    expect(f.writes.filter(data => data === 'ORIGINAL_BODY')).toHaveLength(1)
    expect(f.writes.filter(data => data === '\r')).toHaveLength(1)
    expect(f.writes.filter(data => data === mouse)).toHaveLength(1)
    const beforeRetry = [...f.writes]; await f.send(); expect(f.writes).toEqual(beforeRetry)
    expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission?.submissionId).toBe(f.request.operationId)
  } finally { persist.resolve(); await f.close() }
})
it('continues via real Hosted Unix RPC and queries a rejected mixed-input attempt through compiled CLI', async () => {
  const f = await fixture('verify')
  const owner = { runtimeId: 'private-mouse-host', ownerInstanceId: 'private-mouse-epoch', protocolVersion: 1 as const, processId: process.pid,
    ctxmux: f.client.runtimeIdentity(), availability: 'connected' as const }
  const hosted = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => owner)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, remote: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  try {
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); remote = await connectHostedAgentMux({ rpc })
    const sent = remote.submitAgentPrompt(f.request).then(() => null, error => error); await f.verifying
    const mouseAck = await remote.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: binaryLegacy, source: 'user' })
    f.release.resolve(); expect(await sent).toBeNull(); expect(f.writes).toEqual([binaryLegacy, 'ORIGINAL_BODY', '\r'])
    const request = { ...f.request, operationId: 'original-second-operation', afterSubmissionId: f.request.operationId }
    const failed = remote.submitAgentPrompt(request).then(() => null, error => error)
    // This second current-pane wait observes the already rendered original body.
    await vi.waitFor(() => expect([...f.owner.agentInputTails.get(f.record.agentSessionId)?.renderObservations ?? []].length).toBeGreaterThan(0))
    await remote.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: mouse + 'BODY', source: 'user' })
    const error = await failed; expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' }); expect(error.logId).toMatch(/^delivery-/)
    const sdk = await f.client.readDeliveryAttempt(error.logId)
    const rpcLookup = await rpc.call('message.delivery.inspect', { hostId: 'local', logId: error.logId }); expect(rpcLookup).toEqual(sdk)
    const cli = await runCompiledObjectCli(['message', 'delivery', 'inspect', '--logid', error.logId], objectCliEnvironment(f.root))
    expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(sdk)
    expect(f.writes).toEqual([binaryLegacy, 'ORIGINAL_BODY', '\r', mouse + 'BODY'])
    expect(f.owner.kernel.stop).not.toHaveBeenCalled()
    if (process.env.MOUSE_PUBLIC_EVIDENCE) await writeFile(process.env.MOUSE_PUBLIC_EVIDENCE, JSON.stringify({
      controlledRuntime: true, nativeModelOrUserRun: false, publicTransport: 'actual Unix RPC Hosted owner',
      owner, originalRequest: f.request, mouseInput: { data: [...binaryLegacy], source: 'user' }, mouseAck,
      inputCalls: f.inputCalls.map(call => ({ ...call, data: typeof call.data === 'string' ? call.data : [...call.data] })),
      rejectedRequest: request, error: { code: error.code, detail: error.detail, logId: error.logId, controlFailure: error.controlFailure }, sdkLookup: sdk, rpcLookup, compiledCli: cli,
      inspectedPanes: f.inspectedPanes, writes: f.writes.map(data => typeof data === 'string' ? data : [...data])
    }, null, 2) + '\n')
  } finally { await remote?.dispose(); await rpc?.dispose(); await server.stop(); hosted.dispose(); await f.close() }
})

it('refuses the original request after an actual Session Run replacement', async () => {
  const f = await fixture('verify')
  try {
    const sent = f.send().then(() => null, error => error); await f.verifying
    const current = (await loadAgentSessions(f.store)).find(row => row.agentSessionId === f.record.agentSessionId)
    expect(current).toBeTruthy()
    await f.store.compareAndSwap(current!, { ...current!, run: { runId: 'replacement-run' }, retiredRuns: [f.record.run], updatedAt: Date.now() })
    await f.client.refreshAgentSession(f.record.agentSessionId, { runId: 'replacement-run' })
    const raw = await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: mouse, source: 'user' }).then(() => null, error => error)
    expect(raw).toMatchObject({ code: 'STALE_AGENT_SESSION' })
    f.release.resolve(); expect(await sent).not.toBeNull(); expect(f.writes).toEqual([])
  } finally { await f.close() }
})

it('rereads the actual pane after mouse changes the target instead of using the old idle screen', async () => {
  const f = await fixture('verify', 'immediate', true)
  try {
    const sent = f.send().then(() => null, error => error); await f.verifying
    await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: mouse, source: 'user' })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    f.unready(); f.release.resolve()
    await vi.waitFor(() => expect(f.inspectedPanes).toContain('NOT_READY'))
    await vi.advanceTimersByTimeAsync(8001)
    expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' }); expect(f.writes).toEqual([mouse])
  } finally { vi.useRealTimers(); await f.close() }
})
