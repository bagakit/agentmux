import { describe, expect, it } from 'vitest'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'
import { parseBrowserSnapshotQuery } from '../src/main/browser-snapshot-query.js'
import type { BrowserCdpSession } from '../src/main/browser-cdp-session.js'
import type { BrowserCdpSender } from '../src/main/browser-page-snapshot.js'
import type { BrowserScopedSnapshot } from '../src/shared/browser-snapshot-query.js'
import type { BrowserRefLedger } from '../src/main/browser-ref-ledger.js'

const TREE = [
  { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['left', 'right'] },
  { nodeId: 'left', backendDOMNodeId: 20, role: { value: 'generic' }, childIds: ['a', 'text', 'b'] },
  { nodeId: 'a', backendDOMNodeId: 30, role: { value: 'button' }, name: { value: 'Save' } },
  { nodeId: 'text', backendDOMNodeId: 40, role: { value: 'StaticText' }, name: { value: 'Explanation' } },
  { nodeId: 'b', backendDOMNodeId: 50, role: { value: 'button' }, name: { value: 'Save' } },
  { nodeId: 'right', backendDOMNodeId: 60, role: { value: 'generic' }, childIds: ['c', 'far'] },
  { nodeId: 'c', backendDOMNodeId: 70, role: { value: 'button' }, name: { value: 'Save' } },
  { nodeId: 'far', backendDOMNodeId: 80, role: { value: 'button' }, name: { value: 'Far away' } }
]

