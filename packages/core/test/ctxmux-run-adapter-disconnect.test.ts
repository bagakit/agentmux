import { describe, expect, it, vi } from 'vitest'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

// 单 daemon 语义：一条 attachment 的流断了 = 我们与 daemon 的唯一实时通道没了。这里守的是掉线检测的
// Layer 1：pump 收尾判为 connection-lost 时，必须 (1) 通知 onConnectionLost 的 listener，(2) 让
// isConnected() 从此如实报 false——它此前只 return this.client!==null，若掉线不置空 client 就会一直
// 撒谎「还连着」，把控制请求投进一个死掉的 kernel。
//
// 直接驱动私有 pump（vitest 只转译不查类型）：attach() 需要真 client 的整套 snapshot，而这里要守的判据
// 全在 pump 收尾 + markConnectionLost 上，用可控的 fake attachment 精确触发那两条流结局，不引真 daemon、
// 不引概率性挂起。
function fakeAttachment(events: () => AsyncGenerator<never, void, void>) {
  return { events, close: vi.fn() }
}

async function* throwsImmediately(): AsyncGenerator<never, void, void> {
  throw new Error('wire closed')
}

async function* endsCleanWithoutTerminalEvent(): AsyncGenerator<never, void, void> {
  // daemon 优雅关流，但从没发过 exited/interrupted——run 的下场无人交代。历史缺陷正是这一支。
  return
}

function primeConnectedWithAttachment(adapter: CtxmuxRunAdapter, runId: string, attachment: unknown) {
  const token = Symbol(runId)
  // 装成「已连接、且我们拥有这个 run 的 attachment」：client 必须非空，markConnectionLost 才会真正
  // 拆连接（它对 client===null 幂等早退）。
  ;(adapter as unknown as { client: unknown }).client = { closed: false }
  ;(adapter as unknown as { attachments: Map<string, unknown> }).attachments.set(runId, {
    attachment,
    token
  })
  return token
}

describe('CtxmuxRunAdapter disconnection detection', () => {
  it('marks the connection lost and turns isConnected honest when the stream throws (wire failure)', async () => {
    const adapter = new CtxmuxRunAdapter()
    const listener = vi.fn()
    adapter.onConnectionLost(listener)
    const attachment = fakeAttachment(throwsImmediately)
    const token = primeConnectedWithAttachment(adapter, 'run-1', attachment)

    expect(adapter.isConnected()).toBe(true)
    await (adapter as unknown as {
      pump: (r: string, t: symbol, a: unknown, d: TextDecoder) => Promise<void>
    }).pump('run-1', token, attachment, new TextDecoder())

    expect(listener).toHaveBeenCalledTimes(1)
    // 若掉线不置空 client（把 markConnectionLost 改成 no-op / 删掉 finally 里的分类调用），这条变红。
    expect(adapter.isConnected()).toBe(false)
  })

  it('marks the connection lost when the stream ends cleanly without any terminal event (the historical defect)', async () => {
    const adapter = new CtxmuxRunAdapter()
    const listener = vi.fn()
    adapter.onConnectionLost(listener)
    const attachment = fakeAttachment(endsCleanWithoutTerminalEvent)
    const token = primeConnectedWithAttachment(adapter, 'run-1', attachment)

    await (adapter as unknown as {
      pump: (r: string, t: symbol, a: unknown, d: TextDecoder) => Promise<void>
    }).pump('run-1', token, attachment, new TextDecoder())

    expect(listener).toHaveBeenCalledTimes(1)
    expect(adapter.isConnected()).toBe(false)
  })

  it('does NOT mark the connection lost when a run exits normally (clean end after a terminal event)', async () => {
    const adapter = new CtxmuxRunAdapter()
    const listener = vi.fn()
    adapter.onConnectionLost(listener)
    async function* exitsNormally(): AsyncGenerator<{ type: 'exited'; state: unknown }, void, void> {
      yield { type: 'exited', state: { type: 'exited', code: 0 } }
    }
    const attachment = fakeAttachment(exitsNormally as unknown as () => AsyncGenerator<never, void, void>)
    const token = primeConnectedWithAttachment(adapter, 'run-1', attachment)

    await (adapter as unknown as {
      pump: (r: string, t: symbol, a: unknown, d: TextDecoder) => Promise<void>
    }).pump('run-1', token, attachment, new TextDecoder())

    // 正常退出绝不能被当成掉线——否则每次退出都触发一次重连风暴。
    expect(listener).not.toHaveBeenCalled()
    expect(adapter.isConnected()).toBe(true)
  })

  it('does NOT mark the connection lost when we detached (attachment no longer owned)', async () => {
    const adapter = new CtxmuxRunAdapter()
    const listener = vi.fn()
    adapter.onConnectionLost(listener)
    const attachment = fakeAttachment(throwsImmediately)
    // 我们自己在收尾前把 attachment 换成了别人的 token：这次收尾是主动 detach，不该触发重连。
    primeConnectedWithAttachment(adapter, 'run-1', attachment)
    const staleToken = Symbol('stale')

    await (adapter as unknown as {
      pump: (r: string, t: symbol, a: unknown, d: TextDecoder) => Promise<void>
    }).pump('run-1', staleToken, attachment, new TextDecoder())

    expect(listener).not.toHaveBeenCalled()
    expect(adapter.isConnected()).toBe(true)
  })
})
