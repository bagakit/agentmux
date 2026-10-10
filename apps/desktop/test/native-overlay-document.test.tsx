// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeOverlayChrome } from '../src/renderer/src/hooks/useNativeOverlayChrome'
import type { NativeBrowserInput, NativeBrowserVisibility } from '../src/shared/native-overlay'

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
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  bridge.publish.mockResolvedValue({ projected: 1, capturedPixels: 0 })
  frame = document.createElement('iframe'); document.body.append(frame)
  const doc = frame.contentDocument!, win = doc.defaultView!
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
  stage.getBoundingClientRect = () => new win.DOMRect(12, 22, 25, 20); menu.append(stage); doc.body.append(menu)
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  function Consumer() { return <output>{useNativeOverlayChrome(doc, scope)}</output> }
  await act(async () => root!.render(<Consumer />))
  return { doc, win, scan, stage, host }
}
async function collect() {
  await act(async () => { for (const callback of frames.splice(0)) callback(1); await Promise.resolve() })
}
const demand = (revision: number): NativeBrowserVisibility => ({ revision, bounds: [{ x: 0, y: 0, width: 400, height: 400 }], zoomFactor: 1.5, document: scope })

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
