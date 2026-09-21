import { autoUpdate } from '@floating-ui/dom'

/** Observe the mounted HTML backing stage of a native view, including position-only layout shifts. */
export function observeBrowserStageGeometry(stage: HTMLElement, update: () => void, active: boolean): () => void {
  if (!active) return () => {}
  const resize = new ResizeObserver(update)
  resize.observe(stage)
  // The stage is both reference and backing element. Disable the library's
  // resize observer: its floating-element re-observe would loop on this identity.
  const stop = autoUpdate(stage, stage, update, { elementResize: false, layoutShift: true, animationFrame: false })
  return () => { stop(); resize.disconnect() }
}
