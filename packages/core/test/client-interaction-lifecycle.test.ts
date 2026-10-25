import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withInteractionOperation } from './fixtures/interaction-client.js'
import { fixtureEpoch as _liveTailFixtureEpoch } from "./helpers/fixture-values.js"
import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore, loadAgentSessions, normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import type {
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxStoredAgentSession
} from '../src/types.js'

/**
 * Public Client lifecycle behavior complements the Provider's response-plan contract.
 * Kernel input is synthetic; Store, Provider planning, identity admission, durable claim
 * and settlement are real. These tests do not prove upstream CLI completion or ctxmux dedup.
 * See docs/reviews/typed-interaction-lifecycle-gate-review-.md for gate scope.
 */

const RUN_ID = 'lifecycle-run'
const AGENT_SESSION_ID = 'lifecycle-agent'

function storedSession(pending?: AgentMuxInteractionRequest, providerId: 'codex' | 'claude' = 'codex'): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: AGENT_SESSION_ID,
    providerId,
    executorId: providerId,
    hostId: 'local',
    workspacePath: fixturePath("tmp/lifecycle-agent"),
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-lifecycle',
    hookToken: 'token-lifecycle',

    createdAt: 100,
    updatedAt: 100,
    ...(pending ? { pendingInteraction: { request: pending } } : {})
  } as AgentMuxStoredAgentSession
}

/** 一个 native-hook 的 permission request，绑在本 Session 的当前 Run 上。 */
function permission(id: string): Extract<AgentMuxInteractionRequest, { kind: 'permission' }> {
  return {
    kind: 'permission',
    id,
    agentSessionId: AGENT_SESSION_ID,
    title: 'Allow Edit?',
    nativeToolCallId: `lifecycle-call-${id}`,
    toolName: 'exec_command', toolInput: '{"cmd":"printf lifecycle"}',
    options: [
      { id: 'allow-once', label: 'Allow once', kind: 'allow-once' },
      { id: 'reject-once', label: 'Reject', kind: 'reject-once' }
    ],
    evidence: { source: 'native-hook', observedAt: 1, run: { runId: RUN_ID }, hookReceiptId: id }
  }
}

