import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { AgentTerminalScreenEvidence } from '../src/agent-terminal-screen.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type { CtxmuxAdapterRun, CtxmuxAdapterOutputObservation } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

type Input = { operationId: string; expectedByte: number; data: string | Uint8Array }
type Ack = { run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }
type Inner = {
  connected: boolean
  registry: AgentMuxAgentSessionRegistry
  screenEvidence: AgentScreenEvidenceStore
  kernel: {
    isConnected(): boolean
    identity(): { daemonInstanceId: string }
    status(runId: string): Promise<CtxmuxAdapterRun>
    input(runId: string, operation: Input): Promise<Ack>
    observeOutput: (...args: unknown[]) => Promise<CtxmuxAdapterOutputObservation>
  }
  writeAgentInput(session: AgentMuxStoredAgentSession, data: string): Promise<unknown>
}
const clients: AgentMuxClient[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map(client => client.dispose()))
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(providerId: 'codex' | 'claude') {
  const store = new AgentMuxMemoryAgentSessionStore()
  const stored: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'synthetic-input-agent', providerId, executorId: providerId,
    hostId: 'local', workspacePath: '/synthetic', run: { runId: 'synthetic-running' }, retiredRuns: [],
    hookBindingId: 'synthetic-binding', hookToken: 'synthetic-token', createdAt: 1, updatedAt: 2,
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: 2, stateEnteredAt: 2 }
  }
  await store.compareAndSwap(null, stored)
  const client = new AgentMuxClient({ store })
  clients.push(client)
  const inner = client as unknown as Inner
  await inner.registry.load('local')
  inner.connected = true
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'synthetic-daemon' })
  let acceptedBytes = 0
  const run = (): CtxmuxAdapterRun => ({
    nativeService: null,
    runId: stored.run.runId, lifecycleOperationId: null, program: providerId, args: [],
    workspacePath: '/synthetic', pid: 123, state: { type: 'running' }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: acceptedBytes
  })
  const status = vi.fn(async () => run())
  inner.kernel.status = status
  const writes: Input[] = []
  inner.kernel.input = async (_runId, input) => {
    expect(input.expectedByte).toBe(acceptedBytes)
    writes.push(input)
    const startByte = acceptedBytes
    acceptedBytes += typeof input.data === 'string' ? Buffer.byteLength(input.data) : input.data.byteLength
    return { run: run(), appliedByteRange: { startByte, endByte: acceptedBytes } }
  }
  return { client, inner, stored, writes, status, run }
}


const checkpoint = (): Promise<void> => new Promise(done => setImmediate(done))

function blankTerminalObservation(run: CtxmuxAdapterRun, close: () => Promise<void>): CtxmuxAdapterOutputObservation {
  if (run.cols === null || run.rows === null || run.latestOutputBytes !== 0) {
    throw new Error('This fixture requires a fresh Run with a known empty terminal.')
  }
  return {
    run, replay: [], gap: null, resizeRevision: 0, close,
    // An owner-confirmed blank checkpoint restores a screen without advancing original output.
    terminal: { type: 'basic-vt', checkpoint: { restoreSize: { cols: run.cols, rows: run.rows }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0, runId: run.runId, throughByte: 0,
      resizeRevision: 0, size: { cols: run.cols, rows: run.rows } },
      restoreBytes: new TextEncoder().encode('\x1bc'), resizes: [] }
  }
}

function heldRender(h: Awaited<ReturnType<typeof fixture>>) {
  const entered = deferred<void>()
  const release = deferred<number>()
  const signals: Array<AbortSignal | undefined> = []
  vi.spyOn(h.inner.screenEvidence, 'wait').mockImplementation(async (_session, _boundary, _after, _predicate, options) => {
    signals.push(options.signal)
    entered.resolve()
    if (options.signal?.aborted) throw new AgentMuxError('Synthetic observation cancelled.', 'AGENT_PROMPT_READINESS_CANCELLED')
    let cancel!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new AgentMuxError('Synthetic observation cancelled.', 'AGENT_PROMPT_READINESS_CANCELLED'))
      options.signal?.addEventListener('abort', cancel, { once: true })
    })
    try { return await Promise.race([release.promise, cancelled]) }
    finally { options.signal?.removeEventListener('abort', cancel) }
  })
  return { entered, release, signals }
}

