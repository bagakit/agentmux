// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeOverlayChrome } from '../src/renderer/src/hooks/useNativeOverlayChrome'
import type { NativeBrowserInput, NativeBrowserVisibility, NativeOverlayReceipt } from '../src/shared/native-overlay'

const bridge = vi.hoisted(() => ({ publish: vi.fn(), visibility: undefined as undefined | ((value: NativeBrowserVisibility) => void),
  input: undefined as undefined | ((value: NativeBrowserInput) => void), release: vi.fn(), focus: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { ui: {
  getZoomFactor: () => 99,
  publishNativeOverlays: bridge.publish,
  nativeBrowserVisibility: () => new Promise(() => {}),
  onNativeBrowserVisibility(listener: typeof bridge.visibility) { bridge.visibility = listener; return bridge.release },
  onNativeBrowserInput(listener: typeof bridge.input) { bridge.input = listener; return bridge.release },
  onNativeOverlayWarning: () => bridge.release,
  nativeOverlayFocus: bridge.focus
} } }))
const scope = { windowId: 'original-child', documentGeneration: 'original-child-document' }
let root: Root | undefined, frame: HTMLIFrameElement | undefined
const frames: FrameRequestCallback[] = []
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; frame?.remove(); frame = undefined; document.body.innerHTML = ''; frames.length = 0
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals()
})
async function mount(rootDocument = false, includeMenu = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  bridge.publish.mockImplementation(async regions => ({ projected: regions.length, capturedPixels: 0 }))
  frame = document.createElement('iframe'); document.body.append(frame)
  const doc = frame.contentDocument!, win = doc.defaultView!
  const listeners = vi.spyOn(win, 'addEventListener'), removed = vi.spyOn(win, 'removeEventListener')
  vi.spyOn(win, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  vi.spyOn(win, 'cancelAnimationFrame').mockImplementation(() => {})
  const content = doc.createElement('main'); content.setAttribute('data-workbench-document-root', '')
  content.innerHTML = '<div role="menu" data-state="open">Original editor and terminal tree</div>'
  doc.body.append(content)
  const scan = vi.spyOn(content, 'querySelectorAll')
  const menu = doc.createElement('div'); menu.setAttribute('role', 'menu'); menu.setAttribute('data-state', 'open')
  menu.style.cssText = 'background-color: rgb(20, 20, 20); opacity: 1; border-radius: 4px'
  menu.getBoundingClientRect = () => new win.DOMRect(10, 20, 50, 40)
  const stage = doc.createElement('div'); stage.setAttribute('data-native-browser-stage', 'original-browser')
  stage.getBoundingClientRect = () => new win.DOMRect(12, 22, 25, 20); menu.append(stage)
  if (includeMenu) doc.body.append(menu)
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  function Consumer() { return <output>{useNativeOverlayChrome(doc, rootDocument ? undefined : scope)}</output> }
  await act(async () => root!.render(<Consumer />))
  return { doc, win, scan, stage, menu, host, listeners, removed }
}
async function collect() {
  await act(async () => { for (const callback of frames.splice(0)) callback(1); await Promise.resolve() })
}
const demand = (revision: number): NativeBrowserVisibility => ({ revision, bounds: [{ x: 0, y: 0, width: 400, height: 400 }], zoomFactor: 1.5, document: scope })

it.each([true, false])('queries native focus only for unreleased publication demand in root=%s', async rootDocument => {
  const { doc, win, menu, listeners, removed } = await mount(rootDocument, false)
  const handler = listeners.mock.calls.find(([type]) => type === 'blur')?.[1] as EventListener
  expect(handler, 'The real document consumer installs its capture guard before any projection').toBeTypeOf('function')
  const blur = () => {
    const stop = vi.fn()
    // Exercise the actual capture listener with the platform boundary supplied explicitly.
    // This is not an OS focus or synthetic DOM event qualification.
    handler({ target: win, isTrusted: true, stopImmediatePropagation: stop } as unknown as Event)
    return stop
  }
  const visibility = (revision: number, visible: boolean) => bridge.visibility!({ revision,
    bounds: visible ? [{ x: 0, y: 0, width: 400, height: 400 }] : [], zoomFactor: 1.5,
    ...(rootDocument ? {} : { document: scope }) })
  bridge.focus.mockReturnValue(true)
  const ordinaryBlur = blur()
  expect(bridge.focus, 'A document without projection demand performs no synchronous focus query').not.toHaveBeenCalled()
  expect(ordinaryBlur).not.toHaveBeenCalled()

  let published!: (receipt: NativeOverlayReceipt) => void, removedProjection!: (receipt: NativeOverlayReceipt) => void
  bridge.publish.mockImplementationOnce(() => new Promise(resolve => { published = resolve }))
  doc.body.append(menu); visibility(1, true); await collect()
  expect(bridge.publish.mock.calls.at(-1)![0]).toHaveLength(1)
  expect(blur(), 'Nonempty publication owns focus observation before its receipt').toHaveBeenCalledTimes(1)
  expect(bridge.focus.mock.calls.at(-1)).toEqual(rootDocument ? [] : [scope])
  bridge.focus.mockReturnValue(false); expect(blur()).not.toHaveBeenCalled()
  bridge.focus.mockImplementationOnce(() => { throw Error('Original native focus unavailable') })
  expect(blur()).not.toHaveBeenCalled()
  bridge.focus.mockReturnValue(true)

  bridge.publish.mockImplementationOnce(() => new Promise(resolve => { removedProjection = resolve }))
  visibility(2, false); await collect()
  expect(blur(), 'Queued empty demand cannot declare an in-flight original projection removed').toHaveBeenCalledTimes(1)
  await act(async () => published({ projected: 1, capturedPixels: 0 }))
  expect(bridge.publish.mock.calls.at(-1)![0]).toEqual([])
  expect(blur(), 'An empty request still needs its original removal acknowledgement').toHaveBeenCalledTimes(1)

  let replacement!: (receipt: NativeOverlayReceipt) => void
  bridge.publish.mockImplementationOnce(() => new Promise(resolve => { replacement = resolve }))
  visibility(3, true); await collect()
  await act(async () => removedProjection({ projected: 0, capturedPixels: 0 }))
  expect(bridge.publish.mock.calls.at(-1)![0]).toHaveLength(1)
  expect(blur(), 'An older empty receipt cannot release newer nonempty publication demand').toHaveBeenCalledTimes(1)
  await act(async () => replacement({ projected: 1, capturedPixels: 0 }))

  bridge.publish.mockRejectedValueOnce(Error('Original removal reply unavailable'))
  visibility(4, false); await collect()
  expect(blur(), 'Failed removal preserves original focus observation until absence is confirmed').toHaveBeenCalledTimes(1)
  visibility(5, false); await collect()
  bridge.focus.mockClear()
  expect(blur()).not.toHaveBeenCalled()
  expect(bridge.focus, 'Confirmed removal releases the synchronous query cost').not.toHaveBeenCalled()
  await act(async () => root!.unmount()); root = undefined
  expect(removed).toHaveBeenCalledWith('blur', handler, true)
})

it('waits for actual child scale and observes its portals without scanning original content', async () => {
  const { scan } = await mount()
  expect(scan).not.toHaveBeenCalled()
  expect(bridge.publish).not.toHaveBeenCalled()
  bridge.visibility!({ ...demand(100), document: { ...scope, documentGeneration: 'another-document' } })
  await collect()
  expect(bridge.publish).not.toHaveBeenCalled()
  bridge.visibility!(demand(1)); await collect()
  expect(scan).not.toHaveBeenCalled()
  const regions = bridge.publish.mock.calls.at(-1)![0]
  expect(regions).toHaveLength(1)
  expect(regions[0]).toMatchObject({ bounds: { x: 15, y: 30, width: 75, height: 60 }, radius: 6 })
  expect(bridge.publish.mock.calls.at(-1)![1]).toEqual(scope)
})

it('keeps original child native page notices inside that exact document and releases its consumer', async () => {
  const { stage } = await mount(), escape = vi.fn()
  stage.addEventListener('keydown', escape)
  bridge.visibility!(demand(1)); await collect()
  const notice = { type: 'escape' as const, browserId: 'original-browser', overlayId: 'chrome-1' }
  bridge.input!({ ...notice, document: { ...scope, documentGeneration: 'another-document' } })
  expect(escape).not.toHaveBeenCalled()
  bridge.input!({ ...notice, document: scope })
  expect(escape).toHaveBeenCalledTimes(1)
  const oldDemand = bridge.visibility!
  await act(async () => root!.unmount()); root = undefined
  expect(bridge.release).toHaveBeenCalledTimes(3)
  expect(bridge.publish.mock.calls.at(-1)).toEqual([[], scope])
  bridge.publish.mockClear(); oldDemand(demand(2)); await collect()
  expect(bridge.publish).not.toHaveBeenCalled()
})
