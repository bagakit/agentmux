import { createBrowserPageDispatch } from '@agentmux/browser/page'
import { nativeInputDouble } from './browser-native-input-double.js'
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
  it('only iframe targets become document senders; workers are not missing page documents', async () => {
    const contents = fakeContents()
    const session = BrowserCdpSession.attach(contents)
    contents.debugger.emit('message', 'Target.attachedToTarget', { sessionId: 'worker', targetInfo: { type: 'worker' } })
    contents.debugger.emit('message', 'Target.attachedToTarget', { sessionId: 'frame', targetInfo: { type: 'iframe' } })
    await settle()
    expect([...session.frames.keys()]).toEqual(['frame'])
    expect(session.frameDiscoveryFailure).toBeNull()
    session.detach()
  })

  it('nested attachment failure is reported without losing the readable parent sender', async () => {
    const contents = fakeContents({ sendCommand: async (method, _params, sessionId) => {
      if (method === 'Target.setAutoAttach' && sessionId) throw new Error('nested discovery unavailable')
      return {}
    } })
    const session = BrowserCdpSession.attach(contents)
    contents.debugger.emit('message', 'Target.attachedToTarget', { sessionId: 'frame', targetInfo: { type: 'iframe' } })
    await settle()
    expect([...session.frames.keys()]).toEqual(['frame'])
    expect(session.frameDiscoveryFailure).toEqual(expect.stringMatching(/Nested.*nested discovery unavailable.*Retry/))
    await expect(session.frames.get('frame')!('Accessibility.getFullAXTree')).resolves.toEqual({})
    session.detach()
  })

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
    await expect(session.sendCommand('Runtime.evaluate')).resolves.toBeDefined()

    contents.debugger.emit('detach', 'devtools opened')

    // 不判的话，Agent 收到的是一句 "Debugger is not attached"——既没说是谁踢的，也没说怎么办，
    // 于是它只会重试，而页面上可能已经点过一次了。
    await expect(session.sendCommand('Runtime.evaluate')).rejects.toThrow(/DevTools/)
    expect(session.endedReason, '没记下被踢的原因').toBe('devtools opened')
  })

  it('页面在跑的过程中被关掉，同样说得出来', async () => {
    const contents = fakeContents()
    const session = BrowserCdpSession.attach(contents)
    await settle()
    contents.destroyed = true

    await expect(session.sendCommand('Runtime.evaluate')).rejects.toThrow(/closed/i)
  })
})

describe('收摊要摘干净', () => {
  it('destroyed contents 不再访问 dead debugger，仍释放本轮 frame 和观察者', async () => {
    const contents = fakeContents()
    const session = BrowserCdpSession.attach(contents)
    contents.debugger.emit('message', 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } })
    expect(session.frames.size).toBe(1)
    const observed = vi.fn()
    session.observe(observed)
    const debuggerWrapper = contents.debugger
    contents.destroyed = true
    Object.defineProperty(contents, 'debugger', { get: () => { throw new Error('Object has been destroyed') } })
    expect(session.detach()).toBeNull()
    expect(session.frames.size).toBe(0)
    debuggerWrapper.emit('message', 'Runtime.consoleAPICalled', {})
    expect(observed).not.toHaveBeenCalled()
  })

  it('活页面 cleanup 失败保留明确告示，同时完成其余清理', () => {
    const contents = fakeContents()
    const session = BrowserCdpSession.attach(contents)
    contents.debugger.off = () => { throw new Error('listener removal unavailable') }
    expect(session.detach()).toEqual(expect.stringMatching(/cleanup.*listener removal unavailable.*result is retained/))
    expect(contents.debugger.isAttached()).toBe(false)
    expect(session.frames.size).toBe(0)
  })

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

  it('observers learn which child frame session an event came from; the page itself has none', async () => {
    // A file chooser in a cross-site frame arrives on that frame's session and must be answered there.
    const contents = fakeContents()
    const session = BrowserCdpSession.attach(contents)
    await settle()
    const seen: [string, string | undefined][] = []
    session.observe((method, _params, sessionId) => { seen.push([method, sessionId]) })
    contents.debugger.emit('message', 'Page.fileChooserOpened', { backendNodeId: 2 }, 'child-frame')
    contents.debugger.emit('message', 'Page.javascriptDialogOpening', { type: 'alert' }, '')
    contents.debugger.emit('message', 'Page.loadEventFired', {})
    expect(seen).toEqual([['Page.fileChooserOpened', 'child-frame'], ['Page.javascriptDialogOpening', undefined], ['Page.loadEventFired', undefined]])
  })
})

