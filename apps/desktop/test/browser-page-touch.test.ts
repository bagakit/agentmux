// @vitest-environment happy-dom
import { importTaskRecording } from './helpers/import-task-recording.js'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_PAGE_CAPABILITIES, BROWSER_PAGE_MUTATING_CAPABILITY_NAMES } from '@agentmux/core'
import { PREPARE_TOUCH_WITNESS_DECLARATION } from '@agentmux/browser/page'
import { createBrowserPageDispatch } from '@agentmux/browser/page'
import { compileBrowserSteps } from '../src/main/browser-replay-compiler'
import { BrowserTaskAssets, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import { startBrowserOperationStep } from '@agentmux/browser/operations'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAssetDocument, BrowserTaskContent } from '../src/shared/browser-task-assets'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
function fixture(remaining = Number.POSITIVE_INFINITY, supplyBudget = true) {
  const calls: { method: string; params: any }[] = [], targets: any[] = [], listeners = new Set<any>()
  const notes: string[] = [], controller = new AbortController()
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
    return {}
  }
  const dispatch = createBrowserPageDispatch({ ...(supplyBudget ? { remainingMillis: () => remaining } : {}), signal: controller.signal, session: { sendCommand, frames: new Map(), endedReason: null, frameDiscoveryFailure: null,
    observe: listener => { listeners.add(listener); return () => listeners.delete(listener) } },
    pageInfo: () => ({ url: 'https://example.test/drag', title: 'Drag', navigationId }), gotoUrl: async () => {}, captureScreenshot: async () => ({}),
    readLedger: async () => null, writeLedger: async () => {}, note: text => notes.push(text), beforeAction: () => { if (!controlled) throw new Error('Human took control') },
    recordTarget: (target, endpoint) => targets.push({ endpoint: endpoint ?? 'source', target }),
    beginNativeInput: async () => ({ input: async command => { own = true; try { return await command() } finally { own = false } }, end: () => { ended++ } }) })
  return { calls, dispatch, targets, controller, notes, ended: () => ended, listeners,
    setHook: (next: typeof hook) => { hook = next }, navigate: () => { navigationId = 'nav-2' }, takeover: () => { controlled = false }, remove: () => { removed = true },
    refs: async () => { const page = await dispatch('snapshot', []) as any; expect(page.nodes).toHaveLength(2); return page.nodes.map((node: any) => node.ref) as [string, string] } }
}
const touches = (f: ReturnType<typeof fixture>) => f.calls.filter(row => row.method === 'Input.dispatchTouchEvent').map(row => row.params)
const semantic = (name: string) => ({ role: 'button', name, ordinal: 1, count: 1 })

