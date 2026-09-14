import { type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export const OVERLAY_LAYER_BANDS = {
  windowChrome: 'window-chrome',
  tooltip: 'tooltip',
  popover: 'popover',
  service: 'service',
  dialog: 'dialog'
} as const

export type OverlayLayerBand = (typeof OVERLAY_LAYER_BANDS)[keyof typeof OVERLAY_LAYER_BANDS]

/**
 * Internal helper to synchronously and idempotently ensure that the shared
 * window overlay host exists directly under document.body outside #root.
 *
 * This eliminates the race condition where child overlay portals resolve their
 * container during render before <WindowOverlayHost /> commits to the DOM.
 */
function ensureWindowOverlayHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  let host = document.querySelector<HTMLElement>('[data-overlay-host]')
  if (!host) {
    host = document.createElement('div')
    host.className = 'window-overlay-host'
    host.dataset.overlayHost = ''
    document.body.appendChild(host)
  } else if (!host.classList.contains('window-overlay-host')) {
    host.classList.add('window-overlay-host')
  }
  return host
}

export function getWindowOverlayHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return ensureWindowOverlayHost()
}

/**
 * Resolves the overlay target container synchronously.
 * Guarantees that the shared host exists in document.body so Radix and other portals
 * never receive undefined or silently fall back to document.body.
 */
export function resolveOverlayContainer(
  container?: HTMLElement | Element | DocumentFragment | null
): HTMLElement | Element | DocumentFragment {
  if (container) return container
  const host = ensureWindowOverlayHost()
  if (!host) {
    if (typeof document !== 'undefined') {
      throw new Error(
        'WindowOverlayHost is not mounted: overlays require [data-overlay-host] and must not silently fall back to document.body.'
      )
    }
    return undefined as unknown as HTMLElement
  }
  return host
}

export function useWindowOverlayHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(() => ensureWindowOverlayHost())
  useLayoutEffect(() => {
    setHost(ensureWindowOverlayHost())
  }, [])
  return host
}

/**
 * Window-level host component.
 * Idempotently adopts the synchronously created host element in document.body outside #root.
 */
export function WindowOverlayHost({ children }: { children?: ReactNode } = {}) {
  if (typeof document === 'undefined') return null
  const host = ensureWindowOverlayHost()
  if (!host) return null
  return createPortal(children ?? null, host)
}

export interface WindowOverlayPortalProps {
  children: ReactNode
  layer?: OverlayLayerBand
  container?: Element | null
}

export function WindowOverlayPortal({
  children,
  layer = OVERLAY_LAYER_BANDS.popover,
  container
}: WindowOverlayPortalProps) {
  const host = useWindowOverlayHost()
  const target = container ?? host
  if (!target) return null
  return createPortal(
    <div
      className="window-overlay-host__entry"
      data-overlay-layer={layer}
    >
      {children}
    </div>,
    target
  )
}
