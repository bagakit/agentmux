import { fixturePath } from './helpers/fixture-values.js'
import { runCompiledObjectCli, objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { readAgentPromptPreparationWait, type AgentPromptPreparationWaitReason } from '../src/prompt-preparation.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
type Phase = 'handshake' | 'verify' | 'read' | 'current-run' | 'final-run-status' | 'pane-predicate' | 'input-lane' | 'payload' | 'none'

// Actual public Client/Coordinator/FileStore/Screen and RPC; only Runtime bytes and Provider facts are controlled.
async function fixture(phase: Phase, execution: 'default' | 'immediate' = 'immediate', memory = false, temporaryWait?: AgentPromptPreparationWaitReason) {
  const root = await mkdtemp(join(tmpdir(), 'amx-observation-continuity-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const record: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId: 'controlled-steer', executorId: 'controlled-steer',
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1 }
  const store = memory ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')); await store.compareAndSwap(null, record)
  const template = new AgentProviderRegistry().get('codex')
  const capabilities = { ...template.catalog.capabilities }; delete capabilities.providerFork
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
    inspectPromptPreparationWait: () => temporaryWait,
    inspectPromptExecution: snapshot => { if (phase === 'pane-predicate' || temporaryWait) { entered.resolve(); return 'unavailable' }; return snapshot.lines[snapshot.cursor.row]?.text.trimEnd() === '>' ? 'idle' : 'unavailable' } })
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
  owner.kernel.status = async () => { if (!statusBlocked && ((phase === 'current-run' && readCount > 0) || (phase === 'final-run-status' && verifyCount > 0))) { statusBlocked = true; entered.resolve(); await release.promise }; return run() }
  owner.kernel.disconnect = () => {}; owner.kernel.stop = vi.fn()
  owner.kernel.resize = async (_id: string, c: number, r: number) => { cols = c; rows = r; revision++; ready = true; draw(); return { cols, rows } }
  const receipts = new Map<string, { startByte: number; endByte: number }>()
  owner.kernel.input = async (_id: string, input: { expectedByte: number; operationId: string; data: string }) => {
    const prior = receipts.get(input.operationId); if (prior) return { run: run(), appliedByteRange: prior }
    expect(input.expectedByte).toBe(cursor); writes.push(input.data)
    if ((phase === 'input-lane' && input.data === 'PRIOR') || (phase === 'payload' && input.data === 'ORIGINAL_BODY')) { entered.resolve(); await release.promise }
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
  let observations = 0, scans = 0, statusBlocked = false
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
    temporaryWait: (value?: AgentPromptPreparationWaitReason) => { temporaryWait = value },
    nativeSource: (value: string) => { source = value; nativeEvidence.sourceId = value },
    change: (value: string) => { fault = value }, statistics: () => ({ readCount, verifyCount }),
    screenFacts: () => ({ output, revision }), allow: () => { ready = true }, listener: () => listeners.at(-1)!, counts: () => ({ observations, scans }),
    close: async () => { closed = true; release.resolve(); await client.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }) } }
}
function observation(error: AgentMuxError) {
  let value = JSON.parse(error.detail!)
  while (!value.preclaimObservation && value.detail) value = JSON.parse(value.detail)
  expect(value.code ?? 'AGENT_INPUT_PREPARATION_UNCONFIRMED').toBe('AGENT_INPUT_PREPARATION_UNCONFIRMED')
  return value.preclaimObservation as { phase: string; phaseEnteredAt: number; lastCompletedPhase: string | null; lastPhaseCompletedAt: number | null; deadline: number; pane: any }
}

