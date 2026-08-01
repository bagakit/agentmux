import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { RECONNECT_MAX_ATTEMPTS } from '../src/ctxmux-reconnect.js'
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
