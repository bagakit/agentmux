import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { AgentMuxClient } from '../src/client.js'
import { agentPromptCondition, agentPromptPredecessor } from '../src/agent-prompt-condition.js'
import { AgentMuxMemoryAgentSessionStore, AgentMuxFileAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxStoredAgentSession, AgentMuxPendingInteraction } from '../src/types.js'
import { advanceDelivery, createThread } from '../src/agent-message.js'
import { ackDeliveryBatch, checkDeliveries, type DeliveryQueue } from '../src/agent-delivery-queue.js'

/**
 * T-002 gate: typed prompt ingress has ONE delivery owner in Core, and the two facts the plan forbids
 * merging stay two facts.
 *
 * This file drives the REAL client (only ctxmux I/O faked) so the assertions are about behaviour, not a
 * source scan. The single-phase provider (TraeX) is enough for the ingress properties; the two-facts
 * separation is proven directly against the two owning modules.
 *
 * Why this is the right shape (verbatim from the plan):
 *   - "Host accepted 与 Provider consumed/unknown 分开" — CtxMux acceptedInputBytes proves Host-accepted;
 *     it must NOT be read as the harness having consumed the prompt.
 *   - "Core 的 delivery consumer ack 与 prompt 被 Harness 消费不是同一事实，不能为了统一命名合并。"
 *     ackDeliveryBatch advances a READER's cursor (收到); advanceDelivery→accepted/replied is the harness
 *     acting on the prompt. Same word, different owners — the trap.
 *   - "工作中有待答请求时不把 prompt 当作回答" — a pending human request blocks a prompt from being sent.
 *   - "不双发" — an idempotent replay (same operationId) does NOT write the payload twice.
 */

const RUN_ID = 'ingress-run'
const AGENT_SESSION_ID = 'ingress-agent'
const WORKSPACE = '/tmp/ingress-agent'
const clients: AgentMuxClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())); vi.restoreAllMocks() })

function storedSession(
  extra: Partial<AgentMuxStoredAgentSession> = {}
): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: AGENT_SESSION_ID,
    providerId: 'traex',
    executorId: 'traex',
    hostId: 'local',
    workspacePath: WORKSPACE,
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-ingress',
    hookToken: 'token-ingress',

    createdAt: 100,
    updatedAt: 100,
    ...extra
  }
}

function runProjection(acceptedInputBytes: number) {
  return {
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'traex',
    args: [] as string[],
    workspacePath: WORKSPACE,
    pid: 321,
    state: { type: 'running' as const },
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes
  }
}

type Internals = {
  kernel: Record<string, unknown>
  registry: { load(hostId: string): Promise<void>; update(id: string, run: { runId: string }, operation: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession): Promise<AgentMuxStoredAgentSession> }
  screenEvidence: { wait: (...args: unknown[]) => Promise<number> }
}

/** The daemon owns physical idempotency and byte CAS; its receipt also binds the original range. */
function daemonFixture() {
  let cursor = 0
  let runState: 'running' | 'exited' = 'running'
  let loseAck = false
  const writes: string[] = []
  type Operation = Parameters<CtxmuxRunAdapter['input']>[1]
  const operations: Operation[] = []
  const receipts = new Map<string, Operation>()
  return {
    writes, operations,
    setRunState: (state: 'running' | 'exited') => { runState = state },
    loseNextAck: () => { loseAck = true },
    status: async () => ({ ...runProjection(cursor),
      state: runState === 'running' ? { type: 'running' as const } : { type: 'exited' as const, exitCode: 0 } }),
    input: async (runId: string, operation: Operation) => {
      expect(runId).toBe(RUN_ID)
      operations.push(structuredClone(operation))
      const retained = receipts.get(operation.operationId)
      if (retained) {
        // Mirroring the SDK's exact receipt check: same key with a NEW expectedByte is NOT a replay.
        expect(operation).toEqual(retained)
      } else {
        expect(operation.expectedByte).toBe(cursor)
        receipts.set(operation.operationId, structuredClone(operation))
        writes.push(typeof operation.data === 'string' ? operation.data : Buffer.from(operation.data).toString('utf8'))
        cursor += Buffer.byteLength(operation.data)
      }
      if (loseAck) { loseAck = false; throw new Error('Input response lost after acceptance') }
      return { run: runProjection(cursor), appliedByteRange: {
        startByte: operation.expectedByte, endByte: operation.expectedByte + Buffer.byteLength(operation.data)
      } }
    }
  }
}

async function ingressClient(
  extra: Partial<AgentMuxStoredAgentSession> = {},
  store: AgentMuxAgentSessionStore = new AgentMuxMemoryAgentSessionStore(),
  daemon = daemonFixture()
) {
  if ((await store.load()).length === 0) await store.compareAndSwap(null, storedSession(extra))
  const client = new AgentMuxClient({ store })
  clients.push(client)
  const state = client as unknown as Internals
  await state.registry.load('local')
  state.kernel.isConnected = () => true
  state.kernel.identity = () => ({ daemonInstanceId: 'daemon-1', protocolVersion: 1, buildIdentity: 'test' })
  state.kernel.status = daemon.status
  state.kernel.input = daemon.input
  vi.spyOn(state.screenEvidence, 'wait').mockResolvedValue(0)
  ;(client as unknown as { connected: boolean }).connected = true
  return { ...daemon, client, store }
}