it('locates the incomplete current Run at the original deadline without input', async () => {
  const f = await fixture('current-run', 'immediate', true)
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const start = Date.now(), original = structuredClone(f.request), sent = f.send().then(() => null, error => error as AgentMuxError)
    await f.entered; await vi.advanceTimersByTimeAsync(8_000)
    const error = (await sent)!
    expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(observation(error)).toMatchObject({ phase: 'current-run', phaseEnteredAt: start,
      lastCompletedPhase: 'input-lane', lastPhaseCompletedAt: start, deadline: start + 8_000, pane: null })
    expect(f.writes).toEqual([]); expect(f.request).toEqual(original)
    const frozen = error.detail; f.release.resolve(); await Promise.resolve(); await Promise.resolve(); expect(error.detail).toBe(frozen)
    const record = await f.client.readDeliveryAttempt(error.logId!)
    expect(record.record!.error.detail).toBe(error.detail); expect(JSON.stringify(record)).not.toContain(f.request.prompt)
  } finally { vi.useRealTimers(); await f.close() }
})

// Advance only the existing controlled Screen timers until the selected real await is reached.
async function enteredWithClock(promise: Promise<void>) {
  let entered = false; void promise.then(() => { entered = true })
  for (let step = 0; !entered && step < 100; step++) await vi.advanceTimersByTimeAsync(10)
  expect(entered).toBe(true)
}

it.each([
  ['handshake', 'current-pane', 'current-run'],
  ['pane-predicate', 'current-pane', 'current-run'],
  ['verify', 'native-transport-verifier', 'current-pane'],
  ['final-run-status', 'final-run-status', 'native-transport-verifier']
] as const)('locates the original %s await with no fabricated completion or input', async (blocked, phase, previous) => {
  const f = await fixture(blocked, 'immediate', true)
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const start = Date.now(), sent = f.send().then(() => null, error => error as AgentMuxError)
    await enteredWithClock(blocked === 'verify' ? f.verifying : f.entered)
    await vi.advanceTimersByTimeAsync(start + 8_000 - Date.now())
    const error = (await sent)!, facts = observation(error)
    expect(facts).toMatchObject({ phase, lastCompletedPhase: previous, deadline: start + 8_000 })
    expect(facts.phaseEnteredAt).toBeGreaterThanOrEqual(start); expect(facts.phaseEnteredAt).toBeLessThan(start + 1_000)
    expect(facts.lastPhaseCompletedAt).toBeLessThanOrEqual(facts.phaseEnteredAt)
    expect(error.controlFailure).toEqual({ disposition: 'not_applied', confirmedInputBytes: 0 })
    expect(f.writes).toEqual([])
    if (blocked === 'handshake') expect(facts.pane).toEqual({ predicateEvaluations: 0, predicateEvaluationsCapped: false,
      lastPredicateResult: null, frameObservedAt: null, outputThroughByte: null, geometryRevision: null,
      evidenceGeneration: null, authoritative: null, completeFrameAvailable: null, cols: null, rows: null, cursor: null })
    else expect(facts.pane).toMatchObject({ predicateEvaluations: expect.any(Number), predicateEvaluationsCapped: false,
      lastPredicateResult: blocked !== 'pane-predicate', frameObservedAt: expect.any(Number), outputThroughByte: expect.any(Number),
      geometryRevision: 0, evidenceGeneration: expect.any(Number), authoritative: true, completeFrameAvailable: true,
      cols: 80, rows: 24, cursor: { row: 9, column: 2 } })
    expect(Object.keys(facts.pane).sort()).toEqual(['predicateEvaluations', 'predicateEvaluationsCapped', 'lastPredicateResult',
      'frameObservedAt', 'outputThroughByte', 'geometryRevision', 'evidenceGeneration', 'authoritative', 'completeFrameAvailable', 'cols', 'rows', 'cursor'].sort())
    expect(JSON.stringify(facts)).not.toContain(f.request.prompt)
  } finally { vi.useRealTimers(); await f.close() }
})

