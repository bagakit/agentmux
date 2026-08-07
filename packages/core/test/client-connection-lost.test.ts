import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { RECONNECT_MAX_ATTEMPTS } from '../src/ctxmux-reconnect.js'
import { RECONNECT_FLAP_BUDGET, RECONNECT_PROBATION_MS } from '../src/ctxmux-reconnect-budget.js'
import type { CtxmuxAdapterObservationEvent } from '../src/ctxmux-run-adapter.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type {
  AgentMuxAgentSession,
  AgentMuxClientEvent,
  AgentMuxStoredAgentSession
} from '../src/types.js'

// Layers 2+3 的接线守卫：Core 掉线时必须 (1) 发 connection-state:lost（渲染端置 disconnected 的唯一源），
// (2) 起**有界**重连——用尽仍失败要发 connection-state:unrecoverable（响亮终局，不无限转圈），
// (3) 重连成功要按 daemon 的 list() 把每个 run 的当前状态重新发出去（重连 ≠ 状态就对了）。
//
// client 内部自建 kernel，这里把私有 kernel/registry 换成可控 fake、并覆盖 reconnectSleep 成即时，
// 从而端到端断言接线而不引真 daemon、不等真退避（vitest 只转译不查类型，允许 bracket 访问私有面）。
type Internals = {
  kernel: unknown
  registry: unknown
  reconnectSleep: (ms: number) => Promise<void>
  connectionEpoch: number
  handleConnectionLost: (epoch: number) => void
  reconnectFlaps: number
  connectionHealthySince: number
  screenEvidence: AgentScreenEvidenceStore
  promptSubmission: {
    observeReadiness(session: AgentMuxAgentSession, readiness: NonNullable<
      AgentMuxAgentSession['terminalPromptReadiness']
    >): void
  }
}

function fakeKernel(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    isConnected: () => false,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(() => {}),
    list: vi.fn(async () => []),
    onEvent: () => () => {},
    onError: () => () => {},
    onConnectionLost: () => () => {},
    ...overrides
  }
}

function captureEvents(client: AgentMuxClient): AgentMuxClientEvent[] {
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => events.push(event))
  return events
}

function internals(client: AgentMuxClient): Internals {
  return client as unknown as Internals
}

