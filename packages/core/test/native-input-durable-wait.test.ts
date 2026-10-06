import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentInputSubmissionReceipt, AgentMuxAgentPromptInput, AgentMuxClientEvent, AgentNativePromptInputPlan } from '../src/index.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { DurableAgentMuxMessageQueue as SourceQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxControlServer as SourceServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc as SourceConnect } from '../src/public-rpc-client.js'
import { AgentMuxError as SourceError } from '../src/errors.js'
import { AgentMuxClient as SourceClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore as SourceStore } from '../src/agent-session-store.js'
import { AgentMuxHostedRuntimeService as SourceHostedService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux as SourceConnectHosted } from '../src/hosted-client.js'
import type { AgentMuxHostedRpcPort, AgentMuxHostedOutputRpcPort, AgentMuxHostedRuntimeMethod,
  AgentMuxHostedStreamMethod, AgentMuxHostedRuntimeParameterMap } from '../src/hosted-client-contract.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const entry = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY
const compiled = entry ? await import(entry) : null
const DurableAgentMuxMessageQueue: typeof SourceQueue = compiled?.DurableAgentMuxMessageQueue ?? SourceQueue
const AgentMuxControlServer: typeof SourceServer = compiled ? (await import(new URL('./public-rpc-server.js', pathToFileURL(entry!)).href)).AgentMuxControlServer : SourceServer
const connectAgentMuxRpc: typeof SourceConnect = compiled?.connectAgentMuxRpc ?? SourceConnect
const AgentMuxError: typeof SourceError = compiled?.AgentMuxError ?? SourceError
const AgentMuxClient: typeof SourceClient = compiled?.AgentMuxClient ?? SourceClient
const AgentMuxFileAgentSessionStore: typeof SourceStore = compiled?.AgentMuxFileAgentSessionStore ?? SourceStore
const AgentMuxHostedRuntimeService: typeof SourceHostedService = compiled ? (await import(new URL('./hosted-runtime-service.js', pathToFileURL(entry!)).href)).AgentMuxHostedRuntimeService : SourceHostedService
const connectHostedAgentMux: typeof SourceConnectHosted = compiled ? (await import(new URL('./hosted-client.js', pathToFileURL(entry!)).href)).connectHostedAgentMux : SourceConnectHosted
afterEach(() => vi.unstubAllEnvs())

const plan: AgentNativePromptInputPlan = { kind: 'native-rpc', operation: 'start-or-steer', protocolId: 'controlled-contract',
  sourceId: 'original-source', actorId: 'original-actor', threadId: 'original-thread' }
const text = 'Original text 原文\n{"stop":true,"saved":true} remains opaque.'
const note = 'Original platform note, separate from the body.'

/** Actual Core/Store/journal/RPC owners; Provider and Runtime machine ports are controlled. */
async function fixture() {
  const h = await rpcOwnerFixture(), dispatches: string[] = [], events: AgentMuxClientEvent[] = []
  let connected = false
  h.inner.connected = false; h.inner.kernel.isConnected = () => connected
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'original-runtime', protocolVersion: 1, buildIdentity: 'controlled' })
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(original, { ...original, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: plan.threadId },
    nativeBinding: { source: 'process-witness', run: original.run, observedAt: reshapeFixtureEpoch(0, 0, 1) } })
  await Reflect.get(h.client, 'registry').refresh('recipient', original.run)
  const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
  const prepare = vi.spyOn(provider as typeof provider & Required<Pick<typeof provider, 'prepareNativePromptInput'>>, 'prepareNativePromptInput')
    .mockImplementation(async context => ({ plan, close: async () => {}, assertCurrent: async signal => { signal.throwIfAborted(); expect(context.nativeHandle?.sessionId).toBe(plan.threadId) },
      dispatch: async (_body, operationId) => { dispatches.push(operationId); return { outcome: 'admitted', turnId: 'turn-' + operationId } } }))
  const off = h.client.onEvent(event => events.push(event))
  const input = (id: string): AgentMuxAgentPromptInput => ({ agentSessionId: 'recipient', expectedRun: original.run,
    admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', operationId: id, prompt: text, agentMuxNote: note, authorHuman: true, sourceChannel: 'message-tool' })
  const restore = () => {
    connected = true; h.inner.connected = true
    // This is an explicitly controlled original Core connection event port.
    // The independent real Native fixture must prove actual Runtime restoration.
    Reflect.get(h.client, 'publisher').publish({ type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() } })
  }
  const key = (id: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: original.run, submissionId: id })
  const read = async (id: string) => (await h.client.inspectAgentInput({ key: key(id) }))!
  const secondary = async () => {
    const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path) })
    await Reflect.get(client, 'registry').load('local')
    const kernel = Reflect.get(client, 'kernel')
    kernel.isConnected = () => false; kernel.status = h.inner.kernel.status; kernel.stop = vi.fn()
    return client
  }
  return { ...h, input, key, read, restore, prepare, dispatches, events, provider,
    secondary,
    queue: new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')),
    close: async () => { off(); prepare.mockRestore(); await h.close() } }
}
async function eventual(read: () => Promise<AgentInputSubmissionReceipt>, status: AgentInputSubmissionReceipt['status']) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = await read()
    if (receipt.status === status) return receipt
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const receipt = await read()
  expect(receipt.status, 'The original owner must produce its expected input receipt').toBe(status)
  return receipt
}

