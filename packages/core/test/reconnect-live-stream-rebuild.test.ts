import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type {
  AgentMuxClientEvent,
  AgentMuxStoredAgentSession
} from '../src/types.js'

/**
 * T-001 的行为守卫：**掉线→重连成功后，每个仍在跑的 Agent Run 的实时字节泵必须被重建**。
 *
 * 缺陷（逐行核实）：`markConnectionLost()` 拆掉了每个 run 的 attachment（唯一的字节通道）。重连走
 * `reconnectLoop → open() → republishLiveRunState()`：`open()` 重挂了 kernel 事件订阅，`republish` 把每个
 * run 的状态重新发成 `running`、恢复横幅消失——但**没有任何一处重建 per-run attachment**。于是用户拿到
 * 一个「看起来活着、永远沉默」的终端：daemon 之后写的新字节到不了消费者。
 *
 * 为什么这套 fake 能真的咬住它：生产里实时字节只有一条到达路径——`attach()` 内部起的 per-run pump 读
 * `attachment.events()`，逐条喂给 adapter 那个**全局** eventListener（= `acceptKernelEvent`）。`open()` 只
 * 装那个全局 listener（sink），pump（source）只由 `attach()` 建。所以这里的 fake kernel 把这条耦合钉死：
 * `emitLive(runId, …)` 只有在该 run **存在 attachment** 时才把事件投给 sink，否则丢弃——正是「沉默终端」
 * 的形状。删掉重建那一步 ⇒ 从不 `attach` ⇒ `hasAttachment` 恒 false ⇒ `emitLive` 丢弃 ⇒ 消费者收不到
 * 重连后的字节 ⇒ 本文件红。sink 的接线（`open` 里 `onEvent`）不是被测对象、变异前后都在，故它不可能是
 * 让测试变绿的原因——判别器纯粹是那次 attach 重建。
 *
 * replay 与 live 是**互不重叠**的两条：掉线期间 daemon 缓冲的字节经 attach 快照的 `replay` 回来，attach
 * **之后**的新字节才走实时流。缺陷正是实时流那条，所以核心断言观察的是**重连完成之后**才写下的字节。
 */
type Internals = {
  kernel: FakeKernel
  registry: { load(hostId: string): Promise<void> }
  reconnectSleep: (ms: number) => Promise<void>
  connectionEpoch: number
  handleConnectionLost: (epoch: number) => void
  connected: boolean
}

type KernelDataEvent = {
  type: 'data'
  runId: string
  startByte: number
  endByte: number
  data: string
  dataBytes: Uint8Array
}

function runningRun(runId: string, overrides: Partial<CtxmuxAdapterRun> = {}): CtxmuxAdapterRun {
  return {
    runId,
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/repo',
    pid: 4321,
    state: { type: 'running' as const },
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes: 0,
    ...overrides
  }
}

/**
 * fake kernel = adapter 边界。它模拟生产里唯一那条耦合：`emitLive` 只在 run 有 attachment 时把事件投给
 * `open()` 装的那个全局 sink。`attach(runId, afterByte)` 记账并返回快照（replay = 掉线期间缓冲的字节）。
 */
class FakeKernel {
  private sink: ((event: KernelDataEvent) => void) | null = null
  private readonly attachments = new Map<string, { afterByte: number }>()
  readonly attach = vi.fn(async (runId: string, afterByte: number) => {
    const spec = this.attachSpecs.get(runId)
    if (spec?.throwOnAttach) throw spec.throwOnAttach
    this.attachments.set(runId, { afterByte })
    const run = spec?.run ?? runningRun(runId)
    const replay = (spec?.replay ?? []).map((chunk) => ({
      type: 'data' as const,
      runId,
      startByte: chunk.startByte,
      endByte: chunk.startByte + Buffer.byteLength(chunk.data),
      data: chunk.data,
      dataBytes: new Uint8Array(Buffer.from(chunk.data))
    }))
    return {
      run,
      replay,
      gap: spec?.gap ?? null
    }
  })

  private readonly attachSpecs = new Map<string, {
    run?: CtxmuxAdapterRun
    replay?: { startByte: number; data: string }[]
    gap?: { requestedAfterByte: number; firstAvailableByte: number } | null
    throwOnAttach?: Error
  }>()

