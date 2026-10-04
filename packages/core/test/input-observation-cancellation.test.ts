import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentTerminalScreen, AgentTerminalScreenEvidence } from '../src/agent-terminal-screen.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import type { AgentProviderPromptExecutionContext } from '../src/agent-provider.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

/** Actual public Client, Coordinator, FileStore and RPC; only Runtime bytes and Provider observations are synthetic. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-observation-cause-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const record: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'observed-agent',
    providerId: 'synthetic-interrupt', executorId: 'synthetic-interrupt', hostId: 'local', workspacePath: root,
    run: { runId: 'observed-run' }, retiredRuns: [], hookBindingId: 'fixture-binding', hookToken: 'fixture-token',
    createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, record)
  let cursor = 0, start!: () => void, release!: () => void
  const entered = new Promise<void>(yes => { start = yes })
  const ready = new Promise<void>(yes => { release = yes })
  const screen = new AgentTerminalScreen(80, 24)
  const draw = async (text = '') => {
    const dataBytes = Buffer.from(`\x1b[?2026h\x1b[2J\x1b[10;1H> ${text}\x1b[10;${3 + text.length}H\x1b[?2026l`)
    await screen.write({ startByte: screen.throughByte, endByte: screen.throughByte + dataBytes.length, dataBytes })
  }
  await draw()
  const template = new AgentProviderRegistry().get('codex')
  let verifyCount = 0
  let finalVerify: ((count: number, context: AgentProviderPromptExecutionContext) => Promise<void>) | undefined
  const preparation = vi.fn(async (context: AgentProviderPromptExecutionContext & { signal: AbortSignal }) => {
    start(); await ready; context.signal.throwIfAborted()
    return { nativeSourceId: 'synthetic-native-source', verifyCurrentTransport: async (context: AgentProviderPromptExecutionContext) => {
      await finalVerify?.(++verifyCount, context); return true
    } }
  })
  const interactionPreparation = vi.fn(async () => { throw new AgentMuxError('Synthetic typed target intentionally unavailable.', 'SYNTHETIC_TYPED_TARGET_UNAVAILABLE') })
  // Explicit strategy keeps this fixture independent of the Native-steer Provider.
  const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'synthetic-interrupt', label: 'Synthetic interrupt',
    capabilities: { ...template.catalog.capabilities, promptExecution: { immediate: 'interrupt-before-input' } },
    hookStrategy: { kind: 'native', installation: 'unmanaged' } }, buildArgs: (_, args) => [...args], hook: { rules: [] },
    terminalPromptRender: { frameStart: '\x1b[?2026h', frameEnd: '\x1b[?2026l', activeComposer: '>' },
    planPromptInput: (text, context) => ({ kind: 'render-then-submit', payload: text, renderedText: text, submit: '\r',
      ...(context?.execution === 'immediate' ? { prepare: { refresh: '\x1b[I', interrupt: '\x1b', endEvent: 'Interrupt' } } : {}) }),
    readPromptExecutionEvidence: async () => ({ sourceId: 'synthetic-native-source', id: 'synthetic-turn', state: 'idle' }),
    verifyPromptExecutionTransport: async () => true, preparePromptExecutionTransport: preparation,
    inspectPromptExecution: snapshot => snapshot.lines[snapshot.cursor.row]?.text.trimEnd() === '>' ? 'idle' : 'unavailable',
    interaction: { questionEvents: [], questionTools: [], permissionOptions: [], planResponse: () => ({ data: '1' }) },
    prepareInteractionResponse: interactionPreparation })
  const client = new AgentMuxClient({ store, providers: [provider] })
  const owner = client as any
  await owner.registry.load('local')
  const writes: string[] = [], inputAttempts: string[] = [], receipts = new Map<string, { startByte: number; endByte: number }>()
  const run = () => ({ nativeService: null, runId: 'observed-run', lifecycleOperationId: null,
    program: 'synthetic-interrupt', args: [], workspacePath: root, pid: 123, state: { type: 'running' as const },
    cols: 80, rows: 24, latestOutputBytes: screen.throughByte, firstAvailableByte: 0, acceptedInputBytes: cursor })
  let runtimeConnected = true
  owner.kernel.isConnected = () => runtimeConnected
  owner.kernel.identity = () => ({ daemonInstanceId: 'private-observation-daemon', protocolVersion: 18, buildIdentity: 'synthetic' })
  owner.kernel.status = async () => {
    if (!runtimeConnected) throw new AgentMuxError('Synthetic Runtime transport is disconnected.', 'CLIENT_NOT_CONNECTED')
    return run()
  }
  owner.kernel.disconnect = vi.fn(() => { runtimeConnected = false })
  owner.kernel.stop = vi.fn()
  owner.kernel.input = async (_id: string, input: { operationId: string; expectedByte: number; data: string }) => {
    inputAttempts.push(input.data)
    if (input.data === 'HUMAN_NOT_APPLIED') throw new AgentMuxError('Synthetic raw input was not applied.', 'CTXMUX_input_cursor_mismatch',
      'not_applied', { disposition: 'not_applied', confirmedInputBytes: 0 })
    const old = receipts.get(input.operationId)
    if (old) return { run: run(), appliedByteRange: old }
    expect(input.expectedByte).toBe(cursor)
    const range = { startByte: cursor, endByte: cursor + Buffer.byteLength(input.data) }
    cursor = range.endByte; receipts.set(input.operationId, range); writes.push(input.data)
    if (input.data !== '\r') await draw(input.data === '\x1b[I' ? '' : input.data)
    return { run: run(), appliedByteRange: range }
  }
  const actualScreenWait = owner.screenEvidence.wait.bind(owner.screenEvidence)
  owner.screenEvidence.wait = async (...args: unknown[]) => {
    const inspect = args[3] as (screen: AgentTerminalScreen) => boolean
    if (!inspect(screen)) throw new AgentMuxError('Synthetic complete screen unavailable.', 'AGENT_PROMPT_RENDER_TIMEOUT')
    return screen.throughByte
  }
  owner.screenEvidence.generation = () => 0
  owner.connected = true
  const server = new AgentMuxControlServer({ socketPath: join(root, 'readonly.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'readonly.sock') } })
  const submit = (signal?: AbortSignal) => client.submitAgentPrompt({ agentSessionId: record.agentSessionId, expectedRun: record.run,
    afterSubmissionId: null, operationId: 'original-operation', prompt: 'ORIGINAL_BODY', authorHuman: true,
    execution: 'immediate', ...(signal ? { signal } : {}) }).then(() => null, error => error)
  const write = (data: string, source: 'user' | 'terminal-protocol') => client.writeAgent({ agentSessionId: record.agentSessionId,
    expectedRun: record.run, data, source })
  const answer = async () => {
    const previous = (await loadAgentSessions(store))[0]!
    await store.compareAndSwap(previous, { ...previous, pendingInteraction: { request: {
      kind: 'permission', id: 'original-interaction', agentSessionId: record.agentSessionId, title: 'Synthetic permission',
      nativeToolCallId: 'synthetic-call', toolName: 'synthetic-tool', toolInput: '{}',
      options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }, { id: 'reject-once', label: 'Reject', kind: 'reject-once' }],
      evidence: { source: 'native-hook', observedAt: 1, run: record.run, hookReceiptId: 'synthetic-receipt' }
    } } })
    await expect(client.respondAgentInteraction({ agentSessionId: record.agentSessionId, expectedRun: record.run,
      response: { kind: 'permission', requestId: 'original-interaction', decision: { outcome: 'selected', optionId: 'allow-once' } } }))
      .rejects.toMatchObject({ code: 'SYNTHETIC_TYPED_TARGET_UNAVAILABLE' })
    expect(interactionPreparation).toHaveBeenCalledTimes(1)
  }
  const lookup = async (error: AgentMuxError & { logId: string }) => {
    expect(error.logId).toMatch(/^delivery-/u)
    const sdk = await client.readDeliveryAttempt(error.logId)
    expect(sdk).toMatchObject({ availability: 'found', record: { logId: error.logId, source: 'core', operationId: 'original-operation',
      agentSessionId: record.agentSessionId, expectedRunId: record.run.runId, afterSubmissionId: null, execution: 'immediate' } })
    const actualRpc = await rpc.call('message.delivery.inspect', { hostId: 'local', logId: error.logId })
    expect(actualRpc.record).toEqual(sdk.record)
    if (process.env.AGENTMUX_TEST_CANCELLATION_FACTS) {
      const directory = process.env.AGENTMUX_TEST_CANCELLATION_FACTS
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${error.logId}.json`), JSON.stringify({ sdk, actualRpc, writes, inputAttempts,
        originalBodyInputAttempts: inputAttempts.filter(data => data === 'ORIGINAL_BODY').length,
        submitInputAttempts: inputAttempts.filter(data => data === '\r').length }, null, 2) + '\n', { mode: 0o600 })
    }
    expect(JSON.stringify(sdk)).not.toContain('ORIGINAL_BODY')
    expect(inputAttempts.some(data => data === 'ORIGINAL_BODY' || data === '\r')).toBe(false)
    expect(owner.kernel.stop).not.toHaveBeenCalled()
    return sdk.record!
  }
  return { client, owner, store, preparation, entered, release, writes, inputAttempts, submit, write, answer, lookup,
    actualScreenWait,
    finalVerify: (hook: typeof finalVerify) => { finalVerify = hook },
    close: async () => { release(); await rpc.dispose(); await server.stop(); screen.dispose(); await client.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } }
}

function expectCancellation(error: { detail?: string }, source: string) {
  const cause = JSON.parse(error.detail!)
  expect(cause.code).toBe('AGENT_INPUT_OBSERVATION_CANCELLED')
  expect(JSON.parse(cause.detail)).toEqual({ source })
}

describe('public input observation cancellation provenance', () => {
  it.each(['terminal-user', 'client-disconnect', 'interaction-response'] as const)('retains %s in the original error and read-only durable query', async source => {
    const f = await fixture()
    try {
      const sent = f.submit(); await f.entered
      if (source === 'terminal-user') await expect(f.write('HUMAN_NOT_APPLIED', 'user')).rejects.toMatchObject({ code: 'CTXMUX_input_cursor_mismatch' })
      else if (source === 'client-disconnect') f.client.disconnect()
      else await f.answer()
      const error = await sent, log = await f.lookup(error)
      expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expectCancellation(error, source)
      expect(log.stage).toBe('transport-preparation'); expect(log.error.detail).toBe(error.detail)
      expectCancellation(log.error, source)
      expect(f.writes).toEqual([])
      expect((await loadAgentSessions(f.store))[0]?.promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it.each(['\x1b[?1;2c', '\x1b[1;1R'])('preserves initial read-only qualification for protocol %j', async reply => {
    const f = await fixture()
    try {
      let settled = false
      const sent = f.submit().finally(() => { settled = true }); await f.entered
      const signal = f.preparation.mock.calls[0]![0].signal
      await f.write(reply, 'terminal-protocol')
      expect(signal.aborted).toBe(false); expect(settled).toBe(false)
      // Finish through an existing cancellation source; the protocol itself must not cancel.
      f.client.disconnect()
      const error = await sent; expectCancellation(error, 'client-disconnect')
      expect((await f.lookup(error)).stage).toBe('transport-preparation')
      expect(f.writes).toEqual([reply])
    } finally { await f.close() }
  })

  it('preserves the exact external requestedSignal reason', async () => {
    const f = await fixture(), request = new AbortController()
    const reason = new AgentMuxError('Original caller explicitly cancelled.', 'ORIGINAL_REQUEST_CANCELLED', 'caller-owned-reason')
    try {
      const sent = f.submit(request.signal); await f.entered; request.abort(reason)
      await expect(f.write('HUMAN_NOT_APPLIED', 'user')).rejects.toMatchObject({ code: 'CTXMUX_input_cursor_mismatch' })
      const error = await sent, log = await f.lookup(error)
      expect(f.preparation.mock.calls[0]![0].signal.reason).toBe(reason)
      expect(JSON.parse(error.detail)).toMatchObject({ code: reason.code, message: reason.message, detail: reason.detail })
      expect(log.error.detail).toBe(error.detail); expect(log.stage).toBe('transport-preparation')
      expect(f.writes).toEqual([])
    } finally { await f.close() }
  })

  it('preserves the original preparation timeout instead of claiming a cancellation source', async () => {
    const f = await fixture(), timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      const sent = f.submit(); await f.entered
      const originalDeadline = timers.mock.calls.filter(call => call[1] === 40_000)
      expect(originalDeadline).toHaveLength(1)
      // Invoke the actual observer deadline callback, without waiting forty seconds or changing its budget.
      const expire = originalDeadline[0]![0]
      expect(typeof expire).toBe('function'); (expire as () => void)()
      const error = await sent
      expect(JSON.parse(error.detail)).toMatchObject({ code: 'AGENT_INPUT_PREPARATION_UNCONFIRMED',
        message: 'Native input preparation timed out; the terminal remains available.' })
      expect(JSON.parse(error.detail).detail).toBeUndefined()
      const log = await f.lookup(error)
      expect(log.error.detail).toBe(error.detail); expect(log.stage).toBe('transport-preparation')
      expect(f.writes).toEqual([])
    } finally { timers.mockRestore(); await f.close() }
  })

  it.each(['terminal-user', 'interaction-response', 'client-disconnect'] as const)('preserves %s after the original protocol interruption during owner recheck', async source => {
    const f = await fixture(), refresh = f.owner.registry.refresh.bind(f.owner.registry)
    let entered!: () => void, acknowledged!: () => void, protocolStarted = false, checked = false
    const verifying = new Promise<void>(yes => { entered = yes }), ack = new Promise<void>(yes => { acknowledged = yes })
    let originalInterruption: unknown
    f.finalVerify(async count => {
      if (count !== 1) return
      entered(); await ack
    })
    const originalInput = f.owner.kernel.input
    f.owner.kernel.input = async (...args: any[]) => {
      const result = await originalInput(...args)
      if (args[1].data === '\x1b[1;1R') acknowledged()
      return result
    }
    f.owner.registry.refresh = async (...args: any[]) => {
      const current = await refresh(...args)
      if (protocolStarted && !checked) {
        checked = true
        const observation = [...f.owner.agentInputTails.get('observed-agent').renderObservations][0] as any
        originalInterruption = observation.protocolInput.preclaim.interruption
        expect(observation.controller.signal.reason).toBe(originalInterruption)
        if (source === 'terminal-user') await expect(f.write('HUMAN_NOT_APPLIED', 'user')).rejects.toMatchObject({ code: 'CTXMUX_input_cursor_mismatch' })
        else if (source === 'interaction-response') await f.answer()
        else f.client.disconnect()
        expect(observation.controller.signal.reason).toBe(originalInterruption)
        if (observation.protocolInput.cancelled) expect(JSON.parse(observation.protocolInput.cancelled.detail)).toEqual({ source })
      }
      return current
    }
    try {
      const sent = f.submit(); await f.entered; f.release(); await verifying
      protocolStarted = true
      await f.write('\x1b[1;1R', 'terminal-protocol')
      const error = await sent, log = await f.lookup(error)
      expect(checked).toBe(true); expect(originalInterruption).toBeInstanceOf(Error)
      expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expectCancellation(error, source)
      expectCancellation(log.error, source)
      expect(f.writes).toEqual(['\x1b[1;1R'])
      expect(f.client.agentSession('observed-agent').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('retains terminal-protocol cause while releasing a claimed frame wait for its ACK', async () => {
    const f = await fixture(), originalWait = f.owner.screenEvidence.wait
    let waiting!: () => void
    const entered = new Promise<void>(yes => { waiting = yes })
    f.owner.screenEvidence.wait = async (...args: unknown[]) => {
      const options = args[4] as { requireCompleteFrame?: boolean; signal?: AbortSignal }
      if (!options.requireCompleteFrame) return await originalWait(...args)
      waiting()
      return await new Promise<number>((_yes, reject) => {
        const abort = () => reject(options.signal!.reason)
        options.signal!.addEventListener('abort', abort, { once: true })
        if (options.signal!.aborted) abort()
      })
    }
    try {
      const sent = f.submit(); await f.entered; f.release(); await entered
      const frozen = structuredClone(f.client.agentSession('observed-agent').promptCompletionAdmission)
      expect(frozen?.frameRefresh?.acknowledged).toBe(true)
      await f.write('\x1b[?1;2c', 'terminal-protocol')
      const error = await sent, log = await f.lookup(error)
      expect(log.stage).toBe('input-coordination')
      expect(JSON.parse(error.detail)).toMatchObject({ code: 'AGENT_INPUT_OBSERVATION_CANCELLED', detail: JSON.stringify({ source: 'terminal-protocol' }) })
      expect(log.error.detail).toBe(error.detail)
      expect(f.client.agentSession('observed-agent').promptCompletionAdmission).toEqual(frozen)
      expect(f.writes).toEqual(['\x1b[I', '\x1b[?1;2c'])
    } finally { await f.close() }
  })

  it('preserves typed source through the real screen wrappers and original Core error/log', async () => {
    const f = await fixture()
    const evidence = new AgentTerminalScreenEvidence(80, 24, { start: '\x1b[?2026h', end: '\x1b[?2026l' })
    const initial = Buffer.from('\x1b[?2026h\x1b[2J\x1b[10;1H> \x1b[10;3H\x1b[?2026l')
    evidence.accept({ type: 'data', startByte: 0, endByte: initial.length, dataBytes: initial })
    await evidence.wait({ boundaryByte: 0, requireOutputAfterBoundary: false, requireCompleteFrame: true,
      predicate: () => true, timeoutMessage: 'Initial synthetic frame missing.', terminalMessage: 'Synthetic Run ended.' })
    let ensureEntered!: () => void
    const observing = new Promise<void>(yes => { ensureEntered = yes })
    // Only attachment acquisition is controlled; both production wait/cancellation layers execute.
    f.owner.screenEvidence.evidence.set('observed-agent', { runId: 'observed-run', evidence, close: () => {} })
    f.owner.screenEvidence.ensure = async () => {
      if (f.client.agentSession('observed-agent').promptCompletionAdmission?.frameRefresh?.acknowledged) ensureEntered()
      return evidence
    }
    f.owner.screenEvidence.wait = f.actualScreenWait
    try {
      const sent = f.submit(); await f.entered; f.release(); await observing
      const frozen = structuredClone(f.client.agentSession('observed-agent').promptCompletionAdmission)
      expect(frozen?.frameRefresh?.acknowledged).toBe(true)
      await f.write('\x1b[1;1R', 'terminal-protocol')
      const error = await sent, log = await f.lookup(error)
      expect(error.code).toBe('AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
      const screenCause = JSON.parse(error.detail)
      expect(screenCause.code).toBe('AGENT_PROMPT_READINESS_CANCELLED')
      expect(screenCause.detail).toBeTypeOf('string')
      expectCancellation(screenCause, 'terminal-protocol')
      expect(log.error.detail).toBe(error.detail); expect(log.stage).toBe('input-coordination')
      expect(f.client.agentSession('observed-agent').promptCompletionAdmission).toEqual(frozen)
      expect(f.writes).toEqual(['\x1b[I', '\x1b[1;1R'])
    } finally { evidence.dispose(); await f.close() }
  })

  it('retains the original caller reason at the final admission guard', async () => {
    const f = await fixture(), request = new AbortController()
    const reason = new AgentMuxError('Original caller cancelled before any claim.', 'ORIGINAL_REQUEST_CANCELLED', 'original-admission-reason')
    let verified = false, injected = false
    f.finalVerify(async count => { if (count === 1) verified = true })
    const update = f.owner.updateExactAgentSession.bind(f.owner)
    f.owner.updateExactAgentSession = async (id: string, run: unknown, callback: (current: AgentMuxStoredAgentSession) => unknown) =>
      await update(id, run, (current: AgentMuxStoredAgentSession) => {
        // Preserve the real update/CAS callback; cancel only after final verification and before its admission check.
        if (verified && !injected) { injected = true; request.abort(reason) }
        return callback(current)
      })
    try {
      const sent = f.submit(request.signal); await f.entered; f.release()
      const error = await sent, log = await f.lookup(error)
      expect(injected).toBe(true)
      const admissionCause = JSON.parse(error.detail)
      expect(admissionCause.code).toBe('AGENT_PROMPT_CANCELLED')
      expect(admissionCause.detail).toBeTypeOf('string')
      expect(JSON.parse(admissionCause.detail)).toMatchObject({ code: reason.code, message: reason.message, detail: reason.detail })
      expect(request.signal.reason).toBe(reason)
      expect(log.error.detail).toBe(error.detail); expect(log.stage).toBe('input-coordination')
      expect(f.writes).toEqual([])
      expect(f.client.agentSession('observed-agent').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('preserves lower evidence signal cause and leaves unsourced disposal unknown', async () => {
    const evidence = new AgentTerminalScreenEvidence(80, 24, null), signal = new AbortController()
    const reason = new AgentMuxError('Original typed response replaced this observer.', 'AGENT_INPUT_OBSERVATION_CANCELLED',
      JSON.stringify({ source: 'interaction-response' }))
    const options = { boundaryByte: 0, requireOutputAfterBoundary: false, predicate: () => false,
      timeoutMessage: 'Synthetic frame did not arrive.', terminalMessage: 'Synthetic Run ended.' }
    try {
      const pending = evidence.wait({ ...options, signal: signal.signal }).then(() => null, error => error)
      signal.abort(reason)
      const error = await pending
      expect(error).toMatchObject({ code: 'AGENT_PROMPT_READINESS_CANCELLED', message: 'Terminal screen observation was cancelled.' })
      expect(error.detail).toBeTypeOf('string'); expectCancellation(error, 'interaction-response')
      expect(error.cause).toBe(reason)
      expect(signal.signal.reason).toBe(reason)
    } finally { evidence.dispose() }
    const unsourced = new AgentTerminalScreenEvidence(80, 24, null)
    const pending = unsourced.wait(options).then(() => null, error => error)
    unsourced.dispose()
    expect(await pending).toMatchObject({ code: 'AGENT_PROMPT_READINESS_CANCELLED', detail: undefined })
  })
})
