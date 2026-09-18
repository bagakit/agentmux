import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
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
 * See docs/reviews/typed-interaction-lifecycle-gate-review-2026-10-02.md for gate scope.
 */

const RUN_ID = 'lifecycle-run'
const AGENT_SESSION_ID = 'lifecycle-agent'

function storedSession(pending?: AgentMuxInteractionRequest): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: AGENT_SESSION_ID,
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/lifecycle-agent',
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
function permission(id: string): AgentMuxInteractionRequest {
  return {
    kind: 'permission',
    id,
    agentSessionId: AGENT_SESSION_ID,
    title: 'Allow Edit?',
    options: [
      { id: 'allow-once', label: 'Allow once', kind: 'allow-once' },
      { id: 'reject-once', label: 'Reject', kind: 'reject-once' }
    ],
    evidence: { source: 'native-hook', observedAt: 1, run: { runId: RUN_ID }, hookReceiptId: id }
  } as AgentMuxInteractionRequest
}

function runProjection(acceptedInputBytes: number) {
  return {
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'codex',
    args: [] as string[],
    cwd: '/tmp/lifecycle-agent',
    env: {},
    workspacePath: '/tmp/lifecycle-agent',
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

async function connectedClient(pending?: AgentMuxInteractionRequest): Promise<{
  client: AgentMuxClient
  writes: string[]
  store: AgentMuxMemoryAgentSessionStore
  state: Internals
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession(pending))
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
  ;(client as unknown as { connected: boolean }).connected = true
  return { client, writes, store, state }
}

describe('respondAgentInteraction: the answer must bind to this Session/Run/request', () => {
  it('answers the pending request and clears it, writing the provider byte (positive control)', async () => {
    const { client, writes } = await connectedClient(permission('rcpt-1'))

    await client.respondAgentInteraction({
      agentSessionId: AGENT_SESSION_ID,
      expectedRun: { runId: RUN_ID },
      response: { kind: 'permission', requestId: 'rcpt-1', decision: { outcome: 'selected', optionId: 'allow-once' } }
    })

    // codex 的 allow-once 解析成 '1'（provider 私有知识，client 从不生成字节）。这条正向控制在，
    // 是为了让下面两条不会被一个「永远抛」的实现骗过：真闸门放行合法回答。
    expect(writes, 'the resolved provider byte never reached the PTY').toEqual(['1'])
    expect(client.agentSessions()[0]!.pendingInteraction, 'answering did not clear the pending interaction').toBeUndefined()
    await client.dispose()
  })

  it('refuses an answer aimed at a stale Run — a prior turn cannot answer for the current one', async () => {
    const { client, writes } = await connectedClient(permission('rcpt-1'))

    const error = await client.respondAgentInteraction({
      agentSessionId: AGENT_SESSION_ID,
      expectedRun: { runId: 'a-different-run' },
      response: { kind: 'permission', requestId: 'rcpt-1', decision: { outcome: 'selected', optionId: 'allow-once' } }
    }).then(() => null, (caught: unknown) => caught)

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

    const error = await client.respondAgentInteraction({
      agentSessionId: AGENT_SESSION_ID,
      expectedRun: { runId: RUN_ID },
      response: { kind: 'permission', requestId: 'rcpt-1', decision: { outcome: 'selected', optionId: 'allow-once' } }
    }).then(() => null, (caught: unknown) => caught)

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

    const error = await client.respondAgentInteraction({
      agentSessionId: AGENT_SESSION_ID,
      expectedRun: { runId: RUN_ID },
      response: { kind: 'permission', requestId: 'rcpt-1', decision: { outcome: 'selected', optionId: 'allow-once' } }
    }).then(() => null, (caught: unknown) => caught)

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

describe('typed response settlement and recoverable input disposition', () => {
  it('cancels the exact request with the Provider cancellation plan, without selecting a grant', async () => {
    const { client, writes } = await connectedClient(permission('cancel-1'))
    try {
      await client.respondAgentInteraction({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID },
        response: { kind: 'permission', requestId: 'cancel-1', decision: { outcome: 'cancelled' } } })
      expect(writes).toEqual(['\u001b'])
      expect(client.agentSession(AGENT_SESSION_ID).pendingInteraction).toBeUndefined()
    } finally { await client.dispose() }
  })

  it('settles once when two callers answer the same request concurrently', async () => {
    const { client, writes } = await connectedClient(permission('parallel-1'))
    const input = { agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, response: answer('parallel-1') }
    try {
      const outcomes = await Promise.allSettled([client.respondAgentInteraction(input), client.respondAgentInteraction(input)])
      expect(outcomes[0]!.status).toBe('fulfilled')
      expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'UNKNOWN_AGENT_INTERACTION' } })
      expect(writes).toEqual(['\u001b'])
      expect(client.agentSession(AGENT_SESSION_ID).pendingInteraction).toBeUndefined()
      await expect(client.respondAgentInteraction(input)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_INTERACTION' })
      expect(writes).toEqual(['\u001b'])
    } finally { await client.dispose() }
  })

  it('a second Client with a stale cache cannot answer a request another Client already settled', async () => {
    const h = await connectedClient(permission('shared-1'))
    const second = new AgentMuxClient({ store: h.store })
    const owner = second as unknown as Internals
    await owner.registry.load('local')
    owner.kernel = h.state.kernel
    ;(second as unknown as { connected: boolean }).connected = true
    const input = { agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, response: answer('shared-1') }
    try {
      await h.client.respondAgentInteraction(input)
      await expect(second.respondAgentInteraction(input)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_INTERACTION' })
      expect(h.writes).toEqual(['\u001b'])
      expect(second.agentSession(AGENT_SESSION_ID).pendingInteraction).toBeUndefined()
    } finally { await second.dispose(); await h.client.dispose() }
  })

  it('reloads durable replacement before answering from a stale Client cache', async () => {
    const h = await connectedClient(permission('old-request'))
    try {
      const saved = await loadAgentSessions(h.store)
      expect(saved).toHaveLength(1)
      await h.store.compareAndSwap(saved[0]!, storedSession(permission('new-request')))
      await expect(h.client.respondAgentInteraction({ agentSessionId: AGENT_SESSION_ID,
        expectedRun: { runId: RUN_ID }, response: answer('old-request') }))
        .rejects.toMatchObject({ code: 'UNKNOWN_AGENT_INTERACTION' })
      expect(h.writes).toEqual([])
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.request.id).toBe('new-request')
    } finally { await h.client.dispose() }
  })

  it.each(['answered', 'cancelled'] as const)('question %s uses its semantic plan and settles the exact request', async outcome => {
    const request: AgentMuxInteractionRequest = {
      kind: 'question', id: 'question-1', agentSessionId: AGENT_SESSION_ID,
      questions: [{ id: 'choice-1', prompt: 'Which?', options: [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }] }],
      evidence: { source: 'native-hook', observedAt: 1, run: { runId: RUN_ID }, hookReceiptId: 'question-1' }
    }
    const h = await connectedClient(request)
    try {
      const response: AgentMuxInteractionResponse = outcome === 'cancelled'
        ? { kind: 'question', requestId: request.id, outcome }
        : { kind: 'question', requestId: request.id, outcome, answers: [{ questionId: 'choice-1', optionId: 'second' }] }
      await h.client.respondAgentInteraction({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, response })
      expect(h.writes).toEqual([outcome === 'cancelled' ? '\u001b' : '2'])
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toBeUndefined()
    } finally { await h.client.dispose() }
  })

  it.each(['accepted-receipt-lost', 'not-applied'] as const)('%s retains the exact claim and recovers the same operation without changing the answer', async disposition => {
    const h = await connectedClient(permission('recover-1'))
    const receipts = new Map<string, unknown>()
    const calls: { operationId: string; expectedByte: number; data: string }[] = []
    const original = h.state.kernel.input as (runId: string, operation: typeof calls[number]) => Promise<unknown>
    let first = true
    h.state.kernel.input = async (runId: string, operation: typeof calls[number]) => {
      calls.push({ ...operation })
      if (first) {
        first = false
        if (disposition === 'accepted-receipt-lost') receipts.set(operation.operationId, await original(runId, operation))
        throw new AgentMuxError('Private input receipt unavailable.', 'PRIVATE_INPUT_FAILURE', disposition === 'not-applied' ? 'not_applied' : 'unknown')
      }
      const receipt = receipts.get(operation.operationId)
      return receipt ?? await original(runId, operation)
    }
    const input = { agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, response: answer('recover-1') }
    try {
      await expect(h.client.respondAgentInteraction(input)).rejects.toMatchObject({ code: 'PRIVATE_INPUT_FAILURE' })
      const claim = h.client.agentSession(AGENT_SESSION_ID).pendingInteraction!.response!
      expect(claim).toMatchObject({ value: answer('recover-1'), acknowledged: false, inputByteRange: { startByte: 0, endByte: 1 } })
      expect(claim.operationId.length).toBeGreaterThan(0)
      expect(h.writes).toEqual(disposition === 'not-applied' ? [] : ['\u001b'])
      const recorded = await loadAgentSessions(h.store)
      expect(recorded).toHaveLength(1)
      expect(recorded[0]!.pendingInteraction!.response).toEqual(claim)
      await expect(h.client.respondAgentInteraction({ ...input, response: answer('recover-1', 'allow-once') }))
        .rejects.toMatchObject({ code: 'AGENT_INTERACTION_RESPONSE_CONFLICT' })
      expect(calls).toHaveLength(1)
      await h.client.respondAgentInteraction(input)
      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual(calls[0])
      expect(h.writes).toEqual(['\u001b'])
      expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toBeUndefined()
    } finally { await h.client.dispose() }
  })
})