it.each(['submission-store', 'session-refresh'] as const)('locates %s without replacing the original store/refresh call', async phase => {
  const f = await fixture('none', 'immediate', true), entered = defer(), release = defer()
  try {
    if (phase === 'submission-store') {
      const original = f.store.withPromptSubmission.bind(f.store)
      vi.spyOn(f.store, 'withPromptSubmission').mockImplementation(async (id, call) => {
        entered.resolve(); await release.promise; return original(id, call)
      })
    } else {
      const original = f.owner.registry.refresh.bind(f.owner.registry)
      let blocked = false
      vi.spyOn(f.owner.registry, 'refresh').mockImplementation(async (...args: any[]) => {
        if (!blocked && f.statistics().readCount > 0) { blocked = true; entered.resolve(); await release.promise }
        return original(...args)
      })
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const start = Date.now(), sent = f.send().then(() => null, error => error as AgentMuxError)
    await entered.promise; await vi.advanceTimersByTimeAsync(8_000)
    const error = (await sent)!
    expect(observation(error)).toMatchObject({ phase, phaseEnteredAt: start,
      lastCompletedPhase: phase === 'submission-store' ? 'current-run' : 'submission-store', deadline: start + 8_000 })
    expect(f.writes).toEqual([])
  } finally { release.resolve(); vi.useRealTimers(); await f.close() }
})

it('distinguishes a predecessor input lane from a current Run or pane read', async () => {
  const f = await fixture('input-lane', 'immediate', true), queued = defer()
  const original = f.owner.serializeAgentInput.bind(f.owner)
  f.owner.serializeAgentInput = (...args: any[]) => { const result = original(...args); if (args[3]) queued.resolve(); return result }
  const prior = f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'PRIOR', source: 'user' })
  try {
    await f.entered
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const start = Date.now(), sent = f.send().then(() => null, error => error as AgentMuxError)
    await queued.promise; await vi.advanceTimersByTimeAsync(8_000)
    const error = (await sent)!
    expect(observation(error)).toEqual({ phase: 'input-lane', phaseEnteredAt: start, lastCompletedPhase: null,
      lastPhaseCompletedAt: null, deadline: start + 8_000, pane: null })
    expect(f.writes).toEqual(['PRIOR'])
    f.release.resolve(); await prior; await Promise.resolve()
    expect(f.writes).toEqual(['PRIOR'])
  } finally { f.release.resolve(); vi.useRealTimers(); await prior; await f.close() }
})

it.each(['default', 'immediate'] as const)('preserves successful %s input identity and exactly one payload/Enter', async execution => {
  const f = await fixture('none', execution, true)
  try {
    const before = structuredClone(f.request)
    await f.send()
    expect(f.writes).toEqual(['ORIGINAL_BODY', '\r']); expect(f.request).toEqual(before)
    const current = await f.store.load()
    expect((current[0] as AgentMuxStoredAgentSession).terminalPromptSubmission).toMatchObject({ submissionId: before.operationId,
      payload: { acknowledged: true }, submit: { acknowledged: true } })
  } finally { await f.close() }
})

it('preserves caller cancellation and the first terminal-user cause instead of replacing them with phase timeout', async () => {
  for (const source of ['caller', 'terminal-user'] as const) {
    const f = await fixture('handshake', 'immediate', true)
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const controller = new AbortController(), cause = new AgentMuxError('original cancellation', 'ORIGINAL_CANCEL', 'original-cause')
      const sent = f.send(controller.signal).then(() => null, error => error as AgentMuxError); await f.entered
      if (source === 'caller') controller.abort(cause)
      else await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'private raw', source: 'user' })
      f.release.resolve()
      const error = (await sent)!
      expect(error.code).toBe('AGENT_PROMPT_PREPARATION_FAILED')
      expect(error.detail).not.toContain('preclaimObservation')
      expect(error.detail).toContain(source === 'caller' ? 'original-cause' : 'terminal-user')
      const frozen = error.detail; await vi.advanceTimersByTimeAsync(8_000); expect(error.detail).toBe(frozen)
      expect(f.writes).toEqual(source === 'caller' ? [] : ['private raw'])
    } finally { vi.useRealTimers(); await f.close() }
  }
})