function runProjection(acceptedInputBytes: number | null) {
  return {
    nativeService: null,
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'codex',
    args: [] as string[],
    cwd: fixturePath("tmp/lifecycle-agent"),
    env: {},
    workspacePath: fixturePath("tmp/lifecycle-agent"),
    pid: 999,
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
  registry: { load(hostId: string): Promise<void> }
}

async function connectedClient(pending?: AgentMuxInteractionRequest, providerId: 'codex' | 'claude' = 'codex', nativeSessionId?: string,
  existingStore?: AgentMuxMemoryAgentSessionStore): Promise<{
  client: AgentMuxClient
  writes: string[]
  store: AgentMuxMemoryAgentSessionStore
  state: Internals
}> {
  const store = existingStore ?? new AgentMuxMemoryAgentSessionStore()
  const original = storedSession(pending, providerId)
  original.nativeHandle = { kind: 'provider', providerId, sessionId: nativeSessionId ?? 'lifecycle-native' }
  if (!existingStore) await store.compareAndSwap(null, original)
  const client = new AgentMuxClient({ store })
  const state = client as unknown as Internals
  await state.registry.load('local')

  let cursor = 0
  const writes: string[] = []
  state.kernel.isConnected = () => true
  state.kernel.identity = () => ({ daemonInstanceId: 'daemon-1', protocolVersion: 1, buildIdentity: 'test' })
  state.kernel.status = async () => runProjection(cursor)
  state.kernel.input = async (_runId: string, operation: { expectedByte: number; data: string }) => {
    writes.push(operation.data)
    cursor = operation.expectedByte + Buffer.byteLength(operation.data)
    return { run: runProjection(cursor), appliedByteRange: { startByte: operation.expectedByte, endByte: cursor } }
  }
  // Raw input now opens the same ordered channel before writing. Keep that Runtime
  // seam synthetic while delegating to the test's original write/ACK implementation.
  state.kernel.openInput = async () => ({ run: runProjection(cursor), waitWritable: async () => {},
    input: async (data: string) => await (state.kernel.input as (_id: string, operation: { expectedByte: number; data: string }) => Promise<unknown>)(
      RUN_ID, { expectedByte: cursor, data }) })
  ;(client as unknown as { connected: boolean }).connected = true
  return { client, writes, store, state }
}

/** Real Core Hook completion owner, synthetic authenticated envelope in this unit fixture. */
async function completeNativeRequest(client: AgentMuxClient): Promise<void> {
  const request = client.agentSession(AGENT_SESSION_ID).pendingInteraction!.request
  await (client as unknown as { acceptHookEvent(envelope: import('../src/types.js').NativeHookEnvelope, signal: AbortSignal): Promise<void> }).acceptHookEvent({
    receiptId: 'lifecycle-completed-' + request.id, agentSessionId: AGENT_SESSION_ID,
    providerId: client.agentSession(AGENT_SESSION_ID).providerId, runId: RUN_ID,
    payload: { session_id: client.agentSession(AGENT_SESSION_ID).nativeHandle?.sessionId, hook_event_name: 'PostToolUse', tool_name: request.kind === 'question' ? 'request_user_input' : 'exec_command',
      tool_call_id: request.nativeToolCallId }
  }, new AbortController().signal)
}

describe('respondAgentInteraction: the answer must bind to this Session/Run/request', () => {
  it.each([undefined, 'unspecified'])('rejects an undeclared input source (%s) without guessing or writing', async source => {
    const h = await connectedClient(permission('source-required'))
    try {
      await expect(h.client.writeAgent({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, data: '1', source: source as never }))
        .rejects.toMatchObject({ code: 'INVALID_AGENT_INPUT_SOURCE' })
      expect(h.writes).toEqual([])
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toEqual({ request: permission('source-required') })
    } finally { await h.client.dispose() }
  })

  it('native user input and protocol replies remain usable without approving or clearing the request', async () => {
    const { client, writes, store } = await connectedClient(permission('native-pending'))
    try {
      await client.writeAgent({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, source: 'terminal-protocol', data: '\u001b[0n' })
      await client.writeAgent({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, source: 'user', data: '\u001b' })
      expect(writes).toEqual(['\u001b[0n', '\u001b'])
      expect((await loadAgentSessions(store))[0]!.pendingInteraction).toMatchObject({ request: permission('native-pending'), nativeInput: { delivery: 'accepted' } })
    } finally { await client.dispose() }
  })

  it('a prior native terminal cannot redirect input to this Session after the Run changed', async () => {
    const { client, writes, store } = await connectedClient(permission('native-pending'))
    try {
      await expect(client.writeAgent({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: 'old-run' }, source: 'user', data: '1' }))
        .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
      expect(writes).toEqual([])
      expect((await loadAgentSessions(store))[0]!.pendingInteraction?.request.id).toBe('native-pending')
    } finally { await client.dispose() }
  })

  it('keeps a terminal-only request and directs its answer to the original terminal without bytes', async () => {
    const { client, writes } = await connectedClient(permission('rcpt-1'))
    try {
      await expect(client.respondAgentInteraction(withInteractionOperation(client, { agentSessionId: AGENT_SESSION_ID,
        expectedRun: { runId: RUN_ID }, response: { kind: 'permission', requestId: 'rcpt-1', decision: { outcome: 'selected', optionId: 'allow-once' } } })))
        .rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(writes).toEqual([])
      expect(client.agentSession(AGENT_SESSION_ID).pendingInteraction).toEqual({ request: permission('rcpt-1') })
    } finally { await client.dispose() }
  })

  it('refuses an answer aimed at a stale Run — a prior turn cannot answer for the current one', async () => {
    const { client, writes } = await connectedClient(permission('rcpt-1'))

    const error = await client.respondAgentInteraction(withInteractionOperation(client, {
      agentSessionId: AGENT_SESSION_ID,
      expectedRun: { runId: 'a-different-run' },
      response: { kind: 'permission', requestId: 'rcpt-1', decision: { outcome: 'selected', optionId: 'allow-once' } }
    })).then(() => null, (caught: unknown) => caught)

    expect(error, 'a stale-Run answer was accepted').toBeInstanceOf(AgentMuxError)
    expect((error as AgentMuxError).code).toBe('STALE_AGENT_SESSION')
    // 拒绝必须发生在任何 PTY 写入之前，且不动 pending：这是原则 11 第 2 类的反面——
    // 我们不确定它对，就不落地，而不是先写下去再说。
    expect(writes, 'a stale-Run answer still wrote to the PTY').toEqual([])
    expect(client.agentSessions()[0]!.pendingInteraction?.request.id, 'a rejected answer disturbed the pending interaction').toBe('rcpt-1')
    await client.dispose()
  })

  it('refuses an answer when nothing is pending — an unknown request is not answerable', async () => {
    const { client, writes } = await connectedClient(/* no pending interaction */)

    const error = await client.respondAgentInteraction(withInteractionOperation(client, {
      agentSessionId: AGENT_SESSION_ID,
      expectedRun: { runId: RUN_ID },
      response: { kind: 'permission', requestId: 'rcpt-1', decision: { outcome: 'selected', optionId: 'allow-once' } }
    })).then(() => null, (caught: unknown) => caught)

    expect(error, 'an answer with no pending interaction was accepted').toBeInstanceOf(AgentMuxError)
    expect((error as AgentMuxError).code).toBe('UNKNOWN_AGENT_INTERACTION')
    expect(writes, 'answering nothing still wrote to the PTY').toEqual([])
    await client.dispose()
  })

  it('refuses an answer for a superseded request — a newer interaction replaced the one being answered', async () => {
    // 关键的一条：pending 已经是 rcpt-2（新交互替换了旧的），而回答冲着 rcpt-1（旧的）来。
    // Client 必须给出 UNKNOWN_AGENT_INTERACTION 并保留当前请求；Provider 自己也有
    // response/request 配对校验，故删掉 Client 闸门并不必然导致错误字节写入。
    const { client, writes } = await connectedClient(permission('rcpt-2'))

    const error = await client.respondAgentInteraction(withInteractionOperation(client, {
      agentSessionId: AGENT_SESSION_ID,
      expectedRun: { runId: RUN_ID },
      response: { kind: 'permission', requestId: 'rcpt-1', decision: { outcome: 'selected', optionId: 'allow-once' } }
    })).then(() => null, (caught: unknown) => caught)

    expect(error, 'an answer for a superseded request was accepted').toBeInstanceOf(AgentMuxError)
    expect((error as AgentMuxError).code).toBe('UNKNOWN_AGENT_INTERACTION')
    expect(writes, 'a superseded answer still wrote to the PTY').toEqual([])
    // 新交互原样留着：一次答错的旧回答绝不能把当前在等的这个清掉。
    expect(client.agentSessions()[0]!.pendingInteraction?.request.id, 'the superseding interaction was disturbed').toBe('rcpt-2')
    await client.dispose()
  })
})


