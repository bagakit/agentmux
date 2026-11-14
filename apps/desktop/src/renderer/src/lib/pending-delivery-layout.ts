import { useMemo, type RefObject } from 'react'
import { observeTerminalInputGeometry, readTerminalInputOverlapTop, type TerminalViewIdentity } from './terminal-view-observation'

export type PendingDeliveryLayout = {
  boundaryRef: RefObject<HTMLElement | null>
  readOverlapTop(popup: DOMRect): number | undefined
  reserveReadingSpace?(popup: DOMRect | null): void
  subscribe(onChange: () => void): () => void
}

function visible(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
}

/** The workface supplies its actual nodes; no selector discovers a request or terminal. */
export function usePendingDeliveryLayout({ boundaryRef, bodyRef, protectedRef, interactionSourceRef, interactionRef, interactionId, terminal, active = true }: {
  boundaryRef: RefObject<HTMLElement | null>
  bodyRef?: RefObject<HTMLElement | null>
  protectedRef?: RefObject<HTMLElement | null>
  interactionSourceRef?: RefObject<HTMLElement | null>
  interactionRef?: RefObject<HTMLElement | null>
  interactionId?: string | undefined
  terminal?: TerminalViewIdentity | undefined
  active?: boolean
}): PendingDeliveryLayout {
  return useMemo(() => ({
    boundaryRef,
    reserveReadingSpace(popup) {
      const body = bodyRef?.current
      if (!body) return
      const bounds = body.getBoundingClientRect()
      const overlap = popup && active && popup.left < bounds.right && popup.right > bounds.left
        ? Math.max(0, Math.min(bounds.bottom, popup.bottom) - Math.max(bounds.top, popup.top)) : 0
      const value = `${overlap ? overlap + 8 : 0}px`
      if (body.style.getPropertyValue('--pending-delivery-inset') !== value)
        body.style.setProperty('--pending-delivery-inset', value)
    },
    readOverlapTop(popup) {
      if (!active || !visible(boundaryRef.current)) return undefined
      let top = terminal ? readTerminalInputOverlapTop(terminal, popup) : undefined
      const protectedSurface = protectedRef?.current ?? null
      if (visible(protectedSurface)) {
        const rect = protectedSurface.getBoundingClientRect()
        if (popup.left < rect.right && popup.right > rect.left && popup.top < rect.bottom && popup.bottom > rect.top)
          top = top === undefined ? rect.top : Math.min(top, rect.top)
      }
      const source = interactionSourceRef?.current ?? null, card = interactionRef?.current ?? null
      if (interactionId && visible(source) && visible(card)) {
        const rect = source.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0 && popup.left < rect.right && popup.right > rect.left && popup.top < rect.bottom && popup.bottom > rect.top) {
          top = top === undefined ? rect.top : Math.min(top, rect.top)
        }
      }
      return top
    },
    subscribe(onChange) {
      if (!active) return () => {}
      const nodes = new Set([boundaryRef.current, bodyRef?.current, protectedRef?.current, interactionSourceRef?.current, interactionRef?.current].filter((node): node is HTMLElement => Boolean(node)))
      const resize = new ResizeObserver(onChange), mutation = new MutationObserver(onChange)
      for (const node of nodes) {
        resize.observe(node)
        mutation.observe(node, { attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'style', 'class'] })
      }
      const stopTerminal = terminal ? observeTerminalInputGeometry(terminal, onChange) : () => {}
      return () => { resize.disconnect(); mutation.disconnect(); stopTerminal() }
    }
  }), [boundaryRef, bodyRef, protectedRef, interactionSourceRef, interactionRef, interactionId, terminal?.regionId, terminal?.sessionId, terminal?.runId, active])
}
