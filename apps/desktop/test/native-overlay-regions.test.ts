// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { observeNativeOverlayRegions } from '../src/renderer/src/lib/native-overlay-regions'

let stop: (() => void) | undefined
let frame: (() => void) | undefined
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div><div data-overlay-host></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = () => callback(0); return 1 })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})
afterEach(() => { stop?.(); stop = undefined; frame = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })
function node(role: string, bounds = { x: 20, y: 50, width: 120, height: 80 }): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('role', role)
  element.textContent = 'Actual floating content'
  element.style.borderRadius = '8px'
  element.style.backgroundColor = 'rgb(40, 49, 45)'
  element.getBoundingClientRect = () => ({ ...bounds, top: bounds.y, left: bounds.x, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height, toJSON() {} })
  document.querySelector('[data-overlay-host]')!.appendChild(element)
  return element
}
function flushFrame(): void { const pending = frame; frame = undefined; pending?.() }
it.each(['portal', 'popover'])('only the open %s float declares its own real Browser stages and observes their resize', kind => {
  const popup = node('dialog'), stage = document.createElement('div'), hidden = document.createElement('div')
  stage.setAttribute('data-native-browser-stage', 'inside'); hidden.setAttribute('data-native-browser-stage', 'unrelated')
  const bounds = { x: 25, y: 65, width: 100, height: 60 }
  stage.getBoundingClientRect = () => ({ ...bounds, left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height, toJSON() {} })
  const hiddenGeometry = vi.spyOn(hidden, 'getBoundingClientRect')
  popup.appendChild(stage); document.getElementById('root')!.appendChild(hidden)
  const observed = vi.fn(); let resized!: () => void
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback } observe = observed; disconnect() {} })
  if (kind === 'popover') { popup.setAttribute('popover', 'auto'); document.getElementById('root')!.appendChild(popup) }
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1.25, publish).dispose
  if (kind === 'popover') {
    expect(publish.mock.calls).toEqual([[[], undefined]])
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' }); popup.dispatchEvent(event); flushFrame()
  }
  const expected = { id: 'chrome-1', bounds: { x: 25, y: 62.5, width: 150, height: 100 }, radius: 10,
    browserStages: [{ browserId: 'inside', bounds: { x: 31.25, y: 81.25, width: 125, height: 75 } }] }
  expect(publish.mock.calls.at(-1)).toEqual([[expected], undefined])
  expect(observed.mock.calls.map(call => call[0])).toEqual([popup, stage])
  expect(hiddenGeometry).not.toHaveBeenCalled()
  bounds.width = 90; resized(); flushFrame()
  expect(publish.mock.calls.at(-1)![0]).toEqual([{ ...expected, browserStages: [{ browserId: 'inside', bounds: { x: 31.25, y: 81.25, width: 112.5, height: 75 } }] }])
  expect(hiddenGeometry).not.toHaveBeenCalled()
})
it.each([false, true])('root terminal scroll performs zero new overlay work with unrelated float=%s', withFloat => {
  const root = document.getElementById('root')!
  const terminal = document.createElement('div'), rows = document.createElement('div')
  terminal.appendChild(rows); root.appendChild(terminal)
  const popup = withFloat ? node('tooltip') : null
  const geometry = popup ? vi.spyOn(popup, 'getBoundingClientRect') : null
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls).toEqual([[withFloat ? [{ id: 'chrome-1', bounds: { x: 20, y: 50, width: 120, height: 80 }, radius: 8 }] : [], undefined]])
  publish.mockClear(); geometry?.mockClear()
  for (let index = 0; index < 10; index++) {
    rows.dispatchEvent(new Event('scroll'))
    terminal.dispatchEvent(new Event('scroll'))
    root.dispatchEvent(new Event('scroll'))
  }
  flushFrame()
  expect(window.requestAnimationFrame).not.toHaveBeenCalled()
  expect(publish.mock.calls).toEqual([])
  if (geometry) expect(geometry).not.toHaveBeenCalled()
})
it('scrolling float content, its ancestor or the document keeps current nonempty geometry', () => {
  const bounds = { x: 20, y: 50, width: 120, height: 80 }, popup = node('menu', bounds)
  const content = document.createElement('div'); popup.appendChild(content)
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls).toEqual([[ [{ id: 'chrome-1', bounds: { ...bounds }, radius: 8 }], undefined]])
  for (const target of [content, popup, popup.parentElement!, document, window]) {
    bounds.y += 10
    target.dispatchEvent(new Event('scroll'))
    flushFrame()
    expect(publish.mock.calls.at(-1)![0], target === document ? 'document scroll' : target === window ? 'window scroll' : 'element scroll').toEqual([{ id: 'chrome-1', bounds: { ...bounds }, radius: 8 }])
  }
  expect(publish).toHaveBeenCalledTimes(6)
})
it('closed floating content does not turn ancestor scrolling into overlay work', () => {
  const popup = node('menu'); popup.setAttribute('data-state', 'closed')
  const observe = vi.fn(); vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect() {} })
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls).toEqual([[[], undefined]])
  expect(observe).not.toHaveBeenCalled()
  popup.parentElement!.dispatchEvent(new Event('scroll')); flushFrame()
  expect(window.requestAnimationFrame).not.toHaveBeenCalled()
  expect(publish.mock.calls).toEqual([[[], undefined]])
})
it('a top-layer popover follows its actual toggle invoker scroll and releases that relationship on close', () => {
  const bounds = { x: 20, y: 50, width: 120, height: 80 }, popup = node('dialog', bounds)
  popup.setAttribute('popover', 'auto')
  const root = document.getElementById('root')!, viewport = document.createElement('div'), invoker = document.createElement('button')
  viewport.appendChild(invoker); root.append(viewport, popup)
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls).toEqual([[[], undefined]])
  const open = new Event('toggle')
  Object.defineProperties(open, { newState: { value: 'open' }, source: { value: invoker } })
  popup.dispatchEvent(open); flushFrame()
  expect(publish.mock.calls.at(-1)![0]).toEqual([{ id: 'chrome-1', bounds: { ...bounds }, radius: 8 }])
  bounds.y += 30
  viewport.dispatchEvent(new Event('scroll')); flushFrame()
  expect(publish.mock.calls.at(-1)![0]).toEqual([{ id: 'chrome-1', bounds: { ...bounds }, radius: 8 }])
  const close = new Event('toggle')
  Object.defineProperty(close, 'newState', { value: 'closed' })
  popup.dispatchEvent(close); flushFrame()
  expect(publish.mock.calls.at(-1)![0]).toEqual([])
  publish.mockClear(); vi.mocked(window.requestAnimationFrame).mockClear()
  viewport.dispatchEvent(new Event('scroll')); flushFrame()
  expect(publish.mock.calls).toEqual([])
  expect(window.requestAnimationFrame).not.toHaveBeenCalled()
})
it('portal positioning style changes remain observed even when an unrelated terminal scroll is ignored', async () => {
  const bounds = { x: 20, y: 50, width: 120, height: 80 }, popup = node('tooltip', bounds)
  const terminal = document.createElement('div'); document.getElementById('root')!.appendChild(terminal)
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls).toEqual([[ [{ id: 'chrome-1', bounds: { ...bounds }, radius: 8 }], undefined]])
  publish.mockClear()
  terminal.dispatchEvent(new Event('scroll')); flushFrame()
  expect(publish.mock.calls).toEqual([])
  bounds.x += 40
  popup.parentElement!.style.transform = 'translateX(40px)'
  await new Promise(resolve => setTimeout(resolve, 0)); flushFrame()
  expect(publish.mock.calls).toEqual([[ [{ id: 'chrome-1', bounds: { ...bounds }, radius: 8 }], undefined]])
})
it('real tooltip and popover geometry scales into the same BrowserWindow coordinates', () => {
  node('tooltip')
  node('menu', { x: 160, y: 50, width: 100, height: 100 }).setAttribute('data-state', 'open')
  const insideRoot = document.createElement('div')
  insideRoot.setAttribute('data-state', 'open')
  document.getElementById('root')!.appendChild(insideRoot)
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1.25, publish).dispose
  expect(publish.mock.calls[0]).toEqual([[
    { id: 'chrome-1', bounds: { x: 25, y: 62.5, width: 150, height: 100 }, radius: 10 },
    { id: 'chrome-2', bounds: { x: 200, y: 62.5, width: 125, height: 125 }, radius: 10 }
  ], undefined])
})
it('movement and close publish current geometry; nested items do not duplicate views', async () => {
  const bounds = { x: 20, y: 50, width: 120, height: 80 }
  const menu = node('menu', bounds)
  const child = document.createElement('span')
  child.setAttribute('data-state', 'open')
  menu.appendChild(child)
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls[0]![0]).toEqual([{ id: 'chrome-1', bounds, radius: 8 }])
  bounds.x = 200
  menu.style.left = '200px'
  await new Promise(resolve => setTimeout(resolve, 0))
  frame?.()
  expect(publish.mock.calls.at(-1)![0]).toEqual([{ id: 'chrome-1', bounds, radius: 8 }])
  menu.remove()
  await new Promise(resolve => setTimeout(resolve, 0))
  frame?.()
  expect(publish.mock.calls.at(-1)![0]).toEqual([])
})
it('a translucent empty scrim is a colour plane, preserving underlying page pixels', () => {
  const scrim = node('presentation', { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
  scrim.textContent = ''
  scrim.setAttribute('data-state', 'open')
  scrim.style.backgroundColor = 'rgba(0, 0, 0, 0.2)'
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls[0]![0]).toEqual([{ id: 'chrome-1', bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, radius: 8, scrim: 'rgba(0, 0, 0, 0.2)' }])
})
it('full-window content bitmap is refused with visible degradation rather than covering the Browser', () => {
  node('dialog', { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls[0]![0]).toEqual([])
  expect(publish.mock.calls[0]![1]).toContain('Browser remains available')
})
it('native HTML popover toggle names the actual root-local target without observing the terminal tree', async () => {
  const popup = node('dialog')
  popup.setAttribute('popover', 'auto')
  document.getElementById('root')!.appendChild(popup)
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls[0]![0]).toEqual([])
  const open = new Event('toggle')
  Object.defineProperty(open, 'newState', { value: 'open' })
  popup.dispatchEvent(open)
  frame?.()
  expect(publish.mock.calls.at(-1)![0]).toEqual([{ id: 'chrome-1', bounds: { x: 20, y: 50, width: 120, height: 80 }, radius: 8 }])
  const close = new Event('toggle')
  Object.defineProperty(close, 'newState', { value: 'closed' })
  popup.dispatchEvent(close)
  frame?.()
  expect(publish.mock.calls.at(-1)![0]).toEqual([])
})
it('transparent holes are never replaced by the Main background and their unsupported shape is explicit', () => {
  const popup = node('dialog')
  popup.style.backgroundColor = 'rgba(40, 49, 45, 0.2)'
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls[0]![0]).toEqual([])
  expect(publish.mock.calls[0]![1]).toContain('transparency')
  expect(publish.mock.calls[0]![1]).toContain('Browser remains available')
})