function answer(requestId: string, optionId = 'reject-once'): AgentMuxInteractionResponse {
  return { kind: 'permission', requestId, decision: { outcome: 'selected', optionId } }
}

// Frozen receipt reconciliation is exercised through the public owner in terminal-interaction-retirement.test.ts.

const nativeWrite = (source: 'user' | 'terminal-protocol' = 'user') => ({
  agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, source, data: '\u001b'
})

describe('native input keeps one durable, unconfirmed request owner', () => {
  it('automatic terminal replies leave the typed response available', async () => {
    const h = await connectedClient(permission('protocol-pending'))
    try {
      await h.client.writeAgent(nativeWrite('terminal-protocol'))
      expect((await loadAgentSessions(h.store))[0]!.pendingInteraction).toEqual({ request: permission('protocol-pending') })
      await expect(h.client.respondAgentInteraction(withInteractionOperation(h.client, { agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, response: answer('protocol-pending') })))
        .rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(h.writes).toEqual(['\u001b'])
    } finally { await h.client.dispose() }
  })

  it('persists uncertainty before native bytes and rejects stale typed answers from another Client', async () => {
    const h = await connectedClient(permission('native-shared'))
    const second = new AgentMuxClient({ store: h.store })
    const owner = second as unknown as Internals
    await owner.registry.load('local'); owner.kernel = h.state.kernel
    ;(second as unknown as { connected: boolean }).connected = true
    const original = h.state.kernel.input as (runId: string, input: unknown) => Promise<unknown>
    let beforeInput: unknown
    h.state.kernel.input = async (runId: string, input: unknown) => {
      beforeInput = (await loadAgentSessions(h.store))[0]!.pendingInteraction?.nativeInput
      return await original(runId, input)
    }
    try {
      await h.client.writeAgent(nativeWrite())
      expect(beforeInput).toMatchObject({ delivery: 'unknown' })
      const recorded = (await loadAgentSessions(h.store))[0]!.pendingInteraction!
      expect(recorded).toMatchObject({ request: permission('native-shared'), nativeInput: { delivery: 'accepted' } })
      expect(recorded.nativeInput!.operationId.length).toBeGreaterThan(0)
      await expect(second.respondAgentInteraction(withInteractionOperation(second, { agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, response: answer('native-shared', 'allow-once') })))
        .rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      await h.client.writeAgent({ ...nativeWrite(), data: 'z' })
      expect(h.writes).toEqual(['\u001b', 'z'])
      expect((await loadAgentSessions(h.store))[0]!.pendingInteraction).toEqual(recorded)
    } finally { await second.dispose(); await h.client.dispose() }
  })

  it.each(['not_applied', 'unknown'] as const)('%s native delivery never invents a response or retries bytes', async disposition => {
    const h = await connectedClient(permission('native-failure'))
    const original = h.state.kernel.input
    let attempts = 0
    h.state.kernel.input = async () => {
      attempts++
      throw new AgentMuxError('Native receipt unavailable.', 'PRIVATE_INPUT_FAILURE', disposition)
    }
    try {
      await expect(h.client.writeAgent(nativeWrite())).rejects.toMatchObject({ code: 'PRIVATE_INPUT_FAILURE', detail: disposition })
      expect(attempts).toBe(1)
      expect(h.writes).toEqual([])
      const pending = (await loadAgentSessions(h.store))[0]!.pendingInteraction!
      expect(pending.request.id).toBe('native-failure')
      expect(pending.response).toBeUndefined()
      h.state.kernel.input = original
      const respond = () => h.client.respondAgentInteraction(withInteractionOperation(h.client, { agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, response: answer('native-failure') }))
      if (disposition === 'not_applied') {
        expect(pending.nativeInput).toBeUndefined()
        await expect(respond()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
        await h.client.writeAgent({ ...nativeWrite(), data: 'z' })
        expect(h.writes).toEqual(['z'])
      } else {
        expect(pending.nativeInput?.delivery).toBe('unknown')
        await expect(respond()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
        await h.client.writeAgent({ ...nativeWrite(), data: 'z' })
        expect(h.writes).toEqual(['z'])
        expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction!.nativeInput).toEqual(pending.nativeInput)
      }
    } finally { await h.client.dispose() }
  })

  it('keeps empty native input a no-op and leaves the request answerable', async () => {
    const h = await connectedClient(permission('empty-native'))
    try {
      await h.client.writeAgent({ ...nativeWrite(), data: '' })
      expect(h.writes).toEqual([])
      expect((await loadAgentSessions(h.store))[0]!.pendingInteraction).toEqual({ request: permission('empty-native') })
    } finally { await h.client.dispose() }
  })

  it('a Store failure does not prevent native bytes reaching a healthy Run and remains visible', async () => {
    const h = await connectedClient(permission('store-failure'))
    const events: import('../src/types.js').AgentMuxClientEvent[] = []
    h.client.onEvent(event => events.push(event))
    const original = h.store.compareAndSwapMetadata.bind(h.store)
    h.store.compareAndSwapMetadata = async () => { throw new Error('Private Store unavailable') }
    try {
      expect(await h.client.writeAgent(nativeWrite())).toMatchObject({ acceptedThroughByte: 1 })
      expect(h.writes).toEqual(['\u001b'])
      const notices = events.filter(event => event.type === 'agent-error')
      expect(notices.length).toBeGreaterThan(0)
      expect(notices[0]).toMatchObject({ code: 'AGENT_NATIVE_INPUT_PERSIST_FAILED' })
      expect(notices[0]).not.toHaveProperty('agentSessionId')
    } finally { h.store.compareAndSwapMetadata = original; await h.client.dispose() }
  })
})

describe('native takeover during typed recovery', () => {
  it.each(['accepted', 'unknown'] as const)('%s native input preserves the old claim without replay or an invented ACK', async delivery => {
    const h = await connectedClient(permission('takeover'))
    const originalInput = h.state.kernel.input as (runId: string, input: unknown) => Promise<unknown>
    try {
      const original = (await loadAgentSessions(h.store))[0]!
      const claim = { value: answer('takeover'), responseDigest: createHash('sha256').update(JSON.stringify(answer('takeover'))).digest('base64url'),
        operationId: 'original-takeover-response', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false }
      await h.store.compareAndSwapMetadata(original, { ...original, pendingInteraction: { ...original.pendingInteraction!, response: claim } })
      await h.state.registry.load('local')
      h.state.kernel.input = async (runId: string, input: unknown) => {
        const ack = await originalInput(runId, input)
        if (delivery === 'unknown') throw new AgentMuxError('Private native ACK was lost', 'PRIVATE_INPUT_FAILURE', 'unknown')
        return ack
      }
      const native = h.client.writeAgent({ ...nativeWrite(), data: 'z' })
      if (delivery === 'unknown') await expect(native).rejects.toMatchObject({ detail: 'unknown' })
      else await native
      const pending = structuredClone(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction)
      expect(pending).toMatchObject({ response: claim, nativeInput: { delivery } })
      // Direct owner reconciliation isolates the recovery decision with a synthetic byte owner.
      // The private Electron restart proof separately exercises the public connection caller.
      const reconcile = h.client as unknown as { recoverPendingInteractionResponses(runs: ReturnType<typeof runProjection>[]): Promise<void> }
      await reconcile.recoverPendingInteractionResponses([runProjection(1)])
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toEqual(pending)
      expect((await loadAgentSessions(h.store))[0]!.pendingInteraction).toEqual(pending)
      expect(h.writes).toEqual(['z'])
    } finally { h.state.kernel.input = originalInput; await h.client.dispose() }
  })
})

// Prepared for the existing client-interaction-lifecycle.test.ts after approved Tracker admission.
// This fixture uses two actual public Core Clients, one real supported Store and a strict
// synthetic Runtime seam. It does not claim native Provider/PTY completion.
describe('Claude terminal takeover completion', () => {
  const nativeSessionId = 'native-confirmation-owned-source'
  const questionInput = { questions: [1, 2].map(n => ({ question: `Question ${n}?`, header: `Q${n}`,
    options: [{ label: 'A' }, { label: 'B' }] })) }
  const questionHook = (client: AgentMuxClient, receiptId: string, payload: Record<string, unknown> = {}, runId = RUN_ID) =>
    (client as unknown as { acceptHookEvent(envelope: import('../src/types.js').NativeHookEnvelope, signal: AbortSignal): Promise<void> }).acceptHookEvent({
      receiptId, agentSessionId: AGENT_SESSION_ID, providerId: 'claude', runId,
      payload: { session_id: nativeSessionId, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
        tool_use_id: 'native-question-call', tool_input: questionInput, ...payload } }, new AbortController().signal)
  function request(kind: 'permission' | 'question'): AgentMuxInteractionRequest {
    const evidence = { source: 'native-hook' as const, observedAt: 1, run: { runId: RUN_ID }, hookReceiptId: 'original-claude-request' }
    return kind === 'permission'
      ? { ...permission('claude-terminal-permission'), toolName: 'Bash', toolInput: '{"command":"false"}' }
      : { kind: 'question', id: 'claude-terminal-question', agentSessionId: AGENT_SESSION_ID,
          nativeToolCallId: 'claude-terminal-question-call', questions: [{ id: 'q', prompt: 'Choose?', options: [{ id: 'a', label: 'First' }] }], evidence }
  }
  async function complete(client: AgentMuxClient, pending: AgentMuxInteractionRequest, eventName: string, overrides: Record<string, unknown> = {}) {
    return await (client as unknown as { acceptHookEvent(envelope: import('../src/types.js').NativeHookEnvelope, signal: AbortSignal): Promise<void> }).acceptHookEvent({
      receiptId: 'claude-terminal-' + eventName + '-' + pending.id, agentSessionId: AGENT_SESSION_ID, providerId: 'claude', runId: RUN_ID,
      payload: { hook_event_name: eventName, session_id: nativeSessionId, tool_name: pending.kind === 'question' ? 'AskUserQuestion' : 'Bash',
        tool_use_id: pending.nativeToolCallId, ...(eventName === 'PostToolUseFailure' ? { error: 'Private executed tool failed' } : { tool_response: 'Private completed result' }), ...overrides }
    }, new AbortController().signal)
  }
  it.each(['permission', 'question'] as const)('settles the original %s after accepted native input and exact failed-tool completion', async kind => {
    const pending = request(kind), h = await connectedClient(pending, 'claude', nativeSessionId)
    const events: import('../src/types.js').AgentMuxClientEvent[] = []
    h.client.onEvent(event => events.push(event))
    try {
      await h.client.writeAgent(nativeWrite())
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toMatchObject({ request: { id: pending.id }, nativeInput: { delivery: 'accepted' } })
      await complete(h.client, pending, 'PostToolUseFailure')
      const current = h.client.agentSession(AGENT_SESSION_ID)
      expect(current.pendingInteraction).toBeUndefined()
      expect(current.nativeHandle?.sessionId).toBe(nativeSessionId)
      expect(current.run.runId).toBe(RUN_ID)
      expect(current.hookReceipt?.eventName).toBe('PostToolUseFailure')
      expect((await loadAgentSessions(h.store))[0]!.pendingInteraction).toBeUndefined()
      expect(events.some(event => event.type === 'agent-session' && !event.session.pendingInteraction && event.session.run.runId === RUN_ID)).toBe(true)
      expect(h.writes).toEqual(['\u001b'])
    } finally { await h.client.dispose() }
  })
  it('retains success completion after native takeover without writing a second answer', async () => {
    const pending = request('permission'), h = await connectedClient(pending, 'claude', nativeSessionId)
    try {
      await h.client.writeAgent(nativeWrite())
      await complete(h.client, pending, 'PostToolUse')
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toBeUndefined()
      expect(h.writes).toEqual(['\u001b'])
    } finally { await h.client.dispose() }
  })
  it.each(['foreign-source', 'wrong-call', 'wrong-kind', 'child'] as const)('keeps the current request when failed-tool completion belongs to %s', async changed => {
    const pending = request('permission'), h = await connectedClient(pending, 'claude', nativeSessionId)
    try {
      const overrides = changed === 'foreign-source' ? { session_id: 'foreign-native-source' }
        : changed === 'wrong-call' ? { tool_use_id: 'another-native-call' }
        : changed === 'wrong-kind' ? { tool_name: 'AskUserQuestion' } : { agent_id: 'a-child' }
      await complete(h.client, pending, 'PostToolUseFailure', overrides)
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.request.id).toBe(pending.id)
      expect(h.writes).toEqual([])
    } finally { await h.client.dispose() }
  })
  // A question answered in the native terminal: Claude announces it with PreToolUse (which carries
  // tool_use_id) and settles it with PostToolUse for that same call. No AgentMux reply is involved.
  it.each(['PostToolUse', 'PostToolUseFailure'])('settles duplicate native question reports by their own %s after a terminal answer', async eventName => {
    const h = await connectedClient(undefined, 'claude', nativeSessionId)
    const events: import('../src/types.js').AgentMuxClientEvent[] = []
    h.client.onEvent(event => events.push(event))
    try {
      await questionHook(h.client, 'native-question-asked')
      // Claude runs every matching PreToolUse hook for the same call; the duplicate is the same question.
      await expect(questionHook(h.client, 'native-question-asked-again')).resolves.toBeUndefined()
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.request).toMatchObject({
        kind: 'question', id: 'native-question-asked', nativeToolCallId: 'native-question-call' })
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.additionalRequests).toBeUndefined()
      expect(events.filter(event => event.type === 'interaction').map(event => event.request.id))
        .toEqual(['native-question-asked', 'native-question-asked'])
      await questionHook(h.client, 'native-question-answered', { hook_event_name: eventName, tool_response: questionInput })
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toBeUndefined()
      expect((await loadAgentSessions(h.store))[0]!.pendingInteraction).toBeUndefined()
      expect(h.writes).toEqual([])
    } finally { await h.client.dispose() }
  })

  it('deduplicates an additional question while preserving a different kind with the same call id', async () => {
    const original = { ...request('permission'), nativeToolCallId: 'native-question-call' }
    const h = await connectedClient(original, 'claude', nativeSessionId)
    try {
      await questionHook(h.client, 'additional-question')
      await expect(questionHook(h.client, 'additional-question-again')).resolves.toBeUndefined()
      const pending = h.client.agentSession(AGENT_SESSION_ID).pendingInteraction!
      expect(pending.request).toEqual(original)
      expect(pending.additionalRequests).toHaveLength(1)
      expect(pending.additionalRequests![0]).toMatchObject({ kind: 'question', id: 'additional-question', nativeToolCallId: 'native-question-call' })
      await questionHook(h.client, 'additional-question-complete', { hook_event_name: 'PostToolUse' })
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toEqual({ request: original })
      expect(h.writes).toEqual([])
    } finally { await h.client.dispose() }
  })

  it('preserves a different call when original completion repeats after the next question is promoted', async () => {
    const h = await connectedClient(undefined, 'claude', nativeSessionId)
    try {
      await questionHook(h.client, 'first-question')
      await questionHook(h.client, 'second-question', { tool_use_id: 'second-native-call' })
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.additionalRequests).toHaveLength(1)
      await questionHook(h.client, 'first-complete', { hook_event_name: 'PostToolUse' })
      const promoted = structuredClone(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction)
      expect(promoted?.request).toMatchObject({ id: 'second-question', nativeToolCallId: 'second-native-call' })
      await questionHook(h.client, 'first-complete-again', { hook_event_name: 'PostToolUse' })
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toEqual(promoted)
      await questionHook(h.client, 'second-complete', { hook_event_name: 'PostToolUse', tool_use_id: 'second-native-call' })
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toBeUndefined()
      expect(h.writes).toEqual([])
    } finally { await h.client.dispose() }
  })

  it.each([false, true])('settles retained duplicate receipts while preserving the original unsettled response (%s)', async hasResponse => {
    const primary = request('question'), h = await connectedClient(primary, 'claude', nativeSessionId)
    const copy = (id: string) => ({ ...primary, id, evidence: { ...primary.evidence, hookReceiptId: id } })
    const other = { ...copy('retained-other'), nativeToolCallId: 'retained-other-call' }
    const value: AgentMuxInteractionResponse = { kind: 'question', requestId: primary.id, outcome: 'answered',
      answers: [{ questionId: 'q', optionId: 'a' }] }
    const response = { value, responseDigest: createHash('sha256').update(JSON.stringify(value)).digest('base64url'),
      operationId: 'original-question-response', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false }
    try {
      const stored = (await loadAgentSessions(h.store))[0]!
      await h.store.compareAndSwapMetadata(stored, { ...stored, pendingInteraction: { request: primary,
        additionalRequests: [copy('retained-copy-one'), other, copy('retained-copy-two')], ...(hasResponse ? { response } : {}) } })
      await h.state.registry.load('local')
      await complete(h.client, primary, 'PostToolUse')
      const pending = h.client.agentSession(AGENT_SESSION_ID).pendingInteraction!
      if (hasResponse) {
        expect(pending.request).toEqual(primary)
        expect(pending.response).toEqual(response)
        expect(pending.nativeCompleted?.hookReceiptId).toBe('claude-terminal-PostToolUse-' + primary.id)
        expect(pending.additionalRequests).toEqual([other])
      } else expect(pending).toEqual({ request: other })
      expect((await loadAgentSessions(h.store))[0]!.pendingInteraction).toEqual(pending)
      expect(h.writes).toEqual([])
    } finally { await h.client.dispose() }
  })

  it.each(['foreign-source', 'child', 'old-run'] as const)('does not admit a same-call report belonging to %s', async changed => {
    const h = await connectedClient(undefined, 'claude', nativeSessionId)
    try {
      await questionHook(h.client, 'original-question')
      const original = structuredClone(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction)
      await questionHook(h.client, 'unrelated-question', changed === 'foreign-source' ? { session_id: 'another-source' }
        : changed === 'child' ? { agent_id: 'a-child' } : {}, changed === 'old-run' ? 'old-run' : RUN_ID)
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toEqual(original)
      expect(h.writes).toEqual([])
    } finally { await h.client.dispose() }
  })

  it.each([true, false])('settles only the matching request admitted before a completion CAS retry (same call: %s)', async sameCall => {
    const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-interaction-cas-'))
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(privateRoot, 'messages.ndjson'))
    vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(privateRoot, 'state'))
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(privateRoot, 'runtime'))
    try {
      const reader = await connectedClient(undefined, 'claude', nativeSessionId)
      const writer = await connectedClient(undefined, 'claude', nativeSessionId, reader.store)
      const completionReceipt = 'completion-before-concurrent-request'
      const compare = reader.store.compareAndSwapMetadata.bind(reader.store)
      const reload = vi.spyOn(reader.state.registry, 'load')
      let inserted = false, attempts = 0, stale = 0
      const exchange = vi.spyOn(reader.store, 'compareAndSwapMetadata').mockImplementation(async (previous, next, signal) => {
        if (next?.hookReceipt?.id === completionReceipt) {
          attempts++
          if (!inserted) {
            inserted = true
            await questionHook(writer.client, 'concurrent-question', {
              tool_use_id: sameCall ? 'native-question-call' : 'another-native-call'
            })
          }
        }
        try { return await compare(previous, next, signal) }
        catch (error) {
          if (error instanceof AgentMuxError && error.code === 'STALE_AGENT_SESSION') stale++
          throw error
        }
      })
      const provider = reader.client.providers.get('claude'), plan = provider.planPromptInput
      provider.planPromptInput = prompt => ({ kind: 'single-phase', data: prompt + '\r' })
      try {
        await questionHook(reader.client, completionReceipt, { hook_event_name: 'PostToolUse' })
        expect(inserted).toBe(true)
        // Activity publication may commit metadata too; the completion must at least retry its real CAS.
        expect(attempts).toBeGreaterThanOrEqual(2)
        expect(stale).toBe(1)
        expect(reload).toHaveBeenCalledTimes(1)
        const stored = (await loadAgentSessions(reader.store))[0]!
        expect(stored.nativeInteractionEnds?.calls[JSON.stringify(['question', 'native-question-call'])])
          .toMatchObject({ hookReceiptId: completionReceipt })
        const submit = () => reader.client.submitAgentPrompt({ agentSessionId: AGENT_SESSION_ID,
          operationId: 'explicit-prompt-after-cas', expectedRun: { runId: RUN_ID }, afterSubmissionId: null,
          prompt: 'Continue', execution: 'default', allowUncertainTurn: true })
        if (sameCall) {
          expect(stored.pendingInteraction).toBeUndefined()
          await submit()
          expect(reader.writes).toEqual(['Continue\r'])
        } else {
          expect(stored.pendingInteraction?.request).toMatchObject({
            id: 'concurrent-question', nativeToolCallId: 'another-native-call'
          })
          await expect(submit()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
          expect(reader.writes).toEqual([])
        }
        expect(writer.writes).toEqual([])
        expect(reader.client.agentSession(AGENT_SESSION_ID)).toMatchObject({ agentSessionId: AGENT_SESSION_ID, run: { runId: RUN_ID } })
      } finally {
        provider.planPromptInput = plan
        exchange.mockRestore(); reload.mockRestore()
        await writer.client.dispose(); await reader.client.dispose()
      }
    } finally {
      vi.unstubAllEnvs()
      await rm(privateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it('keeps two reports without a native call identity unconfirmed instead of merging by question text', async () => {
    const h = await connectedClient(undefined, 'claude', nativeSessionId)
    try {
      await questionHook(h.client, 'unconfirmed-first', { tool_use_id: undefined })
      await questionHook(h.client, 'unconfirmed-second', { tool_use_id: undefined })
      const pending = h.client.agentSession(AGENT_SESSION_ID).pendingInteraction!
      expect(pending.request).toMatchObject({ id: 'unconfirmed-first' })
      expect(pending.request.nativeToolCallId).toBeUndefined()
      expect(pending.additionalRequests).toHaveLength(1)
      expect(pending.additionalRequests![0]!.id).toBe('unconfirmed-second')
      expect(h.writes).toEqual([])
    } finally { await h.client.dispose() }
  })

  it.each(['completion-first', 'completed-then-duplicate'] as const)('does not reopen a completed native question after Client reconstruction (%s)', async order => {
    const h = await connectedClient(undefined, 'claude', nativeSessionId)
    try {
      if (order === 'completed-then-duplicate') await questionHook(h.client, 'original-before-end')
      await questionHook(h.client, 'original-end', { hook_event_name: 'PostToolUse' })
      const stored = (await loadAgentSessions(h.store))[0]!
      expect(stored.pendingInteraction).toBeUndefined()
      expect(stored.nativeInteractionEnds?.calls[JSON.stringify(['question', 'native-question-call'])])
        .toMatchObject({ kind: 'question', nativeToolCallId: 'native-question-call', hookReceiptId: 'original-end' })
      expect(normalizeStoredAgentSession(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
      expect(h.client.agentSession(AGENT_SESSION_ID)).not.toHaveProperty('nativeInteractionEnds')
      const reopened = await connectedClient(undefined, 'claude', nativeSessionId, h.store)
      const events: import('../src/types.js').AgentMuxClientEvent[] = []
      reopened.client.onEvent(event => events.push(event))
      try {
        const status = reopened.client.agentSession(AGENT_SESSION_ID).semanticStatus
        await expect(questionHook(reopened.client, 'late-report')).resolves.toBeUndefined()
        const current = reopened.client.agentSession(AGENT_SESSION_ID)
        expect(current.pendingInteraction).toBeUndefined()
        expect(current.semanticStatus).toEqual(status)
        expect(current.hookReceipt).toMatchObject({ id: 'late-report', decision: { activityApplied: false, lifecycleApplied: false } })
        expect(events.filter(event => event.type === 'interaction')).toEqual([])
        expect((await loadAgentSessions(h.store))[0]!.nativeInteractionEnds).toEqual(stored.nativeInteractionEnds)
        await questionHook(reopened.client, 'new-question', { tool_use_id: 'new-native-call' })
        expect(reopened.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.request.id).toBe('new-question')
        expect(reopened.writes).toEqual([])
      } finally { await reopened.client.dispose() }
    } finally { await h.client.dispose() }
  })

  it.each(['foreign-source', 'child', 'unknown-source', 'old-run'] as const)('an interaction completion from %s cannot suppress a current question', async changed => {
    const h = await connectedClient(undefined, 'claude', nativeSessionId)
    try {
      await questionHook(h.client, 'unqualified-end', { hook_event_name: 'PostToolUse',
        ...(changed === 'foreign-source' ? { session_id: 'foreign' } : changed === 'child' ? { agent_id: 'a-child' }
          : changed === 'unknown-source' ? { session_id: undefined } : {}) }, changed === 'old-run' ? 'old-run' : RUN_ID)
      expect((await loadAgentSessions(h.store))[0]!.nativeInteractionEnds).toBeUndefined()
      await questionHook(h.client, 'current-question')
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.request.id).toBe('current-question')
      expect(h.writes).toEqual([])
    } finally { await h.client.dispose() }
  })

  it('does not retain ordinary tool completions as interaction end records', async () => {
    const h = await connectedClient(undefined, 'claude', nativeSessionId)
    try {
      await questionHook(h.client, 'ordinary-tool-end', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'true' } })
      expect((await loadAgentSessions(h.store))[0]!.nativeInteractionEnds).toBeUndefined()
    } finally { await h.client.dispose() }
  })

  it.each(['run', 'source', 'kind'] as const)('does not borrow a retained interaction end from another %s', async changed => {
    const h = await connectedClient(undefined, 'claude', nativeSessionId)
    try {
      await questionHook(h.client, 'scoped-end', { hook_event_name: 'PostToolUse' })
      const stored = (await loadAgentSessions(h.store))[0]!, original = stored.nativeInteractionEnds!
      const fact = Object.values(original.calls)[0]!
      const ends = changed === 'run' ? { ...original, run: { runId: 'previous-run' } }
        : changed === 'source' ? { ...original, nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'previous-native-source' } }
        : { ...original, calls: { [JSON.stringify(['permission', fact.nativeToolCallId])]: { ...fact, kind: 'permission' as const } } }
      await h.store.compareAndSwapMetadata(stored, { ...stored, nativeInteractionEnds: ends })
      await h.state.registry.load('local')
      await questionHook(h.client, 'current-request')
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.request.id).toBe('current-request')
    } finally { await h.client.dispose() }
  })

  it('validates private native interaction completion identities and exact source fields on storage read', async () => {
    const h = await connectedClient(undefined, 'claude', nativeSessionId)
    try {
      await questionHook(h.client, 'end-for-store', { hook_event_name: 'PostToolUse' })
      const stored = (await loadAgentSessions(h.store))[0]!, ends = stored.nativeInteractionEnds!
      for (const invalid of [
        { ...ends, surprise: true }, { ...ends, run: { ...ends.run, surprise: true } },
        { ...ends, nativeHandle: { ...ends.nativeHandle, surprise: true } }, { ...ends, providerId: 'different' },
        { ...ends, calls: { badKey: Object.values(ends.calls)[0] } },
        { ...ends, calls: { [JSON.stringify(['question', 'native-question-call'])]: { ...Object.values(ends.calls)[0], observedAt: -1 } } }
      ]) expect(() => normalizeStoredAgentSession({ ...stored, nativeInteractionEnds: invalid })).toThrow()
    } finally { await h.client.dispose() }
  })


})

