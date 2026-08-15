import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healRef, ledgerFromSnapshot } from '../src/main/browser-ref-ledger.js'
import { BrowserRefLedgerStore, MAX_TRACKED_BROWSERS } from '../src/main/browser-ref-ledger-store.js'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'
import type { BrowserCdpSession } from '../src/main/browser-cdp-session.js'
import type { BrowserPageSnapshot } from '../src/main/../shared/contracts.js'

/**
 * ref 账本的判据，三件事：**跨重启还认得出、认错了要说、认不出不许乱认**。
 *
 * 为什么这条测试必须存在，而不是靠「ref 解不开就报错」兜底：ref 是按走查顺序现编的，每张快照都从
 * `@e1` 重新数。所以上一轮的 `@e3` 在这一轮的新快照里**照样存在、照样解得开**——它只是指着另一个
 * 元素。整条路上没有一处报错，Agent 收到的是一次干净的成功。这类静默错点是这份实现要挡的东西，
 * 也是这些断言真正在守的东西。
 */

function node(ref: string, role: string, name: string, backendNodeId: number): BrowserPageSnapshot['nodes'][number] {
  return { ref, role, name, backendNodeId, depth: 0 }
}

function snapshotOf(
  nodes: BrowserPageSnapshot['nodes'],
  url = 'https://example.invalid/'
): BrowserPageSnapshot {
  return { url, title: 'Example', navigationId: 'nav-1', nodes, missingFrames: [] }
}

describe('账本记的是内容身份，不是 backendNodeId', () => {
  it('重启之后 backendNodeId 全变了，ref 仍然认得回来', () => {
    // 这才是「跨重启」的实质：重启之后 CDP 会重新编号，旧的 backendNodeId 一个都不作数。
    const before = snapshotOf([node('@e1', 'button', 'Save', 11), node('@e2', 'link', 'Docs', 12)])
    const ledger = ledgerFromSnapshot(before)
    expect(ledger.entries, '账本是空的——下面几条都在对空气生效').not.toHaveLength(0)

    const after = snapshotOf([node('@e1', 'link', 'Docs', 88), node('@e2', 'button', 'Save', 99)])
    const healed = healRef(ledger, '@e1', after)

    expect(healed.healed, `没认出来：${healed.healed ? '' : healed.reason}`).toBe(true)
    // 顺序都换了，所以这条同时证明它认的是内容不是位置——按位置认会拿到 Docs。
    expect(healed.healed && healed.node.name, '认成了另一个元素').toBe('Save')
    expect(healed.healed && healed.node.backendNodeId, '拿的还是旧编号——那个解不开').toBe(99)
  })

  it('认出来了也要说这次是自愈的，以及它可能认错', () => {
    // 静默自愈比不自愈更糟：Agent 收到一次干净的成功，而它作用在什么上其实没人知道。
    const ledger = ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'Save', 11)]))
    const healed = healRef(ledger, '@e1', snapshotOf([node('@e1', 'button', 'Save', 99)]))

    expect(healed.healed).toBe(true)
    expect(healed.healed && healed.note, '自愈了却没说——上层无从判断要不要信这次结果')
      .toMatch(/different element that looks the same/)
  })

  it('同名元素有好几个时按第几个认，不是见到第一个就算', () => {
    // 分页那种「一排全是 Next」的页面，认第一个等于每次都点回第一页。
    const before = snapshotOf([
      node('@e1', 'button', 'Next', 11),
      node('@e2', 'button', 'Next', 12),
      node('@e3', 'button', 'Next', 13)
    ])
    const ledger = ledgerFromSnapshot(before)
    const after = snapshotOf([
      node('@e1', 'button', 'Next', 71),
      node('@e2', 'button', 'Next', 72),
      node('@e3', 'button', 'Next', 73)
    ])

    const healed = healRef(ledger, '@e2', after)

    expect(healed.healed && healed.node.backendNodeId, '同名元素认错了第几个').toBe(72)
  })

  it('第几个那一个没了、只能退而求其次时，把这一点也说出来', () => {
    const ledger = ledgerFromSnapshot(snapshotOf([
      node('@e1', 'button', 'Next', 11),
      node('@e2', 'button', 'Next', 12)
    ]))
    // 只剩一个 Next 了：#2 不存在，退回 #1。这次匹配比记账时更弱，不说等于谎报同等可信。
    const healed = healRef(ledger, '@e2', snapshotOf([node('@e1', 'button', 'Next', 71)]))

    expect(healed.healed).toBe(true)
    expect(healed.healed && healed.note, '降级匹配没被说出来，跟精确命中长得一模一样')
      .toMatch(/#2 match is gone/)
  })

  it('地址变了就是真作废，不许在另一个页面上按名字乱认', () => {
    // 两个页面各有一个「Save」是极常见的。跨页面认名字，就是在另一个页面上点了一个同名按钮。
    const ledger = ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'Save', 11)]))
    const healed = healRef(ledger, '@e1', snapshotOf([node('@e1', 'button', 'Save', 99)], 'https://other.invalid/'))

    expect(healed.healed, '换了页面还照样认——这一点会点中另一个页面的同名按钮').toBe(false)
    expect(!healed.healed && healed.reason).toMatch(/other\.invalid/)
  })

  it('页面上真没有对得上的东西，就明说没有', () => {
    const ledger = ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'Save', 11)]))
    const healed = healRef(ledger, '@e1', snapshotOf([node('@e1', 'button', 'Cancel', 99)]))

    expect(healed.healed, '硬认了一个不相干的元素').toBe(false)
    expect(!healed.healed && healed.reason).toMatch(/Take a new snapshot/)
  })

  it('解不回 DOM 的节点（地标、纯文本）不许被当成匹配结果', () => {
    // 它们的 backendNodeId 是 0，认给 Agent 就是一个永远失败的把手。
    const ledger = ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'Save', 11)]))
    const healed = healRef(ledger, '@e1', snapshotOf([node('', 'button', 'Save', 0)]))

    expect(healed.healed, '认了一个解不回 DOM 的节点').toBe(false)
  })
})

