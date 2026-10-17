import { vi } from 'vitest'

/** Browser geometry only: original React Flow adoption, culling and SVG consumers still execute. */
export function installCollaborationCanvasGeometry(width = 1440, height = 900) {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('react-flow__node') ? Number.parseFloat(this.style.width) : width
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('react-flow__node') ? Number.parseFloat(this.style.height) : height
  })
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) {}
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
