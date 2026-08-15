import { describe, expect, it } from 'vitest'
import { captureBrowserPageSnapshot, type BrowserCdpSender } from '../src/main/browser-page-snapshot.js'
import { resolveBrowserRef } from '../src/main/browser-ref-resolve.js'
import type { BrowserPageSnapshot } from '../src/shared/contracts.js'

/**
 * ref → objectId：refs-only 路径。
 *
 * 这里的快照**不手写**，而是真跑一遍 T-004 的走查产出来的。手写一份 `{ref, backendNodeId}` 字面量
 * 等于自己给自己发把手：快照那边改了 ref 的格式或丢掉了 backendNodeId，这边照样绿，而真实闭环
 * （snapshot → click）已经断了（见 MEMORY「合成的 fixture 等于自证」）。两个模块的接缝必须由真数据穿过。
 */

const PAGE_TREE = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Probe' }, childIds: ['2', '3'] },
  { nodeId: '2', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 20 },
  { nodeId: '3', role: { value: 'link' }, name: { value: 'Docs' }, backendDOMNodeId: 30 }
]

const FRAME_TREE = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'f' }, childIds: ['2'] },
  { nodeId: '2', role: { value: 'button' }, name: { value: 'In frame' }, backendDOMNodeId: 200 }
]

type AxFixture = typeof PAGE_TREE

/** 假 CDP 对端。`resolveNode` 可被替换，用来演"节点没了"。 */
function makeSender(
  nodes: AxFixture,
  resolveNode: (backendNodeId: number) => unknown = (backendNodeId) => ({
    object: { objectId: `obj-${backendNodeId}` }
  })
): { send: BrowserCdpSender; commands: { method: string; params?: Record<string, unknown> }[] } {
  const commands: { method: string; params?: Record<string, unknown> }[] = []
  const send: BrowserCdpSender = async (method, params) => {
    // 显式传 `params: undefined` 在 exactOptionalPropertyTypes 下不等于"没传"。
    commands.push(params === undefined ? { method } : { method, params })
    if (method === 'Accessibility.getFullAXTree') return { nodes }
    if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
    if (method === 'DOM.resolveNode') {
      return resolveNode(Number((params as { backendNodeId?: number }).backendNodeId))
    }
    return {}
  }
  return { send, commands }
}

/** 真跑一遍快照，拿到真实的 ref。 */
async function realSnapshot(
  nodes: AxFixture,
  frames?: Map<string, BrowserCdpSender>
): Promise<{ snapshot: BrowserPageSnapshot; send: BrowserCdpSender }> {
  const { send } = makeSender(nodes)
  const snapshot = await captureBrowserPageSnapshot({
    send,
    url: 'https://example.invalid/',
    title: 'Probe',
    navigationId: 'nav-1',
    ...(frames ? { frames } : {})
  })
  return { snapshot, send }
}

