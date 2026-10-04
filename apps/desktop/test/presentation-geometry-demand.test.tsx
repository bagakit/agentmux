// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkbenchTabStrip } from '../src/renderer/src/components/WorkbenchTabStrip'
import { observeMoteMotion } from '../src/renderer/src/lib/mote-face-motion'
import { observeNativeOverlayRegions } from '../src/renderer/src/lib/native-overlay-regions'
let root: Root | undefined, host: HTMLElement, frame: FrameRequestCallback | undefined
let resizeCallbacks: ResizeObserverCallback[], resized: Set<Element>
let disposers: (() => void)[]
beforeEach(() => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
 host = document.createElement('div'); document.body.append(host); frame = undefined; resizeCallbacks = []; resized = new Set(); disposers = []
 vi.stubGlobal('ResizeObserver', class {
  nodes = new Set<Element>()
  constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback) }
  observe(node: Element) { this.nodes.add(node); resized.add(node) }
  disconnect() { for (const node of this.nodes) resized.delete(node); this.nodes.clear() }
 })
 vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 1 })
 vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frame = undefined })
 Element.prototype.scrollIntoView = vi.fn()
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; for (const dispose of disposers) dispose(); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function flushFrame() { const callback = frame; frame = undefined; callback?.(1) }
it('hidden mounted Strip has no geometry or observers; reveal measures retained scroll once and fences old callbacks', async () => {
 root = createRoot(host)
 const render = (visible: boolean, tabIds = ['original-tab']) => act(async () => root!.render(<WorkbenchTabStrip visible={visible} activeTabId="original-tab" tabIds={tabIds}><button data-workbench-tab-id="original-tab">Original</button></WorkbenchTabStrip>))
 await render(false)
 const strip = host.querySelector<HTMLElement>('.pane-tabbar__tabs')!
 expect(strip).not.toBeNull(); strip.scrollLeft = 45
 let reads = 0
 Object.defineProperties(strip, { scrollWidth: { configurable: true, get() { reads++; return 320 } }, clientWidth: { configurable: true, get() { reads++; return 180 } } })
 await render(false, ['original-tab', 'another-hidden'])
 expect(reads).toBe(0); expect(resized.size).toBe(0); expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
 await render(true)
 expect(reads).toBeGreaterThan(0); expect(resized.has(strip)).toBe(true); expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1); expect(strip.scrollLeft).toBe(45)
 const old = resizeCallbacks.at(-1)!
 await render(false); reads = 0
 old([], {} as ResizeObserver)
 expect(reads).toBe(0); expect(resized.size).toBe(0)
 await render(true)
 expect(host.querySelector('.pane-tabbar__tabs')).toBe(strip); expect(strip.scrollLeft).toBe(45); expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
})
it('the real shared Mote owner reads every visible rig before its first style write and never measures a hidden rig', () => {
 vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList)
 vi.stubGlobal('IntersectionObserver', class {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(node: Element) { this.callback([{ target: node, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
  unobserve() {} disconnect() {}
 })
 const sequence: string[] = []
 for (const [id, visible] of [['a', true], ['b', true], ['hidden', false]] as const) {
  const identity = document.createElement('div'), rig = document.createElement('div'); rig.className = 'mote-face'; identity.append(rig); host.append(identity)
  rig.getBoundingClientRect = () => { sequence.push('read-' + id); return { left: 10, top: 10, width: 40, height: 40 } as DOMRect }
  const originalSet = identity.style.setProperty.bind(identity.style)
  vi.spyOn(identity.style, 'setProperty').mockImplementation((...args) => { sequence.push('write-' + id); originalSet(...args) })
  disposers.push(observeMoteMotion(identity, 'identity', visible).dispose)
 }
 sequence.length = 0
 document.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 30 }))
 expect(frame).toBeDefined(); flushFrame()
 expect(sequence.slice(0, 2)).toEqual(['read-a', 'read-b'])
 expect(sequence.length).toBeGreaterThan(2); expect(sequence.slice(2).filter(entry => entry.startsWith('read'))).toEqual([])
 expect(sequence.some(entry => entry.includes('hidden'))).toBe(false)
})
it('zero Main-native demand disconnects measurement; content at identical bounds still refreshes after reveal with bounded trigger diagnostics', async () => {
 document.body.insertAdjacentHTML('afterbegin', '<div id="root"></div>')
 const portal = document.createElement('div'), float = document.createElement('div')
 float.setAttribute('role', 'dialog'); float.style.backgroundColor = 'rgb(40, 49, 45)'; float.textContent = 'First'; portal.append(float); host.append(portal)
 // Actual portals are direct children of body, as in App.
 document.body.append(portal); disposers.push(() => { portal.remove(); document.getElementById('root')?.remove() })
 const bounds = { x: 10, y: 10, width: 120, height: 80 }
 const geometry = vi.fn(() => ({ ...bounds, top: 10, left: 10, right: 130, bottom: 90 } as DOMRect)); float.getBoundingClientRect = geometry
 const publish = vi.fn(), diagnostic = vi.fn()
 const overlays = observeNativeOverlayRegions(document.body, () => 1, publish, diagnostic); disposers.push(overlays.dispose)
 expect(geometry).toHaveBeenCalled(); overlays.setNativeDemand({ revision: 1, bounds: [] }); geometry.mockClear(); publish.mockClear()
 float.textContent = 'Hidden change'; await new Promise(resolve => setTimeout(resolve, 0)); flushFrame()
 expect(geometry).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled(); expect(resized.size).toBe(0)
 overlays.setNativeDemand({ revision: 2, bounds: [bounds] }); flushFrame()
 expect(geometry).toHaveBeenCalledTimes(1); expect(publish.mock.calls.at(-1)?.[0]).toHaveLength(1)
 const first = publish.mock.calls.at(-1)![0]
 float.textContent = 'Same bounds, new content'; float.style.color = 'red'
 await new Promise(resolve => setTimeout(resolve, 0)); flushFrame()
 expect(publish.mock.calls.at(-1)![0]).toEqual(first); expect(publish).toHaveBeenCalledTimes(2)
 expect(geometry).toHaveBeenCalledTimes(2)
 const readings = diagnostic.mock.calls.map(([reading]) => reading)
 expect(readings.length).toBeGreaterThan(0)
 expect(readings.some(reading => reading.reason === 'mutation' && reading.scheduled)).toBe(true)
 expect(readings.filter(reading => reading.reason === 'collect').at(-1)).toMatchObject({ candidateCount: 1, geometryReadCount: 1, nativeDemandCount: 1 })
 overlays.setNativeDemand({ revision: 3, bounds: [] }); geometry.mockClear(); window.dispatchEvent(new Event('resize')); flushFrame()
 expect(geometry).not.toHaveBeenCalled()
})
it('a hidden portal candidate is excluded before geometry, while unknown Main demand retains visible observation', () => {
 const float = document.createElement('div'); float.setAttribute('role', 'dialog'); float.style.visibility = 'hidden'; host.append(float)
 const hiddenGeometry = vi.spyOn(float, 'getBoundingClientRect')
 const publish = vi.fn(), diagnostics = vi.fn()
 const overlay = observeNativeOverlayRegions(document.body, () => 1, publish, diagnostics); disposers.push(overlay.dispose)
 expect(hiddenGeometry).not.toHaveBeenCalled(); expect(publish.mock.calls).toEqual([[[], undefined]])
 expect(diagnostics.mock.calls.at(-1)?.[0]).toMatchObject({ nativeDemandCount: null, geometryReadCount: 0 })
})