describe('original native Browser touch', () => {
  it('a hold without a host budget spans Node timer sections instead of overflowing into a 1ms completion', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']})
    try {
      const f=fixture(Infinity,false), [ref]=await f.refs()
      let settled=false
      const held=f.dispatch('longPress',[ref,{durationMs:2**31}]).then(value=>{settled=true;return value})
      for(let turn=0;turn<300;turn++)await Promise.resolve()
      expect(touches(f).map(row=>row.type)).toEqual(['touchStart'])
      await vi.advanceTimersByTimeAsync(1)
      expect(settled,'An overflowing native hold must not become a 1ms success').toBe(false)
      await vi.advanceTimersByTimeAsync(2**31-2)
      expect(settled,'The first timer section is not the requested whole hold').toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await held
      expect(touches(f).map(row=>row.type)).toEqual(['touchStart','touchEnd'])
    } finally {vi.useRealTimers()}
  })
  it('a hold without a host budget remains cancellable during a timer section', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']})
    try {
      const f=fixture(Infinity,false), [ref]=await f.refs()
      const held=f.dispatch('longPress',[ref,{durationMs:2**31}]).catch(error=>error)
      for(let turn=0;turn<300;turn++)await Promise.resolve()
      f.controller.abort(new Error('Original operation stopped'))
      expect((await held).fact).toEqual({kind:'locator-changed',effects:'unknown'})
      expect(touches(f).map(row=>row.type)).not.toContain('touchEnd')
    } finally {vi.useRealTimers()}
  })
  it('advertises four actually dispatched mutating gestures without a device-identity claim', () => {
    for (const name of ['tap', 'longPress', 'swipe', 'pinch']) {
      expect(BROWSER_PAGE_CAPABILITIES.some(row => row.name === name)).toBe(true)
      expect(BROWSER_PAGE_MUTATING_CAPABILITY_NAMES.has(name)).toBe(true)
    }
  })
  it('taps the fresh original target through native touch, never DOM event synthesis', async () => {
    const f = fixture(), refs = await f.refs(); await f.dispatch('tap', [refs[0]])
    expect(touches(f).map(row => row.type)).toEqual(['touchStart', 'touchEnd'])
    expect(touches(f)[0].touchPoints).toMatchObject([{ id: 1, x: 30, y: 20 }])
    expect(f.targets).toMatchObject([{ target: { name: 'Source' } }]); expect(f.ended()).toBe(1)
    expect(f.calls.some(row => row.method === 'Runtime.callFunctionOn' && /dispatchEvent|new Touch/.test(row.params.functionDeclaration))).toBe(false)
    expect(f.calls.some(row => row.method.startsWith('Emulation.'))).toBe(false)
  })
  it('swipes between two current semantic endpoints and pinches with two distinct contacts inside the same ref', async () => {
    const f = fixture(), refs = await f.refs(); await f.dispatch('swipe', refs)
    expect(touches(f)[0].touchPoints).toMatchObject([{ x: 30, y: 20 }])
    expect(touches(f)[1].touchPoints).toMatchObject([{ x: 210, y: 20 }])
    expect(f.targets.map(row => row.target.name)).toEqual(['Source', 'Drop'])
    expect(f.targets[1].endpoint).toBe('destination')
    f.calls.length = 0; await f.dispatch('pinch', [refs[0], { scale: 2 }])
    const start = touches(f)[0].touchPoints, end = touches(f)[1].touchPoints
    expect(start).toHaveLength(2); expect(start[0].id).not.toBe(start[1].id)
    expect(start.map((p: any) => p.x)).toEqual([25, 35]); expect(end.map((p: any) => p.x)).toEqual([20, 40])
    expect(touches(f).at(-1).touchPoints).toEqual([])
  })
  it('rejects invalid options and guessed destinations before native input', async () => {
    const f = fixture(), refs = await f.refs()
    for (const [kind, args] of [['tap', [refs[0], { x: 20 }]], ['longPress', [refs[0], { durationMs: -1 }]],
      ['pinch', [refs[0], { scale: NaN }]], ['pinch', [refs[0], { scale: 2, hidden: true }]], ['swipe', [refs[0], '@absent']]] as const)
      await expect(f.dispatch(kind, [...args])).rejects.toThrow()
    expect(touches(f)).toEqual([])
  })
  it('refuses a hold that cannot fit this original program’s remaining time before any contact', async () => {
    const f = fixture(20), refs = await f.refs()
    await expect(f.dispatch('longPress', [refs[0], { durationMs: 30 }])).rejects.toMatchObject({ fact: { effects: 'not-dispatched' } })
    expect(touches(f)).toEqual([])
  })
  it.each(['navigation', 'takeover', 'lost-start'] as const)('keeps %s after touch start unknown and never sends a late end into another owner', async cause => {
    const f = fixture(), refs = await f.refs()
    f.setHook((method, params) => { if (method === 'Input.dispatchTouchEvent' && params.type === 'touchStart') {
      if (cause === 'navigation') f.navigate()
      if (cause === 'takeover') f.takeover()
      if (cause === 'lost-start') throw new Error('Native reply lost')
    } })
    await expect(f.dispatch('tap', [refs[0]])).rejects.toMatchObject({ fact: { effects: 'unknown' } })
    expect(touches(f).filter(row => row.type === 'touchStart')).toHaveLength(1)
    expect(touches(f).some(row => row.type === 'touchEnd')).toBe(false)
    if (cause !== 'lost-start') expect(touches(f).filter(row => row.type === 'touchCancel')).toHaveLength(0)
    expect(f.ended()).toBe(1)
  })
  it('keeps an acknowledged final tap when its normal action navigates the page', async () => {
    const f = fixture(), refs = await f.refs()
    f.setHook((method, params) => { if (method === 'Input.dispatchTouchEvent' && params.type === 'touchEnd') f.navigate() })
    await expect(f.dispatch('tap', [refs[0]])).resolves.toBeUndefined()
    expect(touches(f).map(row => row.type)).toEqual(['touchStart', 'touchEnd'])
  })
  it('does not move a pressed swipe into a removed or replaced original destination', async () => {
    const f = fixture(), refs = await f.refs()
    f.setHook((method, params) => { if (method === 'Input.dispatchTouchEvent' && params.type === 'touchStart') f.remove() })
    await expect(f.dispatch('swipe', refs)).rejects.toMatchObject({ fact: { effects: 'unknown' } })
    expect(touches(f).some(row => row.type === 'touchMove' || row.type === 'touchEnd')).toBe(false)
    expect(touches(f).filter(row => row.type === 'touchStart')).toHaveLength(1)
  })
  it('cancels the original held contact wait immediately on Stop instead of sending its delayed end', async () => {
    const f = fixture(), refs = await f.refs()
    f.setHook((method, params) => { if (method === 'Input.dispatchTouchEvent' && params.type === 'touchStart') setTimeout(() => f.controller.abort(), 1) })
    await expect(f.dispatch('longPress', [refs[0], { durationMs: 30_000 }])).rejects.toMatchObject({ fact: { effects: 'unknown' } })
    expect(touches(f).map(row => row.type)).toEqual(['touchStart']); expect(f.ended()).toBe(1)
  })
  it('keeps an earlier unknown result when the caller explicitly starts a fresh gesture', async () => {
    const f = fixture(), refs = await f.refs(); let fail = true
    f.setHook((method, params) => { if (fail && method === 'Input.dispatchTouchEvent' && params.type === 'touchStart') { fail = false; throw Error('Original reply lost') } })
    await expect(f.dispatch('tap', [refs[0]])).rejects.toMatchObject({ fact: { effects: 'unknown' } })
    const original = [...touches(f)]; await f.dispatch('tap', [refs[0]])
    expect(touches(f).slice(0, original.length)).toEqual(original)
    expect(touches(f).slice(original.length).map(row => row.type)).toEqual(['touchStart', 'touchEnd'])
  })
})
it('swipe replay resolves fresh endpoints together and never retains ephemeral refs', async () => {
  const swipe = vi.fn(), snapshot = vi.fn(async () => ({ observation: { scope: { kind: 'page', document: null }, truncated: false, omittedFrames: [] }, nodes: [{ ref: '@new-source', ...semantic('Source') }, { ref: '@new-end', ...semantic('Drop') }] }))
  const code = compileBrowserSteps({ url: 'https://example.test/drag', steps: [{ method: 'swipe', url: 'https://example.test/drag', target: semantic('Source'), destination: semantic('Drop'), args: [] }] })
  await new (Object.getPrototypeOf(async function () {}).constructor)('pageInfo', 'snapshot', 'swipe', code)(async () => ({ url: 'https://example.test/drag' }), snapshot, swipe)
  expect(swipe).toHaveBeenCalledExactlyOnceWith('@new-source', '@new-end'); expect(snapshot).toHaveBeenCalledTimes(1)
  expect(startBrowserOperationStep({ url: 'https://example.test/drag', steps: [] } as any, 'swipe', ['@source', '@end']).replay?.args).toEqual([])
})
it('page-forged touch starts cannot confirm Main’s original native touch', () => {
  const target = window.document.createElement('button'); document.body.append(target)
  const witness = new Function(`return (${PREPARE_TOUCH_WITNESS_DECLARATION})`)().call(target, 1)
  const event = new Event('touchstart', { bubbles: true }); Object.defineProperty(event, 'changedTouches', { value: [{}] }); target.dispatchEvent(event)
  expect(witness.read()).toBe(false); witness.dispose(); target.remove()
})
it('real task editor declares, saves and reloads reviewed gestures through the original asset owner', async () => {
  let saved: BrowserTaskAssetDocument | null = null
  const store: BrowserTaskAssetStore = { load: async () => structuredClone(saved), save: async next => { saved = structuredClone(next) } }, owner = new BrowserTaskAssets(store)
  let asset = await importTaskRecording(owner, { id: 'recording', browserId: 'page', navigationId: 'nav', url: 'https://example.test/drag', revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const host = document.createElement('div'), root = createRoot(host), save = vi.fn(async (draft: BrowserTaskContent) => { asset = await owner.edit(asset.id, asset.revision, draft); asset = await owner.saveVersion(asset.id, asset.revision) })
  document.body.append(host)
  try {
    await act(async () => root.render(createElement(BrowserTaskAssetEditor, { asset, recording: null, onImport: () => {}, onSaveDraft: async () => {}, onSaveVersion: save, onLocateStep: () => {}, onRun: async () => {}, onStop: () => {} })))
    const button = (name: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.includes(name))!
    await act(async () => button('Add touch gesture').click())
    for (const [field, value] of [['role', 'button'], ['name', 'Source']]) {
      const input = host.querySelector<HTMLInputElement>(`[aria-label="Task step 1 target ${field}"]`)!
      await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await act(async () => host.querySelector<HTMLInputElement>('[aria-label="Review task step 1"]')!.click())
    await act(async () => button('Save version').click())
    expect(save).toHaveBeenCalledTimes(1)
    expect((await new BrowserTaskAssets(store).get(asset.id))?.versions[0].steps[0]).toMatchObject({ kind: 'tap', target: semantic('Source'), reviewed: true })
    const draft = { ...asset.draft, steps: [{ ...asset.draft.steps[0], kind: 'longPress' as const, durationMs: 750 }] }
    const edited = await owner.edit(asset.id, asset.revision, draft), version = await owner.saveVersion(asset.id, edited.revision)
    expect((await new BrowserTaskAssets(store).get(asset.id))?.versions[1].steps[0]).toMatchObject({ kind: 'longPress', durationMs: 750 })
    await expect(owner.edit(asset.id, version.revision, { ...draft, steps: [{ ...draft.steps[0], durationMs: 0 }] })).rejects.toThrow('positive finite')
    expect(version.versions[0].steps[0].kind).toBe('tap')
  } finally { await act(async () => root.unmount()); host.remove() }
})
