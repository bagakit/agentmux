import { autoUpdate, computePosition, offset, shift, size } from '@floating-ui/dom'

type ReaderPosition = { pane: HTMLElement | null; anchor: HTMLElement; surface: HTMLElement; maximumHeight: number; gap: number }

/** Both the invoker and its exact Pane can move independently in a split layout. */
export function observeBrowserReader(input: ReaderPosition): () => void {
  let disposed = false, revision = 0
  const position = async () => {
    const ticket = ++revision, current = () => !disposed && ticket === revision
    const result = await positionBrowserReader(input, current)
    if (current()) Object.assign(input.surface.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
  }
  const stop = autoUpdate(input.anchor, input.surface, () => { void position() })
  const Resize = input.surface.ownerDocument.defaultView?.ResizeObserver
  const resize = input.pane && Resize ? new Resize(() => { void position() }) : undefined
  if (resize && input.pane) resize.observe(input.pane)
  return () => { disposed = true; ++revision; resize?.disconnect(); stop() }
}

/** Narrow readers occupy the bottom of the same Pane without changing its live page. */
async function positionBrowserReader(input: ReaderPosition, current: () => boolean) {
  const { pane, anchor, surface } = input
  const bounds = (pane ?? anchor).getBoundingClientRect()
  const compact = pane !== null && bounds.width > 0 && bounds.width <= 380
  const viewportHeight = surface.ownerDocument.documentElement.clientHeight || surface.ownerDocument.defaultView?.innerHeight || bounds.bottom
  const padding = 8
  const paneBottom = Math.min(bounds.bottom, viewportHeight)
  const bottom = paneBottom - padding
  const availablePane = Math.max(0, paneBottom - Math.max(0, bounds.top))
  const clipping = pane ? { boundary: pane, padding } : { padding }
  const reference = compact ? { contextElement: pane!, getBoundingClientRect: () => ({
    x: bounds.left, y: bottom, left: bounds.left, right: bounds.right,
    top: bottom, bottom, width: bounds.width, height: 0
  }) } : anchor
  if (current()) surface.dataset.compactReader = String(compact)
  return await computePosition(reference, surface, { strategy: 'fixed', placement: compact ? 'top-end' : 'bottom-end',
    middleware: [offset(compact ? 0 : input.gap), shift(clipping), size({ ...clipping,
      apply({ availableWidth, availableHeight }) {
        if (!current()) return
        const paneWidth = pane ? bounds.width - 2 * padding : Infinity
        Object.assign(surface.style, { width: `${Math.max(0, Math.min(360, paneWidth, availableWidth))}px`,
          maxHeight: `${Math.max(0, Math.min(input.maximumHeight, availableHeight, compact ? availablePane * 0.44 : Infinity))}px` })
      }
    })] })
}