async function observedWaiting(read: () => Promise<AgentInputSubmissionReceipt>, phase: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = await read()
    if (receipt.control.waiting?.phase === phase) return receipt
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const receipt = await read()
  expect(receipt.control.waiting?.phase, 'The original owner must publish its expected bounded observation').toBe(phase)
  return receipt
}

function barrier() {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  return { pending, release }
}

it('SDK saves original body and note before Runtime qualification, then the original restore event admits once', async () => {
  const h = await fixture()
  try {
    const firstsave = await h.client.submitAgentPrompt(h.input('A')) as AgentInputSubmissionReceipt
    expect(firstsave).toMatchObject({ persistence: 'confirmed', status: 'waiting', ref: { waitGeneration: 1 } })
    const receipt = await observedWaiting(() => h.read('A'), 'runtime')
    expect(receipt).toMatchObject({ persistence: 'confirmed', status: 'waiting', ref: { waitGeneration: 1 },
      control: { state: 'enabled', waiting: { phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored' } } })
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.dispatches).toEqual([])
    const journal = await h.queue.readJournal()
    expect(journal.find(record => record.kind === 'input-intent')).toMatchObject({ intent: { key: h.key('A'),
      admissionIntent: { kind: 'manual-actor', expectedRun: h.key('A').expectedRun }, execution: 'immediate',
      source: { kind: 'prompt', prompt: text, agentMuxNote: note, authorHuman: true, sourceChannel: 'message-tool' } } })
    h.restore()
    const admitted = await eventual(() => h.read('A'), 'admitted')
    expect(admitted.admission?.admission?.inputDispatch?.ref).toEqual(admitted.ref)
    expect(h.dispatches).toEqual(['A'])
    await expect(h.client.submitAgentPrompt(h.input('A'))).resolves.toEqual(admitted)
    h.restore(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.dispatches).toEqual(['A'])
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('SDK stop wins before gate, keeps its original immutable receipt after generation two and never dispatches generation one', async () => {
  const h = await fixture()
  try {
    const first = await h.client.submitAgentPrompt(h.input('A')) as AgentInputSubmissionReceipt
    const stopped = await h.client.stopAgentInputWaiting({ ref: first.ref, cancelOperationId: 'original-stop' })
    expect(stopped).toMatchObject({ ref: first.ref, outcome: 'stopped-before-dispatch' })
    h.restore(); await new Promise(resolve => setTimeout(resolve, 20)); expect(h.dispatches).toEqual([])
    const next = await h.client.rejoinAgentInputWaiting({ ref: first.ref })
    expect(next.ref.waitGeneration).toBe(2)
    expect((await eventual(() => h.read('A'), 'admitted')).status).toBe('admitted'); expect(h.dispatches).toEqual(['A'])
    expect(await h.client.stopAgentInputWaiting({ ref: first.ref, cancelOperationId: 'original-stop' })).toEqual(stopped)
    expect(await h.client.stopAgentInputWaiting({ ref: first.ref, cancelOperationId: 'late-stop' })).toMatchObject({ outcome: 'stale-generation' })
    expect((await h.read('A')).ref).toEqual(next.ref)
  } finally { await h.close() }
})

it('public send and original Control selector preserve waiting instead of claiming delivery', async () => {
  const h = await fixture(), server = new AgentMuxControlServer({ socketPath: join(h.root, 'input.sock'), coreClients: h.coreClients })
  await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const sending = rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, text,
      execution: 'immediate', operationId: 'original-control', messageId: 'A' })
    await expect(sending).resolves.toMatchObject({ delivery: { state: 'queued' }, inputReceipt: { status: 'waiting', persistence: 'confirmed' } })
    const sent = await sending
    expect(sent.delivery.state).toBe('queued'); expect(sent.inputReceipt).toMatchObject({ status: 'waiting', originalControlOperationId: 'original-control' })
    const inspected = await rpc.call('agent.input.inspect', { kind: 'message-control', originalControlOperationId: 'original-control' })
    expect(inspected.input?.ref).toEqual(sent.inputReceipt?.ref); expect(inspected.record).toBeNull()
    const stopped = await rpc.call('agent.input.stop', { ref: sent.inputReceipt!.ref, cancelOperationId: 'public-stop' })
    expect(stopped.outcome).toBe('stopped-before-dispatch')
    const inputCli = async (action: 'inspect' | 'stop' | 'rejoin', body: unknown) => {
      const result = await runCompiledObjectCli(['--endpoint', 'unix://' + server.path, 'agent', 'input', action, '--input', '-'],
        objectCliEnvironment(h.root), JSON.stringify(body))
      expect(result.code, result.stderr).toBe(0)
      return JSON.parse(result.stdout).result
    }
    const cliRead = await inputCli('inspect', { kind: 'message-control', originalControlOperationId: 'original-control' })
    expect(cliRead.input).toMatchObject({ status: 'stopped', ref: sent.inputReceipt!.ref })
    expect(await inputCli('stop', { ref: sent.inputReceipt!.ref, cancelOperationId: 'public-stop' })).toEqual(stopped)
    const rejoined = await inputCli('rejoin', { ref: sent.inputReceipt!.ref })
    expect(rejoined).toMatchObject({ status: 'waiting', persistence: 'confirmed', ref: { key: sent.inputReceipt!.key, waitGeneration: 2 } })
    expect(h.dispatches).toEqual([])
    expect(await inputCli('stop', { ref: rejoined.ref, cancelOperationId: 'compiled-cli-stop-generation-two' }))
      .toMatchObject({ ref: rejoined.ref, outcome: 'stopped-before-dispatch' })
    h.restore(); await new Promise(resolve => setTimeout(resolve, 20)); expect(h.dispatches).toEqual([])
    expect((await h.queue.listAfter())[0]?.delivery.state).toBe('queued')
    expect((await h.queue.listAfter())[0]?.envelope.body).toBe(text)
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})

it('disposing the original observer while ready qualification is awaited cannot win a new dispatch gate', async () => {
  const h = await fixture(), entered = barrier(), continueQualification = barrier()
  h.restore()
  h.prepare.mockImplementationOnce(async () => ({ plan, close: async () => {},
    assertCurrent: async () => { entered.release(); await continueQualification.pending },
    dispatch: async () => { h.dispatches.push('wrong-after-dispose'); return { outcome: 'admitted', turnId: 'wrong-turn' } } }))
  try {
    const pending = h.client.submitAgentPrompt(h.input('dispose-race'))
    await entered.pending
    const disposing = h.client.dispose()
    continueQualification.release()
    await disposing
    await pending
    const receipt = await observedWaiting(() => h.read('dispose-race'), 'observer')
    expect(receipt.status).toBe('waiting'); expect(receipt.control.state).toBe('enabled')
    expect(receipt.observation).toBe('rejoin-needed')
    expect(receipt.admission).toBeNull(); expect(h.dispatches).toEqual([])
    expect((await h.queue.readJournal()).find(record => record.kind === 'input-intent')).toMatchObject({ intent: { source: { prompt: text, agentMuxNote: note } } })
    h.restore(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.dispatches).toEqual([]); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { continueQualification.release(); await h.close() }
})

it('SDK and public inspection retain the original Native phase, bounded cause, detail and log ID without granting retry', async () => {
  const h = await fixture(), server = new AgentMuxControlServer({ socketPath: join(h.root, 'error.sock'), coreClients: h.coreClients })
  const cause = Object.assign(new Error('peer ownership unavailable'), { code: 'EACCES', detail: '{"errno":13,"causes":["owner","mode","peer","image"]}' })
  const original = Object.assign(new AgentMuxError('Original Native preparation failed.', 'AGENT_NATIVE_INPUT_UNCONFIRMED', 'unknown'), { cause, logId: 'UDB5dR1foMBL' })
  h.prepare.mockImplementation(async context => { context.onPreparationPhase?.('native-peer'); throw original })
  h.restore(); await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    await h.client.submitAgentPrompt(h.input('cause'))
    const receipt = await observedWaiting(() => h.read('cause'), 'native-environment')
    expect(receipt).toMatchObject({ status: 'waiting', control: { state: 'enabled', waiting: {
      phase: 'native-environment', wake: 'explicit-rejoin', observation: { phase: 'native-peer', failure: {
        name: 'AgentMuxError', code: 'AGENT_NATIVE_INPUT_UNCONFIRMED', logId: 'UDB5dR1foMBL',
        cause: { message: cause.message, code: 'EACCES', detail: cause.detail }
      } }
    } } })
    const inspected = await rpc.call('agent.input.inspect', { key: h.key('cause') })
    expect(inspected.input?.control.waiting).toEqual(receipt.control.waiting)
    h.restore(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.dispatches).toEqual([])
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})

it('an actual programming error remains a visible service observation failure, while cleanup failure cannot replace Native admission', async () => {
  const h = await fixture()
  h.restore()
  h.prepare.mockRejectedValueOnce(new TypeError('Controlled implementation fault'))
  try {
    await h.client.submitAgentPrompt(h.input('service-fault'))
    const broken = await observedWaiting(() => h.read('service-fault'), 'service')
    expect(broken.control.waiting).toMatchObject({ phase: 'service', reason: 'observation-failed', wake: 'explicit-rejoin',
      failure: { name: 'TypeError', message: 'Controlled implementation fault' } })
    expect(h.dispatches).toEqual([])
    const cleanup = Object.assign(new Error('Original channel close unconfirmed'), { code: 'EIO' })
    h.prepare.mockImplementationOnce(async () => ({ plan, assertCurrent: async signal => signal.throwIfAborted(),
      dispatch: async (_body, id) => { h.dispatches.push(id); return { outcome: 'admitted', turnId: 'admitted-turn' } }, close: async () => { throw cleanup } }))
    await h.client.submitAgentPrompt(h.input('cleanup-fault'))
    const admitted = await eventual(() => h.read('cleanup-fault'), 'admitted')
    await vi.waitFor(() => expect(h.events.find(event => event.type === 'agent-error' && event.code === 'AGENT_NATIVE_INPUT_CLEANUP_UNCONFIRMED')).toBeDefined())
    expect(admitted.status).toBe('admitted'); expect(admitted.admission?.admission?.acknowledged).toBe(true)
    expect(h.events.find(event => event.type === 'agent-error' && event.code === 'AGENT_NATIVE_INPUT_CLEANUP_UNCONFIRMED')).toMatchObject({
      failure: { name: 'Error', message: cleanup.message, code: 'EIO' } })
    expect(h.dispatches).toEqual(['cleanup-fault'])
    expect((await h.read('cleanup-fault')).status).toBe('admitted')
  } finally { await h.close() }
})

it('stop after the original journal gate releases observation without recalling the Native operation', async () => {
  const h = await fixture(), gated = barrier(), proceed = barrier()
  let assertions = 0
  h.restore()
  h.prepare.mockImplementationOnce(async () => ({ plan, close: async () => {}, assertCurrent: async signal => {
    signal.throwIfAborted()
    if (++assertions === 2) { gated.release(); await proceed.pending; signal.throwIfAborted() }
  }, dispatch: async (_body, id, signal) => { signal?.throwIfAborted(); h.dispatches.push(id); return { outcome: 'admitted', turnId: 'original-admitted' } } }))
  try {
    const pending = h.client.submitAgentPrompt(h.input('gate-winner'))
    await gated.pending
    const original = await h.read('gate-winner')
    expect(original.control.state).toBe('dispatch-authorized')
    const stopped = await h.client.stopAgentInputWaiting({ ref: original.ref, cancelOperationId: 'after-gate' })
    expect(stopped.outcome).toBe('observation-stopped')
    proceed.release()
    await pending
    const receipt = await eventual(() => h.read('gate-winner'), 'admitted')
    expect(receipt.status).toBe('admitted'); expect(h.dispatches).toEqual(['gate-winner'])
    expect(await h.client.rejoinAgentInputWaiting({ ref: original.ref })).toEqual(receipt)
    expect(h.dispatches).toEqual(['gate-winner'])
  } finally { proceed.release(); await h.close() }
})

it('caller Abort releases only its original observer before gate and requires explicit rejoin', async () => {
  const h = await fixture(), entered = barrier(), proceed = barrier(), controller = new AbortController()
  h.restore()
  h.prepare.mockImplementationOnce(async context => { entered.release(); await proceed.pending; context.signal.throwIfAborted(); throw new Error('unreachable') })
  try {
    const pending = h.client.submitAgentPrompt({ ...h.input('caller-abort'), signal: controller.signal })
    await entered.pending; controller.abort(new Error('Original caller stopped observing')); proceed.release()
    await pending
    const receipt = await observedWaiting(() => h.read('caller-abort'), 'observer')
    expect(receipt).toMatchObject({ status: 'waiting', observation: 'rejoin-needed', control: { state: 'enabled',
      waiting: { phase: 'observer', reason: 'observer-stopped', wake: 'explicit-rejoin' } }, admission: null })
    expect(h.dispatches).toEqual([])
    h.restore(); await new Promise(resolve => setTimeout(resolve, 20)); expect(h.dispatches).toEqual([])
    await h.client.rejoinAgentInputWaiting({ ref: receipt.ref })
    expect((await eventual(() => h.read('caller-abort'), 'admitted')).status).toBe('admitted'); expect(h.dispatches).toEqual(['caller-abort'])
  } finally { proceed.release(); await h.close() }
})

it('same-key clients keep a firstsaved manual producer when an earlier exact preparation later reaches its metadata claim', async () => {
  const h = await fixture(), other = await h.secondary(), reached = barrier(), proceed = barrier()
  h.restore()
  h.prepare.mockImplementationOnce(async () => ({ plan, close: async () => {}, assertCurrent: async () => { reached.release(); await proceed.pending },
    dispatch: async () => { h.dispatches.push('wrong-exact'); return { outcome: 'admitted', turnId: 'wrong-turn' } } }))
  try {
    const input = h.input('same-key'), { admissionIntent: _manual, ...exact } = input
    const old = h.client.submitAgentPrompt({ ...exact, afterSubmissionId: null }).then(() => ({ error: null }), error => ({ error }))
    await reached.pending
    const saved = await other.submitAgentPrompt(input) as AgentInputSubmissionReceipt
    const stopped = await other.stopAgentInputWaiting({ ref: saved.ref, cancelOperationId: 'same-key-stop' })
    expect(stopped.outcome).toBe('stopped-before-dispatch')
    proceed.release()
    expect((await old).error).toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect(await h.client.inspectAgentPromptSubmission(h.key('same-key'))).toBeNull()
    expect(h.dispatches).toEqual([])
    expect((await h.read('same-key')).status).toBe('stopped')
    expect((await h.queue.readJournal()).filter(record => record.kind === 'input-intent')).toHaveLength(1)
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { proceed.release(); await other.dispose(); await h.close() }
})

it('firstsave ACK loss preserves its original journal, and inspection never starts an observer or dispatches input', async () => {
  const h = await fixture(), queue = Reflect.get(h.client, 'messageQueue') as SourceQueue
  const save = queue.savePromptInput.bind(queue), lost = new Error('Controlled original firstsave ACK lost')
  const fault = vi.spyOn(queue, 'savePromptInput').mockImplementationOnce(async (...args) => { await save(...args); throw lost })
  try {
    await expect(h.client.submitAgentPrompt(h.input('firstsave-lost'))).rejects.toBe(lost)
    fault.mockRestore()
    const receipt = await h.read('firstsave-lost')
    expect(receipt).toMatchObject({ status: 'waiting', observation: 'rejoin-needed', persistence: 'confirmed', admission: null })
    expect((await h.queue.readJournal()).find(record => record.kind === 'input-intent')).toMatchObject({ intent: { source: { prompt: text, agentMuxNote: note } } })
    h.restore(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.dispatches).toEqual([])
    await h.client.rejoinAgentInputWaiting({ ref: receipt.ref })
    expect((await eventual(() => h.read('firstsave-lost'), 'admitted')).status).toBe('admitted'); expect(h.dispatches).toEqual(['firstsave-lost'])
  } finally { fault.mockRestore(); await h.close() }
})

it('metadata CAS success followed by actual journal COMMIT failure keeps the old claim unknown and never dispatches or replays it', async () => {
  const h = await fixture(), queue = Reflect.get(h.client, 'messageQueue') as SourceQueue
  const originalCas = h.store.compareAndSwapMetadata.bind(h.store)
  let injected = false, fault: ReturnType<typeof vi.spyOn> | undefined
  const cas = vi.spyOn(h.store, 'compareAndSwapMetadata').mockImplementation(async (...args) => {
    await originalCas(...args)
    if (args[1]?.promptCompletionAdmission?.submissionId === 'commit-gap' && !injected) {
      injected = true
      const db = Reflect.get(queue, 'database')
      expect(db).toBeDefined()
      const exec = db.exec.bind(db)
      fault = vi.spyOn(db, 'exec').mockImplementation((sql: unknown) => { if (sql === 'COMMIT') throw Object.assign(new Error('Controlled original journal commit failure'), { code: 'EIO' }); return exec(sql) })
    }
  })
  h.restore()
  try {
    const { admissionIntent: _manual, ...input } = h.input('commit-gap')
    await expect(h.client.submitAgentPrompt({ ...input, afterSubmissionId: null })).rejects.toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
    fault?.mockRestore(); cas.mockRestore()
    expect(injected).toBe(true); expect(h.dispatches).toEqual([])
    const old = await h.client.inspectAgentPromptSubmission(h.key('commit-gap'))
    expect(old?.admission).toMatchObject({ transport: 'native', native: { outcome: 'claimed' } })
    await expect(h.client.submitAgentPrompt({ ...input, afterSubmissionId: null })).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    await expect(h.client.submitAgentPrompt(h.input('commit-gap'))).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect(h.dispatches).toEqual([])
    await h.client.submitAgentPrompt(h.input('independent-after-gap'))
    const newInput = await eventual(() => h.read('independent-after-gap'), 'admitted')
    expect(newInput.status).toBe('admitted'); expect(h.dispatches).toEqual(['independent-after-gap'])
    expect(await h.client.inspectAgentPromptSubmission(h.key('commit-gap'))).toEqual(old)
  } finally { fault?.mockRestore(); cas.mockRestore(); await h.close() }
})

it('the existing note-only SDK prompt contract firstsaves the original empty body and separate nonempty note', async () => {
  const h = await fixture()
  try {
    const receipt = await h.client.submitAgentPrompt({ ...h.input('note-only'), prompt: '', agentMuxNote: note }) as AgentInputSubmissionReceipt
    expect(receipt).toMatchObject({ status: 'waiting', persistence: 'confirmed', admission: null })
    expect((await h.queue.readJournal()).find(record => record.kind === 'input-intent')).toMatchObject({ intent: { source: { prompt: '', agentMuxNote: note } } })
    await expect(h.client.submitAgentPrompt({ ...h.input('empty'), prompt: '', agentMuxNote: '' })).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.dispatches).toEqual([])
  } finally { await h.close() }
})

it('Hosted original semantic owner firstsaves and controls the same input while Runtime preconnect fails; reader reconnection is not a wake', async () => {
  const h = await fixture(), calls: unknown[] = []
  const connect = vi.spyOn(h.client, 'connect').mockRejectedValue(new AgentMuxError('Original Runtime is unavailable', 'RUNTIME_UNAVAILABLE'))
  const service = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client))
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params, options) => {
      const wire = JSON.parse(JSON.stringify(params)); calls.push(wire)
      return JSON.parse(JSON.stringify(await service.call(method, wire, options)))
    },
    subscribe: async (...[method, params, handlers]: Parameters<AgentMuxHostedRpcPort['subscribe']> | Parameters<AgentMuxHostedOutputRpcPort['subscribe']>) => {
      const subscription = await service.subscribe(method, JSON.parse(JSON.stringify(params)), event => handlers.onEvent(JSON.parse(JSON.stringify(event))))
      handlers.onInitial!(JSON.parse(JSON.stringify(subscription.initial))); await subscription.start?.()
      return { dispose: () => subscription.dispose() }
    }
  }
  const hosted = await connectHostedAgentMux({ rpc: port, consumerId: 'original-consumer' })
  const baselineConnects = connect.mock.calls.length
  try {
    expect(baselineConnects).toBeGreaterThan(0)
    const receipt = await hosted.submitAgentPrompt(h.input('hosted-A')) as AgentInputSubmissionReceipt
    expect(receipt).toMatchObject({ status: 'waiting', persistence: 'confirmed', key: h.key('hosted-A') })
    expect(connect).toHaveBeenCalledTimes(baselineConnects)
    expect(await hosted.inspectAgentInput({ key: receipt.key })).toMatchObject({ status: 'waiting', key: receipt.key })
    const stop = await hosted.stopAgentInputWaiting({ ref: receipt.ref, cancelOperationId: 'hosted-original-stop' })
    expect(stop).toMatchObject({ ref: receipt.ref, outcome: 'stopped-before-dispatch', cancelOperationId: 'hosted-original-stop' })
    hosted.disconnect(); await hosted.connect()
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.dispatches).toEqual([])
    const next = await hosted.rejoinAgentInputWaiting({ ref: receipt.ref })
    expect(next).toMatchObject({ status: 'waiting', ref: { key: h.key('hosted-A'), waitGeneration: 2 } })
    h.restore()
    const admitted = await eventual(() => h.read('hosted-A'), 'admitted')
    expect(admitted.ref.waitGeneration).toBe(2); expect(h.dispatches).toEqual(['hosted-A'])
    expect(await hosted.inspectAgentInput({ key: receipt.key })).toEqual(admitted)
    const foreign: AgentMuxHostedRpcPort = { ...port,
      call: async <M extends Exclude<AgentMuxHostedRuntimeMethod, AgentMuxHostedStreamMethod>>(method: M,
        params: AgentMuxHostedRuntimeParameterMap[M], options?: { signal?: AbortSignal }) => method === 'runtime.invoke'
        ? await port.call(method, { ...params, fence: { ...(params as AgentMuxHostedRuntimeParameterMap['runtime.invoke']).fence, ownerInstanceId: 'foreign-owner' } }, options)
        : await port.call(method, params, options) }
    const wrongOwner = await connectHostedAgentMux({ rpc: foreign, consumerId: 'foreign-consumer' })
    try { await expect(wrongOwner.stopAgentInputWaiting({ ref: admitted.ref, cancelOperationId: 'foreign-stop' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' }) }
    finally { await wrongOwner.dispose() }
    expect(h.dispatches).toEqual(['hosted-A']); expect(calls.length).toBeGreaterThan(0)
  } finally { await hosted.dispose(); await service.dispose(); connect.mockRestore(); await h.close() }
})

it('caller abort keeps the original Native preparation phase and combined primary/cleanup failure without creating a dispatch gate', async () => {
  const h = await fixture(), controller = new AbortController(), entered = barrier(), finish = barrier()
  const primary = Object.assign(new AgentMuxError('Original preparation was aborted', 'AGENT_NATIVE_INPUT_UNCONFIRMED',
    JSON.stringify({ primary: { name: 'AbortError', code: 'ABORT_ERR' }, cleanup: { name: 'Error', code: 'PRIVATE_HELPER_EXIT_UNKNOWN' } })),
    { cause: Object.assign(new Error('Original abort reason'), { code: 'ABORT_ERR' }), logId: 'JkS9GmT3RoY7' })
  h.prepare.mockImplementation(async context => {
    context.onPreparationPhase?.('native-source'); entered.release()
    await finish.pending
    expect(context.signal.aborted).toBe(true)
    throw primary
  })
  h.restore()
  try {
    await h.client.submitAgentPrompt({ ...h.input('abort-cleanup'), signal: controller.signal })
    await entered.pending; controller.abort(new Error('Original observer stopped')); finish.release()
    const receipt = await observedWaiting(() => h.read('abort-cleanup'), 'observer')
    expect(receipt.control).toMatchObject({ state: 'enabled', waiting: { phase: 'observer', reason: 'observer-stopped', wake: 'explicit-rejoin',
      observation: { phase: 'native-source' }, failure: { code: 'AGENT_NATIVE_INPUT_UNCONFIRMED', detail: primary.detail, logId: 'JkS9GmT3RoY7', cause: { code: 'ABORT_ERR' } } } })
    expect(receipt.admission).toBeNull(); expect(h.dispatches).toEqual([])
    expect(await h.client.inspectAgentPromptSubmission(receipt.key)).toBeNull()
    const server = new AgentMuxControlServer({ socketPath: join(h.root, 'wait-control.sock'), coreClients: h.coreClients })
    await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(h.root, 'wait-control.sock') } })
    try { expect((await rpc.call('agent.input.inspect', { key: receipt.key })).input).toEqual(receipt) }
    finally { await rpc.dispose(); await server.stop() }
  } finally { finish.release(); await h.close() }
})

it('a winning Stop keeps its exact receipt while additional preparation and cleanup uncertainty remains visible on the original error owner', async () => {
  const h = await fixture(), entered = barrier(), finish = barrier()
  const failure = Object.assign(new AgentMuxError('Original cancelled preparation and helper close are unconfirmed', 'AGENT_NATIVE_INPUT_UNCONFIRMED',
    JSON.stringify({ primary: { name: 'AbortError', code: 'ABORT_ERR' }, cleanup: { name: 'Error', code: 'PRIVATE_HELPER_EXIT_UNKNOWN' } })),
    { cause: Object.assign(new Error('Original abort reason'), { code: 'ABORT_ERR' }) })
  h.prepare.mockImplementation(async context => {
    context.onPreparationPhase?.('native-peer'); entered.release(); await finish.pending
    expect(context.signal.aborted).toBe(true); throw failure
  })
  h.restore()
  try {
    const first = await h.client.submitAgentPrompt(h.input('stop-cleanup')) as AgentInputSubmissionReceipt
    await entered.pending
    const stop = await h.client.stopAgentInputWaiting({ ref: first.ref, cancelOperationId: 'original-stop-with-cleanup' })
    expect(stop.outcome).toBe('stopped-before-dispatch'); finish.release()
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'agent-error', agentSessionId: 'recipient',
      code: 'AGENT_INPUT_WAIT_OBSERVATION_UNCONFIRMED', failure: expect.objectContaining({ code: 'AGENT_NATIVE_INPUT_UNCONFIRMED', detail: failure.detail, cause: expect.objectContaining({ code: 'ABORT_ERR' }) }) })))
    const receipt = await h.read('stop-cleanup')
    expect(receipt).toMatchObject({ status: 'stopped', ref: first.ref, control: { state: 'stopped-before-dispatch' }, admission: null })
    expect(h.dispatches).toEqual([])
    expect(await h.client.stopAgentInputWaiting({ ref: first.ref, cancelOperationId: stop.cancelOperationId })).toEqual(stop)
  } finally { finish.release(); await h.close() }
})