it('keeps phase diagnostics per invocation and preserves original tuple on explicit retry', async () => {
  const a = await fixture('current-run', 'immediate', true), b = await fixture('verify', 'immediate', true)
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const first = a.send().then(() => null, error => error as AgentMuxError), other = b.send().then(() => null, error => error as AgentMuxError)
    const start = Date.now(); await enteredWithClock(Promise.all([a.entered, b.verifying]).then(() => {}))
    await vi.advanceTimersByTimeAsync(start + 8_000 - Date.now())
    const errors = [(await first)!, (await other)!]
    expect(errors.map(error => observation(error).phase)).toEqual(['current-run', 'native-transport-verifier'])
    expect(errors[0]!.logId).not.toBe(errors[1]!.logId)
    const frozen = errors.map(error => error.detail)
    a.release.resolve(); b.release.resolve(); vi.useRealTimers()
    // The original queued promises settle before the explicit same-tuple retry.
    await Promise.all([...a.owner.agentInputTails.values(), ...b.owner.agentInputTails.values()].map((lane: any) => lane.tail))
    const tuple = structuredClone(a.request)
    await a.send()
    expect(a.request).toEqual(tuple); expect(a.writes).toEqual(['ORIGINAL_BODY', '\r']); expect(b.writes).toEqual([])
    expect(errors.map(error => error.detail)).toEqual(frozen)
  } finally { vi.useRealTimers(); await a.close(); await b.close() }
})

it('preserves phase detail/logid through actual Hosted SDK, Unix RPC and compiled CLI while offline', async () => {
  const f = await fixture('current-run'), root = await mkdtemp(fixturePath("tmp/amux-phase-cli-"))
  const service = new AgentMuxHostedRuntimeService(f.client, (f.store as AgentMuxFileAgentSessionStore).path, () => hostedTestOwner(f.client))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => service })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, hosted: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  try {
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'owner.sock') } })
    hosted = await connectHostedAgentMux({ rpc })
    const sent = hosted.submitAgentPrompt(f.request).then(() => null, error => error as AgentMuxError)
    await f.entered
    const error = (await sent)!, snapshot = observation(error), first = await hosted.readDeliveryAttempt(error.logId!)
    expect(snapshot.phase).toBe('current-run'); expect(f.writes).toEqual([])
    expect(first.record!.error.detail).toBe(error.detail)
    const connect = vi.spyOn(f.client, 'connect'); f.owner.connected = false
    expect((await hosted.readDeliveryAttempt(error.logId!)).record).toEqual(first.record); expect(connect).not.toHaveBeenCalled()
    const { build } = await import('esbuild'), output = join(root, 'agentmux.mjs')
    await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'))
    const built = await build({ entryPoints: [fileURLToPath(new URL('../src/agentmux.ts', import.meta.url))], outfile: output,
      bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24', metafile: true })
    const env = { ...process.env }; for (const key of Object.keys(env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) delete env[key]
    const result = await new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [output, '--endpoint', 'unix://' + join(root, 'owner.sock'), 'message', 'delivery', 'inspect', '--logid', error.logId!], { env })
      let stdout = '', stderr = ''
      child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
      child.on('error', reject); child.on('close', exit => resolve({ exit, stdout, stderr }))
    })
    expect(result.exit, result.stderr).toBe(0); expect(JSON.parse(result.stdout).result.record).toEqual(first.record)
    expect(result.stdout).not.toContain(f.request.prompt)
    const directory = process.env.AGENTMUX_T041_EVIDENCE
    if (directory) {
      await writeFile(join(directory, 'public-cli.mjs'), await readFile(output))
      await writeFile(join(directory, 'public-cli.metafile.json'), JSON.stringify(built.metafile))
      await writeFile(join(directory, 'public-consumer.json'), JSON.stringify({ request: { ...f.request, prompt: undefined }, error: {
        code: error.code, detail: error.detail, logId: error.logId, controlFailure: error.controlFailure }, snapshot, first, result,
        writes: f.writes, offline: true, nativeInput: false }))
    }
  } finally { f.release.resolve(); await hosted?.dispose(); await rpc?.dispose(); await server.stop(); await service.dispose(); await f.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)

