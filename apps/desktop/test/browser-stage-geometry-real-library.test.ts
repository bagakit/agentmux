// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeBrowserStageGeometry } from '../src/renderer/src/lib/browser-stage-geometry'
import { LatestBrowserBoundsSynchronizer } from '../src/renderer/src/lib/browser-bounds-sync'

// Use the installed Floating UI implementation. Model the browser observer protocol,
// not autoUpdate: a new RO registration gets its initial delivery, repeated observe
// on an existing registration is deduplicated, and unobserve makes the next one new.
function model() {
  let rectangle = new DOMRect(510, 74, 242, 794), frameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const resizes: ModeledResizeObserver[] = [], intersections: ModeledIntersectionObserver[] = []
  class ModeledResizeObserver {
    targets = new Set<Element>()
    pending = new Set<Element>()
    constructor(readonly callback: ResizeObserverCallback) { resizes.push(this) }
    observe(target: Element) {
      if (!this.targets.has(target)) { this.targets.add(target); this.pending.add(target) }
    }
    unobserve(target: Element) { this.targets.delete(target); this.pending.delete(target) }
    disconnect() { this.targets.clear(); this.pending.clear() }
    deliver() {
      const entries = [...this.pending].filter(target => this.targets.has(target))
      this.pending.clear()
      if (entries.length) this.callback(entries.map(target => ({ target }) as ResizeObserverEntry), this as unknown as ResizeObserver)
    }
  }
  class ModeledIntersectionObserver {
    targets = new Set<Element>()
    pending = new Set<Element>()
    constructor(readonly callback: IntersectionObserverCallback) { intersections.push(this) }
    observe(target: Element) { this.targets.add(target); this.pending.add(target) }
    disconnect() { this.targets.clear(); this.pending.clear() }
    deliver() {
      const entries = [...this.pending].filter(target => this.targets.has(target))
      this.pending.clear()
      if (entries.length) this.callback(entries.map(target => ({ target, intersectionRatio: 1 }) as IntersectionObserverEntry), this as unknown as IntersectionObserver)
    }
  }
  vi.stubGlobal('ResizeObserver', ModeledResizeObserver)
  vi.stubGlobal('IntersectionObserver', ModeledIntersectionObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const stage = document.createElement('div')
  stage.getBoundingClientRect = () => rectangle
  document.body.append(stage)
  const apply = vi.fn(async () => {})
  const sync = new LatestBrowserBoundsSynchronizer(apply, vi.fn())
  const update = vi.fn(() => {
    const { x, y, width, height } = stage.getBoundingClientRect()
    sync.observe({ x, y, width, height })
  })
  const tick = () => {
    for (const observer of [...resizes]) observer.deliver()
    for (const observer of [...intersections]) observer.deliver()
    const current = [...frames.values()]; frames.clear()
    for (const callback of current) callback(0)
  }
  const idle = () => { for (let count = 0; count < 20; count++) tick() }
  return { stage, apply, update, sync, resizes, intersections, frames, idle, tick,
    resize() {
      rectangle = new DOMRect(rectangle.x, rectangle.y, 300, rectangle.height)
      for (const observer of resizes) if (observer.targets.has(stage)) observer.pending.add(stage)
    }, move() {
      rectangle = new DOMRect(rectangle.x, 71, rectangle.width, rectangle.height)
      for (const observer of intersections) if (observer.targets.has(stage)) observer.pending.add(stage)
    }, dispose() { sync.dispose(); stage.remove() } }
}

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('actual Floating UI stage observation protocol', () => {
  it('settles after initial delivery instead of silently polling an unchanged stage every frame', async () => {
    const f = model(), stop = observeBrowserStageGeometry(f.stage, f.update, true)
    try {
      f.idle()
      await Promise.resolve()
      expect(f.update).toHaveBeenCalledTimes(2)
      expect(f.apply.mock.calls).toEqual([[{ x: 510, y: 74, width: 242, height: 794 }]])
      expect(f.frames.size).toBe(0)
      expect(f.resizes).toHaveLength(1)
    } finally { stop(); f.dispose() }
  })
  it('delivers real size and position notices separately through the existing bounds synchronizer', async () => {
    const f = model(), stop = observeBrowserStageGeometry(f.stage, f.update, true)
    try {
      f.idle(); await Promise.resolve()
      expect(f.update).toHaveBeenCalledTimes(2)
      f.resize(); f.tick(); await Promise.resolve()
      expect(f.update).toHaveBeenCalledTimes(3)
      f.move(); f.tick(); await Promise.resolve()
      expect(f.update).toHaveBeenCalledTimes(4)
      expect(f.apply.mock.calls).toEqual([
        [{ x: 510, y: 74, width: 242, height: 794 }],
        [{ x: 510, y: 74, width: 300, height: 794 }],
        [{ x: 510, y: 71, width: 300, height: 794 }]
      ])
      f.idle()
      expect(f.update).toHaveBeenCalledTimes(4)
      expect(f.frames.size).toBe(0)
    } finally { stop(); f.dispose() }
  })
  it('disconnects all relevant targets and does no later work after cleanup', () => {
    const f = model(), stop = observeBrowserStageGeometry(f.stage, f.update, true)
    f.idle()
    stop()
    expect(f.resizes.map(observer => observer.targets.size)).toEqual([0])
    expect(f.intersections.map(observer => observer.targets.size)).toEqual([0])
    const before = f.update.mock.calls.length
    f.resize(); f.move(); f.idle()
    expect(f.update.mock.calls).toHaveLength(before)
    expect(f.frames.size).toBe(0)
    f.dispose()
  })
  it('does not allocate observers or schedule work for an inactive stage', () => {
    const f = model(), stop = observeBrowserStageGeometry(f.stage, f.update, false)
    try {
      f.resize(); f.move(); f.idle()
      expect(f.resizes).toEqual([])
      expect(f.intersections).toEqual([])
      expect(f.frames.size).toBe(0)
      expect(f.update).not.toHaveBeenCalled()
      expect(f.apply).not.toHaveBeenCalled()
    } finally { stop(); f.dispose() }
  })
})
