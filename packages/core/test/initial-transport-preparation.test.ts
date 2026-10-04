import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentProviderPreparedPromptTransport, AgentProviderPromptExecutionContext } from '../src/agent-provider.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../src/control-host.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { hostedTestOwner, hostedTestFence, logicalHostedEvents } from './helpers/hosted-runtime-port.js'

/** A protocol query must not wait behind the observation it is required to finish. */
async function inputAckWithin<T>(pending: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  const timeout = Symbol('input ACK blocked behind its input observation')
  try {
    const result = await Promise.race([pending, new Promise<typeof timeout>(done => { timer = setTimeout(() => done(timeout), 1_000) })])
    expect(result, 'input ACK must release the original observation lane').not.toBe(timeout)
    return result as T
  } finally { clearTimeout(timer) }
}

/** Public Client and real coordinator/store; Runtime bytes are explicitly synthetic here. */
async function fixture(storePath?: string) {
  const store = storePath ? new AgentMuxFileAgentSessionStore(storePath) : new AgentMuxMemoryAgentSessionStore()
  const stored = (id: string): AgentMuxStoredAgentSession => ({ kind: 'agent', agentSessionId: id, providerId: 'fixture',
    executorId: 'fixture', hostId: 'local', workspacePath: fixturePath("private/preparation"), run: { runId: `${id}-run` },
    retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1 })
  await store.compareAndSwap(null, stored('prepare'))
  await store.compareAndSwap(null, stored('healthy'))
  const template = new AgentProviderRegistry().get('codex')
  const { providerFork: _fork, ...capabilities } = template.catalog.capabilities
  let source = 'source-1', pid = 123, cursor = 0, recheck = true, lostAck = false
  let verifyCount = 0, statusesAfterVerify = 0, finalStatusFault: string | undefined
  let finalVerify: ((count: number, context: AgentProviderPromptExecutionContext) => Promise<void>) | undefined
  let rawDuringFinalStatus: Promise<unknown> | undefined
  const screen = new AgentTerminalScreen(80, 24)
  const draw = async (text = '') => {
    const bytes = Buffer.from(`\x1b[?2026h\x1b[2J\x1b[10;1H> ${text}\x1b[10;${3 + text.length}H\x1b[?2026l`)
    await screen.write({ startByte: screen.throughByte, endByte: screen.throughByte + bytes.length, dataBytes: bytes })
  }
  await draw()
  let release!: () => void, started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const ready = new Promise<void>(resolve => { release = resolve })
  const preparation = vi.fn(async (context: AgentProviderPromptExecutionContext & { signal: AbortSignal }): Promise<AgentProviderPreparedPromptTransport> => {
    started(); await ready
    context.signal.throwIfAborted()
    return { nativeSourceId: 'source-1', verifyCurrentTransport: async context => { verifyCount++; statusesAfterVerify = 0; await finalVerify?.(verifyCount, context); return recheck } }
  })
  const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'fixture', capabilities: { ...capabilities, promptExecution: { immediate: 'interrupt-before-input' } }, hookStrategy: { kind: 'native', installation: 'unmanaged' } },
    buildArgs: (_, args) => [...args], hook: { rules: [] }, terminalPromptRender: { frameStart: '\x1b[?2026h', frameEnd: '\x1b[?2026l', activeComposer: '>' },
    planPromptInput: (text, context) => ({ kind: 'render-then-submit', payload: text, renderedText: text, submit: '\r',
      ...(context?.execution === 'immediate' ? { prepare: { refresh: '\x1b[I', interrupt: '\x1b', endEvent: 'Interrupt' } } : {}) }),
    readPromptExecutionEvidence: async () => ({ sourceId: source, id: 'initial', state: 'idle' }),
    verifyPromptExecutionTransport: async () => recheck,
    preparePromptExecutionTransport: preparation,
    inspectPromptExecution: snapshot => snapshot.lines[snapshot.cursor.row]?.text.trimEnd() === '>' ? 'idle' : 'unavailable' })
  const client = new AgentMuxClient({ store, providers: [provider] })
  const owner = client as unknown as { connected: boolean; registry: { load(host: string): Promise<void> };
    kernel: Record<string, unknown>; screenEvidence: { wait: (...args: unknown[]) => Promise<number>; generation: () => number } }
  await owner.registry.load('local')
  const writes: Array<{ run: string; data: string }> = [], receipts = new Map<string, { startByte: number; endByte: number }>()
  const run = (id = 'prepare-run') => ({ nativeService: null, runId: id, lifecycleOperationId: null,
    program: 'fixture', args: [], workspacePath: fixturePath("private/preparation"), pid, state: { type: 'running' as const },
    cols: 80, rows: 24, latestOutputBytes: screen.throughByte, firstAvailableByte: 0, acceptedInputBytes: id === 'prepare-run' ? cursor : 0 })
  owner.kernel.isConnected = () => true
  owner.kernel.identity = () => ({ daemonInstanceId: 'prepare-daemon', protocolVersion: 1, buildIdentity: 'test' })
  owner.kernel.status = async (id: string) => {
    if (verifyCount === 2 && ++statusesAfterVerify === 2) {
      if (finalStatusFault === 'cursor') cursor++
      if (finalStatusFault === 'pid') pid++
      if (finalStatusFault === 'raw-cancel') rawDuringFinalStatus = client.writeAgent({ agentSessionId: 'prepare',
        expectedRun: { runId: 'prepare-run' }, data: 'RAW_AT_FINAL_BOUNDARY', source: 'user' })
      if (finalStatusFault === 'protocol') rawDuringFinalStatus = client.writeAgent({ agentSessionId: 'prepare',
        expectedRun: { runId: 'prepare-run' }, data: '\x1b[1;1R', source: 'terminal-protocol' })
    }
    return run(id)
  }
  owner.kernel.input = async (id: string, op: { operationId: string; expectedByte: number; data: string }) => {
    const old = receipts.get(op.operationId)
    if (old) return { run: run(id), appliedByteRange: old }
    if (id === 'prepare-run' && cursor !== op.expectedByte) throw new AgentMuxError('cursor changed', 'CTXMUX_input_cursor_mismatch', 'not_applied')
    const range = { startByte: op.expectedByte, endByte: op.expectedByte + Buffer.byteLength(op.data) }
    if (id === 'prepare-run') cursor = range.endByte
    receipts.set(op.operationId, range); writes.push({ run: id, data: op.data })
    if (id === 'prepare-run' && op.data !== '\r') await draw(op.data === '\x1b[I' ? '' : op.data)
    if (lostAck && op.data === '\x1b[I') { lostAck = false; throw new AgentMuxError('lost original refresh ACK', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown',
      { disposition: 'unknown', confirmedInputBytes: null }) }
    return { run: run(id), appliedByteRange: range }
  }
  owner.screenEvidence.wait = async (...args: unknown[]) => {
    const inspect = args[3] as (screen: AgentTerminalScreen) => boolean
    if (!inspect(screen)) throw new AgentMuxError('screen unavailable', 'AGENT_PROMPT_RENDER_TIMEOUT')
    return screen.throughByte
  }
  owner.screenEvidence.generation = () => 0
  owner.connected = true
  const submit = (signal?: AbortSignal, operationId = 'original-send') => client.submitAgentPrompt({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' },
    afterSubmissionId: null, operationId, prompt: 'ORIGINAL_BODY', execution: 'immediate', ...(signal ? { signal } : {}) })
  return { client, owner, store, provider, preparation, entered, release, writes, submit,
    finalVerify: (hook: typeof finalVerify) => { finalVerify = hook },
    finalStatusFault: (kind: string) => { finalStatusFault = kind }, rawDuringFinalStatus: () => rawDuringFinalStatus,
    change: (kind: string) => { if (kind === 'source') source = 'source-other'; if (kind === 'pid') pid++; if (kind === 'cursor') cursor++;
      if (kind === 'final') recheck = false; if (kind === 'lost-ack') lostAck = true },
    close: async () => { release(); screen.dispose(); await client.dispose() } }
}