it.each(['codex', 'claude'] as const)('preempts optional %s rendering, preserving payload/CR/raw order and the degraded delivery fact', async providerId => {
  const h = await fixture(providerId)
  const screen = heldRender(h)
  const events: unknown[] = []
  h.client.onEvent(event => events.push(event))
  expect(h.client.providers.get(providerId).planPromptInput('hello').kind).toBe('render-then-submit')
  const prompt = h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession(h.stored.agentSessionId)), agentSessionId: h.stored.agentSessionId,
    expectedRun: h.stored.run, operationId: 'synthetic-operation', prompt: 'hello' })
  let raw: Array<Promise<unknown>> = []
  try {
    await screen.entered.promise
    raw = ['\x1b[<64;10;10M', 'z'].map(data => h.client.writeAgent({ agentSessionId: h.stored.agentSessionId, expectedRun: h.client.agentSession(h.stored.agentSessionId).run, data: data, source: 'user' }))
    await checkpoint()
    const beforeRelease = h.writes.map(write => write.data)
    // The fallback only settles broken implementations; it cannot make the before-release oracle green.
    screen.release.resolve(1)
    await Promise.all([prompt, ...raw])
    expect(beforeRelease).toEqual(['hello', '\r', '\x1b[<64;10;10M', 'z'])
    expect(h.writes.map(write => write.expectedByte)).toEqual([0, 5, 6, 18])
    expect(new Set(h.writes.map(write => write.operationId)).size).toBe(4)
    expect(h.client.agentSession(h.stored.agentSessionId).terminalPromptDelivery).toMatchObject({
      state: 'unverified', reason: 'screen-evidence-replaced', submissionId: 'synthetic-operation', run: h.stored.run
    })
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent-session', session: expect.objectContaining({
      terminalPromptDelivery: expect.objectContaining({ reason: 'screen-evidence-replaced' })
    }) }))
    const count = h.writes.length
    await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession(h.stored.agentSessionId)), agentSessionId: h.stored.agentSessionId,
      expectedRun: h.stored.run, operationId: 'synthetic-operation', prompt: 'hello' })
    expect(h.writes).toHaveLength(count)
  } finally {
    screen.release.resolve(1)
    await Promise.allSettled([prompt, ...raw])
  }
})

it('registers observation cancellation before a prompt enters its queued render phase', async () => {
  const h = await fixture('codex')
  const priorEntered = deferred<void>(), priorRelease = deferred<void>()
  const originalInput = h.inner.kernel.input
  h.inner.kernel.input = async (runId, input) => {
    if (input.data === 'prior') { priorEntered.resolve(); await priorRelease.promise }
    return await originalInput(runId, input)
  }
  const screen = heldRender(h)
  const prior = h.client.writeAgent({ agentSessionId: h.stored.agentSessionId, expectedRun: h.client.agentSession(h.stored.agentSessionId).run, data: 'prior', source: 'user' })
  await priorEntered.promise
  const prompt = h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession(h.stored.agentSessionId)), agentSessionId: h.stored.agentSessionId,
    expectedRun: h.stored.run, operationId: 'queued-operation', prompt: 'hello' })
  const raw = h.client.writeAgent({ agentSessionId: h.stored.agentSessionId, expectedRun: h.client.agentSession(h.stored.agentSessionId).run, data: 'z', source: 'user' })
  try {
    priorRelease.resolve()
    await screen.entered.promise
    await checkpoint()
    const beforeRelease = h.writes.map(write => write.data)
    const abortedAtWait = screen.signals[0]?.aborted
    screen.release.resolve(1)
    await Promise.all([prior, prompt, raw])
    expect(abortedAtWait).toBe(true)
    expect(beforeRelease).toEqual(['prior', 'hello', '\r', 'z'])
    expect(h.writes.map(write => write.expectedByte)).toEqual([0, 5, 10, 11])
  } finally {
    priorRelease.resolve()
    screen.release.resolve(1)
    await Promise.allSettled([prior, prompt, raw])
  }
})

