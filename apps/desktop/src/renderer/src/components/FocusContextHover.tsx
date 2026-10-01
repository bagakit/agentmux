import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import type { FocusContext } from '../lib/focus-context'
import { getWindowOverlayHost } from './WindowOverlayHost'
import { usePathDisplay } from '../hooks/usePathDisplay'

// One transient reading surface, with no identity data or retained registry.
let dismissCurrentPreview: (() => void) | null = null

/** Only facts already held by the card; opening this surface performs no I/O. */
export function useFocusContextHover(context: FocusContext, enabled: boolean) {
  const displayPath = usePathDisplay()
  const anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const intent = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restoringFocus = useRef(false)
  const [open, setOpen] = useState(false)
  const id = useId()
  const scope = JSON.stringify([context.id, context.runId, context.name, context.state, context.detail,
    context.recap, context.workspacePath, context.originAddress])
  const close = useCallback((): void => {
    clearTimeout(intent.current); clearTimeout(departure.current)
    if (dismissCurrentPreview === close) dismissCurrentPreview = null
    setOpen(false)
  }, [])
  function keepOpen() { clearTimeout(departure.current) }
  function show() {
    clearTimeout(intent.current); keepOpen()
    // This guards a transient tooltip only, never the original Agent or card action.
    if (!enabled || !anchor.current?.isConnected || anchor.current.closest('[inert]') || document.visibilityState === 'hidden') return
    if (dismissCurrentPreview !== close) dismissCurrentPreview?.()
    dismissCurrentPreview = close
    setOpen(true)
  }
  function showSoon() { clearTimeout(intent.current); keepOpen(); if (enabled) intent.current = setTimeout(show, 180) }
  function hideSoon() { clearTimeout(intent.current); keepOpen(); departure.current = setTimeout(close, 160) }
  function suppressRestoredFocus() {
    restoringFocus.current = true
    // Radix restores its trigger synchronously after closeAutoFocus. A later
    // intentional focus or hover should still disclose the current card.
    queueMicrotask(() => { restoringFocus.current = false })
  }
  useLayoutEffect(() => { close() }, [scope, enabled, close])
  useLayoutEffect(() => () => {
    clearTimeout(intent.current); clearTimeout(departure.current)
    if (dismissCurrentPreview === close) dismissCurrentPreview = null
  }, [close])
  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return
    let current = true
    const surface = panel.current
    const update = async () => {
      const { x, y } = await computePosition(anchor.current!, surface, {
        strategy: 'fixed', placement: 'bottom-start', middleware: [offset(8), flip({ padding: 10 }), shift({ padding: 10 })]
      })
      if (current) Object.assign(surface.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor.current, surface, () => { void update() })
    return () => { current = false; stop() }
  }, [open])
  useLayoutEffect(() => {
    if (!enabled) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    const hide = () => { if (document.visibilityState === 'hidden') close() }
    const outside = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close() }
    document.addEventListener('keydown', escape)
    document.addEventListener('visibilitychange', hide)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', outside, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('keydown', escape)
      document.removeEventListener('visibilitychange', hide)
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', outside, true)
      window.removeEventListener('resize', close)
    }
  }, [enabled, close])
  const host = open ? getWindowOverlayHost() : null
  const preview = open && host ? createPortal(<div ref={panel} id={id} className="focus-context-hover" role="tooltip"
    data-state="open" aria-label={`Full context for ${context.name}`} style={{ visibility: 'hidden' }}
    onPointerEnter={keepOpen} onPointerLeave={hideSoon}>
    <header><strong>{context.name}</strong><span>{context.stateLabel}</span></header>
    {!context.detailIsRecap ? <p className="focus-context-hover__activity">{context.detail}</p> : null}
    {context.recap ? <section className="focus-context-hover__recap"><small>{context.recap.source} · {context.recap.origin}</small><p>{context.recap.text}</p></section> : null}
    <footer><strong>{context.workspaceName}</strong><span>{displayPath(context.workspacePath, context.hostId)}</span>
      {context.originAddress ? <span>{context.originAddress}</span> : null}<code>{context.id}</code></footer>
  </div>, host) : null
  return { anchor, describedBy: open ? id : undefined, preview, close, suppressRestoredFocus,
    triggerEvents: { onPointerEnter: showSoon, onPointerLeave: hideSoon, onFocus: () => { if (!restoringFocus.current) show() }, onBlur: hideSoon, onPointerDown: close } }
}