describe('AgentMuxClient connection-lost wiring', () => {
  it('publishes connection-state:lost the moment the kernel reports a lost connection', async () => {
    const client = new AgentMuxClient()
    const events = captureEvents(client)
    const state = internals(client)
    // 让重连的每次 attempt 立刻失败，且不等真退避，这样 lost→exhausted 端到端在一拍内跑完。
    state.reconnectSleep = async () => {}
    state.kernel = fakeKernel({ connect: vi.fn(async () => { throw new Error('down') }) })

    state.handleConnectionLost(state.connectionEpoch)
    // 等有界重连循环全部跑完（用尽为止）。
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'connection-state' && event.state === 'unrecoverable')).toBe(true)
    })

    const first = events[0]
    expect(first?.type).toBe('connection-state')
    if (first?.type === 'connection-state') expect(first.state).toBe('lost')
    // 掉线后 connected 必须如实报 false——requireConnected 从此拦下控制操作，不再把请求投进死掉的 kernel。
    expect((client as unknown as { connected: boolean }).connected).toBe(false)
  })

  it('gives up with connection-state:unrecoverable after a bounded number of attempts — never unbounded', async () => {
    const client = new AgentMuxClient()
    const events = captureEvents(client)
    const state = internals(client)
    state.reconnectSleep = async () => {}
    const connect = vi.fn(async () => { throw new Error('still down') })
    state.kernel = fakeKernel({ connect })

    state.handleConnectionLost(state.connectionEpoch)
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'connection-state' && event.state === 'unrecoverable')).toBe(true)
    })

    // 界的具体化：把重连改成无限重试（删 give-up / 抬 ceiling 到 Infinity），connect 会被调用远超上限、
    // 永不发 unrecoverable，本测试 waitFor 超时红。open() 每次尝试恰好调一次 kernel.connect。
    expect(connect).toHaveBeenCalledTimes(RECONNECT_MAX_ATTEMPTS)
    expect(events.filter((event) => event.type === 'connection-state' && event.state === 'restored')).toHaveLength(0)
  })

  it('on reconnect, republishes each live run state from the daemon and then emits connection-state:restored', async () => {
    const client = new AgentMuxClient()
    const events = captureEvents(client)
    const state = internals(client)
    state.reconnectSleep = async () => {}

    const liveRun = {
      runId: 'run-1',
      pid: 4321,
      state: { type: 'running' as const },
      workspacePath: '/repo',
      cols: 80,
      rows: 24,
      latestOutputBytes: 0,
      acceptedInputBytes: 0
    }
    // open() 里做很多恢复工作；这里让 open 直接成功（overriding open 是私有面），但仍要求重连成功后
    // republishLiveRunState 走真 kernel.list()。因此覆盖私有 open 为 no-op，只让 list 提供真相。
    const list = vi.fn(async () => [liveRun])
    state.kernel = fakeKernel({ list })
    ;(client as unknown as { open: (epoch: number) => Promise<void> }).open = async () => {}
    ;(state.registry as unknown) = { findByRun: () => undefined }

    state.handleConnectionLost(state.connectionEpoch)
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'connection-state' && event.state === 'restored')).toBe(true)
    })

    // 重连成功后，daemon 的 list() 权威真相被重新发成 process-state——把渲染端的 disconnected 洗回真相。
    // 若删掉 republishLiveRunState 调用，这条 process-state 不会出现，断言红。
    const republished = events.find((event) => event.type === 'process-state')
    expect(republished).toBeDefined()
    if (republished?.type === 'process-state') {
      expect(republished.run.runId).toBe('run-1')
      expect(republished.state).toBe('running')
    }
    expect(list).toHaveBeenCalled()
    // restored 必须在 republish 之后发（补发真相先于宣布恢复）。
    const restoredIndex = events.findIndex((event) => event.type === 'connection-state' && event.state === 'restored')
    const processIndex = events.findIndex((event) => event.type === 'process-state')
    expect(processIndex).toBeGreaterThanOrEqual(0)
    expect(processIndex).toBeLessThan(restoredIndex)
  })
})

/**
 * 半死 daemon 的接线守卫：接受连接、握手过、随即又关流。每一轮重连都「成功」，于是
 * `runBoundedReconnect` 那道单轮的界每次都被重置——**单轮有界不等于整体有界**。
 *
 * 这一族的判据在 `ctxmux-reconnect-budget.ts`（纯函数、单点变异都被咬住，见其测试文件）；
 * 本 describe 守的是**接线**：那个判决有没有被真的调用、有没有落在正确的位置。
 */
