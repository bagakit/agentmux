import { Unplug } from 'lucide-react'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useEffect, useId, useRef, useState } from 'react'
import type { FocusContext } from '../lib/focus-context'
import { WindowOverlayPortal } from './WindowOverlayHost'

/** Only confirmed offline facts enter this rail; details use the existing shared view. */
export function FocusDisconnectedGroup({ contexts, laneId, onReveal }: {
  contexts: readonly FocusContext[]; laneId: string; onReveal(laneId: string, trigger: HTMLElement): void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null), surface = useRef<HTMLDivElement>(null)
  const summaryId = useId()
  useEffect(() => {
    if (!open || !trigger.current || !surface.current) return
    const anchor = trigger.current, tooltip = surface.current
    let disposed = false
    const update = async () => {
      const { x, y } = await computePosition(anchor, tooltip, { strategy: 'fixed', placement: 'top', middleware: [offset(6), flip(), shift({ padding: 8 })] })
      if (!disposed) Object.assign(tooltip.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, tooltip, () => { void update() })
    const hide = () => { if (document.hidden) setOpen(false) }
    document.addEventListener('visibilitychange', hide)
    return () => { disposed = true; stop(); document.removeEventListener('visibilitychange', hide) }
  }, [open])
  return <>
    <button ref={trigger} type="button" className="focus-disconnected-entry" disabled={!contexts.length}
      aria-label={`View disconnected contexts · ${contexts.length}`} aria-describedby={open ? summaryId : undefined}
      title={`Disconnected · ${contexts.length}`} onMouseEnter={() => { if (contexts.length) setOpen(true) }} onMouseLeave={() => setOpen(false)} onFocus={() => { if (contexts.length) setOpen(true) }} onBlur={() => setOpen(false)}
      onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false) } }}
      onClick={event => { setOpen(false); onReveal(laneId, event.currentTarget) }}>
      <Unplug size={12} aria-hidden="true" /><span>{contexts.length}</span>
    </button>
    {open ? <WindowOverlayPortal layer="tooltip"><div ref={surface} id={summaryId} className="focus-disconnected-summary" role="tooltip">
      <strong>Disconnected · {contexts.length}</strong>
      {contexts.slice(0, 3).map(context => <div key={context.id} data-disconnected-summary={context.id}><strong>{context.name}</strong><span>{context.providerId ?? 'Provider not recorded'} · {context.detail}</span></div>)}
      {contexts.length > 3 ? <small>{contexts.length - 3} more · Click to view all</small> : <small>Click to view contexts</small>}
    </div></WindowOverlayPortal> : null}
  </>
}
