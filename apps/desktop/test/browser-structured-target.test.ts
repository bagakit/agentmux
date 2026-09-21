import { describe, expect, it } from 'vitest'
import { resolveBrowserStructuredTarget } from '../src/main/browser-structured-target.js'
import type { BrowserCdpSender } from '../src/main/browser-page-snapshot.js'

function fixture() {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  let current: unknown = true
  let exception: unknown
  let describedFrame: string | undefined = 'child-document'
  const send: BrowserCdpSender = async (method, params) => {
    calls.push({ method, params })
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-document' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params?.frameId === 'main-document' ? 11 : 22 }
    if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params?.executionContextId}` } }
    if (method === 'DOM.describeNode') return { node: { frameId: describedFrame } }
    if (method === 'Runtime.releaseObject') return {}
    if (method === 'Runtime.evaluate') return params?.expression === 'document.URL'
      ? { result: { value: 'https://fixture.invalid/document#fragment' } }
      : { result: { objectId: 'root-11' } }
    if (method === 'Runtime.callFunctionOn') return String(params?.functionDeclaration).includes('getOwnPropertyDescriptor')
      ? { result: { objectId: 'actual-document-element' } }
      : { result: { value: current }, ...(exception ? { exceptionDetails: exception } : {}) }
    throw new Error(`Unexpected command ${method}`)
  }
  return { send, calls, setCurrent: (value: unknown) => { current = value },
    setException: () => { exception = { text: 'Context unavailable' } },
    removeFrame: () => { describedFrame = undefined } }
}

describe('structured observation resolves native wrappers in the actual document', () => {
  it('resolves CSS only in an isolated main document and retains the actual URL including its fragment', async () => {
    const f = fixture()
    const target = await resolveBrowserStructuredTarget(f.send, { within: '#scope' })
    expect(target).toMatchObject({ objectId: 'root-11', document: 'main-document:11' })
    expect(f.calls.filter(call => call.method === 'Page.createIsolatedWorld').map(call => call.params))
      .toEqual([{ frameId: 'main-document', worldName: 'agentmux-structured-observation', grantUniveralAccess: false }])
    const evaluation = f.calls.find(call => String(call.params?.expression).includes('querySelectorAll'))
    expect(evaluation?.params).toMatchObject({ contextId: 11, returnByValue: false })
    expect(await target.isCurrent()).toBe(true)
    expect(f.calls.at(-1)?.params).toMatchObject({ objectId: 'root-11', arguments: [{ value: 'https://fixture.invalid/document#fragment' }] })
    await target.release()
    expect(f.calls.filter(call => call.method === 'Runtime.releaseObject').map(call => call.params?.objectId)).toEqual(['root-11'])
  })

  it('uses the backend node’s actual document frame even when the sender also serves the parent', async () => {
    const f = fixture()
    const target = await resolveBrowserStructuredTarget(f.send, { backendNodeId: 71 })
    expect(target).toMatchObject({ objectId: 'node-22', document: 'child-document:22' })
    expect(f.calls.filter(call => call.method === 'DOM.resolveNode').map(call => call.params))
      .toEqual([{ backendNodeId: 71, executionContextId: 11 }, { backendNodeId: 71, executionContextId: 22 }])
    expect(f.calls.filter(call => call.method === 'Page.createIsolatedWorld').map(call => call.params?.frameId))
      .toEqual(['main-document', 'child-document'])
    expect(f.calls.find(call => call.method === 'Runtime.evaluate')?.params).toMatchObject({ contextId: 22, expression: 'document.URL' })
    await target.release(); await target.release()
    expect(f.calls.filter(call => call.method === 'Runtime.releaseObject').map(call => call.params?.objectId))
      .toEqual(['node-11', 'actual-document-element', 'node-22'])
  })

  it('keeps proven disconnection distinct from an unknown document response', async () => {
    const f = fixture()
    const target = await resolveBrowserStructuredTarget(f.send, {})
    f.setCurrent(false)
    expect(await target.isCurrent()).toBe(false)
    f.setCurrent(undefined)
    await expect(target.isCurrent()).rejects.toThrow(/could not be verified/)
    f.setCurrent(true); f.setException()
    await expect(target.isCurrent()).rejects.toThrow(/Browser remains usable/)
    await target.release()
  })

  it('does not interpret a CDP transport failure as a proven page change', async () => {
    const f = fixture()
    const send: BrowserCdpSender = async (method, params) => {
      if (method === 'Runtime.callFunctionOn') throw new Error('Transport closed')
      return await f.send(method, params)
    }
    const target = await resolveBrowserStructuredTarget(send, {})
    await expect(target.isCurrent()).rejects.toThrow('Transport closed')
    await target.release()
  })

  it('releases every acquired backend handle when the document frame cannot be verified', async () => {
    const f = fixture(); f.removeFrame()
    await expect(resolveBrowserStructuredTarget(f.send, { backendNodeId: 71 })).rejects.toThrow(/document frame/)
    expect(f.calls.filter(call => call.method === 'Runtime.releaseObject').map(call => call.params?.objectId))
      .toEqual(['node-11', 'actual-document-element'])
  })
})
