import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { observeBrowserReader } from '../lib/browser-reader-position'
import { getWindowOverlayHost, WindowOverlayPortal } from './WindowOverlayHost'

/** Keep the original flow footprint until Main confirms no operation needs its viewport. */
export function BrowserTraceReadingHost({ mode, open, held, visible, anchor, onReopen, onClose, children }: {
  mode: 'docked' | 'floating'; open: boolean; held: boolean; visible: boolean
  anchor: () => HTMLElement | null; onReopen: () => void; onClose: () => void; children: ReactNode
}) {
  const panel = useRef<HTMLElement | null>(null)
  const [reserved, setReserved] = useState(open && mode === 'docked')
  // Settle the visual footprint before commit, including idle close → later operation.
  // An old closed reader must never create new flow space merely because an Agent starts.
  if (mode === 'docked' && (open || !held) && reserved !== open) setReserved(open)
  useLayoutEffect(() => {
    if (mode !== 'floating' || !open || !visible) return
    let disposed = false
    let stop: (() => void) | undefined
    // An enclosing surface's callback ref is attached after child layout effects.
    // Read that exact anchor after this commit, without waiting for another Agent update.
    queueMicrotask(() => {
      const source = anchor(), surface = panel.current
      if (disposed || !source?.isConnected || !surface?.isConnected) return
      const toolbar = source.querySelector<HTMLElement>('.browser-toolbar') ?? source
      stop = observeBrowserReader({ pane: source, anchor: toolbar, surface, maximumHeight: 520, gap: 6 })
    })
    return () => { disposed = true; stop?.() }
  }, [mode, open, visible, anchor])
  const reader = <><header className="browser-trace-rail__header"><strong>Browser activity</strong>
    <IconButton aria-label="Close browser activity timeline" onClick={onClose}><SemanticIcon name="action.close" size={12} /></IconButton>
  </header>{children}</>
  if (mode === 'docked') return open || held && reserved ? <aside className="browser-trace-rail" aria-label="Browser activity trace">
    {open ? reader : <div className="browser-trace-held"><span>Page size is held for this Browser operation.</span><Button type="button" onClick={onReopen}>Reopen trace</Button></div>}
  </aside> : null
  const source = anchor()
  return open && visible && source ? <WindowOverlayPortal container={getWindowOverlayHost(source.ownerDocument)}><aside ref={panel}
    className="browser-trace-rail browser-trace-rail--floating" role="dialog" aria-modal="false" aria-label="Browser activity trace" style={{ visibility: 'hidden' }}>{reader}</aside></WindowOverlayPortal> : null
}
