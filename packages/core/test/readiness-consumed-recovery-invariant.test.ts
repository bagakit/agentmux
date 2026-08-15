import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, NativeHookEnvelope } from '../src/types.js'

// ---------------------------------------------------------------------------
// 红线不变量（RED-LINES.md 反例 1 / 「能自动守住的」第一条）：
//
//   一个**活着、running** 的 Agent，其 readiness epoch 已被上一条 prompt 永久消费
//   （consumedBySubmissionId 置位），当这一轮的 canonical turn-end 回执在一次 wire 断线
//   期间落地时，系统**绝不能**把它永久留在「已消费、无续期」的死局里——那等于此后每一条
//   submitAgentPrompt 都撞 AGENT_PROMPT_READINESS_CONSUMED，而 Agent 进程一直活着、PTY 一直
//   接受字节。判据是「Agent 还能干活吗」，不是「我们的记账续上了吗」。
//
// 这条不变量写成一句可证伪断言：turn-end 落在一个 running run 上之后，
//   terminalPromptReadiness.consumedBySubmissionId 必须**不再**是那条旧的消费标记——
// 无论修法是重铸一枚新 epoch、清掉整条 readiness 交给 observeReadiness 重挂、还是降级放行，
// 都会让消费标记消失；唯独「断线分支什么都不写」这个 P0 本体会把旧标记原样留下。
//
// 结构照 hook-stop-kernel-disconnected.test.ts：一条**健康内核**正向控制（证明 harness 与
// 断言本身能观测到「续期发生了」，不是恒红），一条**断线**用例（正是活着的 P0 finding 反例 1）。
// 两条只差 kernel.status() 是否抛 CTXMUX_DISCONNECTED——这个差就是变异探针：把断线分支改成
// 「照写续期」（即让它表现得和健康内核一样），断线用例即从红转绿。
// ---------------------------------------------------------------------------

const RUN_ID = 'consumed-run'
const SESSION_ID = 'consumed-agent'

/** 一个活着、running、readiness 已被上一条 prompt 永久消费的会话。 */
function storedSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: SESSION_ID,
    providerId: 'claude',
    executorId: 'claude',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-consumed-recovery'.padEnd(43, 'A'),
    hookToken: 'token-consumed-recovery'.padEnd(43, 'B'),
    // 非 0：重铸时光标必须退回这个**真实持久值**，而不是编造的 0。若这里是 0，
    // `current.outputCursorBytes` 与字面量 `0` 两个世界不可区分，断言就成了恒真
    // （期望值不能由被测对象算出）。编造 0 会让 screenEvidence 从头扫、把上一轮
    // 的提示符认成这一轮的，正是 client.ts:3659 拒绝的那件事。
    outputCursorBytes: 512,
    createdAt: 1,
    updatedAt: 10,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-1' },
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 10, detail: 'PreToolUse' },
    // 上一轮 turn 0 的 epoch：initial-composer 铸出、已就绪（readyThroughByte 定义）、已被提交消费。
    terminalPromptReadiness: {
      source: 'initial-composer',
      id: 'epoch-turn-0',
      run: { runId: RUN_ID },
      outputCursorBytes: 0,
      readyThroughByte: 100,
      consumedBySubmissionId: 'submission-turn-0'
    },
    // 存储不变量：被消费的 epoch 必须指得出认领它的那次 submission（agent-session-store.ts:1058）。
    terminalPromptSubmission: {
      run: { runId: RUN_ID },
      submissionId: 'submission-turn-0',
      promptDigest: 'a'.repeat(43),
      readinessSource: 'initial-composer',
      readinessId: 'epoch-turn-0',
      readinessOutputCursorBytes: 0,
      readyThroughByte: 100,
      outputCursorBytes: 100,
      payload: {
        operationId: 'payload-turn-0',
        inputByteRange: { startByte: 0, endByte: 1 },
        acknowledged: true
      },
      submit: {
        operationId: 'submit-turn-0',
        inputByteRange: { startByte: 1, endByte: 2 },
        acknowledged: true
      }
    }
  }
}

