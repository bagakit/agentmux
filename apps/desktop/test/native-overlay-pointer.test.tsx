// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeBrowserPointer } from '../src/shared/native-overlay'
import { BrowserOperationStatus } from '../src/renderer/src/components/BrowserOperationSurface'
import { useNativeOverlayChrome } from '../src/renderer/src/hooks/useNativeOverlayChrome'
import { observeNativeOverlayRegions } from '../src/renderer/src/lib/native-overlay-regions'

const signals = vi.hoisted(() => ({ pointer: undefined as undefined | ((point: NativeBrowserPointer) => void) }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { ui: {
  publishNativeOverlays: async () => ({ projected: 0, capturedPixels: 0 }),
  getZoomFactor: () => 1, onNativeOverlayWarning: () => () => {},
  onNativeBrowserPointer(listener: (point: NativeBrowserPointer) => void) { signals.pointer = listener; return () => { signals.pointer = undefined } }
} } }))
function Observer() { useNativeOverlayChrome(); return null }
let root: Root | undefined
afterEach(async () => { if(root) await act(async()=>root!.unmount()); root=undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('native page pointer closes the original keyboard-opened Radix menu without click or focus restoration', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async()=>root!.render(<div id="root"><Observer /><BrowserOperationStatus activity={{ operation: null, control: 'human' }} onOpenTimeline={() => {}} /><div data-native-browser-stage tabIndex={0}>Native page region</div></div>))
  const trigger = container.querySelector<HTMLButtonElement>('.browser-operation-status__trigger')!, stage = container.querySelector('[data-native-browser-stage]')!
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(stage)
  trigger.focus()
  await act(async()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})))
  await vi.waitFor(() => expect(document.querySelector('[role=menu]')).not.toBeNull())
  const focus = vi.spyOn(trigger, 'focus'), click = vi.fn(), ordinary = vi.fn()
  stage.addEventListener('click', click)
  stage.addEventListener('pointerdown', ordinary)
  await act(async()=>{signals.pointer!({ x: 400, y: 120, button: 0 })})
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
  document.body.innerHTML = '<div id="root"><button>Hidden Chrome action</button><div data-native-browser-stage></div></div><div data-overlay-host></div>'
  const stage = document.querySelector('[data-native-browser-stage]')!, button = document.querySelector('button')!
  const target = vi.spyOn(document, 'elementFromPoint').mockReturnValue(button), press = vi.fn()
  button.addEventListener('pointerdown', press)
  const overlays = observeNativeOverlayRegions(document.body, () => 1, () => {})
  overlays.dismissAtPoint({ x: 300, y: 150, button: 0 })
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
  overlays.dismissAtPoint({ x: 300, y: 150, button: 0 })
  expect(popovers.map(element => vi.mocked(element.hidePopover).mock.calls.length)).toEqual([1, 0, 1, 1])
  overlays.dispose()
  overlays.dismissAtPoint({ x: 300, y: 150, button: 0 })
  expect(popovers.map(element => vi.mocked(element.hidePopover).mock.calls.length)).toEqual([1, 0, 1, 1])
})