describe('original immediate transport preparation', () => {
  it.each(['\x1b[?1;2c', '\x1b[1;1R'])('acknowledges preclaim protocol %j before the final verifier and original body complete', async reply => {
    const f = await fixture()
    let entered!: () => void, acknowledged!: () => void
    const verifying = new Promise<void>(resolve => { entered = resolve })
    const ack = new Promise<void>(resolve => { acknowledged = resolve })
    let originalVerifierCompleted = false
    f.finalVerify(async count => {
      if (count !== 1) return
      entered(); await ack; originalVerifierCompleted = true
    })
    const originalInput = f.owner.kernel.input as (id: string, op: { operationId: string; expectedByte: number; data: string }) => Promise<unknown>
    f.owner.kernel.input = async (id: string, op: { operationId: string; expectedByte: number; data: string }) => {
      const result = await originalInput(id, op)
      if (op.data === reply) acknowledged()
      return result
    }
    try {
      const sent = f.submit().then(() => undefined, error => error)
      await f.entered; f.release(); await verifying
      const boundary = (await loadAgentSessions(f.store)).find(session => session.agentSessionId === 'prepare')
      expect(boundary?.promptCompletionAdmission).toBeUndefined()
      await inputAckWithin(f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: reply, source: 'terminal-protocol' }))
      expect(await sent).toBeUndefined()
      expect(originalVerifierCompleted).toBe(true)
      expect(f.writes.map(write => write.data)).toEqual([reply, '\x1b[I', 'ORIGINAL_BODY', '\r'])
      const completed = (await loadAgentSessions(f.store)).find(session => session.agentSessionId === 'prepare')
      expect(completed?.promptCompletionAdmission?.submissionId).toBe('original-send')
      expect(completed?.promptCompletionAdmission?.acknowledged).toBe(true)
      expect(completed?.promptCompletionAdmission?.intent?.prompt).toBe('ORIGINAL_BODY')
    } finally { await f.close() }
  })

  it('retains original protocol ACK authority across qualification completion and first lane queueing', async () => {
    const f = await fixture()
    const owner = f.client as any
    const observe = owner.observeAgentInputPreparation.bind(owner)
    let observed = false
    owner.observeAgentInputPreparation = async (...args: unknown[]) => {
      const result = await observe(...args)
      if (!observed) {
        observed = true
        await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: '\x1b[1;1R', source: 'terminal-protocol' })
      }
      return result
    }
    try {
      const sent = f.submit().then(() => null, error => error)
      await f.entered; f.release()
      expect(await sent).toBeNull()
      expect(observed).toBe(true)
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[1;1R', '\x1b[I', 'ORIGINAL_BODY', '\r'])
    } finally { await f.close() }
  })

  it('retains human cancellation across qualification handoff even when the raw input is not applied', async () => {
    const f = await fixture()
    f.finalVerify(async () => { await new Promise<void>(() => {}) })
    const owner = f.client as any
    const observe = owner.observeAgentInputPreparation.bind(owner)
    const originalInput = f.owner.kernel.input as (id: string, op: { data: string }) => Promise<unknown>
    let humanAttempts = 0
    f.owner.kernel.input = async (id: string, op: { data: string }) => {
      if (op.data === 'HUMAN_HANDOFF') {
        humanAttempts++
        throw new AgentMuxError('raw input was not applied', 'CTXMUX_input_cursor_mismatch', 'not_applied',
          { disposition: 'not_applied', confirmedInputBytes: 0 })
      }
      return await originalInput(id, op)
    }
    owner.observeAgentInputPreparation = async (...args: unknown[]) => {
      const result = await observe(...args)
      await expect(f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' },
        data: 'HUMAN_HANDOFF', source: 'user' })).rejects.toMatchObject({ code: 'CTXMUX_input_cursor_mismatch' })
      return result
    }
    try {
      const sent = f.submit().then(() => null, error => error)
      await f.entered; f.release()
      expect(await inputAckWithin(sent)).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED',
        controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(humanAttempts).toBe(1)
      expect(f.writes).toEqual([])
      expect((await loadAgentSessions(f.store)).find(session => session.agentSessionId === 'prepare')?.promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('retains human cancellation while checking the owner after a preclaim protocol yield', async () => {
    const f = await fixture()
    const owner = f.client as any
    const refresh = owner.registry.refresh.bind(owner.registry)
    const originalInput = f.owner.kernel.input as (id: string, op: { data: string }) => Promise<unknown>
    let entered!: () => void, acknowledged!: () => void
    const verifying = new Promise<void>(done => { entered = done })
    const ack = new Promise<void>(done => { acknowledged = done })
    let protocolStarted = false, humanAttempts = 0, ownerCheck = false
    f.finalVerify(async count => { if (count === 1) { entered(); await ack } })
    f.owner.kernel.input = async (id: string, op: { data: string }) => {
      if (op.data === 'HUMAN_AFTER_YIELD') {
        humanAttempts++
        throw new AgentMuxError('raw input was not applied', 'CTXMUX_input_cursor_mismatch', 'not_applied',
          { disposition: 'not_applied', confirmedInputBytes: 0 })
      }
      const result = await originalInput(id, op)
      if (op.data === '\x1b[1;1R') acknowledged()
      return result
    }
    owner.registry.refresh = async (...args: unknown[]) => {
      const current = await refresh(...args)
      if (protocolStarted && !ownerCheck) {
        ownerCheck = true
        expect(current.promptCompletionAdmission).toBeUndefined()
        await expect(f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' },
          data: 'HUMAN_AFTER_YIELD', source: 'user' })).rejects.toMatchObject({ code: 'CTXMUX_input_cursor_mismatch' })
      }
      return current
    }
    try {
      const sent = f.submit().then(() => null, error => error)
      await f.entered; f.release(); await verifying; protocolStarted = true
      await inputAckWithin(f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' },
        data: '\x1b[1;1R', source: 'terminal-protocol' }))
      expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED',
        controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(ownerCheck).toBe(true); expect(humanAttempts).toBe(1)
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[1;1R'])
      expect((await loadAgentSessions(f.store)).find(session => session.agentSessionId === 'prepare')?.promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it.each(['human', 'source', 'pid', 'cursor', 'final', 'partial', 'unacknowledged'])('keeps the original body absent after preclaim protocol ACK with %s change', async fault => {
    const f = await fixture()
    let entered!: () => void, acknowledge!: () => void
    const verifying = new Promise<void>(done => { entered = done })
    const ack = new Promise<void>(done => { acknowledge = done })
    f.finalVerify(async count => { if (count === 1) { entered(); await ack } })
    const input = f.owner.kernel.input as (id: string, op: { operationId: string; expectedByte: number; data: string }) => Promise<any>
    f.owner.kernel.input = async (id: string, op: { operationId: string; expectedByte: number; data: string }) => {
      const result = await input(id, op)
      if (op.data === '\x1b[?1;2c') {
        if (['source', 'pid', 'cursor', 'final'].includes(fault)) f.change(fault)
        acknowledge()
        if (fault === 'partial') return { ...result, appliedByteRange: { ...result.appliedByteRange, endByte: result.appliedByteRange.endByte - 1 } }
        if (fault === 'unacknowledged') throw new AgentMuxError('protocol ACK unknown', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown')
      }
      return result
    }
    try {
      const sent = f.submit().then(() => null, error => error)
      await f.entered; f.release(); await verifying
      const protocol = f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: '\x1b[?1;2c', source: 'terminal-protocol' }).catch(() => {})
      // This human input is queued while the original protocol input is still pending.
      const human = fault === 'human' ? f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'HUMAN_BEFORE_CLAIM', source: 'user' }) : undefined
      await protocol; await human
      expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(f.writes.some(write => ['ORIGINAL_BODY', '\x1b[I', '\r'].includes(write.data))).toBe(false)
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('human input cancels an uncooperative final preclaim verifier and obtains its ACK immediately', async () => {
    const f = await fixture()
    let enter!: () => void
    const entered = new Promise<void>(done => { enter = done })
    f.finalVerify(async () => { enter(); await new Promise<void>(() => {}) })
    try {
      const sent = f.submit().then(() => null, error => error)
      await f.entered; f.release(); await entered
      await inputAckWithin(f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'HUMAN_FINAL_READ', source: 'user' }))
      expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(f.writes.map(write => write.data)).toEqual(['HUMAN_FINAL_READ'])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('rechecks the original ACK fence when protocol arrives at the last status await before firstclaim', async () => {
    const f = await fixture()
    f.finalStatusFault('protocol')
    try {
      const sent = f.submit().then(() => null, error => error)
      await f.entered; f.release()
      expect(await sent).toBeNull()
      await f.rawDuringFinalStatus()
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[1;1R', '\x1b[I', 'ORIGINAL_BODY', '\r'])
      expect(f.client.agentSession('prepare').promptCompletionAdmission?.frameRefresh?.inputByteRange).toEqual({ startByte: 6, endByte: 9 })
    } finally { await f.close() }
  })

  it('keeps a claim already entering CAS frozen when protocol arrives before its persistence returns', async () => {
    const f = await fixture()
    const cas = f.store.compareAndSwap.bind(f.store)
    let protocol: Promise<unknown> | undefined, frozen: unknown
    f.store.compareAndSwap = async (expected, next) => {
      if (!protocol && next?.agentSessionId === 'prepare' && next.promptCompletionAdmission?.frameRefresh) {
        frozen = structuredClone(next.promptCompletionAdmission)
        protocol = f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: '\x1b[?1;2c', source: 'terminal-protocol' })
      }
      return await cas(expected, next)
    }
    try {
      const sent = f.submit().then(() => null, error => error)
      await f.entered; f.release()
      expect(await sent).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
      await protocol
      expect(frozen).toBeDefined()
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toEqual(frozen)
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[?1;2c'])
      expect(f.preparation).toHaveBeenCalledTimes(1)
    } finally { await f.close() }
  })

  it('releases a post-claim complete-frame observer for a protocol ACK without changing its frozen claim', async () => {
    const f = await fixture()
    let waiting!: () => void
    const frameWait = new Promise<void>(resolve => { waiting = resolve })
    const originalWait = f.owner.screenEvidence.wait
    f.owner.screenEvidence.wait = async (...args: unknown[]) => {
      const options = args[4] as { requireCompleteFrame?: boolean; signal?: AbortSignal }
      if (!options.requireCompleteFrame) return await originalWait(...args)
      waiting()
      return await new Promise<number>((_resolve, reject) => {
        const cancelled = () => reject(new AgentMuxError('frame observation cancelled', 'AGENT_PROMPT_READINESS_CANCELLED'))
        options.signal?.addEventListener('abort', cancelled, { once: true })
        if (options.signal?.aborted) cancelled()
      })
    }
    try {
      const submitted = f.submit().then(() => null, error => error)
      await f.entered; f.release(); await frameWait
      const frozen = structuredClone(f.client.agentSession('prepare').promptCompletionAdmission)
      expect(frozen?.frameRefresh?.acknowledged).toBe(true)
      expect(frozen?.frameRefresh?.inputByteRange).toEqual({ startByte: 0, endByte: 3 })
      const ack = await inputAckWithin(f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' },
        data: '\x1b[?1;2c', source: 'terminal-protocol' }))
      expect(ack.appliedByteRange).toEqual({ startByte: 3, endByte: 10 })
      const error = await submitted
      expect(error).toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
      expect(error.controlFailure?.disposition).not.toBe('not_applied')
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toEqual(frozen)
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I', '\x1b[?1;2c'])
    } finally { await f.close() }
  })

  it.each(['\x1b[?1;2c', '\x1b[1;1R'])('keeps preparation through an acknowledged protocol reply %j', async reply => {
    const f = await fixture()
    try {
      const submitted = f.submit().then(() => null, error => error)
      await f.entered
      const ack = await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' },
        data: reply, source: 'terminal-protocol' })
      expect(ack.appliedByteRange).toEqual({ startByte: 0, endByte: Buffer.byteLength(reply) })
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
      f.release()
      expect(await submitted).toBeNull()
      expect(f.writes.map(write => write.data)).toEqual([reply, '\x1b[I', 'ORIGINAL_BODY', '\r'])
      await f.submit()
      expect(f.writes.filter(write => write.data === 'ORIGINAL_BODY')).toHaveLength(1)
    } finally { await f.close() }
  })

  it('folds consecutive acknowledged protocol ranges without treating either as human input', async () => {
    const f = await fixture()
    try {
      const submitted = f.submit().then(() => null, error => error); await f.entered
      for (const data of ['\x1b[?1;2c', '\x1b[1;1R']) await f.client.writeAgent({ agentSessionId: 'prepare',
        expectedRun: { runId: 'prepare-run' }, data, source: 'terminal-protocol' })
      f.release(); expect(await submitted).toBeNull()
      const admission = f.client.agentSession('prepare').promptCompletionAdmission!
      expect(admission.frameRefresh!.inputByteRange).toEqual({ startByte: 13, endByte: 16 })
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[?1;2c', '\x1b[1;1R', '\x1b[I', 'ORIGINAL_BODY', '\r'])
    } finally { await f.close() }
  })

  it.each(['before', 'between', 'after'])('does not credit foreign input %s protocol ACKs', async position => {
    const f = await fixture()
    try {
      const submitted = f.submit().then(() => null, error => error); await f.entered
      if (position === 'before') f.change('cursor')
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: '\x1b[?1;2c', source: 'terminal-protocol' })
      if (position !== 'before') f.change('cursor')
      if (position === 'between') await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: '\x1b[1;1R', source: 'terminal-protocol' })
      f.release()
      expect(await submitted).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(f.writes.some(write => write.data === 'ORIGINAL_BODY' || write.data === '\x1b[I')).toBe(false)
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it.each(['partial', 'wrong-run', 'wrong-pid', 'unacknowledged', 'unack-no-observed-bytes'])('does not use a %s protocol receipt as input authority', async fault => {
    const f = await fixture()
    const input = f.owner.kernel.input as (id: string, op: { operationId: string; expectedByte: number; data: string }) => Promise<any>
    f.owner.kernel.input = async (id: string, op: { operationId: string; expectedByte: number; data: string }) => {
      if (fault === 'unack-no-observed-bytes') throw new AgentMuxError('Protocol receipt unknown before observed bytes.', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown')
      const result = await input(id, op)
      if (fault === 'partial') return { ...result, appliedByteRange: { ...result.appliedByteRange, endByte: result.appliedByteRange.endByte - 1 } }
      if (fault === 'wrong-run') return { ...result, run: { ...result.run, runId: 'foreign-run' } }
      if (fault === 'wrong-pid') return { ...result, run: { ...result.run, pid: result.run.pid + 1 } }
      throw new AgentMuxError('Protocol ACK lost.', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown')
    }
    try {
      const submitted = f.submit().then(() => null, error => error); await f.entered
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: '\x1b[?1;2c', source: 'terminal-protocol' }).catch(() => {})
      f.release()
      expect(await submitted).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(f.writes.map(write => write.data)).toEqual(fault === 'unack-no-observed-bytes' ? [] : ['\x1b[?1;2c'])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('human input still cancels preparation after a protocol ACK without waiting for the Provider', async () => {
    const f = await fixture()
    try {
      const submitted = f.submit().then(() => null, error => error); await f.entered
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: '\x1b[?1;2c', source: 'terminal-protocol' })
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'REAL_HUMAN_INPUT', source: 'user' })
      expect(await submitted).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
      f.release(); await new Promise(done => setImmediate(done))
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[?1;2c', 'REAL_HUMAN_INPUT'])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('a late protocol ACK belongs only to its original observer and cannot authorize a later preparation', async () => {
    const f = await fixture(), cancel = new AbortController()
    const input = f.owner.kernel.input as (id: string, op: { operationId: string; expectedByte: number; data: string }) => Promise<any>
    let releaseAck!: () => void, started!: () => void
    const enteredInput = new Promise<void>(resolve => { started = resolve })
    const delayed = new Promise<void>(resolve => { releaseAck = resolve })
    f.owner.kernel.input = async (id: string, op: { operationId: string; expectedByte: number; data: string }) => {
      started(); await delayed; return await input(id, op)
    }
    try {
      const first = f.submit(cancel.signal).then(() => null, error => error); await f.entered
      const protocol = f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: '\x1b[?1;2c', source: 'terminal-protocol' })
      await enteredInput; cancel.abort(); expect(await first).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
      const later = f.submit(undefined, 'later-send').then(() => null, error => error)
      while (f.preparation.mock.calls.length < 2) await new Promise(done => setImmediate(done))
      releaseAck(); await protocol; f.release()
      expect(await later).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[?1;2c'])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { releaseAck(); await f.close() }
  })

  it('waits before any input, then sends the original body once and rejoins its ACK without preparing again', async () => {
    const f = await fixture()
    try {
      const submitted = f.submit(); await f.entered
      expect(f.writes).toEqual([])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
      f.release(); await submitted
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I', 'ORIGINAL_BODY', '\r'])
      await f.submit()
      expect(f.preparation).toHaveBeenCalledTimes(1)
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I', 'ORIGINAL_BODY', '\r'])
    } finally { await f.close() }
  })

  it.each(['source', 'pid', 'cursor', 'final'])('rejects changed %s before the first possible input', async kind => {
    const f = await fixture()
    try {
      const submitted = f.submit(); const result = expect(submitted).rejects.toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED',
        controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      await f.entered; f.change(kind); f.release(); await result
      expect(f.writes).toEqual([])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it.each(['cursor', 'pid', 'raw-cancel'])('does not adopt a new %s authorization at the final refresh claim boundary', async kind => {
    const f = await fixture()
    try {
      f.finalStatusFault(kind); f.release()
      await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED',
        controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      await f.rawDuringFinalStatus()
      expect(f.writes.map(write => write.data)).toEqual(kind === 'raw-cancel' ? ['RAW_AT_FINAL_BOUNDARY'] : [])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('allows another healthy Run while this preparation remains pending', async () => {
    const f = await fixture()
    try {
      const submitted = f.submit(); await f.entered
      await f.client.writeAgent({ agentSessionId: 'healthy', expectedRun: { runId: 'healthy-run' }, data: 'HEALTHY_RAW', source: 'user' })
      expect(f.writes).toEqual([{ run: 'healthy-run', data: 'HEALTHY_RAW' }])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
      f.release(); await submitted
      expect(f.writes.map(write => write.data)).toEqual(['HEALTHY_RAW', '\x1b[I', 'ORIGINAL_BODY', '\r'])
    } finally { await f.close() }
  })

  it('allows same-Run raw input during unknown preparation and cancels the original body without waiting', async () => {
    const f = await fixture()
    try {
      const submitted = f.submit().then(() => 'sent', () => 'cancelled'); await f.entered
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'RAW_WHILE_WAITING', source: 'user' })
      expect(await submitted).toBe('cancelled')
      expect(f.writes.map(write => write.data)).toEqual(['RAW_WHILE_WAITING'])
      f.release(); await Promise.resolve()
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
    } finally { await f.close() }
  })

  it('public cancellation abandons an uncooperative Provider observation without taking the byte lane', async () => {
    const f = await fixture(), cancel = new AbortController()
    try {
      const submitted = f.submit(cancel.signal).then(() => 'sent', () => 'cancelled'); await f.entered
      cancel.abort(); expect(await submitted).toBe('cancelled')
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'AFTER_CANCEL', source: 'user' })
      expect(f.writes.map(write => write.data)).toEqual(['AFTER_CANCEL'])
    } finally { await f.close() }
  })

  it('bounds an uncooperative read-only preparation and keeps ordinary input usable after timeout', async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const submitted = f.submit().then(() => 'sent', () => 'timed-out'); await f.entered
      await vi.advanceTimersByTimeAsync(40_001)
      expect(await submitted).toBe('timed-out')
      expect(f.writes).toEqual([])
      vi.useRealTimers()
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'AFTER_TIMEOUT', source: 'user' })
      expect(f.writes.map(write => write.data)).toEqual(['AFTER_TIMEOUT'])
    } finally { vi.useRealTimers(); await f.close() }
  })

  it('cancels an uncooperative final verifier before any Input claim', async () => {
    const f = await fixture(), cancel = new AbortController()
    let entered!: () => void
    const verifying = new Promise<void>(resolve => { entered = resolve })
    f.preparation.mockImplementation(async () => ({ nativeSourceId: 'source-1', verifyCurrentTransport: async () => {
      entered(); return await new Promise<boolean>(() => {})
    } }))
    try {
      const submitted = f.submit(cancel.signal).then(() => 'sent', () => 'cancelled')
      await verifying; cancel.abort()
      expect(await submitted).toBe('cancelled')
      expect(f.writes).toEqual([])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'AFTER_FINAL_CANCEL', source: 'user' })
      expect(f.writes.map(write => write.data)).toEqual(['AFTER_FINAL_CANCEL'])
    } finally { await f.close() }
  })

  it('rejoins an original unknown refresh receipt without starting another preparation or repeating its bytes', async () => {
    const f = await fixture()
    try {
      f.change('lost-ack'); f.release()
      await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED',
        controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I'])
      await f.submit()
      expect(f.preparation).toHaveBeenCalledTimes(1)
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I', 'ORIGINAL_BODY', '\r'])
    } finally { await f.close() }
  })

  it('keeps an original unknown refresh as unknown when its read-only rejoin fails', async () => {
    const f = await fixture()
    try {
      f.change('lost-ack'); f.release()
      await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
      f.change('final')
      const error = await f.submit().then(() => null, value => value)
      expect(error.code).toBe('AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
      expect(error.controlFailure).not.toEqual({ disposition: 'not_applied', confirmedInputBytes: 0 })
      expect(f.preparation).toHaveBeenCalledTimes(1)
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I'])
      expect(f.client.agentSession('prepare').promptCompletionAdmission?.frameRefresh?.acknowledged).toBe(false)
    } finally { await f.close() }
  })

  it('preserves the original preparation cause while reporting only this invocation as not applied', async () => {
    const f = await fixture()
    f.preparation.mockRejectedValue(new AgentMuxError('readonly source unavailable', 'SOURCE_READ_UNAVAILABLE', 'source-private',
      { disposition: 'unknown', confirmedInputBytes: null }))
    try {
      const error = await f.submit().then(() => null, value => value)
      expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(JSON.parse(error.detail)).toEqual({ code: 'SOURCE_READ_UNAVAILABLE', name: 'AgentMuxError', message: 'readonly source unavailable', detail: 'source-private',
        controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
      expect(f.writes).toEqual([])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
      await f.client.writeAgent({ agentSessionId: 'healthy', expectedRun: { runId: 'healthy-run' }, data: 'HEALTHY_RAW', source: 'user' })
      expect(f.writes).toEqual([{ run: 'healthy-run', data: 'HEALTHY_RAW' }])
    } finally { await f.close() }
  })

  it.each(['cancel', 'timeout'] as const)('prevents late uncooperative preparation from adding input after a public %s failure', async kind => {
    const f = await fixture(), cancel = new AbortController()
    let entered!: () => void, resolve!: (value: AgentProviderPreparedPromptTransport) => void
    const started = new Promise<void>(done => { entered = done })
    f.preparation.mockImplementation(async () => { entered(); return await new Promise(done => { resolve = done }) })
    if (kind === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const submitted = f.submit(cancel.signal).then(() => null, error => error); await started
      if (kind === 'cancel') cancel.abort(new AgentMuxError('Public observation cancelled.', 'CLIENT_CANCELLED', 'observer-only'))
      else await vi.advanceTimersByTimeAsync(40_001)
      const error = await submitted
      expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(JSON.parse(error.detail).code).toBe(kind === 'cancel' ? 'CLIENT_CANCELLED' : 'AGENT_INPUT_PREPARATION_UNCONFIRMED')
      vi.useRealTimers()
      resolve({ nativeSourceId: 'source-1', verifyCurrentTransport: async () => true })
      await new Promise(done => setImmediate(done))
      expect(f.writes).toEqual([])
      expect(f.client.agentSession('prepare').promptCompletionAdmission).toBeUndefined()
      await f.client.writeAgent({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, data: 'RAW_AFTER_CANCEL', source: 'user' })
      expect(f.writes.map(write => write.data)).toEqual(['RAW_AFTER_CANCEL'])
    } finally { vi.useRealTimers(); await f.close() }
  })

  it('transports actual Core preparation facts through public RPC and compiled CLI while the logical delivery remains unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-phase-')), queuePath = join(root, 'messages.ndjson')
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', queuePath)
    const f = await fixture(join(root, 'sessions.json'))
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
    let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    f.preparation.mockRejectedValue(new AgentMuxError('Readonly native evidence is unavailable.', 'NATIVE_OBSERVATION_UNAVAILABLE', 'readonly-source'))
    try {
      await server.start()
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } })
      const error = await rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'prepare' }, text: 'RPC_BODY',
        messageId: 'rpc-phase-message', operationId: 'rpc-phase-operation', execution: 'immediate' }).then(() => null, value => value)
      expect(error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(JSON.parse(error.detail)).toEqual({ code: 'NATIVE_OBSERVATION_UNAVAILABLE', name: 'AgentMuxError', message: 'Readonly native evidence is unavailable.', detail: 'readonly-source' })
      const args = ['agent', 'send', '--to-session', 'prepare', '--text', 'CLI_BODY', '--execution', 'immediate',
        '--operation-id', 'cli-phase-operation', '--message-id', 'cli-phase-message']
      const result = await runCompiledObjectCli(args, objectCliEnvironment(root))
      expect(result.code).not.toBe(0)
      const output = JSON.parse(result.stderr)
      expect(output.error).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(JSON.parse(output.error.detail)).toEqual({ code: 'NATIVE_OBSERVATION_UNAVAILABLE', name: 'AgentMuxError', message: 'Readonly native evidence is unavailable.', detail: 'readonly-source' })
      const preparationCalls = f.preparation.mock.calls.length
      const retry = await runCompiledObjectCli(args, objectCliEnvironment(root))
      expect(retry.code).not.toBe(0); expect(JSON.parse(retry.stderr).error.code).toBe('AGENT_PROMPT_UNCONFIRMED')
      expect(f.preparation).toHaveBeenCalledTimes(preparationCalls)
      const records = await new DurableAgentMuxMessageQueue(queuePath).listAfter(0)
      expect(records).toHaveLength(2)
      expect(records.every(record => record.delivery.state === 'queued' && Boolean(record.delivery.reason))).toBe(true)
      expect(f.writes).toEqual([])
      await f.client.writeAgent({ agentSessionId: 'healthy', expectedRun: { runId: 'healthy-run' }, data: 'HEALTHY_RAW', source: 'user' })
      expect(f.writes.map(write => write.data)).toEqual(['HEALTHY_RAW'])
    } finally { await rpc?.dispose(); await server.stop(); await f.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
  }, 30_000)

  it('retains a different Core original unknown input while reporting this concurrent invocation preparation failure', async () => {
    const f = await fixture()
    const { preparePromptExecutionTransport: _prepare, ...peerProvider } = f.provider
    const peer = new AgentMuxClient({ store: f.store, providers: [peerProvider] }), peerOwner = peer as any
    let entered!: () => void, reject!: (error: unknown) => void
    const started = new Promise<void>(done => { entered = done })
    f.preparation.mockImplementation(async () => { entered(); return await new Promise((_resolve, failure) => { reject = failure }) })
    try {
      await peerOwner.registry.load('local')
      for (const method of ['isConnected', 'identity', 'status', 'input']) peerOwner.kernel[method] = f.owner.kernel[method]
      peerOwner.screenEvidence.wait = f.owner.screenEvidence.wait
      peerOwner.screenEvidence.generation = f.owner.screenEvidence.generation
      peerOwner.connected = true
      const first = f.submit().then(() => null, error => error); await started
      f.change('lost-ack')
      await expect(peer.submitAgentPrompt({ agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, afterSubmissionId: null,
        operationId: 'original-send', prompt: 'ORIGINAL_BODY', execution: 'immediate' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED' })
      const original = (await loadAgentSessions(f.store)).find(session => session.agentSessionId === 'prepare')!.promptCompletionAdmission!
      reject(new AgentMuxError('This observer did not qualify.', 'NATIVE_OBSERVATION_UNAVAILABLE'))
      expect(await first).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      const retained = (await loadAgentSessions(f.store)).find(session => session.agentSessionId === 'prepare')!.promptCompletionAdmission!
      expect(retained).toEqual(original)
      expect(retained.frameRefresh?.acknowledged).toBe(false)
      expect(retained.notApplied).not.toBe(true)
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I'])
      await f.client.writeAgent({ agentSessionId: 'healthy', expectedRun: { runId: 'healthy-run' }, data: 'HEALTHY_RAW', source: 'user' })
      expect(f.writes.map(write => write.data)).toEqual(['\x1b[I', 'HEALTHY_RAW'])
    } finally { await peer.dispose(); await f.close() }
  })

  it('preserves invocation-local preparation facts through the finite Hosted runtime consumer', async () => {
    const f = await fixture(), hosted = new AgentMuxHostedRuntimeService(f.client, null, () => hostedTestOwner(f.client))
    let consumer: Awaited<ReturnType<typeof hosted.subscribe>> | undefined
    f.preparation.mockRejectedValue(new AgentMuxError('Readonly provider unavailable.', 'NATIVE_OBSERVATION_UNAVAILABLE', 'read-only'))
    try {
      consumer = await hosted.subscribe('runtime.events', { fence: hostedTestFence, consumerId: 'phase-consumer' }, logicalHostedEvents(() => {})); await consumer.start?.()
      await expect(hosted.call('runtime.invoke', { fence: hostedTestFence, consumerId: 'phase-consumer', invocation: { method: 'submitAgentPrompt', args: [{
        agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, afterSubmissionId: null, operationId: 'hosted-phase-operation', prompt: 'ORIGINAL_BODY', execution: 'immediate'
      }] } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED',
        detail: JSON.stringify({ code: 'NATIVE_OBSERVATION_UNAVAILABLE', name: 'AgentMuxError', message: 'Readonly provider unavailable.', detail: 'read-only' }), controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect(f.writes).toEqual([])
    } finally { await consumer?.dispose(); await hosted.dispose(); await f.close() }
  })
})


describe('mobile original-request authenticated source rejoin', () => {
  it('settles the same acknowledged source without another input and rejects a changed authenticated device', async () => {
    const f = await fixture()
    const input = vi.fn(f.owner.kernel.input as (...args: unknown[]) => Promise<unknown>)
    f.owner.kernel.input = input
    try {
      f.release()
      const sourceDevice = { hostId: 'original-host', deviceId: 'original-mobile', name: 'Phone' }
      const request = { agentSessionId: 'prepare', expectedRun: { runId: 'prepare-run' }, afterSubmissionId: null,
        operationId: 'mobile-original-operation', prompt: 'original mobile body', execution: 'immediate' as const,
        authorHuman: true as const, sourceDevice }
      await f.client.submitAgentPrompt(request)
      const originalCalls = input.mock.calls.length
      expect(originalCalls).toBeGreaterThan(0)
      await f.client.submitAgentPrompt({ ...request, afterSubmissionId: request.operationId })
      expect(input).toHaveBeenCalledTimes(originalCalls)
      await expect(f.client.submitAgentPrompt({ ...request, afterSubmissionId: request.operationId,
        sourceDevice: { ...sourceDevice, deviceId: 'different-authenticated-device' } }))
        .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      expect(input).toHaveBeenCalledTimes(originalCalls)
      expect(f.client.agentSession('prepare').promptCompletionAdmission?.intent?.message?.sourceDevice).toEqual(sourceDevice)
    } finally { await f.close() }
  })
})
