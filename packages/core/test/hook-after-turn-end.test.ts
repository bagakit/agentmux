import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type {
  AgentMuxClientEvent,
  AgentMuxStoredAgentSession,
  AgentProviderId,
  NativeHookEnvelope
} from '../src/types.js'

// ---------------------------------------------------------------------------
// 一个 turn 收尾之后到达的工具事件，不许再改语义状态。
//
// 与 hook-after-run-end.test.ts 守的是**两个不同的**概念，不要合并：那份守「进程已死」（此后一条 hook
// 都不收），这份守「当轮已收尾」（事件照收、时间轴照落，只是不再据此推断「它正在干活」）。进程还活得
// 好好的，只是这一轮交付完了。
//
// 事故形状（探针实测）：`Stop` 让 Agent 落到 `done`，紧随其后一条迟到的 `PostToolUse` 把它翻回
// `working` 并落盘。此后再没有任何事件会拨正它——衰减窗口 15 分钟，且衰减只把 `working` 降到
// `unknown`/`running`，降不回 `done`。用户盯着一个早已交付完成的 Agent 转圈整整一刻钟，冷启动读回
// 磁盘上那条 `working` 会继续撒谎。
//
// 判据为什么不是比 observedAt：见 hook-turn-phase.ts 的头注释（hook 的 observedAt 是**我们摄入**的
// 时刻，迟到的事件反而更大，单调守卫恒真放行）。这条死路被记在那里，别再走一遍。
// ---------------------------------------------------------------------------

function storedSession(providerId: AgentProviderId = 'codex'): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId,
    executorId: providerId,
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    hookBindingId: 'binding-hook-after-turn'.padEnd(43, 'A'),
    hookToken: 'token-hook-after-turn'.padEnd(43, 'B'),
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId, sessionId: 'native-1' }
  }
}

function runningRun(): CtxmuxAdapterRun {
  return {
    runId: 'run-1',
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/repo',
    pid: 999,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes: 0
  }
}

/**
 * 一条真实的 hook。默认走 codex，三个事件名各自在 codex 的 rules 与 canonical 生命周期表上都有归属：
 * `Stop`→turn-end/done、`PostToolUse`→tool-use-end/working、`UserPromptSubmit`→user-prompt-submit/working。
 *
 * `providerId` 可换：Hermes 那族的重开事件是 `pre_llm_call`→turn-start（它的 hook 面上根本没有
 * 「用户提交了 prompt」这种事），所以「闸门认不认第二种重开形状」只能拿真 Provider 驱一遍才算守住。
 */
function hook(
  receiptId: string,
  eventName: string,
  providerId: AgentProviderId = 'codex'
): NativeHookEnvelope {
  return {
    receiptId,
    agentSessionId: 'agent-1',
    runId: 'run-1',
    providerId,
    eventName,
    payload: { hook_event_name: eventName, tool_name: 'shell', session_id: 'native-1' }
  }
}

type Internals = {
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  connected: boolean
  acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
}

async function harness(providerId: AgentProviderId = 'codex'): Promise<{
  client: AgentMuxClient
  feed: (eventName: string, receiptId: string) => Promise<void>
  statuses: () => Extract<AgentMuxClientEvent, { type: 'agent-status' }>[]
  timelines: () => Extract<AgentMuxClientEvent, { type: 'agent-timeline' }>[]
  storedStatus: () => Promise<AgentMuxStoredAgentSession['semanticStatus']>
  storedReceiptId: () => Promise<string | undefined>
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession(providerId))
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as Internals
  await internals.registry.load('local')
  internals.connected = true
  internals.kernel.isConnected = () => true
  internals.kernel.status = async () => runningRun()
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => events.push(event))
  const stored = async (): Promise<AgentMuxStoredAgentSession | undefined> => {
    const sessions = (await store.load()) as readonly AgentMuxStoredAgentSession[]
    return sessions.find((session) => session.agentSessionId === 'agent-1')
  }
  return {
    client,
    feed: async (eventName, receiptId) =>
      await internals.acceptHookEvent(hook(receiptId, eventName, providerId), AbortSignal.timeout(5_000)),
    statuses: () => events.filter(
      (event): event is Extract<AgentMuxClientEvent, { type: 'agent-status' }> =>
        event.type === 'agent-status'
    ),
    timelines: () => events.filter(
      (event): event is Extract<AgentMuxClientEvent, { type: 'agent-timeline' }> =>
        event.type === 'agent-timeline'
    ),
    storedStatus: async () => (await stored())?.semanticStatus,
    storedReceiptId: async () => (await stored())?.hookReceipt?.id
  }
}