describe('账本落盘：重启之后读得回来，读坏了不许把应用挡住', () => {
  let root = ''
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'agentmux-ref-ledger-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  function storePath(): string { return join(root, 'browser-ref-ledger.json') }

  it('写了再用一个全新的 store 读——这才是「跨重启」', async () => {
    const ledger = ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'Save', 11)]))
    await new BrowserRefLedgerStore(storePath()).write('b1', ledger)

    // 同一个实例读会命中它自己的内存缓存，那证明不了任何事。
    const reloaded = await new BrowserRefLedgerStore(storePath()).read('b1')

    expect(reloaded, '重启之后账本没了').toEqual(ledger)
  })

  it('别的 Browser 的账本不会被这一次写覆盖掉', async () => {
    const store = new BrowserRefLedgerStore(storePath())
    await store.write('b1', ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'A', 1)])))
    await store.write('b2', ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'B', 2)])))

    const fresh = new BrowserRefLedgerStore(storePath())
    expect((await fresh.read('b1'))?.entries[0]?.name, 'b2 的写把 b1 冲掉了').toBe('A')
    expect((await fresh.read('b2'))?.entries[0]?.name).toBe('B')
  })

  it('文件坏了读成「没有账本」，不抛——ref 解不开顶多是重取一张快照，崩在这里会挡住整个应用', async () => {
    await writeFile(storePath(), '{ this is not json')

    await expect(new BrowserRefLedgerStore(storePath()).read('b1')).resolves.toBeNull()
  })

  it('落盘的是内容身份，不是 backendNodeId——记了它就是在诱使下一轮拿它去解', async () => {
    await new BrowserRefLedgerStore(storePath()).write(
      'b1',
      ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'Save', 4242)]))
    )

    const raw = await readFile(storePath(), 'utf8')
    expect(raw, '账本里出现了 backendNodeId——它跨不过一次会话，记下来只会被当真').not.toMatch(/4242/)
    expect(raw, '内容身份没落盘').toMatch(/Save/)
  })

  it('裁剪按「最近写过」来，不按「第一次出现」——否则删掉的正是最常用的那个', async () => {
    // 这条判的是 write 里那个 `delete all[browserId]`。少了它，反复被驱动的 Browser 永远停在它
    // 第一次出现的位置，而裁剪从头砍——于是**唯一一个还在用的**账本被当成最老的删掉，其余早就
    // 没人碰的反而留着。表现出来是"用着用着跨轮 ref 突然不认了"，只在开过很多 Browser 之后才复现。
    //
    // 场景要卡在**恰好刚满**上：多写几个 cold 的话，hot 会被裁掉、下一次 write 又把它当新键插回
    // 队尾，不重排的实现反而自愈，判据就恒真了（实测过两种写法都绿）。所以写满 cap - 1 个 cold，
    // 让 hot 始终在册，再写最后一个把它挤出去——只有"重写不挪位"才会挑中 hot。
    const store = new BrowserRefLedgerStore(storePath())
    const hot = ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'Hot', 1)]))
    await store.write('hot', hot)
    for (let i = 0; i < MAX_TRACKED_BROWSERS - 1; i += 1) {
      await store.write(`cold-${i}`, ledgerFromSnapshot(snapshotOf([node('@e1', 'button', `C${i}`, 1)])))
    }
    // 此刻共 cap 个键，hot 排在最前。重写它一次：重排的实现把它挪到队尾，不重排的原地不动。
    await store.write('hot', hot)
    // 再加一个，触发一次恰好删一个的裁剪。
    await store.write('tipping', ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'T', 1)])))

    const fresh = new BrowserRefLedgerStore(storePath())
    expect(await fresh.read('hot'), '刚刚写过的账本被当成最老的裁掉了').toEqual(hot)
    // 反向的一半：裁剪得真的发生过，否则上面那条在一个"从不裁剪"的实现上也绿。
    expect(await fresh.read('cold-0'), '一个都没裁——上限形同虚设').toBeNull()
  })
})