function run(latestOutputBytes: number): CtxmuxAdapterRun {
  return {
    runId: RUN_ID,
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

/** 一条真实的 claude Stop：normalizer 按 provider 规则投影成 turn-end。 */
function stopHook(receiptId: string): NativeHookEnvelope {
  return {
    receiptId,
    agentSessionId: SESSION_ID,
    runId: RUN_ID,
    providerId: 'claude',
    eventName: 'Stop',
    payload: { session_id: 'native-1' }
  }
}

/**
 * 一条**turn 中途**的 hook：PreToolUse 归一化成 tool-use-start（非 turn-end）。
 * 它照样走到 persistReceipt 那段（回执/时间轴对每条事件都落），且它的 `stopRun` 恒为 null——
 * status() 只在 turn-end 时才调。所以它命中的正是「断线臂」的 stopRun===null 分支。
 */
function midTurnHook(receiptId: string): NativeHookEnvelope {
  return {
    receiptId,
    agentSessionId: SESSION_ID,
    runId: RUN_ID,
    providerId: 'claude',
    eventName: 'PreToolUse',
    payload: { session_id: 'native-1', tool_name: 'Bash' }
  }
}

/**
 * 一条**报错收尾**的 hook：`StopFailure` 在报错时**取代** `Stop`（claude.ts:26 逐字："它取代 Stop，
 * 也就是说报错收尾根本不会有 Stop"），claude/kimi 真实发出它、grok 发 snake_case 的 `stop_failure`。
 * normalizer 经**全局合并方言表**把它归一成 `turn-end`（agent-hook-event.ts:84，与 Stop 同一条
 * canonical），而合并表按原始名查、不按 Provider 门控（同上 :310-327、:361-365）。
 *
 * 这条钉的正是「重铸的判据是 canonical `turn-end`，不是字面 `Stop`」：若把 client 的重铸臂从
 * `lifecycleEvent === 'turn-end'` 收窄成 `eventName === 'Stop'`，一个**turn 报错收尾**的活 Agent
 * 就再也救不回——上面三条用 `Stop` 的用例全绿，唯独这条会红，指名缺陷。
 */
function stopFailureHook(receiptId: string): NativeHookEnvelope {
  return {
    receiptId,
    agentSessionId: SESSION_ID,
    runId: RUN_ID,
    providerId: 'claude',
    eventName: 'StopFailure',
    payload: { session_id: 'native-1', error: 'boom' }
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
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession())
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as Internals
  await internals.registry.load('local')
  internals.connected = true
  internals.kernel.isConnected = () => true
  internals.kernel.status = async () => run(4_096)
  return {
    client,
    internals,
    stored: async () => {
      const sessions = (await store.load()) as readonly AgentMuxStoredAgentSession[]
      return sessions.find((session) => session.agentSessionId === SESSION_ID)
    }
  }
}

function disconnectKernel(internals: Internals): void {
  internals.kernel.status = async () => {
    throw new AgentMuxError('AgentMux client is not connected.', 'CTXMUX_DISCONNECTED')
  }
}

describe('活 Agent 的 readiness 被消费后，turn-end 必须留下一条可发送的路', () => {
  it('内核健康：turn-end 续期，旧的消费标记被清掉（正向控制——证明断言能观测到续期）', async () => {
    const { client, internals, stored } = await harness()
    try {
      await internals.acceptHookEvent(stopHook('receipt-healthy'), AbortSignal.timeout(5_000))
      const session = await stored()
      expect(
        session?.terminalPromptReadiness?.consumedBySubmissionId,
        '健康内核下 turn-end 没有续期——正向控制若失败说明 harness 或断言本身坏了，不是在测红线'
      ).toBeUndefined()
    } finally {
      await client.dispose()
    }
  })

  it('内核断线：turn-end 落在一个 running run 上，绝不许把 epoch 永久留在已消费死局（P0 反例 1）', async () => {
    const { client, internals, stored } = await harness()
    try {
      disconnectKernel(internals)
      // 断线是第 2 类：Agent 活着，坏的只有我们取光标那一步。这一条 turn-end 不许抛。
      await internals.acceptHookEvent(stopHook('receipt-disconnected'), AbortSignal.timeout(5_000))

      const session = await stored()
      // 唯一判据：活着的 run 收到 turn-end 之后，不许还挂着上一轮那条永久消费标记。
      // 现状（反例 1 未修）会让它原样留下 'submission-turn-0'，于是此后每条 prompt 永久撞
      // AGENT_PROMPT_READINESS_CONSUMED，而 writeAgentInput 裸键入仍能打字——教科书式第 2 类被写成第 1 类。
      expect(
        session?.terminalPromptReadiness?.consumedBySubmissionId,
        '断线期间的 turn-end 没有重铸/清理消费标记——活着的 Agent 被我们的记账永久锁死发送面（红线违规）'
      ).toBeUndefined()
      // 第二半：重铸出来的 epoch 必须带着**真实**光标。上面那条断言只看「消费标记没了」，
      // 把光标换成编造的 0 它照样绿——而编造 0 会让 screenEvidence 从头扫、把上一轮的提示符
      // 认成这一轮的，于是在 Agent 没就绪时放行 prompt。所以这一档要单独钉住。
      expect(
        session?.terminalPromptReadiness?.outputCursorBytes,
        '重铸的 epoch 用了编造的光标而不是会话最后一次权威 outputCursorBytes'
      ).toBe(512)
    } finally {
      await client.dispose()
    }
  })

  it('turn 中途的 hook（tool-use-start）绝不许清掉消费标记——Agent 还没交还控制权（防解锁到生成中）', async () => {
    // 反例 1 的修复只该在 **turn-end** 触发；断线臂的判据是 `lifecycleEvent === 'turn-end'`，不是
    // 「stopRun 为 null」。后者对**每一条**非 turn-end 事件都为真——一次 PreToolUse（tool-use-start）
    // 的 stopRun 也是 null。若断线臂只判 consumedBySubmissionId，这条 mid-turn hook 会把已消费纪元
    // 重铸成未消费，等于在 Agent 仍在生成、还没把控制权交还时就解锁了发送面（empty-composer 陷阱同族：
    // 生成中途放行 prompt 会打断当轮）。turn-end 才是「交还控制权」的唯一信号。
    //
    // 这条与上一条互为相反两侧（守卫按出口数不按条件数）：上一条钉「turn-end 必须清」，这条钉
    // 「非 turn-end 必须不清」。删掉 gate 里的 `lifecycleEvent === 'turn-end' &&`，这条即红。
    const { client, internals, stored } = await harness()
    try {
      disconnectKernel(internals)
      // mid-turn hook 落在断线期间也不许抛（第 2 类：Agent 活着）。
      await internals.acceptHookEvent(midTurnHook('receipt-mid-turn'), AbortSignal.timeout(5_000))

      const session = await stored()
      expect(
        session?.terminalPromptReadiness?.consumedBySubmissionId,
        'turn 中途的 hook 清掉了消费标记——在 Agent 还没交还控制权时解锁了发送面（会打断正在跑的 turn）'
      ).toBe('submission-turn-0')
    } finally {
      await client.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // 报错收尾（`StopFailure`）与正常收尾（`Stop`）同族：两者都在报错/成功时**互斥地**收尾，
  // 都经全局合并方言表归一成同一个 canonical `turn-end`（agent-hook-event.ts:84；lookup 不按
  // Provider 门控，:361-365）。而 client 的重铸判据取的正是 `lifecycleEvent === 'turn-end'`
  // （不是字面 `Stop`、不是 semanticState），所以**报错收尾的活 Agent 必须与正常收尾一样能恢复**。
  //
  // 为什么这一档没被上面三条覆盖：它们全用 `Stop`。把重铸臂从 canonical `turn-end` 收窄成
  // `eventName === 'Stop'` 会让上面三条继续全绿，唯独报错收尾这条永久锁死——这正是本组要挡的
  // 「数符号名守不住别的拼法／turn-end 的第二拼法」缺陷形状。
  //
  // 结论（世界 A）：`StopFailure` 归一到 `turn-end`，走同一条重铸臂，报错收尾**不**会造成永久锁死。
  // 前提是「报错收尾确实产生一条能归一到 turn-end 的 hook 事件」——对 claude/kimi/grok 由第一方
  // 证据成立（claude.ts:26、kimi.ts:34、agent-hook-event.ts:179）。codex 只声明 `Stop`
  // （codex.ts:13/30/39），其报错收尾**发什么事件**没有第一方证据（评论区无 codex hook 小节）；
  // 但摄入侧不按声明门控：codex 若真发 `StopFailure`，它照样归一成 turn-end 并在此恢复；codex 若
  // 报错时**什么都不发**，则落到 15 分钟通用衰减（agent-status-freshness.ts），那是另一类缺口、
  // 与本纪元记账无关，不在本文件判据面内。
  // -------------------------------------------------------------------------
  it('内核健康：报错收尾（StopFailure）与正常收尾一样续期（证明 turn-end 的第二拼法也被认）', async () => {
    const { client, internals, stored } = await harness()
    try {
      await internals.acceptHookEvent(stopFailureHook('receipt-failure-healthy'), AbortSignal.timeout(5_000))
      const session = await stored()
      expect(
        session?.terminalPromptReadiness?.consumedBySubmissionId,
        '报错收尾没有续期——重铸臂只认字面 Stop、对 StopFailure 失明（turn-end 第二拼法未覆盖）'
      ).toBeUndefined()
    } finally {
      await client.dispose()
    }
  })

  it('内核断线 + 报错收尾：活着的 Agent 报错收尾也绝不许被永久锁死发送面（P0 同族，第二拼法）', async () => {
    const { client, internals, stored } = await harness()
    try {
      disconnectKernel(internals)
      // 报错收尾落在断线期间同样不许抛（第 2 类：Agent 活着，坏的只有取光标那一步）。
      await internals.acceptHookEvent(stopFailureHook('receipt-failure-disconnected'), AbortSignal.timeout(5_000))

      const session = await stored()
      expect(
        session?.terminalPromptReadiness?.consumedBySubmissionId,
        '断线期间的报错收尾没有重铸/清理消费标记——报错后的活 Agent 被记账永久锁死发送面（红线违规）'
      ).toBeUndefined()
      // 与正常收尾同一档：重铸的 epoch 必须带真实光标，不是编造的 0。
      expect(
        session?.terminalPromptReadiness?.outputCursorBytes,
        '报错收尾重铸的 epoch 用了编造的光标而不是会话最后一次权威 outputCursorBytes'
      ).toBe(512)
    } finally {
      await client.dispose()
    }
  })
})