it('preserves the first competing-input cause when the original current Run await outlives cancellation', async () => {
  const f = await fixture('current-run', 'immediate', true)
  let raw: Promise<unknown> | undefined
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sent = f.send().then(() => null, error => error as AgentMuxError); await f.entered
    raw = f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'private raw', source: 'user' })
    await vi.advanceTimersByTimeAsync(8_000)
    const error = (await sent)!
    expect(error.detail).toContain('terminal-user'); expect(error.detail).not.toContain('preclaimObservation')
    expect(error.controlFailure).toEqual({ disposition: 'not_applied', confirmedInputBytes: 0 }); expect(f.writes).toEqual([])
    f.release.resolve(); await raw; expect(f.writes).toEqual(['private raw'])
  } finally { f.release.resolve(); vi.useRealTimers(); await raw; await f.close() }
})

it('keeps the original claimStarted guard after payload dispatch instead of reporting read-only timeout', async () => {
  const f = await fixture('payload', 'immediate', true)
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let completed = false
    const sent = f.send().then(() => { completed = true }, error => { completed = true; throw error })
    await enteredWithClock(f.entered); await vi.advanceTimersByTimeAsync(8_000)
    expect(completed).toBe(false); expect(f.writes).toEqual(['ORIGINAL_BODY'])
    f.release.resolve(); await vi.advanceTimersByTimeAsync(10); await sent
    expect(f.writes).toEqual(['ORIGINAL_BODY', '\r'])
  } finally { f.release.resolve(); vi.useRealTimers(); await f.close() }
})

it('aligns the last predicate result with its actual changed geometry and output owner', async () => {
  const f = await fixture('pane-predicate', 'immediate', true), changedPredicate = defer()
  const provider = f.client.providers.get('controlled-steer'), original = provider.inspectPromptExecution!
  let actualPredicateAt = 0, actualGeneration = 0
  vi.spyOn(provider as Required<Pick<AgentProvider, 'inspectPromptExecution'>>, 'inspectPromptExecution').mockImplementation((...args) => {
    const result = original(...args)
    actualPredicateAt = Date.now(); actualGeneration = f.owner.screenEvidence.generation(f.record.agentSessionId)
    if (args[0].cols === 100) changedPredicate.resolve()
    return result
  })
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const start = Date.now(), sent = f.send().then(() => null, error => error as AgentMuxError)
    await enteredWithClock(f.entered); await vi.advanceTimersByTimeAsync(50)
    await f.resize(true); await enteredWithClock(changedPredicate.promise)
    const expected = f.screenFacts()
    await vi.advanceTimersByTimeAsync(start + 8_000 - Date.now())
    const facts = observation((await sent)!)
    expect(facts.pane).toMatchObject({ lastPredicateResult: false, frameObservedAt: actualPredicateAt,
      outputThroughByte: expected.output, geometryRevision: expected.revision,
      evidenceGeneration: actualGeneration, authoritative: true, completeFrameAvailable: true })
    expect(facts.pane.predicateEvaluations).toBeGreaterThan(1)
    expect(f.writes).toEqual([])
  } finally { vi.useRealTimers(); await f.close() }
})


it.each(['context-compaction', 'native-busy'] as const)('explains the complete current %s pane without input, retaining the original retry fence', async reason => {
  const f = await fixture('none', 'immediate', true, reason)
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const before = structuredClone(f.request), sent = f.send().then(() => null, error => error as AgentMuxError)
    await enteredWithClock(f.entered); await vi.advanceTimersByTimeAsync(8_000)
    const error = (await sent)!, wait = readAgentPromptPreparationWait(error)!
    expect(wait).toEqual({ reason, retrySafe: true, agentSessionId: before.agentSessionId, runId: before.expectedRun.runId,
      operationId: before.operationId, inputByte: 0, nativeSourceId: 'original-source' })
    expect(error.message).toContain(reason === 'context-compaction' ? 'compacting' : 'temporarily')
    expect(f.writes).toEqual([]); expect(f.request).toEqual(before)
    f.temporaryWait(); vi.useRealTimers()
    await f.client.submitAgentPrompt({ ...before, preparationRetry: { inputByte: wait.inputByte, nativeSourceId: wait.nativeSourceId } })
    expect(f.writes).toEqual(['ORIGINAL_BODY', '\r'])
  } finally { vi.useRealTimers(); await f.close() }
})

