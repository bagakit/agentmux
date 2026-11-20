// @vitest-environment happy-dom
import { importTaskRecording } from './helpers/import-task-recording.js'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_PAGE_CAPABILITIES, BROWSER_PAGE_MUTATING_CAPABILITY_NAMES } from '@agentmux/core'
import { PREPARE_POINTER_WITNESS_DECLARATION } from '@agentmux/browser/page'
import { createBrowserPageDispatch } from '@agentmux/browser/page'
import { compileBrowserSteps } from '../src/main/browser-replay-compiler'
import { BrowserTaskAssets, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import { startBrowserOperationStep } from '@agentmux/browser/operations'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAssetDocument, BrowserTaskContent } from '../src/shared/browser-task-assets'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
function fixture(html = false) {
  const calls: { method: string; params: any }[] = [], targets: any[] = [], listeners = new Set<any>()
  const notes: string[] = []
  let navigationId = 'nav-1', controlled = true, removed = false, own = false, ended = 0, moved = 0
  let hook = (_method: string, _params: any) => {}
  const payload = { items: [{ mimeType: 'text/plain', data: 'original native payload' }], dragOperationsMask: 1 }
  const sendCommand = async (method: string, params: any = {}): Promise<any> => {
    calls.push({ method, params }); hook(method, params)
    if (method.startsWith('Input.dispatch')) expect(own, 'trusted-input bracket must own every native dispatch').toBe(true)
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'loader' } } }
    if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: 'root', role: { value: 'generic' }, childIds: ['11', '12'] }, ...[11, 12].map((id, i) => ({ nodeId: String(id), backendDOMNodeId: id, role: { value: 'button' }, name: { value: i ? 'Drop' : 'Source' }, childIds: [] }))] }
    if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
    if (method === 'DOM.resolveNode') return { object: { objectId: `obj-${params.backendNodeId}` } }
    if (method === 'DOM.getContentQuads') { const x = params.objectId === 'obj-11' ? 10 : 190; return { quads: removed && x === 190 ? [] : [[x, 10, x + 40, 10, x + 40, 30, x, 30]] } }
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: params.x < 100 ? 11 : 12, frameId: 'main' }
    if (method === 'Runtime.callFunctionOn') return params.returnByValue === false ? { result: { objectId: 'pointer-witness' } } : { result: { value: true } }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 1 && ++moved === 1 && html) {
      for (const listener of listeners) listener('Input.dragIntercepted', { data: payload })
    }
    return {}
  }
  const dispatch = createBrowserPageDispatch({ session: { sendCommand, frames: new Map(), endedReason: null, frameDiscoveryFailure: null,
    observe: listener => { listeners.add(listener); return () => listeners.delete(listener) } },
    pageInfo: () => ({ url: 'https://example.test/drag', title: 'Drag', navigationId }), gotoUrl: async () => {}, captureScreenshot: async () => ({}),
    readLedger: async () => null, writeLedger: async () => {}, note: text => notes.push(text), beforeAction: () => { if (!controlled) throw new Error('Human took control') },
    recordTarget: (target, endpoint) => targets.push({ endpoint: endpoint ?? 'source', target }),
    beginNativeInput: async () => ({ input: async command => { own = true; try { return await command() } finally { own = false } }, end: () => { ended++ } }) })
  return { calls, dispatch, targets, payload, notes, ended: () => ended, listeners,
    setHook: (next: typeof hook) => { hook = next }, navigate: () => { navigationId = 'nav-2' }, takeover: () => { controlled = false }, remove: () => { removed = true },
    refs: async () => { const page = await dispatch('snapshot', []) as any; expect(page.nodes).toHaveLength(2); return page.nodes.map((node: any) => node.ref) as [string, string] } }
}
const mouse = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.params)