describe('AgentMuxClient 跨成功幸存的抖动预算（半死 daemon）', () => {
  /** 让每次重连都立刻成功的 client：open 是 no-op，list 空，退避即时。 */
  function flappingClient(): { client: AgentMuxClient; events: AgentMuxClientEvent[]; state: Internals } {
    const client = new AgentMuxClient()
    const events = captureEvents(client)
    const state = internals(client)
    state.reconnectSleep = async () => {}
    state.kernel = fakeKernel()
    ;(client as unknown as { open: (epoch: number) => Promise<void> }).open = async () => {}
    ;(state.registry as unknown) = { findByRun: () => undefined }
    return { client, events, state }
  }

  async function flapOnce(events: AgentMuxClientEvent[], state: Internals): Promise<void> {
    const before = events.length
    state.handleConnectionLost(state.connectionEpoch)
    await vi.waitFor(() => {
      // 每一轮的终局是 restored 或 unrecoverable 二者之一；等到本轮出现新的终局事件为止。
      expect(events.slice(before).some((event) =>
        event.type === 'connection-state' && (event.state === 'restored' || event.state === 'unrecoverable')
      )).toBe(true)
    })
  }

  it('反复「掉线→重连成功」到预算用尽即终局，不再无穷抖动', async () => {
    const { events, state } = flappingClient()
    // 每一轮都在缓刑期内（连续健康时间远短于 90s），所以账只增不清。
    state.connectionHealthySince = Date.now()

    for (let round = 0; round < RECONNECT_FLAP_BUDGET; round += 1) await flapOnce(events, state)
    // 预算内的每一轮都必须真的走完「lost → 重连 → restored」，用户看到的是自愈而不是终局。
    expect(events.filter((e) => e.type === 'connection-state' && e.state === 'restored'))
      .toHaveLength(RECONNECT_FLAP_BUDGET)
    expect(events.filter((e) => e.type === 'connection-state' && e.state === 'unrecoverable')).toHaveLength(0)

    // 第 BUDGET+1 次抖动跨过界：终局。若把 handleConnectionLost 里的判决删掉，这里会再来一条
    // restored、unrecoverable 永不出现，本断言红——这就是「无穷抖动 → 红」的具体化。
    await flapOnce(events, state)
    expect(events.filter((e) => e.type === 'connection-state' && e.state === 'unrecoverable')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'connection-state' && e.state === 'restored'))
      .toHaveLength(RECONNECT_FLAP_BUDGET)
  })

  it('放弃时直接发 unrecoverable，绝不再发一次 lost、也不再起重连', async () => {
    // 检查点必须在**发 lost 之前**。放进 reconnectLoop 里就晚了：那样每次抖动仍会先把整屏 Agent
    // 置灰、再白等一整轮（退避 31.5s + daemon ready + 握手）才拿到终局，抖动一次都没少。
    const { client, events, state } = flappingClient()
    state.connectionHealthySince = Date.now()
    state.reconnectFlaps = RECONNECT_FLAP_BUDGET

    const connect = vi.fn(async () => {})
    state.kernel = fakeKernel({ connect })
    state.handleConnectionLost(state.connectionEpoch)

    // 同步就该拿到终局——放弃这条路上没有任何 await。
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'connection-state', state: 'unrecoverable' })
    // 没有 lost：整屏 Agent 不该为了一个已经判死的连接再变灰一次。
    expect(events.filter((e) => e.type === 'connection-state' && e.state === 'lost')).toHaveLength(0)
    // 没有重连尝试：kernel.connect 一次都没被调。若判决被移进 reconnectLoop，这条会红。
    expect(connect).not.toHaveBeenCalled()
    // 仍要如实报未连接——requireConnected 据此拦下控制操作。
    expect((client as unknown as { connected: boolean }).connected).toBe(false)
  })

  it('连接连续健康满缓刑期后清账，长跑的偶发抖动不会攒死', async () => {
    const { events, state } = flappingClient()
    // 账面已经贴着界了，但「上次健康」远在缓刑期之前——这是一台开了很久、偶尔抖一下的机器。
    state.reconnectFlaps = RECONNECT_FLAP_BUDGET
    state.connectionHealthySince = Date.now() - RECONNECT_PROBATION_MS - 1

    await flapOnce(events, state)
    // 清账后重新起算，所以这一次仍然重连、自愈。若清账那句被删（或判据写成拿 restored 清），
    // 这台机器会在第 4 次正常抖动时被判死，本断言红。
    expect(events.filter((e) => e.type === 'connection-state' && e.state === 'restored')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'connection-state' && e.state === 'unrecoverable')).toHaveLength(0)
    // 清零后本次记 1，不是 BUDGET+1。
    expect(state.reconnectFlaps).toBe(1)
  })

  it('open() 成功会写下缓刑期起点——否则这道界是死代码', async () => {
    // `connectionHealthySince` 停在 0 时，`now - 0` 必然超过缓刑期，于是每次掉线都无条件清账，
    // 跨成功的账永远攒不起来。这条钉住「首次连接也算连接变健康」这个写入点。
    //
    // 这里走的是**真的** `open()`（不像上面几条覆盖掉它），因为要证的恰恰是写入点落在 open 的
    // 成功尾部：覆盖掉 open 再断言这个字段，等于断言测试自己写的那一行。代价是要把 registry 的
    // 协作面 fake 齐——那是协作者，不是被测对象。
    const client = new AgentMuxClient()
    const state = internals(client)
    state.kernel = fakeKernel({ isConnected: () => false })
    ;(state.registry as unknown) = {
      async claimStaleLifecycles() { return [] },
      async load() {},
      list: () => [],
      findByRun: () => undefined,
      isRetiredRun: () => false
    }

    expect(state.connectionHealthySince).toBe(0)
    // 起点必须是**此刻**，不能是任意非零常量。`> 0` 单独一条挡不住这一族：写成 `= 1` 时
    // `shouldClearFlapLedger(1, now)` 恒真（now - 1 远超缓刑期），账每次掉线都被清空，整道界重新变
    // 成死代码——而那正是这个字段存在的全部理由。实测把写入点改成 `= 1`，本文件与纯函数那套 14 条
    // 全绿。所以这里夹在调用前后的时间窗里判。
    const before = Date.now()
    await client.connect()
    const after = Date.now()
    expect(state.connectionHealthySince).toBeGreaterThanOrEqual(before)
    expect(state.connectionHealthySince).toBeLessThanOrEqual(after)
  })

  it('open() 在 connect() 之后失败时也不许写下起点——半死 daemon 不是健康的连接', async () => {
    // 判据不是「connect() 抛了没写」——那个位置太靠前，写在它后面一行同样能过。要证的是起点落在
    // open() 的**成功尾部**：`kernel.connect()` 已经返回（wire 通了），但后续恢复工作失败。这正是
    // 半死 daemon 的形状——接受连接、随即关流。
    //
    // 若起点被写在 connect() 之后、恢复工作之前，一台每轮都在这里失败的 daemon 会每轮刷新起点，
    // 于是 `shouldClearFlapLedger` 每轮为真、账每轮清零，预算永不累积，unrecoverable 永不到来——
    // 即 #159 那个缺陷原样复活。实测把写入点上移到 connect() 之后，本条会红。
    const client = new AgentMuxClient()
    const state = internals(client)
    state.kernel = fakeKernel({
      isConnected: () => false,
      // connect 成功，list 失败：wire 通了、daemon 随即不干活。
      list: vi.fn(async () => { throw new Error('stream closed') })
    })
    ;(state.registry as unknown) = {
      async claimStaleLifecycles() { return [] },
      async load() {},
      list: () => [],
      findByRun: () => undefined,
      isRetiredRun: () => false
    }

    await expect(client.connect()).rejects.toThrow('stream closed')
    expect(state.connectionHealthySince).toBe(0)
  })

  it('open() 抛出时不许写下缓刑期起点——失败的连接不是健康的连接', async () => {
    // 最靠前那个出口：wire 根本没通。上面那条守的是「通了但没干完活」，两条一起把整条 open 夹住。
    const client = new AgentMuxClient()
    const state = internals(client)
    state.kernel = fakeKernel({
      isConnected: () => false,
      connect: vi.fn(async () => { throw new Error('daemon refused') })
    })

    await expect(client.connect()).rejects.toThrow('daemon refused')
    expect(state.connectionHealthySince).toBe(0)
  })
})