it.each(['context-compaction', 'unknown'] as const)('retains the completed %s current-pane timeout when read-only store cleanup outlasts the original deadline', async reason => {
  const f = await fixture(reason === 'unknown' ? 'pane-predicate' : 'none', 'immediate', true, reason === 'unknown' ? undefined : reason), cleaning = defer(), released = defer()
  const originalWait = f.owner.screenEvidence.wait.bind(f.owner.screenEvidence), originalStore = f.store.withPromptSubmission.bind(f.store)
  vi.spyOn(f.owner.screenEvidence, 'wait').mockImplementation((...args: any[]) => {
    const options = args[4]
    // The actual Screen owner times out first; the outer original budget stays 8s.
    return originalWait(...args.slice(0, 4), { ...options, timeoutMs: Math.min(1_000, options.timeoutMs) })
  })
  vi.spyOn(f.store, 'withPromptSubmission').mockImplementation((id, call) => originalStore(id, async () => {
    try { return await call() } finally { cleaning.resolve(); await released.promise }
  }))
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const started = Date.now(), sent = f.send().then(() => null, error => error as AgentMuxError)
    await enteredWithClock(f.entered); await vi.advanceTimersByTimeAsync(1_000); await cleaning.promise
    await vi.advanceTimersByTimeAsync(started + 8_000 - Date.now())
    const error = (await sent)!
    if (reason === 'unknown') expect(readAgentPromptPreparationWait(error)).toBeUndefined()
    else expect(readAgentPromptPreparationWait(error)).toMatchObject({ reason, retrySafe: true, operationId: f.request.operationId })
    expect(observation(error).phase).toBe('current-pane'); expect(f.writes).toEqual([])
    expect(observation(error).pane).toMatchObject({ cols: 80, rows: 24, cursor: { row: 9, column: 2 }, geometryRevision: 0 })
    const frozen = error.detail
    released.resolve(); vi.useRealTimers(); await f.resize(true)
    expect(error.detail).toBe(frozen)
    expect(observation(error).pane).toMatchObject({ cols: 80, rows: 24, cursor: { row: 9, column: 2 }, geometryRevision: 0 })
    const record = await f.client.readDeliveryAttempt(error.logId!)
    expect(record.record!.error.detail).toBe(frozen)
    if (process.env.AGENTMUX_T005_EVIDENCE) await writeFile(join(process.env.AGENTMUX_T005_EVIDENCE, `cleanup-geometry-${reason}.json`), JSON.stringify({
      original: observation(error), laterRunSize: { cols: 100, rows: 30 }, record, writes: f.writes }))
  } finally { released.resolve(); vi.useRealTimers(); await f.close() }
})

it.each(['gap', 'cancel', 'raw-input'] as const)('drops the completed timeout retry receipt when %s arrives during read-only cleanup', async fault => {
  const f = await fixture('none', 'immediate', true, 'context-compaction'), cleaning = defer(), released = defer()
  const originalWait = f.owner.screenEvidence.wait.bind(f.owner.screenEvidence), originalStore = f.store.withPromptSubmission.bind(f.store)
  vi.spyOn(f.owner.screenEvidence, 'wait').mockImplementation((...args: any[]) => originalWait(...args.slice(0, 4), { ...args[4], timeoutMs: 1_000 }))
  vi.spyOn(f.store, 'withPromptSubmission').mockImplementation((id, call) => originalStore(id, async () => {
    try { return await call() } finally { cleaning.resolve(); await released.promise }
  }))
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const started = Date.now(), controller = new AbortController(), sent = f.send(controller.signal).then(() => null, error => error as AgentMuxError)
    await enteredWithClock(f.entered); await vi.advanceTimersByTimeAsync(1_000); await cleaning.promise
    if (fault === 'gap') f.listener()({ type: 'gap', runId: f.record.run.runId, firstAvailableByte: 99 })
    else if (fault === 'cancel') controller.abort(new AgentMuxError('User stopped waiting', 'CONTROL_CANCELLED'))
    else void f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'RAW', source: 'user' }).catch(() => {})
    await vi.advanceTimersByTimeAsync(started + 8_000 - Date.now())
    expect(readAgentPromptPreparationWait((await sent)!)).toBeUndefined()
  } finally { released.resolve(); vi.useRealTimers(); await f.close() }
})