describe('native ref-to-ref Browser drag', () => {
  it('is discovered and classified as a mutating page capability', () => {
    expect(BROWSER_PAGE_CAPABILITIES.find(row => row.name === 'drag')?.summary).toContain('sourceRef, destinationRef')
    expect(BROWSER_PAGE_MUTATING_CAPABILITY_NAMES.has('drag')).toBe(true)
  })
  it('uses the exact native HTML5 payload and two independently resolved endpoints', async () => {
    const f = fixture(true), refs = await f.refs(); await f.dispatch('drag', refs)
    expect(f.targets.map(row => [row.endpoint, row.target.name])).toEqual([['source', 'Source'], ['destination', 'Drop']])
    const events = f.calls.filter(call => call.method === 'Input.dispatchDragEvent')
    expect(events.map(call => call.params.type)).toEqual(['dragEnter', 'dragOver', 'drop'])
    expect(events.every(call => call.params.data === f.payload && call.params.x === 210 && call.params.y === 20)).toBe(true)
    expect(mouse(f).map(event => event.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved'])
    expect(f.calls.some(call => call.method === 'Runtime.callFunctionOn' && /dispatchEvent|DataTransfer/.test(call.params.functionDeclaration))).toBe(false)
    expect(f.listeners.size).toBe(0); expect(f.ended()).toBe(1)
    expect(f.calls.filter(call => call.method === 'Input.setInterceptDrags').map(call => call.params.enabled)).toEqual([true, false])
  })
  it('preserves mouse/pointer dragging without inventing HTML5 data', async () => {
    const f = fixture(), refs = await f.refs(); await f.dispatch('drag', refs)
    expect(f.calls.filter(call => call.method === 'Input.dispatchDragEvent')).toHaveLength(0)
    expect(mouse(f).at(-1)).toMatchObject({ type: 'mouseReleased', x: 210, y: 20 })
  })
  it('rejects malformed, absent and old-document destination refs before pressing', async () => {
    const f = fixture(), refs = await f.refs()
    await expect(f.dispatch('drag', [refs[0], { x: 200, y: 20 }])).rejects.toThrow('sourceRef')
    await expect(f.dispatch('drag', [refs[0], '@e9999'])).rejects.toThrow(/snapshot/)
    f.navigate(); await expect(f.dispatch('drag', refs)).rejects.toThrow(/navigat/)
    expect(mouse(f).filter(event => event.type === 'mousePressed')).toHaveLength(0)
  })
  it.each(['navigation', 'takeover', 'removed-target', 'rejected-press'] as const)('keeps %s after press unknown, with no drop/release on a replacement target', async cause => {
    const f = fixture(true), refs = await f.refs()
    f.setHook((method, params) => { if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
      if (cause === 'navigation') f.navigate(); if (cause === 'takeover') f.takeover(); if (cause === 'removed-target') f.remove()
      if (cause === 'rejected-press') throw new Error('acknowledgement lost')
    } })
    await expect(f.dispatch('drag', refs)).rejects.toMatchObject({ fact: { kind: 'locator-changed', effects: 'unknown' } })
    expect(f.calls.some(call => call.method === 'Input.dispatchDragEvent' && call.params.type === 'drop')).toBe(false)
    expect(mouse(f).some(event => event.type === 'mouseReleased')).toBe(false)
    expect(f.calls.some(call => call.method === 'Input.dispatchDragEvent' && call.params.type === 'dragCancel')).toBe(true)
    expect(f.ended()).toBe(1)
  })
  it('attempts cleanup even when enabling interception loses its acknowledgement', async () => {
    const f = fixture(), refs = await f.refs()
    f.setHook((method, params) => { if (method === 'Input.setInterceptDrags' && params.enabled) throw new Error('enable reply lost') })
    await expect(f.dispatch('drag', refs)).rejects.toThrow('enable reply lost')
    expect(f.calls.filter(call => call.method === 'Input.setInterceptDrags').map(call => call.params.enabled)).toEqual([true, false])
    expect(mouse(f)).toHaveLength(0); expect(f.ended()).toBe(1)
  })
  it('retains acknowledged input and reports an unknown cleanup without closing the Browser capability', async () => {
    const f = fixture(), refs = await f.refs()
    f.setHook((method, params) => { if (method === 'Input.setInterceptDrags' && !params.enabled) throw new Error('cleanup unavailable') })
    await f.dispatch('drag', refs)
    expect(f.notes).toHaveLength(1); expect(f.notes[0]).toContain('cleanup could not be confirmed')
    expect(mouse(f).at(-1).type).toBe('mouseReleased'); expect(f.ended()).toBe(1)
  })
  it('rechecks takeover after beginning the own-input bracket before any press', async () => {
    const f = fixture(), refs = await f.refs()
    f.setHook(method => { if (method === 'Input.setInterceptDrags') f.takeover() })
    await expect(f.dispatch('drag', refs)).rejects.toThrow('Human took control')
    expect(mouse(f)).toHaveLength(0); expect(f.ended()).toBe(1)
  })
})

const semantic = (name: string) => ({ role: 'button', name, ordinal: 1, count: 1 })
const observation = { scope: { kind: 'page', document: null }, truncated: false, omittedFrames: [] }
it('replay resolves both endpoints in one complete snapshot and refuses a changed destination without a drag', async () => {
  const drag = vi.fn(), snapshot = vi.fn(async () => ({ observation, nodes: [{ ref: '@fresh-source', ...semantic('Source') }, { ref: '@fresh-drop', ...semantic('Drop') }] }))
  const script = compileBrowserSteps({ url: 'https://example.test/drag', steps: [{ method: 'drag', url: 'https://example.test/drag', target: semantic('Source'), destination: semantic('Drop'), args: ['@old-destination'] }] })
  const execute = () => new (Object.getPrototypeOf(async function () {}).constructor)('pageInfo', 'snapshot', 'drag', script)(async () => ({ url: 'https://example.test/drag' }), snapshot, drag)
  await execute(); expect(drag).toHaveBeenCalledExactlyOnceWith('@fresh-source', '@fresh-drop'); expect(snapshot).toHaveBeenCalledTimes(1)
  snapshot.mockResolvedValue({ observation, nodes: [{ ref: '@fresh-source', ...semantic('Source') }] }); drag.mockClear()
  await expect(execute()).rejects.toThrow('drop target changed'); expect(drag).not.toHaveBeenCalled()
})
it('operation replay never retains either ephemeral drag ref', () => {
  const operation: any = { steps: [], url: 'https://example.test/drag' }
  expect(startBrowserOperationStep(operation, 'drag', ['@source', '@destination']).replay?.args).toEqual([])
})
it('the real task editor authors and saves both semantic endpoints, then the task owner persists the immutable drag version', async () => {
  let document: BrowserTaskAssetDocument | null = null
  const store: BrowserTaskAssetStore = { load: async () => structuredClone(document), save: async next => { document = structuredClone(next) } }
  const owner = new BrowserTaskAssets(store)
  let asset = await importTaskRecording(owner, { id: 'recording', browserId: 'page', navigationId: 'nav', url: 'https://example.test/drag', revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const host = window.document.createElement('div'), root = createRoot(host), save = vi.fn(async (draft: BrowserTaskContent) => { asset = await owner.edit(asset.id, asset.revision, draft); asset = await owner.saveVersion(asset.id, asset.revision) })
  window.document.body.append(host)
  try {
    await act(async () => root.render(createElement(BrowserTaskAssetEditor, { asset, recording: null, onImport: () => {}, onSaveDraft: async () => {}, onSaveVersion: save, onLocateStep: () => {}, onRun: async () => {}, onStop: () => {} })))
    const button = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.includes(text))!
    await act(async () => button('Add drag').click())
    const review = host.querySelector<HTMLInputElement>('[aria-label="Review task step 1"]')!; expect(review.disabled).toBe(true)
    for (const [field, value] of [['source role', 'button'], ['source name', 'Source'], ['destination role', 'button'], ['destination name', 'Drop']]) {
      const input = host.querySelector<HTMLInputElement>(`[aria-label="Task step 1 ${field}"]`)!
      await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    expect(review.disabled).toBe(false); await act(async () => review.click()); await act(async () => button('Save version').click())
    expect(save).toHaveBeenCalledTimes(1)
    expect((await new BrowserTaskAssets(store).get(asset.id))?.versions[0]?.steps[0]).toMatchObject({ kind: 'drag', target: semantic('Source'), destination: semantic('Drop'), reviewed: true })
    expect(host.textContent).toContain('Source → Drop')
  } finally { await act(async () => root.unmount()); host.remove() }
})

it('a synthetic mousemove cannot manufacture the original native pointer witness', () => {
  const target = window.document.createElement('button'); window.document.body.append(target)
  const witness = new Function(`return (${PREPARE_POINTER_WITNESS_DECLARATION})`)().call(target)
  target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0 }))
  expect(witness.read()).toBe(false)
  witness.dispose(); target.remove()
})