it('does not cancel another Run or preempt a prompt for empty input', async () => {
  const h = await fixture('codex')
  const screen = heldRender(h)
  const prompt = h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession(h.stored.agentSessionId)), agentSessionId: h.stored.agentSessionId,
    expectedRun: h.stored.run, operationId: 'kept-operation', prompt: 'hello' })
  await screen.entered.promise
  const empty = h.client.writeAgent({ agentSessionId: h.stored.agentSessionId, expectedRun: h.client.agentSession(h.stored.agentSessionId).run, data: '', source: 'user' })
  const wrongRun = h.inner.writeAgentInput({ ...h.stored, run: { runId: 'another-run' } }, 'z')
    .then(() => null, error => error)
  try {
    await checkpoint()
    const aborted = screen.signals[0]?.aborted
    const beforeRelease = h.writes.map(write => write.data)
    screen.release.resolve(1)
    await Promise.all([prompt, empty])
    expect(await wrongRun).toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(aborted).toBe(false)
    expect(beforeRelease).toEqual(['hello'])
    expect(h.writes.map(write => write.data)).toEqual(['hello', '\r'])
  } finally {
    screen.release.resolve(1)
    await Promise.allSettled([prompt, empty, wrongRun])
  }
})

it.each(['cancel', 'timeout'] as const)('settles %s during attachment creation without a late orphan waiter or second attachment', async reason => {
  const h = await fixture('codex')
  const entered = deferred<void>(), attachment = deferred<CtxmuxAdapterOutputObservation>()
  const close = vi.fn(async () => {})
  const observe = vi.fn(async (): Promise<CtxmuxAdapterOutputObservation> => { entered.resolve(); return await attachment.promise })
  h.inner.kernel.observeOutput = observe
  const waiter = vi.spyOn(AgentTerminalScreenEvidence.prototype, 'wait')
  const abort = new AbortController()
  if (reason === 'timeout') vi.useFakeTimers()
  let settled = false
  const waiting = h.inner.screenEvidence.wait(h.client.agentSession(h.stored.agentSessionId), 0, true,
    () => false, { signal: abort.signal, timeoutMs: 25,
      timeoutMessage: 'Synthetic timeout', terminalMessage: 'Synthetic exit' })
    .then(() => { settled = true; return null }, error => { settled = true; return error })
  try {
    await entered.promise
    if (reason === 'cancel') { abort.abort(); await checkpoint() }
    else await vi.advanceTimersByTimeAsync(25)
    const settledBeforeAttachment = settled
    attachment.resolve(blankTerminalObservation(h.run(), close))
    const result = await waiting
    await Promise.resolve()
    expect(settledBeforeAttachment).toBe(true)
    expect(result).toMatchObject({ code: reason === 'cancel'
      ? 'AGENT_PROMPT_READINESS_CANCELLED' : 'AGENT_PROMPT_RENDER_TIMEOUT' })
    expect(waiter).not.toHaveBeenCalled()
    const ready = h.inner.screenEvidence.wait(h.client.agentSession(h.stored.agentSessionId), 0, false,
      () => true, { timeoutMessage: 'Synthetic timeout', terminalMessage: 'Synthetic exit' })
    // Checkpoint restoration uses xterm's asynchronous write queue, which this branch's clock owns.
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(0)
    expect(await ready).toBe(0)
    expect(observe).toHaveBeenCalledTimes(1)
    expect(waiter).toHaveBeenCalledTimes(1)
    h.inner.screenEvidence.discardAll()
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
    attachment.resolve(blankTerminalObservation(h.run(), close))
    await waiting
  }
})


it('preserves the timeout reason after attachment and cleans the single observation lifetime', async () => {
  const h = await fixture('codex')
  const close = vi.fn(async () => {})
  h.inner.kernel.observeOutput = vi.fn(async (): Promise<CtxmuxAdapterOutputObservation> => blankTerminalObservation(h.run(), close))
  const abort = new AbortController()
  const removeListener = vi.spyOn(abort.signal, 'removeEventListener')
  vi.useFakeTimers()
  const waiting = h.inner.screenEvidence.wait(h.client.agentSession(h.stored.agentSessionId), 0, true,
    () => false, { signal: abort.signal, timeoutMs: 25,
      timeoutMessage: 'Synthetic timeout after attachment', terminalMessage: 'Synthetic exit' })
    .then(() => null, error => error)
  try {
    await vi.advanceTimersByTimeAsync(25)
    expect(await waiting).toMatchObject({ code: 'AGENT_PROMPT_RENDER_TIMEOUT', message: 'Synthetic timeout after attachment' })
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(abort.signal.aborted).toBe(false)
    expect(h.inner.kernel.observeOutput).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
    h.inner.screenEvidence.discardAll()
    await waiting
  }
})