it.each(['gap', 'cancel', 'raw-input', 'geometry'] as const)('does not authorize retry from an earlier compact pane after %s', async fault => {
  const f = await fixture('none', 'immediate', true, 'context-compaction')
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const controller = new AbortController(), sent = f.send(controller.signal).then(() => null, error => error as AgentMuxError)
    await enteredWithClock(f.entered); await vi.advanceTimersByTimeAsync(50)
    if (fault === 'gap') f.listener()({ type: 'gap', runId: f.record.run.runId, firstAvailableByte: 99 })
    else if (fault === 'cancel') controller.abort(new AgentMuxError('User stopped waiting', 'CONTROL_CANCELLED'))
    else if (fault === 'raw-input') await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'RAW', source: 'user' })
    else f.owner.screenEvidence.discard(f.record.agentSessionId)
    await vi.advanceTimersByTimeAsync(8_000)
    const error = (await sent)!
    expect(readAgentPromptPreparationWait(error)).toBeUndefined()
    expect(f.writes).toEqual(fault === 'raw-input' ? ['RAW'] : [])
  } finally { vi.useRealTimers(); await f.close() }
})

it.each(['raw-input', 'native-source'] as const)('rejects preparation retry after original %s changed, preserving the healthy terminal', async changed => {
  const f = await fixture('none', 'immediate', true, 'context-compaction')
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sent = f.send().then(() => null, error => error as AgentMuxError)
    await enteredWithClock(f.entered); await vi.advanceTimersByTimeAsync(8_000)
    const wait = readAgentPromptPreparationWait((await sent)!)!
    vi.useRealTimers(); f.temporaryWait()
    if (changed === 'raw-input') await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'RAW', source: 'user' })
    else f.nativeSource('different-native-source')
    await expect(f.client.submitAgentPrompt({ ...f.request, preparationRetry: { inputByte: wait.inputByte, nativeSourceId: wait.nativeSourceId } }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', detail: expect.stringContaining('AGENT_PROMPT_RETRY_FENCE_CHANGED') })
    expect(f.writes).toEqual(changed === 'raw-input' ? ['RAW'] : [])
    await f.client.writeAgent({ agentSessionId: f.record.agentSessionId, expectedRun: f.record.run, data: 'STILL_OPEN', source: 'user' })
    expect(f.writes.at(-1)).toBe('STILL_OPEN')
  } finally { vi.useRealTimers(); await f.close() }
})


