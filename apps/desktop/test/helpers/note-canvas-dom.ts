import { vi } from 'vitest'

/** Supply browser geometry only. React Flow's real node, edge, keyboard and viewport code runs. */
export function installNoteCanvasGeometry() {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('react-flow__node') ? 288 : 900 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('react-flow__node') ? 154 : 600 })
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback
    targets = new Set<Element>()
    constructor(callback: ResizeObserverCallback) { this.callback = callback }
    observe(target: Element) {
      if (this.targets.has(target)) return
      this.targets.add(target)
      queueMicrotask(() => { if (this.targets.has(target)) this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver) })
    }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  })
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
}
