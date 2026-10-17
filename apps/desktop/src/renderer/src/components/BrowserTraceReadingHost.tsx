import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { autoUpdate, computePosition, offset, shift, size } from '@floating-ui/dom'
import { getWindowOverlayHost, WindowOverlayPortal } from './WindowOverlayHost'

/** Keep the original flow footprint until Main confirms no operation needs its viewport. */
export function BrowserTraceReadingHost({ mode, open, held, visible, anchor, onReopen, children }: {
  mode: 'docked' | 'floating'; open: boolean; held: boolean; visible: boolean
  anchor: () => HTMLElement | null; onReopen: () => void; children: ReactNode
}) {
  const panel = useRef<HTMLElement | null>(null)
  const [reserved, setReserved] = useState(open && mode === 'docked')
  // Settle the visual footprint before commit, including idle close → later operation.
  // An old closed reader must never create new flow space merely because an Agent starts.
  if (mode === 'docked' && (open || !held) && reserved !== open) setReserved(open)
  useLayoutEffect(() => {
    const source = anchor(), surface = panel.current
    if (mode !== 'floating' || !open || !visible || !source || !surface) return
    let disposed = false
    const toolbar = source.querySelector<HTMLElement>('.browser-toolbar') ?? source
    const position = async () => {
      const result = await computePosition(toolbar, surface, { strategy: 'fixed', placement: 'bottom-end', middleware: [offset(6), shift({ padding: 8 }), size({ padding: 8,
        apply({ availableWidth, availableHeight }) { Object.assign(surface.style, { width: `${Math.min(360, availableWidth)}px`, maxHeight: `${Math.min(520, availableHeight)}px` }) }
      })] })
      if (!disposed) Object.assign(surface.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(toolbar, surface, () => { void position() })
    return () => { disposed = true; stop() }
  }, [mode, open, visible, anchor])
  if (mode === 'docked') return open || held && reserved ? <aside className="browser-trace-rail" aria-label="Browser activity trace">
    {open ? children : <div className="browser-trace-held"><span>Page size is held for this Browser operation.</span><button type="button" className="small-button" onClick={onReopen}>Reopen trace</button></div>}
  </aside> : null
  const source = anchor()
  return open && visible && source ? <WindowOverlayPortal container={getWindowOverlayHost(source.ownerDocument)}><aside ref={panel}
    className="browser-trace-rail browser-trace-rail--floating" role="dialog" aria-modal="false" aria-label="Browser activity trace" style={{ visibility: 'hidden' }}>{children}</aside></WindowOverlayPortal> : null
}
