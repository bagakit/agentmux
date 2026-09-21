import { describe, expect, it } from 'vitest'
import { captureBrowserPageSnapshot, type BrowserCdpSender } from '../src/main/browser-page-snapshot.js'
import { discoverBrowserFrameDocuments, MAX_BROWSER_FRAME_DOCUMENTS } from '../src/main/browser-frame-documents.js'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'
import { parseBrowserSnapshotQuery, projectBrowserSnapshot } from '../src/main/browser-snapshot-query.js'
import type { BrowserCdpSession } from '../src/main/browser-cdp-session.js'
import type { BrowserScopedSnapshot } from '../src/shared/browser-snapshot-query.js'

function fixture(options: { failed?: string; empty?: string; changed?: string; discoveryFailed?: boolean; nestedAx?: boolean; wrongRoot?: boolean; pageInterference?: boolean; selectorInterference?: boolean; evaluationFailure?: 'exception' | 'missing-value'; realmFailed?: boolean } = {}) {
  const calls: { session: string; method: string; params?: Record<string, unknown> }[] = []
  const actions: [string, number][] = []
  const backends = new Map([['doc-main', 11], ['doc-child', 21], ['doc-nested', 31], ['doc-remote', 11], ['doc-remote-child', 41]])
  const frame = (id: string, parentId?: string) => ({ id, loaderId: `loader-${id}`, ...(parentId ? { parentId } : {}) })
  const trees = new Map([
    ['main', { frame: frame('doc-main'), childFrames: [{ frame: frame('doc-child', 'doc-main'), childFrames: [{ frame: frame('doc-nested', 'doc-child') }] }] }],
    ['remote-session', { frame: frame('doc-remote', 'doc-main'), childFrames: [{ frame: frame('doc-remote-child', 'doc-remote') }] }]
  ])
  let afterAx = false
  let hiddenEffects = 0
  const sender = (session: string): BrowserCdpSender => async (method, params) => {
    calls.push({ session, method, ...(params ? { params } : {}) })
    if (method === 'Page.getFrameTree') {
      if (options.discoveryFailed && session === 'main') throw new Error('native discovery unavailable')
      const frameTree = structuredClone(trees.get(session))!
      if (afterAx && options.changed) {
        const visit = (node: any) => { if (node.frame.id === options.changed) node.frame.loaderId = 'new-loader'; for (const child of node.childFrames ?? []) visit(child) }
        visit(frameTree)
      }
      return { frameTree }
    }
    if (method === 'Accessibility.getFullAXTree') {
      const id = String(params?.frameId ?? 'doc-main')
      afterAx = true
      if (id === options.failed) throw new Error('actual accessibility unavailable')
      if (id === options.empty) return { nodes: [] }
      if ((session === 'main') !== !id.startsWith('doc-remote')) throw new Error('wrong sender for actual document')
      return { nodes: [
        { nodeId: `root-${id}`, frameId: options.wrongRoot && id === 'doc-child' ? 'doc-main' : id, role: { value: 'RootWebArea' }, childIds: [`target-${id}`, ...(options.nestedAx && id === 'doc-main' ? ['foreign-document'] : [])] },
        { nodeId: `target-${id}`, backendDOMNodeId: backends.get(id), role: { value: 'button' }, name: { value: 'Same action' } },
        ...(options.nestedAx && id === 'doc-main' ? [
          { nodeId: 'foreign-document', frameId: 'doc-child', role: { value: 'RootWebArea' }, childIds: ['foreign-target'] },
          { nodeId: 'foreign-target', backendDOMNodeId: 21, role: { value: 'button' }, name: { value: 'Same action' } }
        ] : [])
      ] }
    }
    if (method === 'Accessibility.enable' || method === 'Runtime.releaseObject') return {}
    if (method === 'Page.createIsolatedWorld') return options.realmFailed ? {} : { executionContextId: params?.frameId === 'doc-child' ? 21 : 11 }
    if (method === 'DOMSnapshot.captureSnapshot') return {
      strings: ['doc-main', 'doc-child'], documents: [
        { frameId: 0, nodes: { backendNodeId: [11] }, layout: { nodeIndex: [0], bounds: [[0, 0, 100, 20]] } },
        { frameId: 1, nodes: { backendNodeId: [21] }, layout: { nodeIndex: [0], bounds: [[0, 0, 100, 20]] } }
      ]
    }
    if (method === 'Runtime.evaluate' && String(params?.expression).includes('width: innerWidth')) return { result: { value: { width: 640, height: 480 } } }
    if (method === 'Runtime.evaluate' && String(params?.expression).includes('Observation within must match exactly one region')) {
      if (options.selectorInterference && params?.contextId !== 11) { hiddenEffects++; return { result: { objectId: 'node-21' } } }
      return { result: { objectId: 'node-11' } }
    }
    if (method === 'Runtime.evaluate' && options.evaluationFailure && String(params?.expression).includes("document.querySelectorAll('[onclick]")) {
      return options.evaluationFailure === 'exception' ? { exceptionDetails: { text: 'Observation context was destroyed' }, result: { value: '[]' } } : { result: {} }
    }
    if (method === 'Runtime.evaluate' && options.pageInterference && String(params?.expression).includes("document.querySelectorAll('[onclick]")) {
      if (params?.contextId !== 11) { hiddenEffects++; return { result: { value: '["Foreign child clickable"]' } } }
    }
    if (method === 'Runtime.evaluate' && String(params?.expression).includes('__agentmuxClickable[')) return { result: { objectId: 'node-21' } }
    if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
    if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params?.backendNodeId}` } }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: Number(String(params?.objectId).split('-')[1]) } }
    if (method === 'Runtime.callFunctionOn' && String(params?.functionDeclaration).includes('__agentmuxClickable.map')) return { result: { value: [] } }
    if (method === 'Runtime.callFunctionOn') { actions.push([session, Number(String(params?.objectId).split('-')[1])]); return { result: { value: null } } }
    throw new Error(`Unmodelled protocol command ${method}`)
  }
  const send = sender('main')
  const frames = new Map([['remote-session', sender('remote-session')]])
  const info = { url: 'https://fixture.invalid/', title: 'Frames', navigationId: 'main-nav-1' }
  const dispatch = createBrowserPageDispatch({
    session: { sendCommand: send, frames, frameDiscoveryFailure: null } as unknown as BrowserCdpSession,
    pageInfo: () => info, gotoUrl: async () => {}, captureScreenshot: async () => ({}),
    readLedger: async () => null, writeLedger: async () => {}, note: () => {}
  })
  return { calls, actions, send, frames, dispatch, hiddenEffects: () => hiddenEffects, capture: () => captureBrowserPageSnapshot({ send, frames, ...info }) }
}

describe('native document facts within the sole snapshot owner', () => {
  it('reads same-process, nested and OOPIF documents exactly once through their actual sender', async () => {
    const h = fixture()
    const captured = await h.capture()
    expect(captured.nodes.map(node => [node.frameId, node.sessionId, node.backendNodeId, node.depth])).toEqual([
      ['doc-main', undefined, 11, 0], ['doc-child', undefined, 21, 1], ['doc-nested', undefined, 31, 2],
      ['doc-remote', 'remote-session', 11, 1], ['doc-remote-child', 'remote-session', 41, 2]
    ])
    expect(captured.missingFrames).toEqual([])
    expect(h.calls.filter(call => call.method === 'Accessibility.getFullAXTree').map(call => [call.session, call.params?.frameId])).toEqual([
      ['main', 'doc-main'], ['main', 'doc-child'], ['main', 'doc-nested'],
      ['remote-session', 'doc-remote'], ['remote-session', 'doc-remote-child']
    ])
    expect(captured.scopeFacts.work).toMatchObject({ axTrees: 5, axNodes: 10, layoutTrees: 0, cdpCommands: h.calls.length })
    expect(new Set(captured.nodes.map(node => node.ref)).size).toBe(5)
  })

  it('publishes same-named targets separately and withinRef scopes a document rather than a shared session', async () => {
    const h = fixture()
    const first = await h.dispatch('snapshot', []) as BrowserScopedSnapshot
    expect(first.nodes).toHaveLength(5)
    const child = first.nodes.find(node => node.frameId === 'doc-child')!
    await h.dispatch('click', [child.ref])
    const local = await h.dispatch('snapshot', [{ withinRef: child.ref }]) as BrowserScopedSnapshot
    expect(local.nodes.map(node => [node.frameId, node.backendNodeId])).toEqual([['doc-child', 21]])
    expect(local.observation).toMatchObject({ fullObserved: 5, scoped: 1, returned: 1, truncated: false, scope: { document: 'doc-child' }, omittedFrames: ['doc-main', 'doc-nested', 'doc-remote', 'doc-remote-child'] })
    await h.dispatch('click', [local.nodes[0]!.ref])
    expect(h.actions).toEqual([['main', 21], ['main', 21]])
    await expect(h.dispatch('click', [child.ref])).rejects.toThrow(/superseded/)
    expect(h.actions).toEqual([['main', 21], ['main', 21]])
  })

  it('does not merge document identity for the same backend or same session', async () => {
    const h = fixture()
    const captured = await h.capture()
    const identities = new Set(captured.nodes.map(node => `${node.frameId}:${node.sessionId ?? ''}:${node.backendNodeId}`))
    expect(identities.size).toBe(5)
    // Deliberately exercise projection identity itself, not only its producer.
    const duplicate = { ...captured.nodes[0]!, frameId: 'other-document' }
    const projected = projectBrowserSnapshot({ ...captured, nodes: [captured.nodes[0]!, duplicate] },
      { ...captured.scopeFacts, document: 'doc-main', backendNodes: new Set(['doc-main:main:11']) }, parseBrowserSnapshotQuery({ maxNodes: 1 }))
    expect(projected.observation).toMatchObject({ fullObserved: 2, scoped: 1, returned: 1, truncated: false })
    expect(projected.nodes.map(node => node.frameId)).toEqual(['doc-main'])
  })

  it('viewport projection uses the same-process child document and its actual realm', async () => {
    const h = fixture()
    const query = parseBrowserSnapshotQuery({ withinRef: '@e2', scope: 'viewport' })
    const captured = await captureBrowserPageSnapshot({ send: h.send, frames: h.frames,
      url: 'https://fixture.invalid/', title: 'Frames', navigationId: 'nav', query,
      withinTarget: { objectId: 'node-21', frameId: 'doc-child' } })
    const projected = projectBrowserSnapshot(captured, captured.scopeFacts, query)
    expect(projected.nodes.map(node => [node.frameId, node.backendNodeId])).toEqual([['doc-child', 21]])
    expect(projected.observation).toMatchObject({ scope: { document: 'doc-child' }, fullObserved: 5, scoped: 1, work: { layoutTrees: 1 } })
    expect(h.calls.filter(call => call.method === 'Page.createIsolatedWorld').map(call => call.params?.frameId)).toEqual(['doc-main', 'doc-child'])
    expect(h.calls.filter(call => call.method === 'Runtime.evaluate' && String(call.params?.expression).includes('width: innerWidth')).map(call => call.params?.contextId)).toEqual([21])
  })

  it('page selectors cannot execute hidden effects or supply child backends for the Main supplement', async () => {
    const h = fixture({ pageInterference: true })
    const captured = await h.capture()
    expect(captured.nodes.map(node => [node.frameId, node.backendNodeId])).toEqual([
      ['doc-main', 11], ['doc-child', 21], ['doc-nested', 31], ['doc-remote', 11], ['doc-remote-child', 41]
    ])
    expect(h.hiddenEffects()).toBe(0)
    expect(h.calls.filter(call => call.method === 'Runtime.evaluate' && String(call.params?.expression).includes("document.querySelectorAll('[onclick]")).map(call => call.params?.contextId)).toEqual([11])
  })

  it('an unavailable Main observation realm keeps AX content and explicitly reports the missing supplement', async () => {
    const h = fixture({ realmFailed: true })
    const captured = await h.capture()
    expect(captured.nodes.map(node => node.frameId)).toEqual(['doc-main', 'doc-child', 'doc-nested', 'doc-remote', 'doc-remote-child'])
    expect(captured.missingFrames).toEqual([{frameId:'doc-main',reason:expect.stringMatching(/clickable observation is unavailable.*Accessibility content remains observable.*retry/)}])
  })

  it('CSS within resolves only in the actual Main isolated context, without page selector effects or foreign regions', async () => {
    const h = fixture({ selectorInterference: true })
    const pending = h.dispatch('snapshot', [{ within: '#scope' }])
    await expect(pending).resolves.toMatchObject({ missingFrames: [] })
    const local = await pending as BrowserScopedSnapshot
    expect(local.nodes.map(node => [node.frameId, node.backendNodeId])).toEqual([['doc-main', 11]])
    expect(local.observation).toMatchObject({ fullObserved: 5, scoped: 1, returned: 1, scope: { document: 'doc-main' } })
    expect(local.missingFrames).toEqual([])
    expect(h.hiddenEffects()).toBe(0)
    expect(h.actions).toEqual([])
    expect(h.calls.filter(call => call.method === 'Runtime.evaluate' && String(call.params?.expression).includes('Observation within must match exactly one region')).map(call => call.params?.contextId)).toEqual([11])
  })

  it.each(['exception', 'missing-value'] as const)('a %s during clickable evaluation is explicit incomplete observation and keeps actual AX content', async evaluationFailure => {
    const h = fixture({ evaluationFailure })
    const captured = await h.capture()
    expect(captured.nodes.map(node => node.frameId)).toEqual(['doc-main', 'doc-child', 'doc-nested', 'doc-remote', 'doc-remote-child'])
    expect(captured.missingFrames).toEqual([{ frameId: 'doc-main', reason: expect.stringMatching(/clickable observation is unavailable.*evaluation did not return.*Accessibility content remains observable.*retry/) }])
    expect(h.calls.filter(call => call.method === 'Runtime.evaluate' && call.params?.expression === 'delete window.__agentmuxClickable').map(call => call.params?.contextId)).toEqual([11])
    expect(h.actions).toEqual([])
  })

  it('reports a failed embedded AX tree while preserving all other actual documents', async () => {
    const h = fixture({ failed: 'doc-child' })
    const captured = await h.capture()
    expect(captured.nodes.map(node => node.frameId)).toEqual(['doc-main', 'doc-nested', 'doc-remote', 'doc-remote-child'])
    expect(captured.missingFrames).toEqual([{ frameId: 'doc-child', reason: 'actual accessibility unavailable' }])
    expect(captured.scopeFacts.work.axTrees).toBe(5)
  })

  it('an empty embedded tree is missing observation, not complete absence of elements', async () => {
    const h = fixture({ empty: 'doc-child' })
    const captured = await h.capture()
    expect(captured.nodes.map(node => node.frameId)).toEqual(['doc-main', 'doc-nested', 'doc-remote', 'doc-remote-child'])
    expect(captured.missingFrames).toEqual([{ frameId: 'doc-child', reason: expect.stringMatching(/no document root.*Retry/) }])
  })

  it('rejects a mismatched native AX root, and does not duplicate foreign document subtrees', async () => {
    const nested = await fixture({ nestedAx: true }).capture()
    expect(nested.nodes.map(node => [node.frameId, node.backendNodeId])).toEqual([
      ['doc-main', 11], ['doc-child', 21], ['doc-nested', 31], ['doc-remote', 11], ['doc-remote-child', 41]
    ])
    const wrong = await fixture({ wrongRoot: true }).capture()
    expect(wrong.nodes.map(node => node.frameId)).toEqual(['doc-main', 'doc-nested', 'doc-remote', 'doc-remote-child'])
    expect(wrong.missingFrames).toEqual([{ frameId: 'doc-child', reason: expect.stringMatching(/different document/) }])
  })

  it('discards a changed embedded document even though Main navigation and the sender did not change', async () => {
    const h = fixture({ changed: 'doc-child' })
    const captured = await h.capture()
    expect(captured.nodes.map(node => node.frameId)).toEqual(['doc-main', 'doc-nested', 'doc-remote', 'doc-remote-child'])
    expect(captured.missingFrames).toEqual([{ frameId: 'doc-child', reason: expect.stringMatching(/document disappeared, changed/i) }])
    expect(captured.navigationId).toBe('main-nav-1')
  })

  it('keeps both read and currency facts in one missing-document notice', async () => {
    const h = fixture({ failed: 'doc-child', changed: 'doc-child' })
    const captured = await h.capture()
    expect(captured.nodes.map(node => node.frameId)).toEqual(['doc-main', 'doc-nested', 'doc-remote', 'doc-remote-child'])
    expect(captured.missingFrames).toEqual([{frameId:'doc-child',reason:expect.stringMatching(/^actual accessibility unavailable .*document disappeared, changed.*snapshot/)}])
  })

  it('preserves observable main content and states unknown embedded coverage when discovery fails', async () => {
    const h = fixture({ discoveryFailed: true })
    const captured = await h.capture()
    expect(captured.nodes.map(node => [node.frameId, node.backendNodeId])).toEqual([['doc-main', 11]])
    expect(captured.missingFrames[0]).toMatchObject({ frameId: '(document discovery)', reason: expect.stringMatching(/coverage is unknown.*Retry/) })
    expect(captured.missingFrames.length).toBeGreaterThan(0)
    expect(captured.scopeFacts.work.axTrees).toBe(1)
  })

  it('bounds actual document reads, and marks unobserved frames separately from output clipping', async () => {
    let axReads = 0
    const send: BrowserCdpSender = async method => {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'actual-main', loaderId: 'one' },
        childFrames: Array.from({ length: 150 }, (_, index) => ({ frame: { id: `actual-${index}`, parentId: 'actual-main', loaderId: 'one' } })) } }
      if (method === 'Accessibility.getFullAXTree') { axReads++; return { nodes: [{ nodeId: 'a', backendDOMNodeId: axReads, role: { value: 'button' }, name: { value: 'Present' } }] } }
      if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
      return {}
    }
    const captured = await captureBrowserPageSnapshot({ send, url: 'https://fixture.invalid/', title: 'Bounded', navigationId: 'nav' })
    expect(captured.nodes).toHaveLength(MAX_BROWSER_FRAME_DOCUMENTS)
    expect(axReads).toBe(MAX_BROWSER_FRAME_DOCUMENTS)
    expect(captured.missingFrames).toEqual([{ frameId: 'actual-127', reason: expect.stringMatching(/128-document.*further embedded documents were not observed/) }])
    const projected = projectBrowserSnapshot(captured, captured.scopeFacts, parseBrowserSnapshotQuery({ maxNodes: 1 }))
    expect(projected.observation).toMatchObject({ fullObserved: 128, returned: 1, truncated: true, work: { axTrees: 128 } })
    expect(projected.missingFrames).toEqual(captured.missingFrames)
  })

  it('refuses ambiguous native sender ownership and unknown ancestry', async () => {
    const tree = { frameTree: { frame: { id: 'actual-main', loaderId: 'one' }, childFrames: [{ frame: { id: 'actual-child', parentId: 'actual-main', loaderId: 'two' } }] } }
    const main: BrowserCdpSender = async () => tree
    const sender: BrowserCdpSender = async () => ({ frameTree: { frame: { id: 'actual-child', parentId: 'actual-main', loaderId: 'two' } } })
    const duplicate: BrowserCdpSender = async () => ({ frameTree: { frame: { id: 'actual-child', parentId: 'actual-main', loaderId: 'two' } } })
    const discovery = await discoverBrowserFrameDocuments(main, new Map([['session-a', sender], ['session-b', duplicate]]))
    expect(discovery.documents.map(document => document.frameId)).toEqual(['actual-main'])
    expect(discovery.missingFrames).toEqual([{ frameId: 'actual-child', reason: expect.stringMatching(/More than one/) }])
  })
})