  private runs: CtxmuxAdapterRun[] = []

  configureRuns(runs: CtxmuxAdapterRun[]): void {
    this.runs = runs
  }

  configureAttach(runId: string, spec: {
    run?: CtxmuxAdapterRun
    replay?: { startByte: number; data: string }[]
    gap?: { requestedAfterByte: number; firstAvailableByte: number } | null
    throwOnAttach?: Error
  }): void {
    this.attachSpecs.set(runId, spec)
  }

  /** 预置一个「已存在」的 attachment（模拟用户手动 attach 在途），走 hasAttachment 的幂等闸。 */
  preexistingAttachment(runId: string): void {
    this.attachments.set(runId, { afterByte: 0 })
  }

  attachedAfterByte(runId: string): number | undefined {
    return this.attachments.get(runId)?.afterByte
  }

  /** daemon 写新字节。只有该 run 有 attachment（泵在场）时才到达消费者——否则沉默丢弃。 */
  emitLive(runId: string, startByte: number, data: string): void {
    if (!this.attachments.has(runId)) return
    this.sink?.({
      type: 'data',
      runId,
      startByte,
      endByte: startByte + Buffer.byteLength(data),
      data,
      dataBytes: new Uint8Array(Buffer.from(data))
    })
  }

  // --- adapter 表面 ---
  isConnected = () => true
  connect = vi.fn(async () => {})
  disconnect = vi.fn(() => {})
  list = vi.fn(async () => this.runs)
  onEvent = (listener: (event: KernelDataEvent) => void) => {
    this.sink = listener
    return () => { if (this.sink === listener) this.sink = null }
  }
  onError = () => () => {}
  onConnectionLost = () => () => {}
  hasAttachment = (runId: string) => this.attachments.has(runId)
  detach = vi.fn(async (runId: string) => { this.attachments.delete(runId) })
}

function storedSession(overrides: Partial<AgentMuxStoredAgentSession> = {}): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    hookBindingId: 'binding-1',
    hookToken: 'token-1',
    outputCursorBytes: 0,
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

/**
 * 真 client + 真 registry + 真 memory store（seed 仍在跑的 Agent Session），fake kernel。`open()` 覆盖成
 * 只做真 open 里与本测试相关的两件事：装全局事件 sink、置 connected——两者都**不是**被测对象（缺陷是
 * 「没 attach 重建」，与 sink 接线无关）。被测对象是 `republishLiveRunState` 那条 attach 重建。
 */
async function fixture(sessions: AgentMuxStoredAgentSession[]): Promise<{
  client: AgentMuxClient
  events: AgentMuxClientEvent[]
  state: Internals
  kernel: FakeKernel
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  for (const session of sessions) await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store })
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => events.push(event))
  const state = client as unknown as Internals
  const kernel = new FakeKernel()
  state.kernel = kernel
  state.reconnectSleep = async () => {}
  await state.registry.load('local')
  const acceptKernelEvent = (client as unknown as {
    acceptKernelEvent: (event: KernelDataEvent) => void
  }).acceptKernelEvent.bind(client)
  ;(client as unknown as { open: (epoch: number) => Promise<void> }).open = async () => {
    // 生产 open() 在重连时做的、本测试依赖的两件事的替身：重挂全局事件 sink + 置 connected。
    kernel.onEvent((event) => acceptKernelEvent(event))
    state.connected = true
  }
  return { client, events, state, kernel }
}

function terminalOutputs(events: AgentMuxClientEvent[], runId: string): string[] {
  return events
    .filter((event): event is Extract<AgentMuxClientEvent, { type: 'terminal-output' }> =>
      event.type === 'terminal-output' && event.run.runId === runId)
    .map((event) => event.data)
}

async function driveReconnect(state: Internals, events: AgentMuxClientEvent[]): Promise<void> {
  state.handleConnectionLost(state.connectionEpoch)
  await vi.waitFor(() => {
    expect(events.some((event) => event.type === 'connection-state' && event.state === 'restored')).toBe(true)
  })
}