/** 一个只回答 AX 树的假对端；`nodes` 每次现取，用来模拟两轮之间页面重新渲染。 */
function fakeSession(nodes: () => unknown[]): BrowserCdpSession {
  return {
    sendCommand: async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: nodes() }
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
}

/**
 * 一棵最小的 AX 树：一个 generic 根挂着这些叶子。
 *
 * 必须是树不是数组——`captureBrowserPageSnapshot` 从 `nodes[0]` 开始走查，平铺的兄弟节点里只有
 * 第一个会被收进快照。一次假绿就是这么来的：扫描面只有一个节点，而断言看起来还在正常工作。
 */
function axTree(...leaves: { id: number; role: string; name: string }[]): unknown[] {
  return [
    { nodeId: 'root', role: { value: 'generic' }, name: { value: '' }, childIds: leaves.map((leaf) => String(leaf.id)) },
    ...leaves.map((leaf) => axNode(leaf.id, leaf.role, leaf.name))
  ]
}

function axNode(backendDOMNodeId: number, role: string, name: string): unknown {
  return { nodeId: String(backendDOMNodeId), backendDOMNodeId, role: { value: role }, name: { value: name }, childIds: [] }
}

describe('派发层：上一轮的 ref 走账本，不许撞进这一轮的新编号', () => {
  it('第二轮拿第一轮的 ref 来点，解的是账本认回来的那个元素，并留下自愈说明', async () => {
    // 这条是整个 T-011 的核心判据。两轮之间元素顺序换了，于是「按编号解」和「按内容认」会指向
    // **不同的元素**——少了这个差异，一个完全没实现账本的版本也能让这条全绿。
    const store = new BrowserRefLedgerStore(join(await mkdtemp(join(tmpdir(), 'agentmux-ref-dispatch-')), 'l.json'))
    const first = axTree({ id: 11, role: 'button', name: 'Save' }, { id: 12, role: 'button', name: 'Cancel' })
    const second = axTree({ id: 91, role: 'button', name: 'Cancel' }, { id: 92, role: 'button', name: 'Save' })

    let resolved: number | null = null
    const sessionFor = (nodes: unknown[]): BrowserCdpSession => ({
      ...fakeSession(() => nodes),
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Accessibility.getFullAXTree') return { nodes }
        if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
        if (method === 'DOM.resolveNode') {
          resolved = params?.backendNodeId as number
          return { object: { objectId: 'obj-1' } }
        }
        if (method === 'Runtime.callFunctionOn') return { result: { value: null } }
        return {}
      }
    }) as unknown as BrowserCdpSession

    const notes: string[] = []
    const contextFor = (nodes: unknown[]): Parameters<typeof createBrowserPageDispatch>[0] => ({
      session: sessionFor(nodes),
      pageInfo: () => ({ url: 'https://example.invalid/', title: 'Example', navigationId: 'nav-1' }),
      gotoUrl: async () => {},
      captureScreenshot: async () => ({}),
      readLedger: async () => await store.read('b1'),
      writeLedger: async (ledger) => { await store.write('b1', ledger) },
      note: (text) => notes.push(text)
    })

    // 第一轮：取快照，账本落盘。
    const runOne = createBrowserPageDispatch(contextFor(first))
    const snapshot = (await runOne('snapshot', [])) as { nodes: { ref: string; name: string }[] }
    const saveRef = snapshot.nodes.find((candidate) => candidate.name === 'Save')!.ref

    // 第二轮是一个全新的派发器（新的一次 browser run），它对第一轮一无所知。
    const runTwo = createBrowserPageDispatch(contextFor(second))
    await runTwo('click', [saveRef])

    expect(resolved, 'Save 的新 backendNodeId 是 92——解到别的就是按编号撞上的').toBe(92)
    expect(notes, '自愈了却没说——Agent 会把一次按外观的匹配当成干净的成功').not.toHaveLength(0)
    expect(notes[0], '说明里没提这次匹配可能认错').toMatch(/looks the same/)
  })

  it('本轮自己发出的 ref 不走账本，也不该留下自愈说明', async () => {
    // 反向的一半。少了它，一个「每次都走自愈」的实现会让上面那条全绿——而那等于每次操作都
    // 附一句"可能认错了"，狼来了喊多了就没人信。
    const store = new BrowserRefLedgerStore(join(await mkdtemp(join(tmpdir(), 'agentmux-ref-dispatch-')), 'l.json'))
    const nodes = axTree({ id: 11, role: 'button', name: 'Save' })
    const notes: string[] = []
    const dispatch = createBrowserPageDispatch({
      session: fakeSession(() => nodes),
      pageInfo: () => ({ url: 'https://example.invalid/', title: 'Example', navigationId: 'nav-1' }),
      gotoUrl: async () => {},
      captureScreenshot: async () => ({}),
      readLedger: async () => await store.read('b1'),
      writeLedger: async (ledger) => { await store.write('b1', ledger) },
      note: (text) => notes.push(text)
    })

    const snapshot = (await dispatch('snapshot', [])) as { nodes: { ref: string }[] }
    await dispatch('click', [snapshot.nodes.find((candidate) => candidate.ref !== '')!.ref])

    expect(notes, '本轮刚发出的 ref 也报自愈——狼来了').toHaveLength(0)
  })

  it('账本里也没有的 ref，明说没有，不许在新快照里撞一个同号的出来', async () => {
    const store = new BrowserRefLedgerStore(join(await mkdtemp(join(tmpdir(), 'agentmux-ref-dispatch-')), 'l.json'))
    await store.write('b1', ledgerFromSnapshot(snapshotOf([node('@e1', 'button', 'Save', 11)])))
    const dispatch = createBrowserPageDispatch({
      session: fakeSession(() => axTree({ id: 91, role: 'button', name: 'Save' })),
      pageInfo: () => ({ url: 'https://example.invalid/', title: 'Example', navigationId: 'nav-1' }),
      gotoUrl: async () => {},
      captureScreenshot: async () => ({}),
      readLedger: async () => await store.read('b1'),
      writeLedger: async (ledger) => { await store.write('b1', ledger) },
      note: () => {}
    })

    // `@e9` 在新快照里不存在；但即便存在，它也不该被当成那个 ref——账本里没有就是没有。
    await expect(dispatch('click', ['@e9'])).rejects.toThrow(/snapshot/i)
  })
})

