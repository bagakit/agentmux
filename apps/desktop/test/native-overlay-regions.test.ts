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
