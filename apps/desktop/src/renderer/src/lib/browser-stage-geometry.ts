import { autoUpdate } from '@floating-ui/dom'
import { hasPositiveBrowserStageGeometry } from './browser-bounds-sync'

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
