import { describe, expect, it } from 'vitest'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'
import type { BrowserCdpSession } from '../src/main/browser-cdp-session.js'

/**
 * 派发层的判据：**够不着的东西必须说出来**，以及三类 ref 失败各自说到下一步为止。
 *
 * 这里用假的 CDP 对端，与真机那条（browser-drive-e2e.test.ts）分工明确：真机证"这套代码在真
 * 页面上能闭环"，这条证"说不清的时候它有没有说出来"。后者在真机上几乎无法构造——要让
 * `Target.setAutoAttach` 在真 Electron 上失败，得先找到一个不支持它的 target。
 */

/** 一个只回答 AX 树的假对端。页面语义不是这条要判的东西，所以给最小的一份。 */
function fakeSession(overrides: Partial<{
  frameDiscoveryFailure: string | null
  nodes: unknown[]
}> = {}): BrowserCdpSession {
  const nodes = overrides.nodes ?? [
    {
      nodeId: '1',
      backendDOMNodeId: 11,
      role: { value: 'button' },
      name: { value: 'Submit' },
      childIds: []
    }
  ]
  return {
    sendCommand: async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes }
      if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: null } }
      return {}
    },
    frames: new Map(),
    endedReason: null,
    frameDiscoveryFailure: overrides.frameDiscoveryFailure ?? null,
    observe: () => () => {},
    detach: () => {}
  } as unknown as BrowserCdpSession
}

/**
 * 建一个只关心页面语义的派发器。
 *
 * ref 账本那一侧在这里给成「没有账本、写了也不留」：本文件判的是**本轮之内**的分派与失败分类，
 * 跨轮认领由 browser-ref-ledger.test.ts 单独判。给一个真账本会让这里的失败断言变成"自愈没成功"，
 * 而那是另一条判据。
 */
function dispatchOn(session: BrowserCdpSession, navigationId = 'nav-1'): ReturnType<typeof createBrowserPageDispatch> {
  return createBrowserPageDispatch({
    session,
    pageInfo: () => ({ url: 'https://example.invalid/', title: 'Example', navigationId }),
    gotoUrl: async () => {},
    captureScreenshot: async () => ({}),
    readLedger: async () => null,
    writeLedger: async () => {},
    note: () => {}
  })
}

/** 同上，但 `pageInfo` 由调用方给——导航相关的几条要在中途换身份。 */
function dispatchWith(
  session: BrowserCdpSession,
  pageInfo: () => { url: string; title: string; navigationId: string },
  gotoUrl: () => Promise<void> = async () => {}
): ReturnType<typeof createBrowserPageDispatch> {
  return createBrowserPageDispatch({
    session,
    pageInfo,
    gotoUrl,
    captureScreenshot: async () => ({}),
    readLedger: async () => null,
    writeLedger: async () => {},
    note: () => {}
  })
}

describe('够不着的 frame 要浮现，不能被读成「这页没有 iframe」', () => {
  it('子 frame 自动 attach 失败时，快照在 missingFrames 里说出来', async () => {
    const dispatch = dispatchOn(fakeSession({ frameDiscoveryFailure: 'not supported on this target' }))

    const snapshot = (await dispatch('snapshot', [])) as {
      nodes: unknown[]
      missingFrames: { frameId: string; reason: string }[]
    }

    // 先证扫描面非空：快照本身是空的话，下面那条会在一个没有意义的对象上生效。
    expect(snapshot.nodes.length, '快照是空的——这条在对空气生效').toBeGreaterThan(0)
    // `missingFrames` 只在**尝试过**某个 frame 时才写入，而 attach 没建起来就一个 frame 都不会被
    // 枚举。两者一叠，Agent 读到的是"这页没有 iframe"——一张有洞的地图声称自己是完整的。
    expect(snapshot.missingFrames, '够不着跨域 iframe 却一声不响').not.toHaveLength(0)
    expect(snapshot.missingFrames[0]!.reason, '没说清是我们够不着，也没说这意味着什么')
      .toMatch(/not supported on this target/)
  })

  it('反向的一半：attach 正常时不许凭空报缺失', async () => {
    // 少了这条，一个"永远往 missingFrames 里塞一条"的实现会让上面那条全绿——
    // 而那等于每张快照都自称有洞，Agent 从此不敢相信任何一张。
    const dispatch = dispatchOn(fakeSession({ frameDiscoveryFailure: null }))

    const snapshot = (await dispatch('snapshot', [])) as { missingFrames: unknown[] }

    expect(snapshot.missingFrames, 'attach 好好的却报缺失——狼来了').toHaveLength(0)
  })
})