it('a saved Agent message does not retain a dispatch grant after its actual author capability is revoked', async () => {
  const h = await fixture(), server = new AgentMuxControlServer({ socketPath: join(h.root, 'author-wait.sock'), coreClients: h.coreClients })
  await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: h.credentials })
  try {
    const first = await rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, text,
      execution: 'immediate', operationId: 'author-original-control', messageId: 'author-original-input' })
    expect(first.inputReceipt).toMatchObject({ status: 'waiting', persistence: 'confirmed' })
    const sender = (await h.store.readMetadata('caller'))!
    const revoked = { ...sender, updatedAt: sender.updatedAt + 1 }
    delete revoked.capabilityHash
    await h.store.compareAndSwapMetadata(sender, revoked)
    h.restore()
    const receipt = await observedWaiting(() => h.client.inspectAgentInput({ key: first.inputReceipt!.key }) as Promise<AgentInputSubmissionReceipt>, 'authorization')
    expect(receipt.control.waiting).toMatchObject({ phase: 'authorization', reason: 'author-authorization-needed', wake: 'explicit-rejoin' })
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.dispatches).toEqual([])
    const original = await h.queue.readByOperationId('author-original-control')
    expect(original?.envelope).toMatchObject({ body: text, sender: { kind: 'agent-session', agentSessionId: 'caller' }, senderRunId: 'run-caller', recipientRunId: 'run-recipient' })
    await expect(h.client.rejoinAgentInputWaiting({ ref: receipt.ref, caller: h.credentials })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    const stop = await h.client.stopAgentInputWaiting({ ref: receipt.ref, cancelOperationId: 'trusted-original-stop' })
    expect(stop.outcome).toBe('stopped-before-dispatch'); expect(h.dispatches).toEqual([])
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})

