import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxStoredAgentSession, AgentMuxPendingInteraction } from '../src/types.js'
import { advanceDelivery, createThread } from '../src/agent-message.js'
import { ackDeliveryBatch, checkDeliveries, type DeliveryQueue } from '../src/agent-delivery-queue.js'

/**
 * T-002 gate: typed prompt ingress has ONE delivery owner in Core, and the two facts the plan forbids
 * merging stay two facts.
 *
 * This file drives the REAL client (only ctxmux I/O faked) so the assertions are about behaviour, not a
 * source scan. The single-phase provider (claude) is enough for the ingress properties; the two-facts
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

function storedSession(
  extra: Partial<AgentMuxStoredAgentSession> = {}
): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: AGENT_SESSION_ID,
    providerId: 'claude',
    executorId: 'claude',
    hostId: 'local',
    workspacePath: WORKSPACE,
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-ingress',
    hookToken: 'token-ingress',
    outputCursorBytes: 0,
    createdAt: 100,
    updatedAt: 100,
    ...extra
  }
}

function runProjection(acceptedInputBytes: number) {
  return {
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'claude',
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
  registry: { load(hostId: string): Promise<void> }
}

async function ingressClient(
  extra: Partial<AgentMuxStoredAgentSession> = {}
): Promise<{ client: AgentMuxClient; writes: string[]; setRunState(state: 'running' | 'exited'): void }> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession(extra))
  const client = new AgentMuxClient({ store })
  const state = client as unknown as Internals
  await state.registry.load('local')

  let cursor = 0
  let runState: 'running' | 'exited' = 'running'
  const writes: string[] = []
  state.kernel.isConnected = () => true
  state.kernel.identity = () => ({ daemonInstanceId: 'daemon-1', protocolVersion: 1, buildIdentity: 'test' })
  state.kernel.status = async () => ({
    ...runProjection(cursor),
    state: runState === 'running' ? { type: 'running' as const } : { type: 'exited' as const, exitCode: 0 }
  })
  state.kernel.input = async (_runId: string, operation: { expectedByte: number; data: string }) => {
    writes.push(operation.data)
    cursor = operation.expectedByte + Buffer.byteLength(operation.data)
    return {
      run: runProjection(cursor),
      appliedByteRange: { startByte: operation.expectedByte, endByte: cursor }
    }
  }
  ;(client as unknown as { connected: boolean }).connected = true

  return { client, writes, setRunState: (s) => { runState = s } }
}

describe('typed prompt ingress has one delivery owner in Core', () => {
  it('accepts a prompt for a running Run and writes the bytes through the daemon exactly once', async () => {
    const fixture = await ingressClient()
    await fixture.client.submitAgentPrompt({
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-send',
      prompt: 'ship it'
    })
    // claude is single-phase: the whole outbound (prompt + \r) is one daemon input write.
    // MUTATION: change submitAgentPrompt to call promptSubmission.submitInputPlan twice, or drop the
    // single-phase early return in prompt-submission.ts:134 — writes.length becomes 2 → this goes red.
    expect(fixture.writes).toEqual(['ship it\r'])
  })

  it('does NOT double-send when the SAME operationId is replayed (the anti-double-send owner is Core)', async () => {
    const fixture = await ingressClient()
    const input = { agentSessionId: AGENT_SESSION_ID, operationId: 'op-replay', prompt: 'once only' }
    await fixture.client.submitAgentPrompt(input)
    await fixture.client.submitAgentPrompt(input)
    // The renderer steer queue leans ENTIRELY on this: a retry replays the same id and Core recognizes it.
    // MUTATION: mint a fresh operationId per attempt (e.g. randomUUID() inside submitAgentPrompt instead of
    // using input.operationId) — the second call writes again → length 2 → red.
    expect(fixture.writes).toEqual(['once only\r'])
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
    const fixture = await ingressClient({ pendingInteraction: pending })
    await expect(fixture.client.submitAgentPrompt({
      agentSessionId: AGENT_SESSION_ID,
      operationId: 'op-during-pending',
      prompt: 'must-not-bypass-permission'
    })).rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
    // Not one byte reached the Agent — the pending card owns the input surface.
    // MUTATION: delete the `if (current.pendingInteraction) throw` guard in submitAgentPrompt
    // (client.ts:2336) — the prompt is written and the reject below fails → red.
    expect(fixture.writes).toEqual([])
  })

  it('does not accept a prompt for a Run that has exited before delivery', async () => {
    const fixture = await ingressClient()
    fixture.setRunState('exited')
    await expect(fixture.client.submitAgentPrompt({
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