describe('三类 ref 失败各自说到下一步为止', () => {
  it('不认识的 ref：说清它不在快照里，让人去重取', async () => {
    const dispatch = dispatchOn(fakeSession())
    await dispatch('snapshot', [])

    await expect(dispatch('click', ['@e9999'])).rejects.toThrow(/snapshot/i)
  })

  it('页面导航过了：整张快照作废，不是某一个 ref 的问题', async () => {
    // 这一条是最危险的那种：页面换了之后，旧 ref 的 backendNodeId 往往**仍然解得开**——
    // 假对端这里就照样返回 objectId。若不判 navigationId，Agent 会在新页面上点中一个毫不相干的
    // 节点，而收到的是"成功"。
    let navigationId = 'nav-1'
    const session = fakeSession()
    const dispatch = dispatchWith(session, () => ({ url: 'https://example.invalid/', title: 'Example', navigationId }))
    const snapshot = (await dispatch('snapshot', [])) as { nodes: { ref: string }[] }
    const ref = snapshot.nodes.find((node) => node.ref !== '')!.ref

    // 同一个 ref，导航之前解得开。先证这一点，否则下面的红可能只是因为这个 ref 本来就是坏的。
    await expect(dispatch('click', [ref])).resolves.not.toThrow()

    navigationId = 'nav-2'
    await expect(dispatch('click', [ref])).rejects.toThrow(/navigat/i)
  })

  it('两类失败不是同一句话', async () => {
    // 折并成一句，Agent 就分不清"该重取快照"与"我把手拼错了"——而这两件事的下一步完全不同。
    let navigationId = 'nav-1'
    const session = fakeSession()
    const dispatch = dispatchWith(session, () => ({ url: 'https://example.invalid/', title: 'Example', navigationId }))
    const snapshot = (await dispatch('snapshot', [])) as { nodes: { ref: string }[] }
    const ref = snapshot.nodes.find((node) => node.ref !== '')!.ref

    const unknown = await dispatch('click', ['@e9999']).catch((error: Error) => error.message)
    navigationId = 'nav-2'
    const stale = await dispatch('click', [ref]).catch((error: Error) => error.message)

    expect(unknown, '不认识的 ref 被放行了').toEqual(expect.any(String))
    expect(stale, '陈旧快照被放行了').toEqual(expect.any(String))
    expect(stale, '两类失败被折并成同一句话').not.toBe(unknown)
  })
})

