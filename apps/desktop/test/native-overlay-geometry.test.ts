// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { observeNativeOverlayRegions } from '../src/renderer/src/lib/native-overlay-regions'

const browser = { revision: 1, bounds: [{ x: 0, y: 0, width: 1200, height: 800 }] }
let frames: Map<number, FrameRequestCallback>, serial: number, dispose: (() => void) | undefined
let visibility: DocumentVisibilityState
beforeEach(() => {
  frames = new Map(); serial = 0; visibility = 'visible'
  document.body.innerHTML = '<div id="root"></div><div data-overlay-host></div>'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++serial, callback); return serial })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })
function flush() { const current = [...frames.values()]; frames.clear(); for (const callback of current) callback(0) }
function float() {
  const node = document.createElement('section'), box = { x: 20, y: 30, width: 200, height: 150 }
  node.setAttribute('role', 'dialog'); node.style.cssText = 'background:rgb(40,49,45);border-radius:8px'
  node.getBoundingClientRect = vi.fn(() => ({ ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON() {} }))
  document.querySelector('[data-overlay-host]')!.appendChild(node)
  return { node, box }
}

it('one document frame only reads the known rectangles while geometry is stable', () => {
  const floats = Array.from({ length: 8 }, float), publish = vi.fn()
  const host = document.querySelector('[data-overlay-host]')!, query = vi.spyOn(host, 'querySelectorAll'), styles = vi.spyOn(window, 'getComputedStyle')
  const rootRead = vi.spyOn(document.getElementById('root')!, 'getBoundingClientRect')
  dispose = observeNativeOverlayRegions(document.body, () => 1, publish, undefined, browser).dispose
  publish.mockClear(); query.mockClear(); styles.mockClear()
  for (const { node } of floats) vi.mocked(node.getBoundingClientRect).mockClear()
  for (let index = 0; index < 6; index++) { expect(frames.size).toBe(1); flush() }
  expect(query).not.toHaveBeenCalled(); expect(styles).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled()
  expect(rootRead).not.toHaveBeenCalled()
  for (const { node } of floats) expect(node.getBoundingClientRect).toHaveBeenCalledTimes(6)
})

it('discovers float and contained stage movement without mutation, resize or scroll events', () => {
  const { node, box } = float(), stage = document.createElement('div'), stageBox = { x: 30, y: 50, width: 100, height: 80 }
  stage.setAttribute('data-native-browser-stage', 'original-page')
  stage.getBoundingClientRect = () => ({ ...stageBox, left: stageBox.x, top: stageBox.y, right: stageBox.x + stageBox.width, bottom: stageBox.y + stageBox.height, toJSON() {} })
  node.appendChild(stage)
  const publish = vi.fn()
  dispose = observeNativeOverlayRegions(document.body, () => 1.25, publish, undefined, browser).dispose
  publish.mockClear(); box.x += 12; stageBox.x += 18
  flush()
  expect(publish).toHaveBeenCalledTimes(1)
  expect(publish.mock.calls[0]![0][0]).toMatchObject({ bounds: { x: 40 }, browserStages: [{ browserId: 'original-page', bounds: { x: 60 } }] })
  flush(); expect(publish).toHaveBeenCalledTimes(1)
})

it('cancels the exact frame on hide, no Browser, close and disposal, then remeasures on show', async () => {
  const { node, box } = float(), publish = vi.fn()
  const owner = observeNativeOverlayRegions(document.body, () => 1, publish, undefined, browser); dispose = owner.dispose
  expect(frames.size).toBe(1)
  visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))
  expect(frames.size).toBe(0)
  vi.mocked(node.getBoundingClientRect).mockClear(); box.y = 70
  flush(); expect(node.getBoundingClientRect).not.toHaveBeenCalled()
  visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); flush()
  expect(publish.mock.calls.at(-1)![0][0].bounds.y).toBe(70)
  owner.setNativeDemand({ revision: 2, bounds: [] }); expect(frames.size).toBe(0)
  owner.setNativeDemand({ ...browser, revision: 3 }); flush(); expect(frames.size).toBe(1)
  node.setAttribute('data-state', 'closed')
  await new Promise(resolve => setTimeout(resolve, 0)); flush()
  expect(publish.mock.calls.at(-1)![0]).toEqual([]); expect(frames.size).toBe(0)
  node.removeAttribute('data-state')
  await new Promise(resolve => setTimeout(resolve, 0)); flush(); expect(frames.size).toBe(1)
  owner.dispose(); dispose = undefined
  expect(frames.size).toBe(0)
})

it('does not start new background checking until native Browser demand is confirmed', () => {
  float()
  const owner = observeNativeOverlayRegions(document.body, () => 1, vi.fn()); dispose = owner.dispose
  expect(frames.size).toBe(0)
  owner.setNativeDemand(browser); flush(); expect(frames.size).toBe(1)
})

it('uses and cancels only the source document frame when a second document owns the float', () => {
  const iframe = document.createElement('iframe'); document.body.appendChild(iframe)
  const other = iframe.contentWindow!, doc = iframe.contentDocument!
  const ownFrames = new Map<number, FrameRequestCallback>()
  vi.spyOn(other, 'requestAnimationFrame').mockImplementation(callback => { ownFrames.set(++serial, callback); return serial })
  vi.spyOn(other, 'cancelAnimationFrame').mockImplementation(id => { ownFrames.delete(id) })
  const node = doc.createElement('section'); node.setAttribute('role', 'dialog'); node.style.background = 'rgb(40,49,45)'
  node.getBoundingClientRect = () => ({ x: 20, y: 30, width: 100, height: 80, left: 20, top: 30, right: 120, bottom: 110, toJSON() {} })
  doc.body.appendChild(node)
  dispose = observeNativeOverlayRegions(doc.body, () => 1, vi.fn(), undefined, browser).dispose
  expect(ownFrames.size).toBe(1); expect(frames.size).toBe(0)
  const callbacks = [...ownFrames.values()]; ownFrames.clear(); callbacks.forEach(callback => callback(0))
  expect(ownFrames.size).toBe(1); expect(frames.size).toBe(0)
  dispose(); dispose = undefined
  expect(ownFrames.size).toBe(0)
})
