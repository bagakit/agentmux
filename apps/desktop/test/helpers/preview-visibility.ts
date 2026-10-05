import { vi } from 'vitest'

/** Control browser facts, not useVisibleWork: its observers and document listener execute. */
export function previewVisibility(inViewport = true, foreground = true) {
  const observers: { target?: Element; active: boolean; callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = []
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => foreground ? 'visible' : 'hidden')
  vi.stubGlobal('IntersectionObserver', class {
    target?: Element
    active = true
    disconnect = vi.fn(() => { this.active = false })
    constructor(public callback: IntersectionObserverCallback) { observers.push(this) }
    observe(target: Element) { this.target = target; this.callback([{ target, isIntersecting: inViewport } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
  })
  return {
    observers,
    viewport(value: boolean) {
      inViewport = value
      for (const observer of observers) if (observer.active && observer.target) observer.callback([{ target: observer.target, isIntersecting: value } as IntersectionObserverEntry], observer as unknown as IntersectionObserver)
    },
    foreground(value: boolean) { foreground = value; document.dispatchEvent(new Event('visibilitychange')) }
  }
}