/**
 * #628 后半：**线断了 ⇒ 长命的屏幕观察当场失效**。
 *
 * 缺陷机制（三段，缺一不成立）：
 * 1. 掉线时 `observeOutput` 的排空循环把错误交给 adapter 那个**全局** errorListener，而不是交给某次
 *    观察自己的 listener。于是屏幕证据永远不会 `fail()`。
 * 2. `AgentScreenEvidenceStore.ensure()` 复用旧 entry 的条件是 `runId 相同 && !evidence.failed`——一具
 *    没被标记 failed 的死证据恰好满足它。
 * 3. `markConnectionLost()` 已经把那条 Attachment `.close()` 掉了，再没有新字节进来。
 *
 * 合起来：重连时握手路径那次重挂会重新挂到同一具尸体上，照旧永等；readiness 卡在 pending，此后每条
 * prompt 被 AGENT_PROMPT_NOT_READY 拒掉，且没有任何出路（#238）。
 *
 * 为什么要**两条**不同的判据、而不是一条「等待有没有被结束」：`notify()` 是同步的，所以
 * `cancelAllReadiness()` 与 `discardAll()` **单独任何一个**都足以让挂着的 wait 立刻 settle。只钉「settle
 * 了」等于只守住其中一个调用，另一个可以被删掉而全绿。两者各自承重的东西不同：
 *
 * - `discardAll()` 买的是**重建**：它把 entry 从表里删掉，所以下一次 `ensure()` 必须重新
 *   `observeOutput`。只 cancel 不 discard 时，尸体还在表里，重连后照旧复用它——这才是「重连也修不好」
 *   的那一半。判据 = 下一次观察的 `observeOutput` 调用数上涨。
 * - `cancelAllReadiness()` 买的是**取消表的干净**：`observeReadiness` 的 `.catch` 撞上
 *   AGENT_PROMPT_READINESS_CANCELLED 时**提前 return、不删表项**（prompt-submission.ts 那条早退）。
 *   于是只 discard 不 cancel 时，那条 cancel 闭包连同它的 AbortController 永久留在
 *   `readinessCancels` 里——Session 生命周期结束也不回收。判据 = 掉线后取消表为空。
 *
 * 这后一条读的是私有表本身，因为它就是那件事：两个调用产生的**事件序列完全相同**（都走
 * CANCELLED，都被 `.catch` 吞掉），除了这张表没有别的可观测差异。本文件其余用例同样按 bracket 访问
 * 私有面，这里不额外破例。
 */
