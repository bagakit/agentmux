import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { RECONNECT_MAX_ATTEMPTS } from '../src/ctxmux-reconnect.js'
import { RECONNECT_FLAP_BUDGET, RECONNECT_PROBATION_MS } from '../src/ctxmux-reconnect-budget.js'
import type { AgentMuxClientEvent } from '../src/types.js'

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
