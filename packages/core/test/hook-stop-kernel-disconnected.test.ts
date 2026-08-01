import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type {
  AgentMuxClientEvent,
  AgentMuxStoredAgentSession,
  NativeHookEnvelope
} from '../src/types.js'

// ---------------------------------------------------------------------------
// 「这一 turn 结束了」与「取不到输出光标快照」是两件事，不许共用一个失败出口。
//
// acceptHookEvent 在 Stop 事件上要向内核问一次 run 状态，图的只是 `latestOutputBytes` —— 一个给
// composer 就绪判定用的光标快照。而内核在**断线期间**这个调用直接抛 CTXMUX_DISCONNECTED（置
// client=null 后 requireClient 恒抛），错误一路穿出 onEvent、被 hook-server 应答成 503，发事件的
// hook 子进程重试一次仍是 503，只写一行 stderr 就正常退出——**这条 Stop 永久丢失**。
//
// 而重连**只拆内核**：hookServer.stop() 全仓只在 open() 失败与 dispose() 两处调用，binding.close()
// 的每个调用点都在 launch/resume/stop/dispose 路径。所以掉线期间 HTTP 口一直开着、一直收 POST、
// 一直 503，窗口是每轮退避的整个时长（可达 31.5s），远大于 hook 客户端 2s 的超时。
//
// 后果是最坏的那一种，且已实测：done 从未落盘（抛出发生在任何持久化之前），会话停在 working，
// 15 分钟衰减只把 working 降到 running 不会降到 done，完成通知**永不触发**。一次 wire 抖动把
// 「我读不到光标」误当成「这一轮的完成整个丢失」。
//
// 光标本身确实丢了，我们不假装它没丢——但 done 不依赖它：done 来自 Provider 的 normalizeHook 规则
// （claude 的 Stop→done），与内核状态无关。所以正确的形状是快照降级为 best-effort，done 照落。
// ---------------------------------------------------------------------------

function storedSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId: 'claude',
    executorId: 'claude',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    hookBindingId: 'binding-stop-disconnected'.padEnd(43, 'A'),
    hookToken: 'token-stop-disconnected'.padEnd(43, 'B'),
    outputCursorBytes: 0,
    createdAt: 1,
    // 存储不变量要求 updatedAt 不早于 semanticStatus.observedAt（agent-session-store.ts:972）。
    updatedAt: 10,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-1' },
    semanticStatus: {
      state: 'working',
      source: 'native-hook',
      observedAt: 10,
      detail: 'PreToolUse'
    }
  }
}

function run(latestOutputBytes: number): CtxmuxAdapterRun {
  return {
    runId: 'run-1',
    lifecycleOperationId: null,
    program: 'claude',
    args: [],
    workspacePath: '/repo',
    pid: 999,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes,
    firstAvailableByte: 0,
    acceptedInputBytes: 0
  }
}

/** 一条真实的 claude Stop：normalizer 按 provider 规则把它投影成 semanticState='done'。 */
function stopHook(receiptId: string): NativeHookEnvelope {
  return {
    receiptId,
    agentSessionId: 'agent-1',
    runId: 'run-1',
    providerId: 'claude',
    eventName: 'Stop',
    payload: { session_id: 'native-1' }
  }
}

type Internals = {
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  connected: boolean
  acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
}

async function harness(): Promise<{
  client: AgentMuxClient
  internals: Internals
  stored: () => Promise<AgentMuxStoredAgentSession | undefined>
  statuses: () => Extract<AgentMuxClientEvent, { type: 'agent-status' }>[]
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession())
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as Internals
  await internals.registry.load('local')
  internals.connected = true
  internals.kernel.isConnected = () => true
  internals.kernel.status = async () => run(4_096)
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => events.push(event))
  return {
    client,
    internals,
    stored: async () => {
      const sessions = (await store.load()) as readonly AgentMuxStoredAgentSession[]
      return sessions.find((session) => session.agentSessionId === 'agent-1')
    },
    statuses: () => events.filter(
      (event): event is Extract<AgentMuxClientEvent, { type: 'agent-status' }> => event.type === 'agent-status'
    )
  }
}

/** 让内核像掉线期间那样对每一次 status() 抛断连——这正是 requireClient 在 client=null 后做的事。 */
function disconnectKernel(internals: Internals): void {
  internals.kernel.status = async () => {
    throw new AgentMuxError('AgentMux client is not connected.', 'CTXMUX_DISCONNECTED')
  }
}