describe('页面自己抛了，不许读成成功', () => {
  it('CDP 把页面异常放进 exceptionDetails 照常返回，这里必须认出来', async () => {
    // CDP 在"函数抛了"这件事上**不 reject**——它带着 exceptionDetails 正常返回。不看那个字段，
    // 一次抛在页面里的错会变成 `undefined` 的成功值，而 Agent 会接着往下走。
    // （这条是变异测出来的：把那个判断改成恒假，此前 14 条测试照样绿，真机那条也绿。）
    const session = {
      sendCommand: async (method: string) => {
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: [{ nodeId: '1', backendDOMNodeId: 11, role: { value: 'button' }, name: { value: 'Submit' }, childIds: [] }] }
        }
        if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
        if (method === 'Runtime.callFunctionOn') {
          return { result: { value: undefined }, exceptionDetails: { text: 'TypeError: handler is not a function' } }
        }
        return {}
      },
      frames: new Map(),
      endedReason: null,
      frameDiscoveryFailure: null,
      observe: () => () => {},
      detach: () => {}
    } as unknown as BrowserCdpSession

    const dispatch = dispatchOn(session)
    const snapshot = (await dispatch('snapshot', [])) as { nodes: { ref: string }[] }
    const ref = snapshot.nodes.find((node) => node.ref !== '')!.ref

    await expect(dispatch('click', [ref]), '页面抛的错被读成了成功').rejects.toThrow(/handler is not a function/)
  })

  it('js 逃生口同样不许把页面异常读成返回值', async () => {
    // 与上面那条是**两个出口**，各有各的判断。只守一侧的话，另一侧照样把异常读成值
    // （MEMORY「守卫按出口数不按条件数」）。
    const session = {
      sendCommand: async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return { result: { value: undefined }, exceptionDetails: { text: 'ReferenceError: nope is not defined' } }
        }
        return {}
      },
      frames: new Map(),
      endedReason: null,
      frameDiscoveryFailure: null,
      observe: () => () => {},
      detach: () => {}
    } as unknown as BrowserCdpSession

    await expect(dispatchOn(session)('js', ['nope()'])).rejects.toThrow(/nope is not defined/)
  })
})

describe('导航之后旧快照必须被丢掉', () => {
  it('gotoUrl 之后，上一张快照的 ref 不再被拿来解', async () => {
    // 不丢的话，下一次 click 会拿旧地图去解——backendNodeId 可能还解得开，只是解到了新页面上
    // 一个毫不相干的节点。这里让 pageInfo 在导航后换身份，若缓存没丢就会被 stale 判据抓住；
    // 真正要证的是「派发层自己丢了缓存」，所以判据取"它重新取了一张快照"。
    let navigationId = 'nav-1'
    let axCalls = 0
    const session = {
      sendCommand: async (method: string) => {
        if (method === 'Accessibility.getFullAXTree') {
          axCalls += 1
          return { nodes: [{ nodeId: '1', backendDOMNodeId: 11, role: { value: 'button' }, name: { value: 'Submit' }, childIds: [] }] }
        }
        if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
        if (method === 'Runtime.callFunctionOn') return { result: { value: null } }
        return {}
      },
      frames: new Map(),
      endedReason: null,
      frameDiscoveryFailure: null,
      observe: () => () => {},
      detach: () => {}
    } as unknown as BrowserCdpSession

    const dispatch = dispatchWith(
      session,
      () => ({ url: 'https://example.invalid/', title: 'Example', navigationId }),
      async () => { navigationId = 'nav-2' }
    )

    const first = (await dispatch('snapshot', [])) as { nodes: { ref: string }[] }
    const ref = first.nodes.find((node) => node.ref !== '')!.ref
    expect(axCalls, '第一张快照没走查').toBe(1)

    await dispatch('gotoUrl', ['https://elsewhere.invalid/'])
    // 缓存丢了，所以这次 click 会先自己取一张新快照。取了就说明旧地图没被复用。
    await dispatch('click', [ref]).catch(() => {})
    expect(axCalls, 'gotoUrl 之后没有重新走查——旧快照被拿去解新页面了').toBe(2)

    // **第二次**才是真正危险的那次，而且只判第一次是抓不到的：上面那次失败的路径内部会取一张
    // 新快照并把它存回缓存。缓存这就非空了，若"本轮发出过哪些 ref"没跟着一起作废，这个旧编号
    // 会命中快路径，在**新页面**的快照里按数字解开——解得开，点得下去，点的是另一个元素。
    // 整条路上没有一处报错，而这正是本模块存在的理由。
    await expect(
      dispatch('click', [ref]),
      'gotoUrl 之后第二个旧 ref 在新页面上被按数字解开了——静默点中了别的元素'
    ).rejects.toThrow()
  })
})
