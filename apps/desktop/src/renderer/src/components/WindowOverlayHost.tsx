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

const WINDOW_OVERLAY_HOST_ID = 'agentmux-window-overlay-host'
const interactiveOverlay = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-state="open"], [data-state="delayed-open"]'
const interactionHosts = new WeakMap<HTMLElement, HTMLElement>()

function captureNativeInvoker(host: HTMLElement): void {
  const active = document.activeElement
  const popover = active instanceof HTMLElement ? active.closest<HTMLElement>('[popover]') : null
  if (popover && popover !== host && !host.contains(popover) && popover.matches(':popover-open')) {
    // DOM ancestry is the native auto-popover's light-dismiss ownership. A
    // higher manual layer alone does not preserve that ancestor on pointerup.
    if (host.parentElement !== popover) popover.appendChild(host)
  } else if (host.parentElement?.hasAttribute('popover') && !host.parentElement.matches(':popover-open')) {
    // A closed empty Portal may have followed its former invoker during render.
    // Recover that same host before the next ordinary Dialog's autofocus runs.
    const root = document.getElementById(WINDOW_OVERLAY_HOST_ID)
    if (root) root.appendChild(host)
  }
}

/** Promote only new interactive surfaces; persistent window chrome stays painted. */
function bindWindowOverlayTopLayer(host: HTMLElement): void {
  host.setAttribute('popover', 'manual')
  const active = new Set<Element>()
  const chromeEntry = (node: Element) => { const chrome = node.closest('[data-overlay-layer="window-chrome"]'); return chrome && host.contains(chrome) }
  const eligible = (node: Element) => { const closed = node.closest('[data-state="closed"]')
    return node.matches(interactiveOverlay) && (!closed || !host.contains(closed)) && !chromeEntry(node) }
  const observer = new MutationObserver(records => {
    let opened = false
    const admit = (node: Element) => {
      if (eligible(node) && !active.has(node)) { active.add(node); opened = true }
    }
    for (const record of records) {
      if (record.type === 'attributes') admit(record.target as Element)
      else for (const node of record.addedNodes) {
        if (!(node instanceof Element) || chromeEntry(node)) continue
        admit(node)
        for (const child of node.querySelectorAll(interactiveOverlay)) admit(child)
      }
    }
    for (const node of active) if (!host.contains(node) || !eligible(node)) active.delete(node)
    if (!host.isConnected) { observer.disconnect(); return }
    if (typeof host.showPopover !== 'function') return
    const shown = host.matches(':popover-open')
    if (active.size === 0) {
      if (shown) host.hidePopover()
      const root = document.getElementById(WINDOW_OVERLAY_HOST_ID)
      if (root && host.parentElement !== root) root.appendChild(host)
      return
    }
    if (!opened && shown) return
    // Native popovers and HTML dialogs share the top layer. A newer window
    // overlay must enter after its invoker. Reordering has no focus side effect
    // for a manual popover: Radix still owns modality, focus and Escape.
    if (shown) host.hidePopover()
    host.showPopover()
  })
  observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'role'] })
}

/**
 * Internal helper to synchronously and idempotently ensure that the shared
 * window overlay host exists directly under document.body outside #root.
 *
 * This eliminates the race condition where child overlay portals resolve their
 * container during render before <WindowOverlayHost /> commits to the DOM.
 */
function ensureWindowOverlayHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  // The host is a single window identity. Descendant selectors traverse retained
  // terminal content before reaching this body child on every Portal render.
  let host = document.getElementById(WINDOW_OVERLAY_HOST_ID)
  if (!host) {
    host = document.createElement('div')
    host.id = WINDOW_OVERLAY_HOST_ID
    host.className = 'window-overlay-host'
    host.dataset.overlayHost = ''
    document.body.appendChild(host)
  } else if (!host.classList.contains('window-overlay-host')) {
    host.classList.add('window-overlay-host')
  }
  return host
}

function ensureInteractionHost(): HTMLElement | null {
  const root = ensureWindowOverlayHost()
  if (!root) return null
  let host = interactionHosts.get(root)
  if (!host?.isConnected) {
    host = document.createElement('div')
    host.id = WINDOW_OVERLAY_HOST_ID + '-interaction'
    host.className = 'window-overlay-host'
    host.dataset.overlayHost = 'interaction'
    root.appendChild(host)
    interactionHosts.set(root, host)
    bindWindowOverlayTopLayer(host)
  }
  captureNativeInvoker(host)
  return host
}

export function getWindowOverlayHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return ensureInteractionHost()
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
  const host = ensureInteractionHost()
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
  const [host, setHost] = useState<HTMLElement | null>(() => ensureInteractionHost())
  useLayoutEffect(() => {
    setHost(ensureInteractionHost())
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
  const target = container ?? (layer === OVERLAY_LAYER_BANDS.windowChrome ? ensureWindowOverlayHost() : host)
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
