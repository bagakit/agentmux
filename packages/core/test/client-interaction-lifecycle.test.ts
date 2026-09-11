import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import type {
  AgentMuxInteractionRequest,
  AgentMuxStoredAgentSession
} from '../src/types.js'

/**
 * T-003 的 client 级生命周期闸门：回答一次交互，必须绑定当前的 Session/Run/request。
 *
 * `provider-human-request-contract.test.ts` 已经把 **provider 那半** 钉死了——optionId→byte 的解析、
 * 未知选项、requestId 与 request.id 不符，全走 `planInteractionResponse` / `normalizeAgentInteractionResponse`。
 * 但 A3 还要 client 这半：「旧 Run 的回答、已被替换的 request，不影响新请求」。这半只活在
 * `client.respondAgentInteraction`（client.ts:2433 的 sameRun 闸门、:2440 的 pending-id 闸门）里，而在此之前
 * **没有任何测试直接调用过它**——它只在 packed-consumer 集成用例里跑过一次成功路径。
 *
 * 实测的缺口（2026-09-26）：把这两道闸门整段删掉、重建 core dist，T-003 的三条 gate（agent-interaction /
 * agent-provider-protocol / provider-human-request-contract）**47 条全绿**。也就是说「答错 Run / 答一个不再
 * pending 的 request」当前一条判据都没有。本文件补的正是这半。
 *
 * 为什么这半和 provider 那半必须分开证：provider 的 id 校验比的是「这个 response 冲着这个 request 吗」，
 * client 的闸门比的是「这个 request 此刻还在这个 Session 上等着答吗」。一个新的交互替换了旧的之后，旧回答
 * 的 requestId 对旧 request 完全合法——只有 client 这道 `pending.request.id !== requestId` 能把它挡住。
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
    outputCursorBytes: 0,
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
  return { client, writes }
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
    // rcpt-1 这个 requestId 对旧 request 完全合法，所以 provider 的 id 校验拦不住它——只有 client
    // 这道 `pending.request.id !== requestId` 能认出「你答的那个已经不在了」。
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