it('an independent actual Core client wins Stop at the original journal gate without cancelling the first client or reporting normal Stop as a service failure', async () => {
  const h = await fixture(), other = await h.secondary(), entered = barrier(), finish = barrier()
  h.prepare.mockImplementation(async () => ({ plan, close: async () => {}, assertCurrent: async () => { entered.release(); await finish.pending },
    dispatch: async (_body, id) => { h.dispatches.push(id); return { outcome: 'admitted', turnId: 'unexpected' } } }))
  h.restore()
  try {
    const first = await h.client.submitAgentPrompt(h.input('cross-client-stop')) as AgentInputSubmissionReceipt
    await entered.pending
    const stop = await other.stopAgentInputWaiting({ ref: first.ref, cancelOperationId: 'independent-original-stop' })
    expect(stop.outcome).toBe('stopped-before-dispatch'); finish.release()
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'agent-input', receipt: expect.objectContaining({ status: 'stopped' }) })))
    expect(h.dispatches).toEqual([]); expect(await h.client.inspectAgentPromptSubmission(first.key)).toBeNull()
    expect(h.events.filter(event => event.type === 'agent-error' && event.code === 'AGENT_INPUT_WAIT_OBSERVATION_UNCONFIRMED')).toEqual([])
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { finish.release(); await other.dispose(); await h.close() }
})

