import { describe, expect, it, vi } from 'vitest'
import { BrowserCdpSession } from '../src/main/browser-cdp-session.js'

/**
 * CDP 会话本身的判据：**接不上、被踢掉、够不着子 frame——三件事都要能说出来**。
 *
 * 为什么这一层单独测：它是唯一知道"为什么没了"的地方。上面两层（派发、manager）只能读它的结论，
 * 所以那两层的测试可以直接把结论塞进假 session——而那就完全绕过了这里的记账逻辑（实测：一条把
 * `frameAttachFailure` 的赋值删掉的变异，在派发层与 manager 层的 10 条测试下全绿）。
 * 判据必须落在被改的那一层（MEMORY「可达性要在被改的那一层核」）。
 */

type SendResult = Promise<unknown>

function fakeContents(overrides: {
  attach?: () => void
  sendCommand?: (method: string, params?: unknown, sessionId?: string) => SendResult
} = {}): any {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const contents = {
    destroyed: false,
    isDestroyed: () => contents.destroyed,
    debugger: {
      attached: false,
      listeners,
      attach: overrides.attach ?? (() => { contents.debugger.attached = true }),
      isAttached: () => contents.debugger.attached,
      detach: () => { contents.debugger.attached = false },
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return this
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener))
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of [...(listeners.get(event) ?? [])]) listener({}, ...args)
      },
      sendCommand: vi.fn(overrides.sendCommand ?? (async () => ({})))
    }
  }
  return contents
}

/** setAutoAttach 是 fire-and-forget 的，所以断言前要让出一次微任务队列。 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('接不上要说清怎么办', () => {
  it('attach 失败时点名 DevTools——那是最常见的原因，也是用户能自己解决的', () => {
    const contents = fakeContents({
      attach: () => { throw new Error('Another debugger is already attached') }
    })

    // 原样抛 CDP 那句话等于让 Agent 去猜。它必须点名一个能走通的下一步。
    expect(() => BrowserCdpSession.attach(contents)).toThrow(/DevTools/)
  })
})

describe('够不着子 frame 要记下来，不能一声不响', () => {
  it('setAutoAttach 失败时把原因留给上层读', async () => {
    const contents = fakeContents({
      sendCommand: async (method) => {
        if (method === 'Target.setAutoAttach') throw new Error('not supported on this target')
        return {}
      }
    })

    const session = BrowserCdpSession.attach(contents)
    await settle()

    // 不记的话，跨域 iframe 一个都不会被枚举，而快照的 missingFrames 只在**尝试过**某个 frame
    // 时才写入——两者一叠，Agent 读到的是"这页没有 iframe"，而真相是"有，我们够不着"。
    expect(session.frameDiscoveryFailure, '够不着子 frame 却没记账——上层无从分辨"没有"和"看不见"')
      .toMatch(/not supported on this target/)
    session.detach()
  })

  it('反向的一半：setAutoAttach 正常时不许凭空报失败', async () => {
    // 少了这条，一个"永远记一条失败"的实现会让上面那条全绿——而那等于每张快照都自称有洞。
    const session = BrowserCdpSession.attach(fakeContents())
    await settle()

    expect(session.frameDiscoveryFailure, 'attach 好好的却报够不着——狼来了').toBeNull()
    session.detach()
  })
})

describe('被踢掉之后不许再假装在工作', () => {
  it('detach 事件之后，每一次 send 都说清是谁踢的、以及什么都没跑', async () => {
    const contents = fakeContents()
    const session = BrowserCdpSession.attach(contents)
    await settle()

    // 正常时发得出去。先证这一点，否则下面的红可能只是因为 send 从来就不通。
    await expect(session.send('Runtime.evaluate')).resolves.toBeDefined()

    contents.debugger.emit('detach', 'devtools opened')

    // 不判的话，Agent 收到的是一句 "Debugger is not attached"——既没说是谁踢的，也没说怎么办，
    // 于是它只会重试，而页面上可能已经点过一次了。
    await expect(session.send('Runtime.evaluate')).rejects.toThrow(/DevTools/)
    expect(session.endedReason, '没记下被踢的原因').toBe('devtools opened')
  })

  it('页面在跑的过程中被关掉，同样说得出来', async () => {
    const contents = fakeContents()
    const session = BrowserCdpSession.attach(contents)
    await settle()
    contents.destroyed = true

    await expect(session.send('Runtime.evaluate')).rejects.toThrow(/closed/i)
  })
})

describe('收摊要摘干净', () => {
  it('detach 之后 debugger 上不留监听', async () => {
    const contents = fakeContents()
    const session = BrowserCdpSession.attach(contents)
    await settle()
    expect(contents.debugger.listeners.get('detach') ?? [], '压根没挂上监听——这条在对空气生效')
      .not.toHaveLength(0)

    session.detach()

    for (const event of ['detach', 'message']) {
      expect(contents.debugger.listeners.get(event) ?? [], `${event} 的监听没摘掉`).toHaveLength(0)
    }
    expect(contents.debugger.isAttached(), 'debugger 还挂着——用户此后打不开这页的 DevTools').toBe(false)
  })

  it('已经被踢掉了也照样摘监听，且不重复 detach', async () => {
    const contents = fakeContents()
    const session = BrowserCdpSession.attach(contents)
    await settle()
    contents.debugger.emit('detach', 'devtools opened')

    session.detach()

    // 漏掉的话，每一次「跑到一半被打开 DevTools」都会留下一对永不回收的 handler。
    for (const event of ['detach', 'message']) {
      expect(contents.debugger.listeners.get(event) ?? [], `${event} 的监听没摘掉——每轮泄漏一对`)
        .toHaveLength(0)
    }
  })
})
