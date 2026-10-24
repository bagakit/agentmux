import { autoUpdate } from '@floating-ui/dom'
import { hasPositiveBrowserStageGeometry } from './browser-bounds-sync'

/** Native views cannot inherit CSS overflow clipping. Keep capture readable, but do not cover a
 * scrollport or its sticky ruler with a partly clipped native input surface. */
export function browserStageInputVisible(stage: HTMLElement): boolean {
  const view = stage.ownerDocument.defaultView
  if (!view) return false
  const bounds = stage.getBoundingClientRect()
  let left = 0, top = 0, right = view.innerWidth, bottom = view.innerHeight
  for (let parent = stage.parentElement; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent), rect = parent.getBoundingClientRect()
    if (/^(auto|scroll|hidden|clip)$/u.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right) }
    if (/^(auto|scroll|hidden|clip)$/u.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom) }
    if (parent.hasAttribute('data-workbench-reading-scroll')) {
      const ruler = parent.querySelector<HTMLElement>('.activity-ruler')
      if (ruler) top = Math.max(top, ruler.getBoundingClientRect().bottom)
    }
  }
  return bounds.left >= left - 0.5 && bounds.top >= top - 0.5 && bounds.right <= right + 0.5 && bounds.bottom <= bottom + 0.5
}

/** Observe the mounted HTML backing stage of a native view, including position-only layout shifts. */
export function observeBrowserStageGeometry(stage: HTMLElement, update: () => void, active: boolean): () => void {
  if (!active) return () => {}
  let disposed = false
  let stop: (() => void) | undefined
  const bindPosition = (): void => {
    if (stop || !stage.isConnected || !hasPositiveBrowserStageGeometry(stage.getBoundingClientRect())) return
    // Retained portal children run their layout effects before the host attaches.
    // Bind against the actual connected ancestors and a measurable reference.
    stop = autoUpdate(stage, stage, update, { elementResize: false, layoutShift: true, animationFrame: false })
  }
  const resize = new ResizeObserver(() => {
    if (disposed) return
    bindPosition()
    update()
  })
  resize.observe(stage)
  // The stage is both reference and backing element. Disable the library's
  // resize observer: its floating-element re-observe would loop on this identity.
  bindPosition()
  return () => { disposed = true; stop?.(); resize.disconnect() }
}