describe('T-001 重连后重建实时字节泵', () => {
  it('掉线→重连：重连之后写下的新字节到达消费者，且从该 run 自己的 outputCursorBytes 续上', async () => {
    // outputCursorBytes 是**测试自己选**的字面量（不从被测调用推导），resume 点必须正好等于它。
    const { events, state, kernel } = await fixture([storedSession({ outputCursorBytes: 100 })])

    kernel.configureRuns([runningRun('run-1', { latestOutputBytes: 106 })])
    // attach 快照带回掉线期间缓冲的字节 [100,106)——这是 replay 那条，用来证「不跳过掉线期间的区段」。
    kernel.configureAttach('run-1', {
      run: runningRun('run-1', { latestOutputBytes: 106 }),
      replay: [{ startByte: 100, data: 'REPLAY' }]
    })

    await driveReconnect(state, events)

    // 核心（行为判据，acceptance #1/#3）：重连**完成之后** daemon 写的新字节，必须到达消费者。这条走的是
    // 实时流（与 replay 互不重叠），只有重建出来的 pump 才能送达。删掉重建那一步 ⇒ 没有 attachment ⇒
    // emitLive 丢弃 ⇒ 这条断言红。先断这条：它是本任务的行为契约，要让它在核心变异下第一个塌。
    const before = terminalOutputs(events, 'run-1').length
    kernel.emitLive('run-1', 106, 'LIVE-AFTER-REBUILD')
    const after = terminalOutputs(events, 'run-1')
    expect(after.length).toBe(before + 1)
    expect(after).toContain('LIVE-AFTER-REBUILD')

    // resume 点正确：attach 必须从该 run 自己的 outputCursorBytes（100）续上，不重放已消费的、不留缺口。
    expect(kernel.attach).toHaveBeenCalledTimes(1)
    expect(kernel.attachedAfterByte('run-1')).toBe(100)

    // 掉线期间缓冲的字节（replay）补发到位——「不跳过区段」。
    expect(terminalOutputs(events, 'run-1')).toContain('REPLAY')
  })

  it('部分失败：一个 run 重建抛错不连累其余 run，且失败可见（发 agent-error）；无 Agent Session 的 run 跳过', async () => {
    const { events, state, kernel } = await fixture([
      storedSession({ agentSessionId: 'agent-a', run: { runId: 'run-a' } }),
      storedSession({ agentSessionId: 'agent-b', run: { runId: 'run-b' } })
    ])

    // 三个仍在跑的 run：a 会 attach 抛错，b 正常，orphan 没有 Agent Session（Q1：跳过、不 attach）。
    kernel.configureRuns([
      runningRun('run-a'),
      runningRun('run-b'),
      runningRun('run-orphan')
    ])
    kernel.configureAttach('run-a', { throwOnAttach: new Error('attach a boom') })
    kernel.configureAttach('run-b', { run: runningRun('run-b') })

    await driveReconnect(state, events)

    // b 不被 a 的失败连累：它的 attachment 建起来了，重连后的新字节照常到达。
    expect(kernel.attachedAfterByte('run-b')).toBe(0)
    kernel.emitLive('run-b', 0, 'B-LIVE')
    expect(terminalOutputs(events, 'run-b')).toContain('B-LIVE')

    // a 的失败**可见**：发了一条 agent-error（否则「全失败」与「全成功」同形，无从分辨）。
    const errorForA = events.find((event) =>
      event.type === 'agent-error' && event.agentSessionId === 'agent-a')
    expect(errorForA).toBeDefined()

    // b 接上了，就该照常被 republish 成 running——修复只跳过接不上的那个 run，不是把整段 republish
    // 关掉。这条**排在 a 的判据之前**：放在后面的话，a 那条一抛，它就成了永不执行的死代码，
    // 于是「变异下 b 仍绿」这个说法根本无从观察（审计实测指出了这一点）。b 的独立性要能被看见，
    // 就必须先于会抛的那条跑。
    const runningForB = events.find((event) =>
      event.type === 'process-state' && event.agentSessionId === 'agent-b' && event.state === 'running')
    expect(runningForB).toBeDefined()

    // 而且这条 error 必须**活到最后**。上面只证了它被发出去，那还不够：紧跟一条 `running` 的
    // process-state 就会在渲染端把它洗回「运行中」——reducer 的新鲜度判据是 `>=`
    // （session-state.ts:513），而 `run-process` 不在它的豁免来源里（只豁免 native-hook / acp）。
    // 两条事件的 observedAt 来自**两次**相邻的 Date.now()：catch 里那次在前、projectRunWith 那次在后，
    // 所以后者恒 >= 前者——同毫秒时靠 `>=` 取胜，跨毫秒时靠 `>` 就已经取胜。也就是说这个洗白与是否
    // 同刻无关，`>=` 只在同毫秒那一档才是**独有**的承重条件。用户于是看到恢复横幅消失、状态正常、
    // 输入框可写，屏幕却永远沉默——正是本文件要守的那个缺陷，换到失败分支上原样复活。
    // 判据取「a 的最后一条状态类事件」，而不是「有没有 running」：b 的 running 是对的，不能连坐。
    const lastStatefulForA = [...events]
      .filter((event) =>
        (event.type === 'agent-error' || event.type === 'process-state') &&
        event.agentSessionId === 'agent-a')
      .pop()
    expect(lastStatefulForA?.type).toBe('agent-error')

    // orphan（无 Agent Session）不 attach——只有 a、b 两个 run 被尝试过 attach。
    expect(kernel.attachedAfterByte('run-orphan')).toBeUndefined()
    expect(kernel.attach).toHaveBeenCalledTimes(2)
  })

  it('截断（daemon 逐出了游标处的字节）：照常 republish 成 running，但 OUTPUT_GAP 披露排在它之后', async () => {
    // 与上面那条失败分支是同一个缺陷的孪生：那条讲「失败被洗成正常」，这条讲「截断被洗成正常」。
    // 解法必须相反——流是活的，running 是实话，所以不能跳过 republish；要让披露活下来，只能把它
    // 排在 running **后面**。渲染端 reducer 的新鲜度判据是 `>=`（session-state.ts:513），同刻时
    // 后到者赢，所以顺序就是这里唯一的承重物。披露被洗掉会怎样，由
    // `apps/desktop/test/output-gap-disclosure-survives.test.ts` 用真 reducer 钉住；本条只钉
    // Core 发出的顺序确实是那一个。
    const { events, state, kernel } = await fixture([storedSession({ outputCursorBytes: 100 })])

    kernel.configureRuns([runningRun('run-1', { latestOutputBytes: 160 })])
    kernel.configureAttach('run-1', {
      run: runningRun('run-1', { latestOutputBytes: 160 }),
      // 游标在 100，daemon 最早还留着 140——[100,140) 这段被逐出了。
      gap: { requestedAfterByte: 100, firstAvailableByte: 140 }
    })

    await driveReconnect(state, events)

    const forAgent = events.filter((event) =>
      (event.type === 'agent-error' || event.type === 'process-state') &&
      event.agentSessionId === 'agent-1')

    // 两条都得在场：只发 running 是丢披露，只发 gap 是丢「它其实在跑」。
    const running = forAgent.findIndex((event) =>
      event.type === 'process-state' && event.state === 'running')
    const gap = forAgent.findIndex((event) =>
      event.type === 'agent-error' && event.code === 'OUTPUT_GAP')
    expect(running, '截断时没有 republish 成 running——流是活的，不该跳过').toBeGreaterThanOrEqual(0)
    expect(gap, '截断没有被披露').toBeGreaterThanOrEqual(0)

    // 承重的那条：披露必须是**后**发的。把 client.ts 里两条 publish 调回「先 gap 后 running」，
    // 这条红；而上面两条「都在场」仍绿——所以红的确实是顺序，不是缺了谁。
    expect(gap, 'OUTPUT_GAP 排在 running 之前，会被同刻的 running 洗掉，用户永远看不见')
      .toBeGreaterThan(running)
  })

  it('幂等：run 已存在 attachment（用户手动 attach 在途）时，重连不再 attach 第二次、不抛', async () => {    const { events, state, kernel } = await fixture([storedSession()])

    kernel.configureRuns([runningRun('run-1')])
    kernel.preexistingAttachment('run-1') // hasAttachment → true

    await driveReconnect(state, events)

    // 已经有 attachment 就不再重建：attach 一次都不该被调（否则会撞 ATTACHMENT_EXISTS 或泄第二条泵）。
    expect(kernel.attach).not.toHaveBeenCalled()
    // 那条既有 attachment 仍然活着——新字节照常到达。
    kernel.emitLive('run-1', 0, 'LIVE-VIA-EXISTING')
    expect(terminalOutputs(events, 'run-1')).toContain('LIVE-VIA-EXISTING')
  })
})

