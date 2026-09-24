// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeBrowserInput } from '../src/shared/native-overlay'
import { BrowserOperationStatus } from '../src/renderer/src/components/BrowserOperationSurface'
import { useNativeOverlayChrome } from '../src/renderer/src/hooks/useNativeOverlayChrome'
import { observeNativeOverlayRegions } from '../src/renderer/src/lib/native-overlay-regions'

const signals = vi.hoisted(() => ({ pointer: undefined as undefined | ((input: NativeBrowserInput) => void) }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { ui: {
  publishNativeOverlays: async () => ({ projected: 0, capturedPixels: 0 }),
  getZoomFactor: () => 1, onNativeOverlayWarning: () => () => {},
  onNativeBrowserInput(listener: (input: NativeBrowserInput) => void) { signals.pointer = listener; return () => { signals.pointer = undefined } }
} } }))
function Observer() { useNativeOverlayChrome(); return null }
let root: Root | undefined
afterEach(async () => { if(root) await act(async()=>root!.unmount()); root=undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('native page pointer closes the original keyboard-opened Radix menu without click or focus restoration', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async()=>root!.render(<div id="root"><Observer /><BrowserOperationStatus activity={{ operation: null, control: 'human' }} onOpenTimeline={() => {}} /><div data-native-browser-stage="page" tabIndex={0}>Native page region</div></div>))
  const trigger = container.querySelector<HTMLButtonElement>('.browser-operation-status__trigger')!, stage = container.querySelector('[data-native-browser-stage]')!
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(stage)
  trigger.focus()
  await act(async()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})))
  await vi.waitFor(() => expect(document.querySelector('[role=menu]')).not.toBeNull())
  const focus = vi.spyOn(trigger, 'focus'), click = vi.fn(), ordinary = vi.fn()
  stage.addEventListener('click', click)
  stage.addEventListener('pointerdown', ordinary)
  await act(async()=>{signals.pointer!({ type: 'pointerDown', browserId: 'page', x: 400, y: 120, button: 0 })})
  await vi.waitFor(() => expect(document.querySelector('[role=menu]')).toBeNull())
  expect(ordinary).toHaveBeenCalledTimes(1)
  expect((ordinary.mock.calls[0]![0] as PointerEvent).isTrusted).not.toBe(true)
  expect(click).not.toHaveBeenCalled()
  expect(focus).not.toHaveBeenCalled()
  await act(async()=>root!.unmount()); root=undefined
  expect(signals.pointer).toBeUndefined()
})

it('a stale native point cannot act on hidden Chrome and only named auto popovers light-dismiss', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  document.body.innerHTML = '<div id="root"><button>Hidden Chrome action</button><div data-native-browser-stage="page"></div></div><div data-overlay-host></div>'
  const stage = document.querySelector('[data-native-browser-stage]')!, button = document.querySelector('button')!
  const target = vi.spyOn(document, 'elementFromPoint').mockReturnValue(button), press = vi.fn()
  button.addEventListener('pointerdown', press)
  const overlays = observeNativeOverlayRegions(document.body, () => 1, () => {})
  overlays.handleNativeInput({ type: 'pointerDown', browserId: 'page', x: 300, y: 150, button: 0 })
  expect(press).not.toHaveBeenCalled()
  const popovers = ['auto', 'manual', '', 'hint'].map(kind => {
    const element = document.createElement('div'); element.setAttribute('popover', kind); Object.defineProperty(element, 'popover', { value: kind || 'auto' }); document.getElementById('root')!.appendChild(element)
    element.getBoundingClientRect = () => ({ x: 10, y: 10, width: 80, height: 50, left: 10, top: 10, right: 90, bottom: 60, toJSON() {} })
    vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':popover-open')
    element.hidePopover = vi.fn()
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' }); element.dispatchEvent(event)
    return element
  })
  target.mockReturnValue(stage)
  overlays.handleNativeInput({ type: 'pointerDown', browserId: 'page', x: 300, y: 150, button: 0 })
  expect(popovers.map(element => vi.mocked(element.hidePopover).mock.calls.length)).toEqual([1, 0, 1, 1])
  overlays.dispose()
  overlays.handleNativeInput({ type: 'pointerDown', browserId: 'page', x: 300, y: 150, button: 0 })
  expect(popovers.map(element => vi.mocked(element.hidePopover).mock.calls.length)).toEqual([1, 0, 1, 1])
})