describe('#628 掉线让屏幕证据与 readiness 观察一起失效', () => {
  function readinessStoredSession(): AgentMuxStoredAgentSession {
    return {
      kind: 'agent',
      agentSessionId: 'readiness-agent',
      providerId: 'codex',
      executorId: 'codex',
      hostId: 'local',
      workspacePath: '/tmp/readiness-agent',
      run: { runId: 'readiness-run' },
      retiredRuns: [],
      hookBindingId: 'binding-readiness',
      hookToken: 'token-readiness',
      outputCursorBytes: 0,
      // 未就绪的观察：只有边界，没有 readyThroughByte。这正是 #628 卡住的那个状态。
      terminalPromptReadiness: {
        source: 'initial-composer',
        id: 'readiness-epoch-1',
        run: { runId: 'readiness-run' },
        outputCursorBytes: 0
      },
      createdAt: 100,
      updatedAt: 100
    }
  }

  /**
   * 真 client + 真 AgentScreenEvidenceStore + 真 registry；只把 kernel 的三个协作方法换成 fake
   * （observeOutput 计次、list 空、connect 无副作用），并把 `open()` 换成 no-op 让重连在无 daemon 下
   * 也能「成功」。屏幕证据的失效逻辑是被测对象，绝不 stub 掉它——否则钉的是测试自己写的那一行。
   *
   * `observeOutput` 的**握手可闸**（`releaseHandshake`）是本组用例的关键：掉线相对这次握手的落点
   * 决定了两条完全不同的路径，而它们各自需要不同的产品代码守着（见下面两条用例的注释）。用真实时序
   * 去「碰巧」落到某一条上是不可复现的——事实上本组第一版就是这么写的：它等的是 `observeCalls === 1`，
   * 而计次发生在**进入** fake 时，于是每一次运行都恰好落在握手在途那一侧，表现为整条用例挂死。
   */
  async function readinessClient(): Promise<{
    state: Internals
    session: AgentMuxAgentSession
    waiter: AgentScreenEvidenceStore
    observeCalls: () => number
    openObservations: () => number
    releaseHandshake: () => void
    park: (timeoutMs: number) => Promise<number>
  }> {
    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, readinessStoredSession())
    const client = new AgentMuxClient({ store })
    const state = internals(client)
    state.reconnectSleep = async () => {}
    await (state.registry as { load(hostId: string): Promise<void> }).load('local')

    let observeCalls = 0
    let openObservations = 0
    // 握手闸：默认就装好，用例按需 release。默认闸住而不是默认放行，是因为「掉线落在握手在途」
    // 那一侧才是此前无人守的路径——默认值要落在更容易漏的那一边。
    let openHandshakeGate: () => void = () => {}
    const handshakeGate = new Promise<void>((resolve) => { openHandshakeGate = resolve })
    const kernel = state.kernel as Record<string, unknown>
    kernel.observeOutput = async () => {
      observeCalls += 1
      await handshakeGate
      openObservations += 1
      return {
        run: {
          runId: 'readiness-run',
          lifecycleOperationId: null,
          program: 'codex',
          args: [],
          workspacePath: '/tmp/readiness-agent',
          pid: 321,
          state: { type: 'running' as const },
          cols: 80,
          rows: 24,
          latestOutputBytes: 0,
          firstAvailableByte: 0,
          acceptedInputBytes: 0
        },
        // 空重放：屏幕上没有 composer 帧，所以任何 readiness 观察都会停在 pending——
        // 「屏幕永不再变」在生产上就是这个形状。
        replay: [] as CtxmuxAdapterObservationEvent[],
        gap: null,
        close: async () => {}
      }
    }
    kernel.list = async () => []
    ;(client as unknown as { open: (epoch: number) => Promise<void> }).open = async () => {}

    const session = (state.registry as {
      get(agentSessionId: string): AgentMuxStoredAgentSession
    }).get('readiness-agent') as AgentMuxAgentSession
    const waiter = state.screenEvidence
    return {
      state,
      session,
      waiter,
      observeCalls: () => observeCalls,
      // 「握手真的回来了几次」——与 observeCalls（发起了几次）分开数，闸住时两者会差一。
      openObservations: () => openObservations,
      releaseHandshake: () => { openHandshakeGate() },
      // 一次永不满足的观察，走的是生产同一个 store.wait()。预算由调用方给：**挂着**那一次要给到
      // 远超测试时长（不靠「没有上界」这件事，好让本条与前半那道 timeout 守卫互不依赖），而掉线后
      // 用来数 observeOutput 的那一次要给一个短预算——它同样永不满足，只是这里要的是「它重挂了没有」
      // 而不是「它等多久」。
      park: (timeoutMs: number) => waiter.wait(session, 0, true, () => false, {
        timeoutMs,
        timeoutMessage: 'fixture screen never settles',
        terminalMessage: 'fixture exit'
      })
    }
  }

  function readinessCancels(state: Internals): Map<string, () => void> {
    return (state.promptSubmission as unknown as {
      readinessCancels: Map<string, () => void>
    }).readinessCancels
  }

  /**
   * 掉线前先把两样都挂上：一次生产 readiness 观察（进取消表），一次挂起的 store.wait（可断言 settle）。
   *
   * 等的是 `openObservations`（握手**回来**了）而不是 `observeCalls`（握手**发出**了）：证据要在掉线前
   * 真的登记进 `evidence` 表，本组前三条用例钉的才是「已登记的证据被作废」。数发起次数会让等待在握手
   * 仍闸着时就返回，于是三条用例全部漂到第四条那个交错上去。
   */
  async function armParkedObservation(fixture: Awaited<ReturnType<typeof readinessClient>>): Promise<{
    parked: Promise<number>
  }> {
    fixture.state.promptSubmission.observeReadiness(
      fixture.session,
      fixture.session.terminalPromptReadiness!
    )
    const parked = fixture.park(600_000)
    fixture.releaseHandshake()
    // 让 ensure() 的 await 链跑完，证据建起来、两条观察都真的挂上去了再断线。
    await vi.waitFor(() => {
      expect(fixture.openObservations()).toBe(1)
      expect(readinessCancels(fixture.state).size).toBe(1)
    })
    return { parked }
  }

  /**
   * 断言一条挂起的观察真的结束了，且**失败时打出一句话**而不是让整个用例超时。
   *
   * 为什么不直接写 `await expect(parked).rejects.…`：那个形状在没人结束这条观察时会一路等到 vitest
   * 的用例预算耗尽（删掉 `discardAll()` 时实测 5004ms「测试超时」），读报告的人看不出塌的是哪条
   * 不变量。这里跟一个短哨兵赛跑：拿到哨兵就说明没人结束它，直接把 `what` 打出来。
   *
   * 顺带记一件事实（`armParkedObservation` 挂的这条 wait 不传 `signal`，与生产的 readiness 观察不同）：
   * 只有 `discardAll()` 能结束它——`discard()` 里的 `evidence.dispose()` 同步 `notify()`，`wait()` 的
   * `inspect()` 看到 `disposed` 走 `abort()`。`cancelAllReadiness()` 只 abort 生产那条观察自己的
   * signal，碰不到这一条。所以这个判据是 `discardAll` 独有的，不是两条调用共有的。
   */
  async function expectObservationCancelled(
    parked: Promise<number>,
    what: string
  ): Promise<void> {
    const stillParked = Symbol('still-parked')
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      parked.then(() => 'resolved' as const, (error: unknown) => error),
      new Promise<typeof stillParked>((resolve) => {
        timer = setTimeout(() => resolve(stillParked), 200)
      })
    ])
    if (timer) clearTimeout(timer)
    expect(outcome, what).not.toBe(stillParked)
    expect(outcome).toMatchObject({ code: 'AGENT_PROMPT_READINESS_CANCELLED' })
  }

  it('重连路：挂起的屏幕观察当场结束，且下一次观察必须重建而不是复用尸体', async () => {
    const fixture = await readinessClient()
    const { parked } = await armParkedObservation(fixture)

    fixture.state.handleConnectionLost(fixture.state.connectionEpoch)

    // 判据 0（用户看得见的症状）：那条永等的观察不再永等。它由 discardAll 独有（见
    // `expectObservationCancelled` 的说明：本条挂的 wait 不带 signal，cancelAllReadiness 碰不到它），
    // 所以它与判据 A 守的是同一条调用的两个后果——症状消失，和证据真的被撤下来。
    await expectObservationCancelled(
      parked,
      '掉线后那条挂起的屏幕观察仍然挂着：没人 dispose 它，用户侧就是 prompt 永久发不出去'
    )

    // 判据 A（只有 discardAll 能满足）：下一次观察必须重新 observeOutput。删掉 discardAll 时，
    // ensure() 会复用那具 failed=false 的尸体，这里仍是 1——重连后 readiness 照旧永等（#238）。
    // 这一次给 10ms 预算：本条要的是「它重挂了没有」，不是「它等多久」，所以让它自己超时收场，
    // 别在测试里留一条悬着的 rejection。
    await expect(fixture.park(10)).rejects.toBeDefined()
    expect(
      fixture.observeCalls(),
      '掉线后的下一次观察复用了旧 entry：ensure() 的复用闸看的是 evidence.failed，而掉线不会置位它'
    ).toBe(2)

    // 判据 B（只有 cancelAllReadiness 能满足）：取消表清空。删掉它时，observeReadiness 的 .catch
    // 撞 CANCELLED 提前 return、不删表项，那条闭包与它的 AbortController 永久留着。
    expect(
      readinessCancels(fixture.state).size,
      'readinessCancels 仍留着掉线前那条 cancel：观察已经死了，表项不会自己回收'
    ).toBe(0)
  })

  it('放弃路（give-up）同样作废——否则用户手动 Resume 时还是撞上那具尸体', async () => {
    // 检查点必须在 give-up 判决**之前**（两条出口共用）。把这对调用挪到 reconnecting 那一侧之后，
    // 本条会红：连接判死时不作废，而恢复入口（SessionPane 的 Resume）恰恰走的是判死之后那条路。
    const fixture = await readinessClient()
    fixture.state.connectionHealthySince = Date.now()
    fixture.state.reconnectFlaps = RECONNECT_FLAP_BUDGET
    const { parked } = await armParkedObservation(fixture)

    fixture.state.handleConnectionLost(fixture.state.connectionEpoch)

    await expectObservationCancelled(
      parked,
      'give-up 这条出口没有结束挂起的观察：判死之后走 Resume 的用户会撞上同一具尸体'
    )
    await expect(fixture.park(10)).rejects.toBeDefined()
    expect(fixture.observeCalls(), 'give-up 这条出口没有作废屏幕证据').toBe(2)
    expect(readinessCancels(fixture.state).size, 'give-up 这条出口没有清取消表').toBe(0)
  })

  it('连接健康时不作废任何观察——作废是掉线的后果，不是定时卫生', async () => {
    // 反向自证：上面两条断言的是「掉线后归零」，而一个无条件在别处也作废的实现同样能过。这条把
    // 前提带进场——没有掉线事件时，挂起的观察必须仍然挂着、取消表必须仍然有那一项。
    // epoch 不匹配是 handleConnectionLost 最靠前的出口（并发的旧世代回调走的正是它）。
    const fixture = await readinessClient()
    const { parked } = await armParkedObservation(fixture)
    let settled = false
    void parked.catch(() => { settled = true })
    fixture.state.handleConnectionLost(fixture.state.connectionEpoch - 1)
    await Promise.resolve()

    expect(settled, '陈旧世代的掉线回调作废了当前连接的观察').toBe(false)
    expect(readinessCancels(fixture.state).size).toBe(1)
    expect(fixture.observeCalls(), '没有掉线也重建了证据：那次重放是白付的').toBe(1)
  })

  it('掉线落在 observeOutput 握手在途时，那次握手的产物不许被登记（否则留下一具挂在死线上的尸体）', async () => {
    // 上面三条钉的是「**已登记**的证据被作废」。这一条是另一条路径：`discardAll()` 只能撤回已登记的
    // entry，而一次 build() 从发出 observeOutput 到拿到 Attachment 之间是异步的。掉线落在这段窗口里时，
    // 作废看到的表还是空的，随后握手返回、build() 把一具挂在**已死连线**上的证据登记进去。它的
    // `failed` 是 false（掉线只经 adapter 的全局 errorListener，不会置位本次观察），于是 ensure() 的
    // 复用闸认为它可用，此后每一次观察都复用这具尸体、永远等不到字节——正是 #628 要修掉的症状本身，
    // 只是换了个交错。而「半死 daemon」恰恰就是让握手悬在途中的那种故障，所以这不是理论缝隙。
    //
    // 判据取「重建」而不是「那次 wait 拒绝了」：拒绝可以由 cancelAllReadiness 单独满足，而尸体是否被
    // 登记只有下一次 ensure 会不会重新 observeOutput 才看得出来。
    const fixture = await readinessClient()
    fixture.state.promptSubmission.observeReadiness(
      fixture.session,
      fixture.session.terminalPromptReadiness!
    )
    await vi.waitFor(() => {
      // 握手已发出、仍闸着：这正是那段窗口。
      expect(fixture.observeCalls()).toBe(1)
      expect(fixture.openObservations()).toBe(0)
    })

    fixture.state.handleConnectionLost(fixture.state.connectionEpoch)
    // 掉线之后才放行握手——顺序就是这条用例的全部内容。
    fixture.releaseHandshake()
    await vi.waitFor(() => { expect(fixture.openObservations()).toBe(1) })

    await expect(fixture.park(10)).rejects.toBeDefined()
    expect(
      fixture.observeCalls(),
      '在途握手的产物被登记了：掉线时它还不在表里，作废撤不到它，于是 ensure() 复用了一具挂在死线上的证据'
    ).toBe(2)
  })
})