it('preserves separately painted native child dialogs and their real layer order without projecting the transparent viewport host', () => {
  const parent = node('dialog', { x: 30, y: 40, width: 500, height: 400 })
  parent.setAttribute('popover', 'auto'); document.getElementById('root')!.append(parent)
  const host = document.createElement('div'); host.setAttribute('popover', 'manual')
  host.style.pointerEvents = 'none'; host.style.backgroundColor = 'rgba(0, 0, 0, 0)'
  host.getBoundingClientRect = () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }) as DOMRect
  parent.append(host)
  const dialog = node('dialog', { x: 300, y: 250, width: 320, height: 120 }); host.append(dialog)
  const publish = vi.fn(); stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  for (const target of [parent, host]) { const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' }); target.dispatchEvent(event) }
  flushFrame()
  expect(publish.mock.calls.at(-1)).toEqual([[
    { id: 'chrome-1', bounds: { x: 30, y: 40, width: 500, height: 400 }, radius: 8 },
    { id: 'chrome-2', bounds: { x: 300, y: 250, width: 320, height: 120 }, radius: 8 }
  ], undefined])
})

it('zero floats observe no geometry and terminal churn inside root does no overlay work', async () => {
  const observe = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect() {} })
  const terminal = document.createElement('div')
  document.getElementById('root')!.appendChild(terminal)
  const publish = vi.fn()
  stop = observeNativeOverlayRegions(document.body, () => 1, publish).dispose
  expect(publish.mock.calls).toEqual([[[], undefined]])
  expect(observe).not.toHaveBeenCalled()
  for (let index = 0; index < 10; index++) {
    const row = document.createElement('span')
    row.setAttribute('data-state', 'open')
    row.textContent = `Terminal bytes ${index}`
    terminal.appendChild(row)
  }
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(window.requestAnimationFrame).not.toHaveBeenCalled()
  expect(publish.mock.calls).toEqual([[[], undefined]])
  expect(observe).not.toHaveBeenCalled()
})