function harness(withFrames = false, initialLedger: BrowserRefLedger | null = null) {
  const calls: { document: string; method: string; params?: Record<string, unknown> }[] = []
  const acted: { document: string; backend: number }[] = []
  const notes: string[] = []
  let ledger = initialLedger
  let navigationId = 'nav-1'
  const frameTree = [
    { nodeId: 'frame-root', role: { value: 'RootWebArea' }, childIds: ['field'] },
    { nodeId: 'field', backendDOMNodeId: 30, role: { value: 'textbox' }, name: { value: 'Frame field' } }
  ]
  const sender = (document: string): BrowserCdpSender => async (method, params) => {
    calls.push({ document, method, ...(params ? { params } : {}) })
    if (document === 'broken' && method === 'Accessibility.getFullAXTree') throw new Error('frame read unavailable')
    if (method === 'Accessibility.getFullAXTree') return { nodes: document === 'main' ? TREE : frameTree }
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression)
      if (expression.includes('document.querySelectorAll')) {
        if (expression.includes('#left')) return { result: { objectId: 'region-20' } }
        if (expression.includes('#right')) return { result: { objectId: 'region-60' } }
        return { exceptionDetails: { text: 'matches 0 or more than one' } }
      }
      if (expression.includes('width: innerWidth')) return { result: { value: { width: 900, height: 700 } } }
      return { result: { value: '[]' } }
    }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: Number(String(params?.objectId).split('-').at(-1)) } }
    if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params?.backendNodeId}` } }
    if (method === 'Runtime.callFunctionOn') {
      if (String(params?.functionDeclaration).includes('__agentmuxClickable')) return { result: { value: [] } }
      acted.push({ document, backend: Number(String(params?.objectId).split('-').at(-1)) })
      return { result: { value: null } }
    }
    if (method === 'DOMSnapshot.captureSnapshot') return {
      documents: [{ scrollOffsetX: 0, scrollOffsetY: 100, nodes: { backendNodeId: [30, 40, 50, 70, 80] }, layout: {
        nodeIndex: [0, 1, 2, 3, 4], bounds: [[0, 100, 100, 20], [0, 120, 100, 20], [0, 140, 100, 20], [200, 100, 100, 20], [0, 2000, 100, 20]]
      } }]
    }
    if (method === 'Accessibility.enable' || method === 'Runtime.releaseObject') return {}
    throw new Error(`Unexpected CDP command ${method}`)
  }
  const context = {
    session: { sendCommand: sender('main'), frames: withFrames ? new Map([['frame-one', sender('frame-one')], ['broken', sender('broken')]]) : new Map(), frameDiscoveryFailure: null } as unknown as BrowserCdpSession,
    pageInfo: () => ({ url: 'https://fixture.invalid/', title: 'Fixture', navigationId }),
    gotoUrl: async () => {}, captureScreenshot: async () => ({}),
    readLedger: async () => ledger,
    writeLedger: async (next: BrowserRefLedger) => { ledger = next },
    note: (text: string) => notes.push(text)
  }
  return { dispatch: createBrowserPageDispatch(context), context, calls, acted, notes, ledger: () => ledger, navigate: () => { navigationId = 'nav-2' } }
}

describe('bounded Browser observation through production dispatch', () => {
  it('projects a unique CSS region without renumbering, and only publishes returned handles', async () => {
    const h = harness()
    const result = await h.dispatch('snapshot', [{ within: '#left', interactiveOnly: true, maxNodes: 1 }]) as BrowserScopedSnapshot
    expect(result.nodes.map((node) => [node.ref, node.backendNodeId])).toEqual([['@e1', 30]])
    expect(result.observation).toMatchObject({ fullObserved: 5, scoped: 3, matched: 2, returned: 1, truncated: true, scope: { kind: 'subtree', document: 'main' } })
    expect(h.ledger()?.entries).toEqual([{ ref: '@e1', role: 'button', name: 'Save', nth: 1 }])
    await expect(h.dispatch('click', ['@e1'])).resolves.toBeNull()
    expect(h.acted).toEqual([{ document: 'main', backend: 30 }])
    await expect(h.dispatch('click', ['@e2'])).rejects.toThrow(/snapshot/i)
    expect(h.acted).toEqual([{ document: 'main', backend: 30 }])
  })

  it('separates excluded documents from actual failed reads and preserves capture costs', async () => {
    const h = harness(true)
    const result = await h.dispatch('snapshot', [{ within: '#right', maxNodes: 1 }]) as BrowserScopedSnapshot
    expect(result.nodes.map((node) => [node.ref, node.backendNodeId])).toEqual([['@e3', 70]])
    expect(result.observation).toMatchObject({ fullObserved: 6, scoped: 2, matched: 2, returned: 1, truncated: true, omittedFrames: ['frame-one', 'broken'], work: { axTrees: 3, axNodes: 10 } })
    expect(result.missingFrames).toEqual([{ frameId: 'broken', reason: 'frame read unavailable' }])
    expect(h.calls.filter((call) => call.method === 'Accessibility.getFullAXTree').map((call) => call.document)).toEqual(['main', 'frame-one', 'broken'])
    expect(result.observation.work.cdpCommands).toBe(h.calls.length)
  })

  it('never reuses an issued ref after another snapshot, including snapshotText', async () => {
    const h = harness()
    const first = await h.dispatch('snapshot', [{ within: '#left', interactiveOnly: true }]) as BrowserScopedSnapshot
    expect(first.nodes.map((node) => node.ref)).toEqual(['@e1', '@e2'])
    const second = await h.dispatch('snapshot', [{ within: '#right', interactiveOnly: true }]) as BrowserScopedSnapshot
    expect(second.nodes.map((node) => node.ref)).toEqual(['@e7', '@e8'])
    await expect(h.dispatch('click', [first.nodes[0]!.ref])).rejects.toThrow(/superseded/)
    await h.dispatch('click', [second.nodes[0]!.ref])
    expect(h.acted).toEqual([{ document: 'main', backend: 70 }])
    const text = await h.dispatch('snapshotText', [{ within: '#right', maxNodes: 1 }]) as string
    expect(text).toContain('@e11 button: Save')
    expect(text).toContain('truncated=true')
    await expect(h.dispatch('click', [second.nodes[0]!.ref])).rejects.toThrow(/superseded/)
    await h.dispatch('click', ['@e11'])
    expect(h.acted).toEqual([{ document: 'main', backend: 70 }, { document: 'main', backend: 70 }])
  })

  it('uses withinRef actual frame identity and refuses it after publication or navigation', async () => {
    const h = harness(true)
    const first = await h.dispatch('snapshot', []) as BrowserScopedSnapshot
    const target = first.nodes.find((node) => node.sessionId === 'frame-one')!
    expect(target).toMatchObject({ ref: '@e5', backendNodeId: 30 })
    const scoped = await h.dispatch('snapshot', [{ withinRef: target.ref }]) as BrowserScopedSnapshot
    expect(scoped.nodes.map((node) => [node.ref, node.sessionId, node.backendNodeId])).toEqual([['@e10', 'frame-one', 30]])
    expect(scoped.observation).toMatchObject({ scoped: 1, returned: 1, scope: { kind: 'subtree', document: 'frame-one', withinRef: '@e5' }, omittedFrames: ['main', 'broken'] })
    await expect(h.dispatch('click', [target.ref])).rejects.toThrow(/superseded/)
    await h.dispatch('fillInput', [scoped.nodes[0]!.ref, 'value'])
    expect(h.acted).toEqual([{ document: 'frame-one', backend: 30 }])
    h.navigate()
    await expect(h.dispatch('click', [scoped.nodes[0]!.ref])).rejects.toThrow(/navigat/i)
  })

  it('keeps full graph ordinals in the durable ledger for a clipped same-named element', async () => {
    const h = harness()
    const first = await h.dispatch('snapshot', []) as BrowserScopedSnapshot
    const secondSave = first.nodes.find((node) => node.backendNodeId === 50)!
    const scoped = await h.dispatch('snapshot', [{ withinRef: secondSave.ref }]) as BrowserScopedSnapshot
    expect(scoped.nodes.map((node) => node.backendNodeId)).toEqual([50])
    expect(h.ledger()?.entries).toEqual([{ ref: scoped.nodes[0]!.ref, role: 'button', name: 'Save', nth: 2 }])
    const nextRun = createBrowserPageDispatch(h.context)
    await nextRun('click', [scoped.nodes[0]!.ref])
    expect(h.acted).toEqual([{ document: 'main', backend: 50 }])
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]).toMatch(/appearance, not identity/)
  })

  it('reserves prior-run ref names even when a new snapshot has been issued', async () => {
    const h = harness(false, { url: 'https://fixture.invalid/', entries: [{ ref: '@e1', role: 'button', name: 'Far away', nth: 1 }] })
    const result = await h.dispatch('snapshot', [{ within: '#left', maxNodes: 1 }]) as BrowserScopedSnapshot
    expect(result.nodes.map((node) => node.ref)).toEqual(['@e2'])
    await expect(h.dispatch('click', ['@e1'])).resolves.toBeNull()
    expect(h.acted).toEqual([{ document: 'main', backend: 80 }])
    expect(h.notes).toHaveLength(1)
  })

  it('viewport projection uses document scroll offsets, and leaves full AX collection intact', async () => {
    const h = harness(true)
    const result = await h.dispatch('snapshot', [{ scope: 'viewport', interactiveOnly: true }]) as BrowserScopedSnapshot
    expect(result.nodes.map((node) => node.backendNodeId)).toEqual([30, 50, 70])
    expect(result.observation).toMatchObject({ fullObserved: 6, scoped: 4, matched: 3, returned: 3, truncated: false, scope: { kind: 'viewport', document: 'main' }, omittedFrames: ['frame-one', 'broken'], work: { axTrees: 3, layoutTrees: 1 } })
    expect(h.calls.filter((call) => call.method === 'Accessibility.getFullAXTree')).toHaveLength(3)
    expect(h.calls.filter((call) => call.method === 'DOMSnapshot.captureSnapshot')).toHaveLength(1)
  })

  it('counts the extra full capture needed to recover a prior-run withinRef', async () => {
    const h = harness(false, { url: 'https://fixture.invalid/', entries: [{ ref: '@e1', role: 'button', name: 'Save', nth: 2 }] })
    const result = await h.dispatch('snapshot', [{ withinRef: '@e1' }]) as BrowserScopedSnapshot
    expect(result.nodes.map((node) => node.backendNodeId)).toEqual([50])
    expect(h.notes).toHaveLength(1)
    expect(h.calls.filter((call) => call.method === 'Accessibility.getFullAXTree')).toHaveLength(2)
    expect(result.observation.work).toMatchObject({ axTrees: 2, axNodes: 16 })
  })

  it('invalid or ambiguous CSS scope does not silently become an empty or global result', async () => {
    const h = harness()
    const first = await h.dispatch('snapshot', []) as BrowserScopedSnapshot
    await expect(h.dispatch('snapshot', [{ within: '.ambiguous' }])).rejects.toThrow(/exactly one/)
    await h.dispatch('click', [first.nodes[0]!.ref])
    expect(h.acted).toEqual([{ document: 'main', backend: 30 }])
  })

  it('text reports actual missing and excluded frames beside counts', async () => {
    const h = harness(true)
    const text = await h.dispatch('snapshotText', [{ within: '#left', maxNodes: 1 }]) as string
    expect(text).toContain('6 observed, 3 scoped, 3 matched, 1 returned; truncated=true')
    expect(text).toContain('documents excluded by scope, not failed reads: frame-one, broken')
    expect(text).toContain('(frame broken could not be read: frame read unavailable)')
  })

  it('validates observation options at the real dispatcher before any new capture', async () => {
    const h = harness()
    for (const options of [{ maxNodes: 0 }, { maxNodes: 1001 }, { within: '#left', withinRef: '@e1' }, { scope: 'invented' }, { selector: '#left' }]) {
      await expect(h.dispatch('snapshot', [options])).rejects.toThrow()
    }
    expect(h.calls).toEqual([])
    expect(parseBrowserSnapshotQuery(undefined)).toEqual({ scope: 'page', interactiveOnly: false, maxNodes: 200 })
  })
})