describe('tool events arriving after the turn already ended', () => {
  it('turn 收尾自己照旧落到 done——闸门不许把 Stop 也判成迟到', async () => {
    // 台账在 acceptHookEvent 里必须**先读后推**：`Stop` 就是那条把阶段推到 turn-ended 的事件，先推后读
    // 会把它自己判成「收尾后的迟到事件」，于是 Agent 永远落不到 done。这是本修法最容易犯的一处顺序错。
    const { client, feed, statuses, storedStatus } = await harness()
    try {
      await feed('Stop', 'receipt-stop')
      expect(statuses().at(-1)).toMatchObject({ state: 'done' })
      expect(await storedStatus()).toMatchObject({ state: 'done' })
    } finally {
      await client.dispose()
    }
  })

  it('收尾后迟到的工具事件不把 done 翻回 working——事件流这一侧', async () => {
    const { client, feed, statuses, storedStatus } = await harness()
    try {
      await feed('Stop', 'receipt-stop')
      await feed('PostToolUse', 'receipt-late-tool')
      // 最后一条状态仍是 done。别只断言「没有 working」——那在一条状态都不发时也成立，而
      // 「整条 hook 一律拒收」是个过宽的错修法，会顺带丢掉时间轴与回执（下面另有一条钉它）。
      expect(statuses().at(-1)).toMatchObject({ state: 'done' })
      expect(await storedStatus()).toMatchObject({ state: 'done' })
    } finally {
      await client.dispose()
    }
  })

  it('收尾后迟到的工具事件不把 done 翻回 working——磁盘那一侧独立钉一条', async () => {
    // 语义状态有**两个**写入点（发事件、落盘）。只挡其一都不够：只挡落盘则本次 UI 被点亮成 working，
    // 只挡发布则磁盘上留着 working，下次冷启动读回来继续撒谎。这里让事件流完全不参与判定：新建一个
    // harness、只看磁盘。
    const { client, feed, storedStatus } = await harness()
    try {
      await feed('Stop', 'receipt-stop-disk')
      await feed('PostToolUse', 'receipt-late-tool-disk')
      expect(await storedStatus()).toMatchObject({ state: 'done' })
    } finally {
      await client.dispose()
    }
  })

  it('事前那一侧也挡：PreToolUse 与 PostToolUse 同属一次工具调用', async () => {
    // `tool-use-start` 与 `tool-use-end` 是同一族的两个出口。只挡 Post 会留下同形的第二条路——本仓
    // 「守卫按出口数不按条件数」那族缺陷的形状。
    const { client, feed, statuses, storedStatus } = await harness()
    try {
      await feed('Stop', 'receipt-stop-pre')
      await feed('PreToolUse', 'receipt-late-pre')
      expect(statuses().at(-1)).toMatchObject({ state: 'done' })
      expect(await storedStatus()).toMatchObject({ state: 'done' })
    } finally {
      await client.dispose()
    }
  })

  it('新一轮用户输入把台账重新打开，此后的工具事件照常算 working——正向那一侧', async () => {
    // 没有这一条，「收尾之后永远不再更新语义状态」这种过宽的修法也会全绿，而那会让 Agent 在第二轮
    // 提问后永远显示 done：用户提了问题、它明明在干活，界面说它闲着。
    const { client, feed, statuses, storedStatus } = await harness()
    try {
      await feed('Stop', 'receipt-stop-reopen')
      await feed('UserPromptSubmit', 'receipt-new-prompt')
      await feed('PostToolUse', 'receipt-second-turn-tool')
      expect(statuses().at(-1)).toMatchObject({ state: 'working' })
      expect(await storedStatus()).toMatchObject({ state: 'working' })
    } finally {
      await client.dispose()
    }
  })

  it('从没收过 turn-end 的 run 里，工具事件一律照常算 working', async () => {
    // 台账缺席（`undefined`）读作「这个 run 还没见过任何 turn-end」，必须放行。若把缺席当成「收尾了」，
    // 每个 Agent 的第一轮工作都不会被点亮。
    const { client, feed, statuses, storedStatus } = await harness()
    try {
      await feed('PostToolUse', 'receipt-first-turn-tool')
      expect(statuses().at(-1)).toMatchObject({ state: 'working' })
      expect(await storedStatus()).toMatchObject({ state: 'working' })
    } finally {
      await client.dispose()
    }
  })

  it('Hermes 靠 pre_llm_call 重开：没有它，第一次收尾后整个 run 余下的状态全被吞掉', async () => {
    // **这条就是那次生产事故的形状。** 闸门此前只认 `user-prompt-submit`，而 Hermes 的 hook 面上根本
    // 没有这种事件（用户在它自己的 TUI 里打字，AgentMux 看不见），能看见的只有「这一轮开工了」
    // （`pre_llm_call`）。于是第一条 `post_llm_call` 收尾之后，此后每条 `pre_tool_call` 都被判 false，
    // 整个 run 余下的 working / 等你态**永久**被静默吞掉——不是延迟 15 分钟，是再也不会正确。
    //
    // 拿真 Provider 驱一遍是必须的：上面那几条全走 codex，而 codex 的重开事件恰好是闸门原本认得的
    // 那一种，所以它们对「第二种重开形状」完全失明。
    const { client, feed, statuses, storedStatus } = await harness('hermes')
    try {
      await feed('post_llm_call', 'receipt-hermes-turn-end')
      expect(statuses().at(-1), 'Hermes 的收尾照旧要落 done').toMatchObject({ state: 'done' })

      // 收尾之后、重开之前：迟到的工具事件仍要被压住（这是闸门本来的用途，别把它一起放开）。
      await feed('pre_tool_call', 'receipt-hermes-late-tool')
      expect(
        statuses().at(-1),
        '收尾后还没重开，迟到的工具事件不许把 done 翻回 working'
      ).toMatchObject({ state: 'done' })

      // 新一轮开工——Hermes 只报这一个。它必须能把台账重新打开。
      await feed('pre_llm_call', 'receipt-hermes-turn-start')
      await feed('pre_tool_call', 'receipt-hermes-second-turn-tool')
      expect(
        statuses().at(-1),
        'pre_llm_call 之后的工具事件必须照常算 working，否则 Hermes 从第二轮起永远显示 done'
      ).toMatchObject({ state: 'working' })
      expect(await storedStatus()).toMatchObject({ state: 'working' })
    } finally {
      await client.dispose()
    }
  })

  it('Pi 没有重开事件，摄入侧必须把这件事算出来喂给闸门——否则它永久 latch', async () => {
    // 这一条守的是**接线**，不是判据。闸门那个 `providerCanReopenTurn` 入参在 client.ts 里由
    // `eventNamesCanReopenTurn(provider.hook.rules…)` 算出来，而那句可以被写成常量 `true`
    // ——实测：改成 `true` 后上面全部 43 条断言照旧全绿。于是 Pi 在生产里第一次 `agent_end` 之后
    // 永久拒绝更新语义状态，整个 run 余下的 working/等你态全被吞掉，而门禁一片绿。
    //
    // 判据只能拿一个**真的没有重开事件**的 Provider 驱：Pi 的 rules 里没有任何事件归一到
    // user-prompt-submit / turn-start（这件事本身由 agent-provider-protocol.test.ts 的缺口清单钉着，
    // 两条成对）。所以对 Pi 而言正确行为是**不抑制**——两害相权，宁可漏掉一次「压制迟到残响」，
    // 也不能让健康的 Agent 从此再也点不亮。
    const { client, feed, statuses, storedStatus } = await harness('pi')
    try {
      await feed('agent_end', 'receipt-pi-turn-end')
      expect(statuses().at(-1), 'Pi 的收尾照旧落 done').toMatchObject({ state: 'done' })

      // Pi 无从重开，所以这条工具事件必须放行。若接线把前提写死成「都能重开」，它会被压住，
      // 而此后没有任何事件能把 Pi 救回来。
      await feed('tool_execution_start', 'receipt-pi-after-end')
      expect(
        statuses().at(-1),
        'Pi 缺重开能力，收尾后的工具事件必须照收——否则抑制从可逆变成永久'
      ).toMatchObject({ state: 'working' })
      expect(await storedStatus()).toMatchObject({ state: 'working' })
    } finally {
      await client.dispose()
    }
  })

  it('挡的只是「所以它在干活」这个推论：回执与时间轴照旧落地', async () => {
    // 一次真实发生过的工具调用是**事实**，该出现在时间轴上、该留下回执。把整条事件拒收（照
    // hook-after-run-end 那道闸的写法照抄）会让用户在收尾后彻底看不见最后那步工具调用的结果——
    // 而那一步往往正是他最想看的那个。
    const { client, feed, timelines, storedReceiptId } = await harness()
    try {
      await feed('Stop', 'receipt-stop-facts')
      const before = timelines().length
      await feed('PostToolUse', 'receipt-late-facts')
      expect(timelines().length, '迟到的工具事件仍要落时间轴').toBeGreaterThan(before)
      expect(await storedReceiptId()).toBe('receipt-late-facts')
    } finally {
      await client.dispose()
    }
  })
})