// ---------------------------------------------------------------------------
// T-002：输出通道断了、进程没死时，放行必须配一条可持久的告知。
//
// `resumed==='dead'` 分支刻意**跳过** republish 成 running（否则会洗掉刚发的 agent-error，见上面的
// 部分失败测试）。但那条 agent-error 会被后续会话快照的 `>=` 洗白、且只在 Activity 视图短暂存在。真正
// 欠着的是：Core 要落一条**可持久**的降级事实（`terminalOutputChannel`），渲染端据此长出「输出可能没在
// 显示，Resume 可重新附着」的服务窗——它挺过快照刷新，直到一次成功的 reattach 撤下它。
// ---------------------------------------------------------------------------

function outputChannelOf(events: AgentMuxClientEvent[], agentSessionId: string): unknown[] {
  return events
    .filter((event): event is Extract<AgentMuxClientEvent, { type: 'agent-session' }> =>
      event.type === 'agent-session' && event.session.agentSessionId === agentSessionId)
    .map((event) => event.session.terminalOutputChannel)
}

describe('T-002 输出通道断了的可持久告知', () => {
  it('重建失败：落一条 terminalOutputChannel 降级事实，说明「进程在跑、输出通道没了」', async () => {
    const { client, events, state, kernel } = await fixture([storedSession()])

    kernel.configureRuns([runningRun('run-1')])
    kernel.configureAttach('run-1', { throwOnAttach: new Error('reattach boom') })

    await driveReconnect(state, events)

    // 承重条：这条降级事实必须被发布并持久化。删掉 `publishOutputChannelSevered` 那一发，这条红。
    const persisted = client.agentSession('agent-1').terminalOutputChannel
    expect(persisted).toMatchObject({
      state: 'severed',
      mode: 'degraded',
      reason: 'reattach-failed',
      run: { runId: 'run-1' }
    })
    // 事实要走 agent-session 事件到达渲染端（这才是渲染端消费的那条投影），而不是只存进 store。
    expect(outputChannelOf(events, 'agent-1').some((fact) => fact !== undefined)).toBe(true)

    // 进程没被报成 dead：`resumed==='dead'` 仍跳过 republish 成 running（不洗掉 error），
    // 但会话本身没有被改成 exited——放行的前提是进程还活着。
    expect(client.agentSession('agent-1').run.runId).toBe('run-1')
  })

  it('成功 reattach 撤下它——恢复路径：通道又通了，服务窗消失', async () => {
    const { client, events, state, kernel } = await fixture([storedSession()])

    // 先制造降级：重连时 attach 抛错。
    kernel.configureRuns([runningRun('run-1')])
    kernel.configureAttach('run-1', { throwOnAttach: new Error('reattach boom') })
    await driveReconnect(state, events)
    expect(client.agentSession('agent-1').terminalOutputChannel).toBeDefined()

    // 用户点 Resume（走 reattachAgent → attachAgentRun 这条共享核心）：这次 attach 成功。
    kernel.configureAttach('run-1', { run: runningRun('run-1') })
    await client.reattachAgent('agent-1')

    // 承重条：一次成功的 reattach 就地清除降级事实。删掉 attachAgentRun 里的 clearOutputChannel，这条红。
    expect(client.agentSession('agent-1').terminalOutputChannel).toBeUndefined()
    // 且清除也经 agent-session 事件到达渲染端——最后一条投影里这个字段是缺席的。
    const lastFact = outputChannelOf(events, 'agent-1').at(-1)
    expect(lastFact).toBeUndefined()
  })
})