it('content mutations inside an explicitly hidden portal do not remeasure another visible native-overlapping float', async () => {
 const active = document.createElement('div'), hidden = document.createElement('div')
 active.setAttribute('role', 'dialog'); active.style.backgroundColor = 'rgb(40, 49, 45)'; active.textContent = 'Original visible float'
 hidden.style.display = 'none'; const closed = document.createElement('div'); closed.setAttribute('role', 'dialog'); hidden.append(closed)
 document.body.append(active, hidden); disposers.push(() => { active.remove(); hidden.remove() })
 const rect = { x: 10, y: 10, width: 120, height: 80, top: 10, left: 10, right: 130, bottom: 90 } as DOMRect
 const visibleGeometry = vi.fn(() => rect), hiddenGeometry = vi.fn(() => rect)
 active.getBoundingClientRect = visibleGeometry; closed.getBoundingClientRect = hiddenGeometry
 const publish = vi.fn(), overlays = observeNativeOverlayRegions(document.body, () => 1, publish)
 disposers.push(overlays.dispose); overlays.setNativeDemand({ revision: 1, bounds: [rect] }); flushFrame()
 visibleGeometry.mockClear(); hiddenGeometry.mockClear(); publish.mockClear()
 closed.textContent = 'A hidden status update'
 await new Promise(resolve => setTimeout(resolve, 0)); flushFrame()
 expect(visibleGeometry).not.toHaveBeenCalled(); expect(hiddenGeometry).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled()
 hidden.style.display = 'block'; closed.style.backgroundColor = 'rgb(40, 49, 45)'
 await new Promise(resolve => setTimeout(resolve, 0)); flushFrame()
 expect(visibleGeometry).toHaveBeenCalledTimes(1); expect(hiddenGeometry).toHaveBeenCalledTimes(1)
 expect(publish.mock.calls.at(-1)?.[0]).toHaveLength(2)
})