describe('Profile environment and page programs share the original connection', () => {
  it('releases only the exact consumer and its event subscriptions until the final lease ends', async () => {
    const c = fakeContents(), environment = BrowserCdpSession.attach(c), page = BrowserCdpSession.attach(c)
    const originalAttach = c.debugger.listeners.get('detach')
    expect(originalAttach).toHaveLength(1)
    const environmentEvent = vi.fn(), pageEvent = vi.fn()
    environment.observe(environmentEvent); page.observe(pageEvent)
    c.debugger.emit('message', 'Target.attachedToTarget', { sessionId: 'frame', targetInfo: { type: 'iframe' } })
    const expiredFrame = page.frames.get('frame')!
    page.detach(); page.detach()
    expect(c.debugger.isAttached()).toBe(true)
    c.debugger.emit('message', 'Runtime.consoleAPICalled', {})
    expect(environmentEvent).toHaveBeenCalledTimes(2); expect(pageEvent).toHaveBeenCalledTimes(1)
    await expect(environment.sendCommand('Runtime.evaluate')).resolves.toEqual({})
    expect(() => page.sendCommand('Runtime.evaluate')).toThrow(/lease was released/)
    expect(() => expiredFrame('Runtime.evaluate')).toThrow(/lease was released/)
    environment.detach(); expect(c.debugger.isAttached()).toBe(false)
  })
  it('late release of a detached incarnation cannot detach a new original connection', () => {
    const c = fakeContents(), old = BrowserCdpSession.attach(c)
    c.debugger.attached = false; c.debugger.emit('detach', 'devtools opened')
    const current = BrowserCdpSession.attach(c)
    old.detach(); expect(c.debugger.isAttached()).toBe(true)
    current.detach(); expect(c.debugger.isAttached()).toBe(false)
  })
})


it('the actual ref dispatcher consumes one stable child sender and refuses its replaced or released lease', async () => {
  const native=nativeInputDouble(), c=fakeContents({sendCommand:async(method,params:any,sessionId)=>{
    const answered=native.answer(method,params)
    if(answered!==undefined)return answered
    if(method==='Page.getFrameTree')return sessionId?{frameTree:{frame:{id:'child-document',loaderId:'child-loader'}}}:{frameTree:{frame:{id:'main-document',loaderId:'main-loader'},childFrames:[{frame:{id:'child-document',parentId:'main-document',loaderId:'child-loader'}}]}}
    if(method==='Accessibility.getFullAXTree')return {nodes:sessionId?[{nodeId:'field',backendDOMNodeId:11,role:{value:'textbox'},name:{value:'Child field'},childIds:[]}]:[{nodeId:'root',role:{value:'RootWebArea'},childIds:[]}]}
    if(method==='Page.createIsolatedWorld')return {executionContextId:1}
    if(method==='DOM.resolveNode')return {object:{objectId:'child-field'}}
    if(method==='Runtime.evaluate')return {result:{value:'[]'}}
    return {}
  }})
  const environment=BrowserCdpSession.attach(c), page=BrowserCdpSession.attach(c)
  c.debugger.emit('message','Target.attachedToTarget',{sessionId:'child',targetInfo:{type:'iframe'}})
  const original=page.frames.get('child')!
  const dispatch=createBrowserPageDispatch({session:page,pageInfo:()=>({url:'https://example.test/',title:'Parent',navigationId:'main-nav'}),gotoUrl:async()=>{},captureScreenshot:async()=>({}),readLedger:async()=>null,writeLedger:async()=>{},note:()=>{}})
  const snapshot=await dispatch('snapshot',[]) as import('@agentmux/browser/model').BrowserPageSnapshot
  expect(snapshot.missingFrames).toEqual([])
  const field=snapshot.nodes.find(node=>node.name==='Child field')!
  expect(field.sessionId).toBe('child')
  await dispatch('fillInput',[field.ref,'native child value'])
  expect(native.typed.map(row=>row.text)).toEqual(['native child value'])
  expect(page.frames.get('child')).toBe(original)
  c.debugger.emit('message','Target.detachedFromTarget',{sessionId:'child'})
  c.debugger.emit('message','Target.attachedToTarget',{sessionId:'child',targetInfo:{type:'iframe'}})
  const before=c.debugger.sendCommand.mock.calls.length
  expect(()=>original('Runtime.evaluate')).toThrow('original child document sender changed')
  expect(c.debugger.sendCommand.mock.calls).toHaveLength(before)
  const current=page.frames.get('child')!
  expect(current).not.toBe(original)
  page.detach()
  expect(()=>current('Runtime.evaluate')).toThrow('lease was released')
  await expect(environment.sendCommand('Runtime.evaluate')).resolves.toBeDefined()
  environment.detach()
})