it.each(['missing-known', 'confirmed-after-unknown', 'known-replacement'] as const)('saved original Native source stays bounded when its observation is %s', async change => {
  const h = await fixture()
  try {
    if (change === 'confirmed-after-unknown') {
      const old = (await h.store.readMetadata('recipient'))!
      const unknown = { ...old }; delete unknown.nativeHandle; delete unknown.nativeBinding
      await h.store.compareAndSwapMetadata(old, unknown)
    }
    const receipt = await h.client.submitAgentPrompt(h.input('source-fence')) as AgentInputSubmissionReceipt
    const saved = (await h.store.readMetadata('recipient'))!
    const changed = { ...saved, updatedAt: Math.max(saved.updatedAt, 2) }
    if (change === 'missing-known') { delete changed.nativeHandle; delete changed.nativeBinding }
    else {
      changed.nativeHandle = { kind: 'provider', providerId: 'codex', sessionId: change === 'known-replacement' ? 'different-thread' : plan.threadId }
      changed.nativeBinding = { source: 'process-witness', run: saved.run, observedAt: reshapeFixtureEpoch(0, 0, 2) }
    }
    await h.store.compareAndSwapMetadata(saved, changed)
    h.restore()
    const waiting = await observedWaiting(() => h.read('source-fence'), 'native-environment')
    expect(waiting.control.waiting).toMatchObject({ phase: 'native-environment', wake: 'explicit-rejoin',
      reason: change === 'known-replacement' ? 'original-target-changed' : 'original-environment-unconfirmed' })
    expect(waiting.admission).toBeNull(); expect(waiting.key).toEqual(receipt.key)
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.dispatches).toEqual([])
    expect((await h.queue.readJournal()).find(record => record.kind === 'input-intent')).toMatchObject({ intent: { key: receipt.key, source: { prompt: text, agentMuxNote: note } } })
  } finally { await h.close() }
})