it.each(['portal', 'popover'])('the original %s DOM owner receives enter/leave, capture pin and scoped Escape without copying native clicks', kind => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1 })
  document.body.innerHTML = '<div id="root"><button id="outside">Original Chrome</button></div><div data-overlay-host></div>'
  const popup = document.createElement('div'), stage = document.createElement('div')
  popup.setAttribute('role', 'dialog'); popup.setAttribute('data-state', 'open'); popup.style.backgroundColor = 'rgb(40, 49, 45)'
  stage.setAttribute('data-native-browser-stage', 'inside'); popup.appendChild(stage)
  const rect = { x: 90, y: 80, width: 240, height: 200, left: 90, top: 80, right: 330, bottom: 280, toJSON() {} }
  popup.getBoundingClientRect = () => rect
  stage.getBoundingClientRect = () => ({ ...rect, x: 110, y: 120, width: 200, height: 140, left: 110, top: 120, right: 310, bottom: 260 })
  if (kind === 'popover') { popup.setAttribute('popover', 'auto'); document.getElementById('root')!.appendChild(popup) }
  else document.querySelector('[data-overlay-host]')!.appendChild(popup)
  const target = vi.spyOn(document, 'elementFromPoint').mockReturnValue(stage), publish = vi.fn()
  const overlays = observeNativeOverlayRegions(document.body, () => 1, publish)
  const toggle = (state: string, type = 'toggle') => { const event = new Event(type); Object.defineProperty(event, 'newState', { value: state }); popup.dispatchEvent(event) }
  if (kind === 'popover') toggle('open')
  const regions = publish.mock.calls.at(-1)![0]
  expect(regions).toEqual([{ id: 'chrome-1', bounds: { x: 90, y: 80, width: 240, height: 200 }, radius: 0,
    browserStages: [{ browserId: 'inside', bounds: { x: 110, y: 120, width: 200, height: 140 } }] }])
  const enter = vi.fn(), leave = vi.fn(), down = vi.fn(), click = vi.fn(), escape = vi.fn((event: Event) => event.preventDefault())
  popup.addEventListener('pointerenter', enter); popup.addEventListener('pointerleave', leave)
  popup.addEventListener('pointerdown', down, true); popup.addEventListener('keydown', escape); stage.addEventListener('click', click)
  const move: NativeBrowserInput = { type: 'pointerMove', overlayId: regions[0].id, browserId: 'inside', x: 140, y: 160, button: 0 }
  overlays.handleNativeInput(move); overlays.handleNativeInput(move)
  expect(enter).toHaveBeenCalledTimes(1)
  expect((enter.mock.calls[0][0] as PointerEvent).bubbles).toBe(false)
  overlays.handleNativeInput({ ...move, type: 'pointerDown' })
  expect(down).toHaveBeenCalledTimes(1); expect(click).not.toHaveBeenCalled()
  target.mockReturnValue(document.getElementById('outside')!)
  overlays.handleNativeInput({ ...move, type: 'pointerLeave', x: 500, y: 160 })
  expect(leave).toHaveBeenCalledTimes(1)
  expect((leave.mock.calls[0][0] as PointerEvent).bubbles).toBe(false)
  overlays.handleNativeInput({ type: 'escape', overlayId: regions[0].id, browserId: 'different' })
  overlays.handleNativeInput({ type: 'escape', overlayId: 'stale', browserId: 'inside' })
  expect(escape).not.toHaveBeenCalled()
  overlays.handleNativeInput({ type: 'escape', overlayId: regions[0].id, browserId: 'inside' })
  expect(escape).toHaveBeenCalledTimes(1)
  if (kind === 'popover') toggle('closed')
  else popup.setAttribute('data-state', 'closed')
  overlays.handleNativeInput({ type: 'escape', overlayId: regions[0].id, browserId: 'inside' })
  expect(escape).toHaveBeenCalledTimes(1)
  overlays.dispose()
})

it('the same mounted float reenters from its native page after original DOM leave and a close/reopen between frames', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  let flush!: () => void
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { flush = () => callback(0); return 1 })
  document.body.innerHTML = '<div id="root"><div role="dialog" popover="auto" style="background:rgb(40, 49, 45)"><div data-native-browser-stage="inside"></div></div></div>'
  const popup = document.querySelector('[popover]')!, stage = popup.firstElementChild!
  const rect = { x: 90, y: 80, width: 240, height: 200, left: 90, top: 80, right: 330, bottom: 280, toJSON() {} }
  popup.getBoundingClientRect = stage.getBoundingClientRect = () => rect
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(stage)
  const publish = vi.fn(), overlays = observeNativeOverlayRegions(document.body, () => 1, publish)
  const toggle = (state: string, type = 'toggle') => { const event = new Event(type); Object.defineProperty(event, 'newState', { value: state }); popup.dispatchEvent(event) }
  toggle('open'); flush()
  expect(publish.mock.calls.at(-1)![0]).toEqual([{ id: 'chrome-1', bounds: { x: 90, y: 80, width: 240, height: 200 }, radius: 0,
    browserStages: [{ browserId: 'inside', bounds: { x: 90, y: 80, width: 240, height: 200 } }] }])
  const enter = vi.fn(); popup.addEventListener('pointerenter', enter)
  const move: NativeBrowserInput = { type: 'pointerMove', overlayId: 'chrome-1', browserId: 'inside', x: 120, y: 130, button: 0 }
  overlays.handleNativeInput(move); expect(enter).toHaveBeenCalledTimes(1)
  popup.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
  overlays.handleNativeInput(move); expect(enter).toHaveBeenCalledTimes(2)
  toggle('closed', 'beforetoggle')
  toggle('closed'); toggle('open'); flush()
  overlays.handleNativeInput(move); expect(enter).toHaveBeenCalledTimes(3)
  expect(popup.isConnected).toBe(true)
  overlays.dispose()
})