describe('independent native network scope and original connection retention', () => {
  it('releases the last debugger only after the native detach callback unwinds', async () => {
    const contents = fakeContents({ sendCommand: async method => {
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'original-native' } }
      if (method === 'Target.attachToTarget') return { sessionId: 'original-network' }
      return {}
    } })
    const program = BrowserCdpSession.attach(contents), reader = BrowserCdpSession.attach(contents, { background: true })
    await program.openNetworkSession()
    program.detach()
    contents.debugger.emit('message', 'Target.detachedFromTarget', { sessionId: 'original-network' })
    expect(BrowserCdpSession.hasOnlyBackgroundLeases(contents)).toBe(true)
    reader.detach()
    expect(contents.debugger.isAttached()).toBe(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(contents.debugger.isAttached()).toBe(false)
  })

  it('keeps the original environment connection protected after the program lease ends, until that exact scope closes', async () => {
    const contents = fakeContents({sendCommand: async (method) => method === 'Target.getTargetInfo' ? {targetInfo: {targetId: 'original-native'}} : method === 'Target.attachToTarget' ? {sessionId: 'original-network'} : {}})
    const environment = BrowserCdpSession.attach(contents, { background: true }), program = BrowserCdpSession.attach(contents)
    const network = await program.openNetworkSession()
    program.detach()
    expect(BrowserCdpSession.hasOnlyBackgroundLeases(contents)).toBe(false)
    expect(contents.debugger.isAttached()).toBe(true)
    await network.close()
    expect(BrowserCdpSession.hasOnlyBackgroundLeases(contents)).toBe(true)
    expect(await environment.sendCommand('DOM.getDocument')).toEqual({})
    environment.detach()
    expect(contents.debugger.isAttached()).toBe(false)
  })
  it('retains the original unknown native scope until its exact detach fact, without detaching another consumer', async () => {
    let acknowledge!: () => void
    const contents = fakeContents({sendCommand: async (method) => {
      if (method === 'Target.getTargetInfo') return {targetInfo: {targetId: 'original-native'}}
      if (method === 'Target.attachToTarget') return {sessionId: 'original-network'}
      if (method === 'Target.detachFromTarget') await new Promise<void>(resolve => {acknowledge = resolve})
      return {}
    }})
    const environment = BrowserCdpSession.attach(contents, { background: true }), program = BrowserCdpSession.attach(contents)
    const network = await program.openNetworkSession(); program.detach()
    const closing = network.close(); await settle()
    expect(BrowserCdpSession.hasOnlyBackgroundLeases(contents)).toBe(false)
    expect(await environment.sendCommand('DOM.getDocument')).toEqual({})
    contents.debugger.emit('message', 'Target.detachedFromTarget', {sessionId:'other-scope'})
    expect(BrowserCdpSession.hasOnlyBackgroundLeases(contents)).toBe(false)
    contents.debugger.emit('message', 'Target.detachedFromTarget', {sessionId:'original-network'})
    expect(BrowserCdpSession.hasOnlyBackgroundLeases(contents)).toBe(true)
    acknowledge(); await closing
    expect(contents.debugger.isAttached()).toBe(true); environment.detach()
  })
})