describe('按 ref 解析元素', () => {
  it('快照发出的 ref 能解成 objectId——两个模块的接缝是通的', async () => {
    const { snapshot, send } = await realSnapshot(PAGE_TREE)

    // 扫到有收获：快照没发出 ref 的话，下面的 find 会拿到 undefined，
    // 整条断言链退化成在解一个 undefined（AGENTS.md:85-88）。
    const submit = snapshot.nodes.find((node) => node.name === 'Submit')
    expect(submit?.ref, '快照没给按钮发 ref——被测的解析对象不存在').toBeTruthy()

    const result = await resolveBrowserRef({ snapshot, ref: submit!.ref, send })
    expect(result.resolved, '解不开一个刚刚由快照发出的 ref').toBe(true)
    expect(result.resolved && result.objectId).toBe('obj-20')
  })

  it('解析走的是 backendNodeId，且带上对象组', async () => {
    const { snapshot } = await realSnapshot(PAGE_TREE)
    const { send, commands } = makeSender(PAGE_TREE)
    const docs = snapshot.nodes.find((node) => node.name === 'Docs')!

    await resolveBrowserRef({ snapshot, ref: docs.ref, send })

    const call = commands.find((command) => command.method === 'DOM.resolveNode')
    expect(call, '根本没发 DOM.resolveNode——解析没有真的发生').toBeDefined()
    // 按 backendNodeId 解，不是按选择器：这是 refs-only 路径的全部内容。
    expect(call!.params).toMatchObject({ backendNodeId: 30, objectGroup: 'agentmux-browser' })
  })

  it('不认识的 ref 明确报 unknown-ref，不猜一个元素给它', async () => {
    const { snapshot, send } = await realSnapshot(PAGE_TREE)
    const result = await resolveBrowserRef({ snapshot, ref: '@e999', send })

    expect(result.resolved).toBe(false)
    expect(!result.resolved && result.failure.kind).toBe('unknown-ref')
  })

  it('空 ref 不会匹配到快照里那些没有 ref 的结构节点', async () => {
    // 地标/标题/文本节点的 ref 是空串。用空串去解如果匹配上了，Agent 就能操作一个
    // 本来就不该被操作的节点，而且它看起来是成功的。
    const { snapshot, send } = await realSnapshot([
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'r' }, childIds: ['2'] },
      { nodeId: '2', role: { value: 'heading' }, name: { value: 'Title' }, backendDOMNodeId: 20 }
    ])
    expect(snapshot.nodes.some((node) => node.ref === ''), '快照里没有无 ref 节点，这条在对空气生效').toBe(true)

    const result = await resolveBrowserRef({ snapshot, ref: '', send })
    expect(!result.resolved && result.failure.kind).toBe('unknown-ref')
  })

  it('节点没了报 stale-ref，而不是静默换一个同名元素', async () => {
    const { snapshot } = await realSnapshot(PAGE_TREE)
    const submit = snapshot.nodes.find((node) => node.name === 'Submit')!
    const { send } = makeSender(PAGE_TREE, () => {
      throw new Error('No node with given id found')
    })

    const result = await resolveBrowserRef({ snapshot, ref: submit.ref, send })
    expect(result.resolved, '参考实现在这里会按角色/名字回退——那会静默选中另一个元素').toBe(false)
    expect(!result.resolved && result.failure.kind).toBe('stale-ref')
    expect(!result.resolved && 'reason' in result.failure && result.failure.reason)
      .toContain('No node with given id found')
  })

  it('CDP 不抛错但没给 objectId，同样算没解开', async () => {
    // 「没抛错」不等于「成功」。这一支若当成功返回，调用方会拿着 undefined 去派发动作。
    const { snapshot } = await realSnapshot(PAGE_TREE)
    const submit = snapshot.nodes.find((node) => node.name === 'Submit')!
    const { send } = makeSender(PAGE_TREE, () => ({ object: {} }))

    const result = await resolveBrowserRef({ snapshot, ref: submit.ref, send })
    expect(result.resolved).toBe(false)
    expect(!result.resolved && result.failure.kind).toBe('stale-ref')
  })

  it('页面导航过之后，整张快照的 ref 一律作废', async () => {
    const { snapshot, send } = await realSnapshot(PAGE_TREE)
    const submit = snapshot.nodes.find((node) => node.name === 'Submit')!

    const result = await resolveBrowserRef({
      snapshot, ref: submit.ref, send, currentNavigationId: 'nav-2'
    })

    // 危险恰恰在于：换页之后 backendNodeId 往往仍然能解开，只是解到了一个毫不相干的节点上。
    // 所以这条必须在解析**之前**判，不能等 CDP 报错。
    expect(result.resolved, '导航之后旧 ref 仍被解开了——它指向的已经是另一个页面的节点').toBe(false)
    expect(!result.resolved && result.failure.kind).toBe('stale-snapshot')

    // 反向那一半：导航身份一致时不能误杀。只判上面那句的话，"永远返回 stale-snapshot" 也会绿。
    const same = await resolveBrowserRef({
      snapshot, ref: submit.ref, send, currentNavigationId: 'nav-1'
    })
    expect(same.resolved, '导航没变却把 ref 判成作废').toBe(true)
  })
})

describe('按 ref 解析元素：iframe', () => {
  it('iframe 里的节点，命令发到该 frame 自己的 session', async () => {
    const { send: frameSend, commands: frameCommands } = makeSender(FRAME_TREE)
    const frames = new Map([['frame-a', frameSend]])
    const { snapshot, send } = await realSnapshot(PAGE_TREE, frames)

    const inFrame = snapshot.nodes.find((node) => node.name === 'In frame')
    expect(inFrame?.ref, 'iframe 里的按钮没进快照——被测对象不存在').toBeTruthy()

    const result = await resolveBrowserRef({ snapshot, ref: inFrame!.ref, send, frames })
    expect(result.resolved).toBe(true)
    expect(result.resolved && result.sessionId, '解出来的句柄没带 session，派发时会发错对端').toBe('frame-a')

    // 承重的一条：命令必须真的发给了 iframe 的对端。发给主 frame 的话 backendNodeId 解不开，
    // 而那种失败看起来和"元素没了"一模一样。
    expect(
      frameCommands.some((command) => command.method === 'DOM.resolveNode'),
      'DOM.resolveNode 没发到 iframe 的 session'
    ).toBe(true)
  })

  it('frame 的 session 已经不在了，报 stale-ref 而不是退回主 frame 去解', async () => {
    const { send: frameSend } = makeSender(FRAME_TREE)
    const { snapshot, send } = await realSnapshot(PAGE_TREE, new Map([['frame-a', frameSend]]))
    const inFrame = snapshot.nodes.find((node) => node.name === 'In frame')!

    // 解析时不再提供这个 frame 的 sender——frame 没了。
    const result = await resolveBrowserRef({ snapshot, ref: inFrame.ref, send, frames: new Map() })

    expect(result.resolved, '退回主 frame 去解了——那会解到一个无关节点上').toBe(false)
    expect(!result.resolved && result.failure.kind).toBe('stale-ref')
  })
})