describe('typed prompt ingress has one delivery owner in Core', () => {
  it('does not turn a missing original condition into the current admission, and preserves raw input', async () => {
    const fixture = await ingressClient()
    const missing = { agentSessionId: AGENT_SESSION_ID, operationId: 'missing-condition', prompt: 'kept' }
    await expect(fixture.client.submitAgentPrompt(missing as never)).rejects.toMatchObject({
      code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', detail: 'unknown' })
    expect(fixture.writes).toEqual([])
    expect((await fixture.store.load())[0]).not.toHaveProperty('promptCompletionAdmission')
    await fixture.client.writeAgent({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, data: 'healthy raw\r', source: 'user' })
    expect(fixture.writes).toEqual(['healthy raw\r'])
  })

  it('distinguishes confirmed empty admission from a record with no logical identity', async () => {
    const fixture = await ingressClient()
    expect(agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID))).toEqual({
      expectedRun: { runId: RUN_ID }, afterSubmissionId: null })
    const current = (await fixture.store.load())[0] as AgentMuxStoredAgentSession
    const unknown = { ...current, promptCompletionAdmission: { operationId: 'unidentified', startByte: 0, endByte: 1 } }
    expect(agentPromptPredecessor(unknown)).toBeUndefined()
    expect(() => agentPromptCondition(unknown)).toThrow('no logical identity')
    expect(fixture.writes).toEqual([])
  })

  it('checks the frozen predecessor before any claim write when delivery facts change', async () => {
    const fixture = await ingressClient()
    const waiting = { ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID, operationId: 'waiting-at-old-admission', prompt: 'waiting', allowUncertainTurn: true }
    await fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID, operationId: 'earlier-admitted', prompt: 'earlier' })
    const admitted = await fixture.store.load()
    await expect(fixture.client.submitAgentPrompt(waiting)).rejects.toMatchObject({
      code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', detail: 'unknown' })
    expect(await fixture.store.load()).toEqual(admitted)
    expect(fixture.writes).toEqual(['earlier\r'])
    // A new explicit intent still uses the healthy Run. Unknown belongs only to the old intent.
    await fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID, operationId: 'fresh-explicit-message', prompt: 'fresh', allowUncertainTurn: true })
    expect(fixture.writes).toEqual(['earlier\r', 'fresh\r'])
  })

  it('can prepare again only after its first scope refusal proves no original dispatch', async () => {
    const daemon = daemonFixture(), store = new AgentMuxMemoryAgentSessionStore()
    const first = await ingressClient({}, store, daemon), second = await ingressClient({}, store, daemon)
    const contender = { ...agentPromptCondition(second.client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID, operationId: 'never-dispatched', prompt: 'second', allowUncertainTurn: true }
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const input = daemon.input
    ;(first.client as unknown as Internals).kernel.input = async (...args: Parameters<typeof input>) => {
      entered(); await gate; return await input(...args)
    }
    const delivering = first.client.submitAgentPrompt({ ...agentPromptCondition(first.client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID, operationId: 'live-owner', prompt: 'first' }).then(() => null, error => error)
    await started
    try {
      await expect(second.client.submitAgentPrompt(contender)).rejects.toMatchObject({ code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
      expect(daemon.operations).toEqual([])
    } finally { release(); await delivering }
    expect(await delivering).toBeNull()
    await second.client.refreshAgentSession(AGENT_SESSION_ID, contender.expectedRun)
    const rePrepared = { ...contender, ...agentPromptCondition(second.client.agentSession(AGENT_SESSION_ID)) }
    expect(rePrepared.afterSubmissionId).toBe('live-owner')
    await second.client.submitAgentPrompt(rePrepared)
    expect(daemon.writes).toEqual(['first\r', 'second\r'])
    expect(daemon.operations).toHaveLength(2)
  })

  it.each([['memory', 'traex'], ['file', 'traex'], ['memory', 'codex'], ['file', 'codex']] as const)('does not let another live Client replace an in-flight zero-byte prompt claim (%s Store / %s)', async (kind, providerId) => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-ingress-owner-'))
    const store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
    const daemon = daemonFixture()
    const first = await ingressClient({ providerId, executorId: providerId }, store, daemon)
    let release!: () => void, started!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    const paused = new Promise<void>(resolve => { release = resolve })
    const input = daemon.input
    ;(first.client as unknown as Internals).kernel.input = async (...args: Parameters<typeof input>) => {
      started(); await paused; return await input(...args)
    }
    const inFlight = first.client.submitAgentPrompt({ ...agentPromptCondition(first.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'client-one-flight', prompt: 'first', allowUncertainTurn: true })
    // Always observe rejection and release the private native boundary, including under mutation.
    const settled = inFlight.then(() => null, error => error)
    await start
    try {
      // This is a second live reader of the shared durable claim, not a stale snapshot CAS test.
      const second = await ingressClient({}, kind === 'memory' ? store : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), daemon)
      const claimed = ((await store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission
      expect(claimed).toMatchObject({ submissionId: 'client-one-flight', startByte: 0, endByte: 6 })
      await expect(second.client.submitAgentPrompt({ ...agentPromptCondition(second.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
        operationId: 'client-two-flight', prompt: 'second contender', allowUncertainTurn: true }))
        .rejects.toMatchObject({ code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
      expect(((await store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission).toEqual(claimed)
      expect(daemon.writes).toEqual([])
    } finally { release(); await settled; await rm(root, { recursive: true, force: true }) }
    expect(await settled).toBeNull()
    expect(daemon.writes).toEqual(providerId === 'codex' ? ['first', '\r'] : ['first\r'])
  })

  it.each([['memory', 'traex'], ['file', 'traex'], ['memory', 'codex'], ['file', 'codex']] as const)('joins the original Native pending input after Core has released its scope (%s / %s)', async (kind, providerId) => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-ingress-native-pending-'))
    const path = join(root, 'sessions.json')
    const store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(path)
    const daemon = daemonFixture(), originalInput = daemon.input
    let original!: Parameters<typeof originalInput>[1], release!: () => void, joined!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const joining = new Promise<void>(resolve => { joined = resolve })
    let lost = false
    daemon.input = async (runId, operation) => {
      if (!lost) {
        lost = true; original = structuredClone(operation)
        throw new AgentMuxError('Response lost while Native input is pending', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown')
      }
      if (operation.operationId === original.operationId) {
        expect(operation).toEqual(original)
        joined(); await pending
      }
      return await originalInput(runId, operation)
    }
    try {
      const first = await ingressClient({ providerId, executorId: providerId }, store, daemon)
      await expect(first.client.submitAgentPrompt({ ...agentPromptCondition(first.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
        operationId: 'original-native-pending', prompt: 'original' })).rejects.toThrow('Native input is pending')
      const originalClaim = ((await store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission
      expect(originalClaim?.intent?.plan.kind).toBe(providerId === 'codex' ? 'render-then-submit' : 'single-phase')
      const second = await ingressClient({}, kind === 'memory' ? store : new AgentMuxFileAgentSessionStore(path), daemon)
      const delivery = second.client.submitAgentPrompt({ ...agentPromptCondition(second.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
        operationId: 'next-after-native-pending', prompt: 'next', allowUncertainTurn: true })
      const settled = delivery.then(() => null, error => error)
      expect(await Promise.race([joining.then(() => true), settled.then(() => false)])).toBe(true)
      try {
        expect(((await store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission).toEqual(originalClaim)
        expect(daemon.writes).toEqual([])
      } finally { release() }
      expect(await settled).toBeNull()
      expect(daemon.writes).toEqual(providerId === 'codex' ? ['original', '\r', 'next', '\r'] : ['original\r', 'next\r'])
      expect(((await store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission)
        .toMatchObject({ submissionId: 'next-after-native-pending', acknowledged: true })
    } finally { release?.(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['traex', 'codex'])('recovers frozen bytes and incarnation despite a changed Provider plan (%s)', async providerId => {
    const daemon = daemonFixture(), store = new AgentMuxMemoryAgentSessionStore()
    const first = await ingressClient({ providerId, executorId: providerId }, store, daemon)
    const input = {...agentPromptCondition(first.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID, operationId: 'frozen-provider-plan', prompt: 'original bytes' }
    daemon.loseNextAck()
    await expect(first.client.submitAgentPrompt(input)).rejects.toThrow('Input response lost')
    const restarted = await ingressClient({}, store, daemon)
    const internals = restarted.client as unknown as Internals & { providers: { get(id: string): { planPromptInput(prompt: string): unknown } } }
    vi.spyOn(internals.providers.get(providerId), 'planPromptInput').mockReturnValue({ kind: 'single-phase', data: 'changed Provider plan\r' })
    internals.kernel.identity = () => ({ daemonInstanceId: 'changed-incarnation', protocolVersion: 1, buildIdentity: 'test' })
    const result = await restarted.client.submitAgentPrompt(input).then(() => null, error => error)
    expect(result).toBeNull()
    expect(daemon.writes).toEqual(providerId === 'codex' ? ['original bytes', '\r'] : ['original bytes\r'])
    expect(daemon.operations.map(operation => operation.ownerInstanceId)).toEqual(providerId === 'codex' ? ['daemon-1', 'daemon-1', 'daemon-1'] : ['daemon-1', 'daemon-1'])
  })

  it('allows another message after definite not_applied without waiting for a lease', async () => {
    const fixture = await ingressClient(), inner = fixture.client as unknown as Internals
    const input = fixture.input
    inner.kernel.input = vi.fn().mockRejectedValueOnce(new AgentMuxError('Not dispatched', 'CTXMUX_INPUT_NOT_APPLIED', 'not_applied')).mockImplementation(input)
    await expect(fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'not-dispatched', prompt: 'kept message' })).rejects.toThrow('Not dispatched')
    expect(((await fixture.store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission)
      .toMatchObject({ submissionId: 'not-dispatched', notApplied: true })
    await fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'after-not-applied', prompt: 'next', allowUncertainTurn: true })
    expect(fixture.writes).toEqual(['next\r'])
  })

  it('revokes an old not_applied disposition before retry dispatch, preserving a later unknown intent', async () => {
    const fixture = await ingressClient(), inner = fixture.client as unknown as Internals
    const original = {...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID, operationId: 'retry-disposition', prompt: 'kept input' }
    inner.kernel.input = vi.fn()
      .mockRejectedValueOnce(new AgentMuxError('Before dispatch', 'CTXMUX_INPUT_NOT_APPLIED', 'not_applied'))
      .mockImplementationOnce(async () => {
        expect(((await fixture.store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission)
          .toMatchObject({ submissionId: original.operationId, notApplied: false })
        throw new AgentMuxError('Native is still pending', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown')
      })
    await expect(fixture.client.submitAgentPrompt(original)).rejects.toThrow('Before dispatch')
    await expect(fixture.client.submitAgentPrompt(original)).rejects.toThrow('Native is still pending')
    expect(((await fixture.store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission)
      .toMatchObject({ submissionId: original.operationId, acknowledged: false, notApplied: false })
    const successor = await ingressClient({}, fixture.store, fixture)
    await successor.client.submitAgentPrompt({ ...agentPromptCondition(successor.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'after-pending-retry', prompt: 'next', allowUncertainTurn: true })
    expect(fixture.writes).toEqual(['kept input\r', 'next\r'])
  })

  it('allows a second Core raw input and Hook while the first Core owns a Prompt', async () => {
    const store = new AgentMuxMemoryAgentSessionStore(), daemon = daemonFixture()
    const first = await ingressClient({}, store, daemon)
    let release!: () => void, started!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    ;(first.client as unknown as Internals).kernel.input = async () => {
      started(); await pending
      throw new AgentMuxError('Prompt was not dispatched', 'CTXMUX_INPUT_NOT_APPLIED', 'not_applied')
    }
    const sending = first.client.submitAgentPrompt({ ...agentPromptCondition(first.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'prompt-owner-kept', prompt: 'kept intent' }).then(() => null, error => error)
    await entered
    try {
      const second = await ingressClient({}, store, daemon), state = second.client as unknown as Internals
      await state.registry.update(AGENT_SESSION_ID, { runId: RUN_ID }, current => ({ ...current,
        hookReceipt: { id: 'concurrent-hook', providerId: 'traex', agentSessionId: AGENT_SESSION_ID, eventName: 'UserPromptSubmit', run: { runId: RUN_ID }, observedAt: Date.now() },
        updatedAt: Math.max(current.updatedAt, Date.now()) }))
      const raw = await second.client.writeAgent({ agentSessionId: AGENT_SESSION_ID,
        expectedRun: { runId: RUN_ID }, data: 'raw while owned\r', source: 'user' })
      expect(raw.appliedByteRange).toEqual({ startByte: 0, endByte: 16 })
      expect(daemon.writes).toEqual(['raw while owned\r'])
      expect(((await store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission)
        .toMatchObject({ submissionId: 'prompt-owner-kept', acknowledged: false })
    } finally { release() }
    expect(await sending).toMatchObject({ code: 'CTXMUX_INPUT_NOT_APPLIED' })
    expect(((await store.load())[0] as AgentMuxStoredAgentSession).hookReceipt?.id).toBe('concurrent-hook')
  })

  it('accepts a prompt for a running Run and writes the bytes through the daemon exactly once', async () => {
    const fixture = await ingressClient()
    await fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-send',
      prompt: 'ship it'
    })
    // TraeX is single-phase: the whole outbound (prompt + \r) is one daemon input write.
    expect(fixture.writes).toEqual(['ship it\r'])
  })

  it('replays the SAME operation and original byte range without a completion observation', async () => {
    const fixture = await ingressClient()
    const input = {...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID, operationId: 'op-replay', prompt: 'once only' }
    await fixture.client.submitAgentPrompt(input)
    await fixture.client.submitAgentPrompt(input)
    // Core retains the complete operation; ctxmux returns its receipt without a second physical write.
    expect(fixture.operations).toHaveLength(2)
    expect(fixture.operations[1]).toEqual(fixture.operations[0])
    expect(fixture.writes).toEqual(['once only\r'])
  })

  it.each(['other', 'different'])('rejects reuse of a claimed logical operation for changed content (%s) before another write', async (changed) => {
    const fixture = await ingressClient()
    const input = {...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID, operationId: 'claimed', prompt: 'first' }
    await fixture.client.submitAgentPrompt(input)
    await expect(fixture.client.submitAgentPrompt({ ...input, prompt: changed }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect(fixture.writes).toEqual(['first\r'])
    expect(fixture.operations).toHaveLength(1)
  })

  it.each([false, true])('recovers the persisted single-phase range after client restart (lost ack: %s)', async (lostAck) => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-ingress-restart-'))
    try {
      const path = join(root, 'sessions.json')
      const daemon = daemonFixture()
      const first = await ingressClient({}, new AgentMuxFileAgentSessionStore(path), daemon)
      const input = {...agentPromptCondition(first.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID, operationId: 'restart-operation', prompt: 'persist me' }
      if (lostAck) {
        daemon.loseNextAck()
        await expect(first.client.submitAgentPrompt(input)).rejects.toThrow('Input response lost')
      } else await first.client.submitAgentPrompt(input)
      // A fresh file store and Client have no in-memory cursor or coordinator state.
      const restarted = await ingressClient({}, new AgentMuxFileAgentSessionStore(path), daemon)
      await restarted.client.submitAgentPrompt(input)
      expect(daemon.writes).toEqual(['persist me\r'])
      expect(daemon.operations).toHaveLength(2)
      expect(daemon.operations[1]).toEqual(daemon.operations[0])
      expect((await restarted.store.load())[0]).toMatchObject({ promptCompletionAdmission: {
        submissionId: input.operationId, startByte: 0, endByte: 11
      } })
      await expect(restarted.client.submitAgentPrompt({ ...input, prompt: 'changed after restart' }))
        .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      expect(daemon.writes).toEqual(['persist me\r'])
      // Replay is not a new turn. An unconfirmed turn needs the same explicit continuation
      // after restart as before it; that choice does not fabricate a native completion.
      const next = { ...input, ...agentPromptCondition(restarted.client.agentSession(AGENT_SESSION_ID)), operationId: 'next-operation', prompt: 'next' }
      await expect(restarted.client.submitAgentPrompt(next))
        .rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(daemon.writes).toEqual(['persist me\r'])
      await restarted.client.submitAgentPrompt({ ...next, allowUncertainTurn: true })
      expect(daemon.writes).toEqual(['persist me\r', 'next\r'])
      expect(((await restarted.store.load())[0] as AgentMuxStoredAgentSession).terminalPromptDelivery)
        .toMatchObject({ reason: 'turn-end-unconfirmed', submissionId: next.operationId })
      await restarted.client.submitAgentPrompt(next)
      expect(daemon.writes).toEqual(['persist me\r', 'next\r'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('keeps an admission without its original tuple unknown and leaves raw input available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-ingress-existing-admission-'))
    try {
      const path = join(root, 'sessions.json')
      const daemon = daemonFixture()
      const first = await ingressClient({ semanticStatus: { state: 'done', source: 'native-hook', observedAt: 100 } },
        new AgentMuxFileAgentSessionStore(path), daemon)
      const input = {...agentPromptCondition(first.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID, operationId: 'existing-operation', prompt: 'existing input' }
      await first.client.submitAgentPrompt(input)
      const stored = (await first.store.load())[0] as AgentMuxStoredAgentSession
      const { operationId, startByte, endByte, completionId } = stored.promptCompletionAdmission!
      // This is the exact already-installed shape. Missing logical identity is unknown, not invalid.
      expect(completionId).toBe('["ingress-run",100]')
      const existing = { operationId, startByte, endByte, completionId: completionId! }
      await first.store.compareAndSwap(stored, { ...stored, promptCompletionAdmission: existing })
      const restarted = await ingressClient({}, new AgentMuxFileAgentSessionStore(path), daemon)
      await expect(restarted.client.submitAgentPrompt(input)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      expect(daemon.writes).toEqual(['existing input\r'])
      expect(daemon.operations).toHaveLength(1)
      expect(((await restarted.store.load())[0] as AgentMuxStoredAgentSession).terminalPromptDelivery)
        .toMatchObject({ reason: 'input-unconfirmed' })
      await restarted.client.writeAgent({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, data: 'n\r', source: 'user' })
      expect(daemon.writes).toEqual(['existing input\r', 'n\r'])
      expect((await restarted.store.load())[0]).toMatchObject({ promptCompletionAdmission: existing })
      expect(((await restarted.store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission)
        .not.toHaveProperty('submissionId')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('recovers an older lost ACK without replacing a newer accepted prompt claim', async () => {
    const daemon = daemonFixture(), store = new AgentMuxMemoryAgentSessionStore()
    const first = await ingressClient({}, store, daemon)
    const original = {...agentPromptCondition(first.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID, operationId: 'older-lost-ack', prompt: 'older prompt' }
    daemon.loseNextAck()
    await expect(first.client.submitAgentPrompt(original)).rejects.toThrow('Input response lost')
    const second = await ingressClient({}, store, daemon)
    await second.client.submitAgentPrompt({ ...agentPromptCondition(second.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'newer-accepted', prompt: 'newer prompt', allowUncertainTurn: true })
    const newerClaim = ((await store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission
    const newerSession = await store.load()
    expect(newerClaim?.submissionId).toBe('newer-accepted')
    const restarted = await ingressClient({}, store, daemon)
    const result = await restarted.client.submitAgentPrompt({ ...original, allowUncertainTurn: true }).then(() => undefined, error => error)
    // Primary oracle is Core's durable fact. A failed old receipt lookup must not replace B.
    expect(((await store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission).toEqual(newerClaim)
    expect(await store.load()).toEqual(newerSession)
    expect(daemon.writes).toEqual(['older prompt\r', 'newer prompt\r'])
    expect(result).toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', detail: 'unknown' })
    await restarted.client.writeAgent({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, source: 'user', data: 'healthy raw\r' })
    expect(daemon.writes).toEqual(['older prompt\r', 'newer prompt\r', 'healthy raw\r'])
  })

  it('refuses a prompt while a human request is pending — a prompt is not silently its answer', async () => {
    const pending: AgentMuxPendingInteraction = {
      request: {
        kind: 'permission',
        id: 'perm-1',
        agentSessionId: AGENT_SESSION_ID,
        title: 'Allow command?',
        options: [
          { id: 'allow-once', label: 'Allow', kind: 'allow-once' },
          { id: 'reject-once', label: 'Deny', kind: 'reject-once' }
        ],
        evidence: { source: 'native-hook', observedAt: 200, run: { runId: RUN_ID }, hookReceiptId: 'perm-1' }
      }
    }
    const fixture = await ingressClient({ pendingInteraction: pending, updatedAt: 200 })
    await expect(fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-during-pending',
      prompt: 'must-not-bypass-permission'
    })).rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
    // Not one byte reached the Agent — the pending card owns the input surface.
    // The coordinator's durable new-admission check owns this refusal.
    expect(fixture.writes).toEqual([])
  })

  it.each(['local', 'another Client'] as const)('does not submit a rendered Prompt as an answer to a request that arrived before dispatch (%s)', async source => {
    const fixture = await ingressClient({ providerId: 'codex', executorId: 'codex' })
    const inner = fixture.client as unknown as Internals
    let release!: () => void, started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const paused = new Promise<void>(resolve => { release = resolve })
    vi.mocked(inner.screenEvidence.wait).mockImplementationOnce(async () => { started(); await paused; return 0 })
    const submission = fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'permission-arrives', prompt: 'ordinary prompt', allowUncertainTurn: true })
    const settled = submission.then(() => null, error => error)
    await entered
    const pending: AgentMuxPendingInteraction = { request: {
      kind: 'permission', id: 'new-permission', agentSessionId: AGENT_SESSION_ID, title: 'New decision',
      options: [{ id: 'deny', label: 'Deny', kind: 'reject-once' }],
      evidence: { source: 'native-hook', observedAt: 200, run: { runId: RUN_ID }, hookReceiptId: 'new-permission' }
    } }
    try {
      const writer = source === 'local' ? inner : (await ingressClient({}, fixture.store, fixture)).client as unknown as Internals
      if (source === 'another Client') expect(writer).not.toBe(inner)
      await writer.registry.update(AGENT_SESSION_ID, { runId: RUN_ID }, current => ({ ...current,
        pendingInteraction: pending, updatedAt: Math.max(current.updatedAt, 200) }))
    } finally { release() }
    expect(await settled).toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
    expect(fixture.writes).toEqual(['ordinary prompt'])
    expect(fixture.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toEqual(pending)
    expect(fixture.client.agentSession(AGENT_SESSION_ID).terminalPromptSubmission?.submit.acknowledged).toBe(false)
  })

  it('lets an exact typed answer end the optional Prompt render observation in the same Core', async () => {
    const fixture = await ingressClient({ providerId: 'codex', executorId: 'codex' })
    const inner = fixture.client as unknown as Internals
    let release!: () => void, started!: () => void, observation!: AbortSignal
    const entered = new Promise<void>(resolve => { started = resolve })
    vi.mocked(inner.screenEvidence.wait).mockImplementationOnce(async (...args) => {
      observation = (args[4] as { signal: AbortSignal }).signal
      expect(observation).toBeInstanceOf(AbortSignal)
      return await new Promise<number>((resolve, reject) => {
        release = () => resolve(0)
        observation.addEventListener('abort', () => reject(new AgentMuxError(
          'Render observation ended', 'AGENT_PROMPT_READINESS_CANCELLED')), { once: true })
        started()
      })
    })
    const prompt = fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'render-before-typed-answer', prompt: 'ordinary prompt' }).then(() => null, error => error)
    await entered
    const pending: AgentMuxPendingInteraction = { request: {
      kind: 'permission', id: 'exact-typed-answer', agentSessionId: AGENT_SESSION_ID, title: 'Exact decision',
      options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }],
      evidence: { source: 'native-hook', observedAt: 200, run: { runId: RUN_ID }, hookReceiptId: 'exact-typed-answer' }
    } }
    await inner.registry.update(AGENT_SESSION_ID, { runId: RUN_ID }, current => ({ ...current,
      pendingInteraction: pending, updatedAt: Math.max(current.updatedAt, 200) }))
    const answer = fixture.client.respondAgentInteraction({ agentSessionId: AGENT_SESSION_ID,
      expectedRun: { runId: RUN_ID }, response: { kind: 'permission', requestId: pending.request.id,
        decision: { outcome: 'selected', optionId: 'allow-once' } } }).then(() => null, error => error)
    try { expect(observation.aborted).toBe(true) }
    finally { release(); await Promise.all([prompt, answer]) }
    expect(await prompt).toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
    expect(await answer).toBeNull()
    expect(fixture.writes).toEqual(['ordinary prompt', '1'])
    expect(fixture.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toBeUndefined()
    expect((await fixture.status()).state).toEqual({ type: 'running' })
  })

  it.each(['new message joins', 'old retry then cold File'] as const)('converges an old submit that Native rejected after an exact human answer occupied its range (%s)', async source => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-partial-submit-'))
    try {
      const store = source === 'new message joins' ? new AgentMuxMemoryAgentSessionStore()
        : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
      const fixture = await ingressClient({ providerId: 'codex', executorId: 'codex' }, store)
      const inner = fixture.client as unknown as Internals
      const pending: AgentMuxPendingInteraction = { request: {
        kind: 'permission', id: 'human-before-submit', agentSessionId: AGENT_SESSION_ID, title: 'Exact decision',
        options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }],
        evidence: { source: 'native-hook', observedAt: 200, run: { runId: RUN_ID }, hookReceiptId: 'human-before-submit' }
      } }
      vi.mocked(inner.screenEvidence.wait).mockImplementationOnce(async () => {
        await inner.registry.update(AGENT_SESSION_ID, { runId: RUN_ID }, current => ({ ...current,
          pendingInteraction: pending, updatedAt: Math.max(current.updatedAt, 200) }))
        return 0
      })
      await expect(fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
        operationId: 'partial-before-human', prompt: 'original payload' }))
        .rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
      const originalClaim = ((await fixture.store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission
      expect(fixture.writes).toEqual(['original payload'])
      await fixture.client.respondAgentInteraction({ agentSessionId: AGENT_SESSION_ID,
        expectedRun: { runId: RUN_ID }, response: { kind: 'permission', requestId: pending.request.id,
          decision: { outcome: 'selected', optionId: 'allow-once' } } })
      expect(fixture.writes).toEqual(['original payload', '1'])
      let rejectedSubmit = 0
      inner.kernel.input = async (runId: string, operation: Parameters<CtxmuxRunAdapter['input']>[1]) => {
        // The original submit has never entered Native. Its immutable range is now
        // behind the actual cursor, so this exact request has no future write eligibility.
        if (operation.data === '\r' && operation.expectedByte === originalClaim!.endByte - 1) {
          expect((await fixture.status()).acceptedInputBytes).toBeGreaterThan(operation.expectedByte)
          rejectedSubmit++
          throw new AgentMuxError('Original submit range was occupied', 'CTXMUX_input_cursor_mismatch', 'not_applied')
        }
        return await fixture.input(runId, operation)
      }
      let successor = fixture.client
      if (source === 'old retry then cold File') {
        await expect(fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
          operationId: 'partial-before-human', prompt: 'original payload', allowUncertainTurn: true }))
          .rejects.toMatchObject({ code: 'CTXMUX_input_cursor_mismatch', detail: 'not_applied' })
        const partial = (await store.load())[0] as AgentMuxStoredAgentSession
        expect(partial.promptCompletionAdmission).toEqual(originalClaim)
        expect(partial.terminalPromptSubmission).toMatchObject({ payload: { acknowledged: true },
          submit: { acknowledged: false, notApplied: true } })
        const writes = [...fixture.writes]
        await expect(fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
          operationId: 'partial-before-human', prompt: 'original payload', allowUncertainTurn: true }))
          .rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED' })
        expect(fixture.writes).toEqual(writes)
        successor = (await ingressClient({}, new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), fixture)).client
      }
      const result = await successor.submitAgentPrompt({ ...agentPromptCondition(successor.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
        operationId: 'next-after-human', prompt: 'next payload', allowUncertainTurn: true }).then(() => null, error => error)
      expect(result).toBeNull()
      expect(rejectedSubmit).toBe(1)
      expect(fixture.writes).toEqual(['original payload', '1', 'next payload', '\r'])
      expect(((await fixture.store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission)
        .toMatchObject({ submissionId: 'next-after-human', acknowledged: true })
      expect((await fixture.status()).state).toEqual({ type: 'running' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('keeps an original Native claim unknown when a different incarnation rejects only the retry', async () => {
    const fixture = await ingressClient(), inner = fixture.client as unknown as Internals
    inner.kernel.input = vi.fn().mockRejectedValueOnce(new AgentMuxError('Original Native is pending', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown'))
    await expect(fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'original-owner-pending', prompt: 'original' })).rejects.toThrow('Original Native is pending')
    const originalClaim = ((await fixture.store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission
    const second = await ingressClient({}, fixture.store, fixture), other = second.client as unknown as Internals
    other.kernel.identity = () => ({ daemonInstanceId: 'other-native-owner', protocolVersion: 1, buildIdentity: 'test' })
    other.kernel.input = async (runId: string, operation: Parameters<CtxmuxRunAdapter['input']>[1]) => {
      if (operation.ownerInstanceId !== 'other-native-owner') {
        throw new AgentMuxError('Another Native owner cannot confirm the original input', 'CTXMUX_invalid_operation', 'not_applied')
      }
      return await fixture.input(runId, operation)
    }
    await expect(second.client.submitAgentPrompt({ ...agentPromptCondition(second.client.agentSession(AGENT_SESSION_ID)), agentSessionId: AGENT_SESSION_ID,
      operationId: 'new-after-owner-change', prompt: 'next', allowUncertainTurn: true }))
      .rejects.toMatchObject({ code: 'CTXMUX_invalid_operation', detail: 'not_applied' })
    expect(((await fixture.store.load())[0] as AgentMuxStoredAgentSession).promptCompletionAdmission).toEqual(originalClaim)
    expect(second.client.agentSession(AGENT_SESSION_ID).terminalPromptDelivery).toMatchObject({ reason: 'input-unconfirmed' })
    await second.client.writeAgent({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, source: 'user', data: 'healthy raw' })
    expect(fixture.writes).toEqual(['healthy raw'])
  })

  it('does not accept a prompt for a Run that has exited before delivery', async () => {
    const fixture = await ingressClient()
    fixture.setRunState('exited')
    await expect(fixture.client.submitAgentPrompt({ ...agentPromptCondition(fixture.client.agentSession(AGENT_SESSION_ID)),
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-dead',
      prompt: 'too late'
    })).rejects.toBeInstanceOf(AgentMuxError)
    // MUTATION: remove the `run.state.type !== 'running'` check in serializeAgentInput (client.ts:3691) —
    // the write goes through → writes non-empty → red.
    expect(fixture.writes).toEqual([])
  })
})

describe('the trap: delivery-consumer ack and harness-consumed are two facts, never merged', () => {
  // FACT A — a reader confirming it RECEIVED a batch. This advances only that consumer's cursor; the
  // message's own state does not change. (agent-delivery-queue.ts header: 收到 ≠ 接受.)
  it('ackDeliveryBatch advances a consumer cursor without asserting the harness accepted anything', () => {
    const queue: DeliveryQueue = { pending: ['d1', 'd2'], consumers: {} }
    const batch = checkDeliveries(queue, 'reader-1', 2)
    const acked = ackDeliveryBatch(batch.queue, 'reader-1', batch.generation)
    expect(acked.consumers['reader-1']).toMatchObject({ acked: 2, inFlight: 0 })
    // The queue exposes NO 'accepted'/'replied' vocabulary — ack cannot express harness consumption.
    // MUTATION: if someone folds AgentDeliveryState into this module (e.g. ack returns { state:'accepted' }),
    // this shape check breaks — the two owners would have been merged.
    expect(acked).not.toHaveProperty('state')
    expect(Object.keys(acked)).toEqual(['pending', 'consumers'])
  })

  // FACT B — the harness actually acting on the prompt. Reaching 'accepted'/'replied' is a DIFFERENT owner
  // (agent-message.ts) and needs Hook/ACP/native receipt evidence; a mere delivery is at most 'delivered'.
  it('advanceDelivery keeps delivered distinct from accepted/replied and forbids reviving a terminal state', () => {
    const thread = createThread({
      threadId: 'th-1',
      authorAgentSessionId: 'agent-a',
      targetAgentSessionId: 'agent-b',
      workspacePath: WORKSPACE,
      body: 'please review',
      operationId: 'op-1',
      createdAt: 1000
    })
    expect(thread.delivery.state).toBe('queued')
    const delivered = advanceDelivery(thread.delivery, 'delivered', 1001)
    expect(delivered.state).toBe('delivered')
    const accepted = advanceDelivery(delivered, 'accepted', 1002)
    const replied = advanceDelivery(accepted, 'replied', 1003)
    expect(replied.state).toBe('replied')
    // 'delivered' is NOT 'accepted' — the evidence tier the whole feature protects.
    expect(delivered.state).not.toBe(accepted.state)
    // A terminal state has no successors: a late "the reader got it" cannot reopen a replied prompt.
    // MUTATION: add any state to NEXT.replied in agent-message.ts — this throw stops firing → red.
    expect(() => advanceDelivery(replied, 'accepted', 1004)).toThrow(AgentMuxError)
  })

  it('the two facts do not share a state vocabulary — a queue cursor is numeric, a ledger state is a tag', () => {
    // If the two owners were unified, one of these shapes would have to change to match the other. They
    // deliberately do not: ConsumerCursor counts positions; AgentDeliveryState names an evidence tier.
    const cursor = checkDeliveries({ pending: ['d1'], consumers: {} }, 'r', 1)
    expect(typeof cursor.queue.consumers['r']!.acked).toBe('number')
    const delivered = advanceDelivery(
      createThread({
        threadId: 't', authorAgentSessionId: 'a', targetAgentSessionId: 'b',
        workspacePath: WORKSPACE, body: 'x', operationId: 'o', createdAt: 1
      }).delivery,
      'delivered',
      2
    )
    expect(typeof delivered.state).toBe('string')
  })
})