it('the public Hosted SDK, Unix RPC and compiled CLI retain the typed compact reason and original never-input receipt', async () => {
  const f = await fixture('none', 'immediate', false, 'context-compaction'), root = await mkdtemp(fixturePath("tmp/amux-compact-cli-"))
  const service = new AgentMuxHostedRuntimeService(f.client, (f.store as AgentMuxFileAgentSessionStore).path, () => hostedTestOwner(f.client))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => service })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, hosted: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  try {
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); hosted = await connectHostedAgentMux({ rpc })
    const error = await hosted.submitAgentPrompt(f.request).then(() => null, error => error as AgentMuxError)
    expect(readAgentPromptPreparationWait(error), JSON.stringify({ code: error?.code, detail: error?.detail })).toMatchObject({ reason: 'context-compaction', retrySafe: true, operationId: f.request.operationId })
    const record = await hosted.readDeliveryAttempt(error!.logId!)
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + server.path, 'message', 'delivery', 'inspect', '--logid', error!.logId!], objectCliEnvironment(root))
    expect(cli.code, cli.stderr).toBe(0)
    const observed = JSON.parse(cli.stdout).result.record
    expect(observed).toEqual(record.record)
    expect(readAgentPromptPreparationWait(observed.error)).toEqual(readAgentPromptPreparationWait(error))
    expect(f.writes).toEqual([])
    if (process.env.AGENTMUX_T002_EVIDENCE) await writeFile(join(process.env.AGENTMUX_T002_EVIDENCE, 'compact-reason-public-consumer.json'), JSON.stringify({ record, cli }))
  } finally { await hosted?.dispose(); await rpc?.dispose(); await server.stop(); await service.dispose(); await f.close(); await rm(root, { recursive: true, force: true }) }
}, 20_000)


it('a retry cannot rejoin an already admitted logical operation even when a former call wrote no bytes', async () => {
  const f = await fixture('none', 'immediate', true)
  try {
    await f.send(); expect(f.writes).toEqual(['ORIGINAL_BODY', '\r'])
    await expect(f.client.submitAgentPrompt({ ...f.request, preparationRetry: { inputByte: 0, nativeSourceId: 'original-source' } }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_RETRY_FENCE_CHANGED' })
    expect(f.writes).toEqual(['ORIGINAL_BODY', '\r'])
  } finally { await f.close() }
})

it('T005 keeps original pane geometry through the actual Hosted SDK, durable receipt and compiled inspect CLI', async () => {
  const f = await fixture('pane-predicate'), root = await mkdtemp(fixturePath("tmp/amux-pane-geometry-"))
  const service = new AgentMuxHostedRuntimeService(f.client, (f.store as AgentMuxFileAgentSessionStore).path, () => hostedTestOwner(f.client))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => service })
  const originalWait = f.owner.screenEvidence.wait.bind(f.owner.screenEvidence)
  vi.spyOn(f.owner.screenEvidence, 'wait').mockImplementation((...args: any[]) => originalWait(...args.slice(0, 4), { ...args[4], timeoutMs: 100 }))
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, hosted: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  try {
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); hosted = await connectHostedAgentMux({ rpc })
    const error = (await hosted.submitAgentPrompt(f.request).then(() => null, error => error as AgentMuxError))!
    const original = observation(error)
    expect(original).toMatchObject({ phase: 'current-pane', pane: { cols: 80, rows: 24, cursor: { row: 9, column: 2 }, geometryRevision: 0,
      authoritative: true, completeFrameAvailable: true, lastPredicateResult: false } })
    expect(readAgentPromptPreparationWait(error)).toBeUndefined(); expect(f.writes).toEqual([])
    await f.resize(true)
    const record = await hosted.readDeliveryAttempt(error.logId!)
    expect(record.record!.error.detail).toBe(error.detail)
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + server.path, 'message', 'delivery', 'inspect', '--logid', error.logId!], objectCliEnvironment(root))
    expect(cli.code, cli.stderr).toBe(0)
    const observed = JSON.parse(cli.stdout).result.record
    expect(observed).toEqual(record.record)
    expect(observation(observed.error)).toEqual(original)
    expect(original.pane).toMatchObject({ cols: 80, rows: 24, cursor: { row: 9, column: 2 }, geometryRevision: 0 })
    if (process.env.AGENTMUX_T005_EVIDENCE) await writeFile(join(process.env.AGENTMUX_T005_EVIDENCE, 'geometry-public-consumer.json'), JSON.stringify({ original, record, cli, laterRunSize: { cols: 100, rows: 30 }, writes: f.writes }))
  } finally { await hosted?.dispose(); await rpc?.dispose(); await server.stop(); await service.dispose(); await f.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)
