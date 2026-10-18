import { vi } from 'vitest'

/** Browser geometry only: original React Flow adoption, culling and SVG consumers still execute. */
export function installCollaborationCanvasGeometry(width = 1440, height = 900) {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('collaboration-area__overview-label')) return Math.min(Number.parseFloat(this.style.maxWidth), Math.max(148, (this.querySelector('strong')?.textContent?.length ?? 0) * 7 + 70))
    return this.classList.contains('react-flow__node') ? Number.parseFloat(this.style.width) : width
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('collaboration-area__overview-label')) return 28 + Math.max(1, Math.ceil((this.querySelector('strong')?.textContent?.length ?? 0) * 7 / (this.offsetWidth - 70))) * 16
    return this.classList.contains('react-flow__node') ? Number.parseFloat(this.style.height) : height
  })
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (this.targets.has(target)) return
      this.targets.add(target)
      queueMicrotask(() => { if (this.targets.has(target)) this.callback([{ target, contentRect: target.getBoundingClientRect(), borderBoxSize: [{ inlineSize: (target as HTMLElement).offsetWidth, blockSize: (target as HTMLElement).offsetHeight }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver) })
    }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  })
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
}