it('preserves one exact durable request when a cold terminal-only answer has no responder', async () => {
  const h = await connectedClient(permission('cold-exact'))
  const registry = Reflect.get(h.client, 'registry') as { sessions: Map<string, unknown> }
  registry.sessions.clear()
  try {
    const result = await h.client.respondAgentInteraction(withInteractionOperation(h.client, { agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID },
      response: { kind: 'permission', requestId: 'cold-exact', decision: { outcome: 'selected', optionId: 'allow-once' } } })).then(() => null, error => error)
    expect(result).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
    expect(h.writes).toEqual([])
    expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.response).toBeUndefined()
  } finally { await h.client.dispose() }
})


it.each(['connect', 'author'])('does not apply an old ACP choice to a replacement original binding across %s', async phase => {
  const { nativeToolCallId: _unused, ...original } = permission('reused-request-id')
  const request = { ...original, evidence: { source: 'acp' as const, run: { runId: RUN_ID }, observedAt: _liveTailFixtureEpoch(0, 0, 1), acpAdapterId: 'original-adapter', acpSessionId: 'original-session' } }
  const h = await connectedClient(request)
  const before = (await h.store.readMetadata(AGENT_SESSION_ID))!
  await h.store.compareAndSwapMetadata(before, { ...before, nativeHandle: { kind: 'acp', adapterId: 'original-adapter', sessionId: 'original-session' } })
  await h.state.registry.load('local')
  const acp = Reflect.get(h.client, 'acp') as { respondPermission: (...args: unknown[]) => Promise<void> }
  const respond = vi.spyOn(acp, 'respondPermission').mockResolvedValue()
  const replace = async () => {
    const previous = (await h.store.readMetadata(AGENT_SESSION_ID))!
    const run = { runId: phase === 'connect' ? 'replacement-run' : RUN_ID }
    await h.store.compareAndSwapMetadata(previous, { ...previous, run,
      nativeHandle: { kind: 'acp', adapterId: 'replacement-adapter', sessionId: 'replacement-session' },
      pendingInteraction: { request: { ...request, evidence: { ...request.evidence, run, acpSessionId: 'replacement-session' } } } })
    await h.state.registry.load('local')
  }
  vi.spyOn(h.client, 'connect').mockImplementation(async () => { if (phase === 'connect') await replace() })
  try {
    const result = await h.client.respondAgentInteraction(withInteractionOperation(h.client, { agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID },
      response: { kind: 'permission', requestId: request.id, decision: { outcome: 'selected', optionId: 'allow-once' } } }),
      { assertCurrent: async () => { if (phase === 'author') await replace() } }).then(() => null, error => error)
    expect(result).toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(respond).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
  } finally { vi.restoreAllMocks(); await h.client.dispose() }
})