it('the current original managed author can inspect and stop an old recipient Run without authorizing input to its replacement', async () => {
  const h = await fixture(), server = new AgentMuxControlServer({ socketPath: join(h.root, 'old-recipient.sock'), coreClients: h.coreClients })
  await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: h.credentials })
  try {
    const sent = await rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, text,
      execution: 'immediate', operationId: 'old-author-control', messageId: 'old-author-input' })
    const original = sent.inputReceipt!, old = (await h.store.readMetadata('recipient'))!
    const replacement = { ...old, run: { runId: 'replacement-recipient' } }; delete replacement.nativeBinding
    await h.store.compareAndSwapMetadata(old, replacement)
    const read = await rpc.call('agent.input.inspect', { key: original.key })
    expect(read.input?.key).toEqual(original.key); expect(read.input?.status).toBe('waiting')
    const stopped = await rpc.call('agent.input.stop', { ref: original.ref, cancelOperationId: 'original-author-stop' })
    expect(stopped).toMatchObject({ ref: original.ref, outcome: 'stopped-before-dispatch' })
    const stoppedBeforeRejoin = await h.client.inspectAgentInput({ key: original.key })
    await expect(h.client.rejoinAgentInputWaiting({ ref: original.ref, caller: h.credentials })).rejects.toMatchObject({ code: 'MESSAGE_RECIPIENT_MISMATCH' })
    expect(await h.client.inspectAgentInput({ key: original.key })).toEqual(stoppedBeforeRejoin)
    expect(await h.client.stopAgentInputWaiting({ ref: original.ref, cancelOperationId: stopped.cancelOperationId, caller: h.credentials })).toEqual(stopped)
    await expect(h.client.stopAgentInputWaiting({ ref: original.ref, cancelOperationId: 'wrong-author',
      caller: { agentSessionId: 'recipient', capability: h.credentials.capability } })).rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.dispatches).toEqual([])
    expect((await h.queue.readByOperationId('old-author-control'))?.envelope).toMatchObject({ body: text, recipientRunId: old.run.runId, senderRunId: 'run-caller' })
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})