describe('Stop 落 done 不得依赖活着的内核', () => {
  it('内核健康时：done 落盘，且光标快照一起带上', async () => {
    // 正向那一侧。没有它，「一律不取快照」这种过宽的修法也会全绿，而那会让 composer 就绪判定永远
    // 拿不到起点。
    const { client, internals, stored } = await harness()
    try {
      await internals.acceptHookEvent(stopHook('receipt-healthy'), AbortSignal.timeout(5_000))
      const session = await stored()
      expect(session?.semanticStatus).toMatchObject({ state: 'done' })
      expect(session?.hookReceipt?.outputCursorBytes, '内核健康时光标必须逐字来自 status()').toBe(4_096)
      expect(session?.terminalPromptReadiness).toMatchObject({
        source: 'native-stop',
        outputCursorBytes: 4_096
      })
    } finally {
      await client.dispose()
    }
  })

  it('内核断线时：done 照样落盘——一次 wire 抖动不许吃掉整轮的完成', async () => {
    const { client, internals, stored } = await harness()
    try {
      disconnectKernel(internals)

      // 不许抛。抛出去就是 503，就是这条 Stop 永久丢失。
      await internals.acceptHookEvent(stopHook('receipt-disconnected'), AbortSignal.timeout(5_000))

      const session = await stored()
      expect(session?.semanticStatus, '断线吞掉了 done——Agent 会永久停在 working，完成通知永不触发')
        .toMatchObject({ state: 'done' })
    } finally {
      await client.dispose()
    }
  })

  it('内核断线时：done 也发到事件流上，不只是落盘', async () => {
    // 两个写入点各钉一条（同 hook-after-run-end 的先例）：只落盘不发布，界面这一屏仍然转圈到 reload。
    const { client, internals, statuses } = await harness()
    try {
      disconnectKernel(internals)
      await internals.acceptHookEvent(stopHook('receipt-disconnected-event'), AbortSignal.timeout(5_000))
      expect(statuses().at(-1), '断线时 done 没发出去——这一屏会一直转圈').toMatchObject({ state: 'done' })
    } finally {
      await client.dispose()
    }
  })

  it('内核断线时：光标缺席就是缺席，绝不编一个 0 冒充「输出到此为止」', async () => {
    // 快照确实丢了，我们不假装它没丢。写一个 0 会让 composer 就绪判定从头开始扫整份输出，把上一轮
    // 的提示符误认成这一轮的——那比缺席更坏。缺席让就绪判定留在待定，等重连后的真相。
    const { client, internals, stored } = await harness()
    try {
      disconnectKernel(internals)
      await internals.acceptHookEvent(stopHook('receipt-no-cursor'), AbortSignal.timeout(5_000))
      const session = await stored()
      expect(session?.hookReceipt?.eventName).toBe('Stop')
      expect(session?.hookReceipt?.outputCursorBytes, '断线时编造了一个光标值').toBeUndefined()
      expect(session?.terminalPromptReadiness, '断线时编造了一个就绪起点').toBeUndefined()
    } finally {
      await client.dispose()
    }
  })

  /**
   * 降级**只对断线**成立。别的错误照旧响亮失败——那是真 bug，不是 wire 抖动。
   *
   * 为什么必须单独钉：上面三条断线用例只质询 catch 的**吞下侧**，每一条喂的都是 CTXMUX_DISCONNECTED，
   * 所以把 catch 体整个换成裸 `return null`（吞掉一切）对它们的任何断言都不改变什么（实测：4 条全绿）。
   * 那样一来 run 不存在、内核协议错、adapter 内部断言失败全都被静默压平成「Stop 落了、光标没取到」，
   * 一个真 bug 就此免检。这一条让「只吞断线」这个收窄成为那个现场里唯一还站着的守卫。
   */
  it('别的内核错误照旧响亮失败——降级只给断线，不给真 bug', async () => {
    const { client, internals } = await harness()
    try {
      internals.kernel.status = async () => {
        throw new AgentMuxError('Run is unknown to the kernel.', 'CTXMUX_run_not_found')
      }
      await expect(
        internals.acceptHookEvent(stopHook('receipt-other-error'), AbortSignal.timeout(5_000)),
        '一个真正的内核错误被静默吞成了「光标没取到」'
      ).rejects.toThrow(/unknown to the kernel/)
    } finally {
      await client.dispose()
    }
  })

  /**
   * 放开的是「Stop ⟹ 必须有光标」，**不是**「有光标 ⟹ 必须是 Stop」。后者承重且必须继续拦下。
   *
   * 这个不变量此前是个双条件，而**两侧都无人守**（实测：把整个判断换成 `if (false)`，本文件与
   * agent-session-store 那 34 条全绿）。放开一半时若不同时把另一半钉住，等于把一条没人看的规则改成
   * 一条更松的、同样没人看的规则。伪造侧的后果是实的：一个 mid-turn 回执带着「权威输出光标」，会让
   * composer 就绪判定以一个 turn 中间的字节位置为边界，把上一轮的提示符认成这一轮的，于是在 Agent
   * 其实还在干活时放行 prompt。
   */
  it('非 Stop 的回执绝不许携带权威输出光标', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    const forged: AgentMuxStoredAgentSession = {
      ...storedSession(),
      hookReceipt: {
        id: 'receipt-forged',
        providerId: 'claude',
        agentSessionId: 'agent-1',
        run: { runId: 'run-1' },
        eventName: 'PreToolUse',
        observedAt: 10,
        outputCursorBytes: 4_096
      }
    }
    await expect(
      store.compareAndSwap(null, forged),
      '一个 mid-turn 回执带着权威输出光标却被存下来了'
    ).rejects.toThrow(/authoritative output cursor/)
  })

  it('Stop 回执携带光标仍然合法——放开的只是「必须有」，不是「不许有」', async () => {
    // 反向那一侧：别把伪造守卫写成「谁都不许带光标」，那会让健康路径整个存不下去。
    const store = new AgentMuxMemoryAgentSessionStore()
    const healthy: AgentMuxStoredAgentSession = {
      ...storedSession(),
      hookReceipt: {
        id: 'receipt-legit',
        providerId: 'claude',
        agentSessionId: 'agent-1',
        run: { runId: 'run-1' },
        eventName: 'Stop',
        observedAt: 10,
        outputCursorBytes: 4_096
      }
    }
    await expect(store.compareAndSwap(null, healthy)).resolves.not.toThrow()
    const sessions = (await store.load()) as readonly AgentMuxStoredAgentSession[]
    // 不止「没抛」——光标必须逐字存了下来，否则一个静默丢弃字段的实现也会让上面那句通过。
    expect(sessions[0]?.hookReceipt?.outputCursorBytes).toBe(4_096)
  })
})