describe('自愈过的运行不许报成干净的成功', () => {
  it('runScript 在自愈发生过时把结局降为 indeterminate，并把说明带回去', async () => {
    // 判在 manager 这一层而不是靠派发层的一句日志：`completed` 这一支连个放警告的字段都没有
    // （contracts 的四分类），所以「做了但不确定作用在什么上」只能由结局本身承载。
    vi.resetModules()
    const contents = { debugger: { attach() {}, isAttached: () => false, detach() {}, on() { return this }, off() { return this }, async sendCommand() { return {} } } }
    vi.doMock('../src/main/browser-page-dispatch.js', () => ({
      createBrowserPageDispatch: (context: { note(text: string): void }) => async () => {
        context.note('@e1 was recovered by matching button "Save" against the page again.')
        return null
      },
      renderBrowserSnapshotText: () => ''
    }))
    vi.doMock('electron', () => ({
      WebContentsView: class {
        readonly webContents = {
          ...contents,
          session: { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} },
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          on() { return this }, once() { return this }, removeListener() { return this },
          setWindowOpenHandler() {}, setZoomFactor() {}, getZoomFactor: () => 1,
          getURL: () => 'https://example.invalid/', getTitle: () => 'Example',
          isLoading: () => false, isLoadingMainFrame: () => false, isDestroyed: () => false,
          async loadURL() {}, close() {}
        }
        setVisible() {}
        setBounds() {}
      }
    }))
    const { BrowserViewManager } = await import('../src/main/browser-view-manager.js')
    const manager = new BrowserViewManager(
      { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { isDestroyed: () => false, send() {} } } as never,
      { defaultProfileId: () => 'default', resolvePartition: (id: string) => `persist:${id}` },
      new BrowserRefLedgerStore(join(await mkdtemp(join(tmpdir(), 'agentmux-ref-run-')), 'l.json'))
    )
    await manager.create('b1', 'https://example.invalid/')

    const report = await manager.runScript('b1', 'await click("@e1"); return "done"')

    expect(report.outcome.kind, '自愈过却报 completed——Agent 无从知道它点的是不是同一个元素')
      .toBe('indeterminate')
    expect(report.outcome.kind === 'indeterminate' ? report.outcome.message : '').toMatch(/recovered/)
    // 返回值照常带回去：程序真算出来了，丢掉它只会逼 Agent 再跑一遍（而重跑正是 indeterminate 要劝阻的）。
    expect(report.result, '把程序的返回值一并丢了').toBe('done')
    vi.doUnmock('../src/main/browser-page-dispatch.js')
    vi.doUnmock('electron')
  }, 30_000)
})
