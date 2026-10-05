import { useId, useLayoutEffect, useRef } from 'react'
import { autoUpdate, computePosition, offset, shift, size, type VirtualElement } from '@floating-ui/dom'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusTimelineEventFacts } from '../lib/focus-timeline-event-facts'
import { WindowOverlayPortal } from './WindowOverlayHost'

const ThemeObjectActivityIcon = semanticIconComponent('object.activity')
const ThemeActionRevealIcon = semanticIconComponent('action.reveal')
const ThemeStatusRunningIcon = semanticIconComponent('status.running')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')


/** Only the existing event's already-read facts; no focus, Reader or resource work. */
export function FocusTimelineEventPreview({ facts, anchor, onClose, onMouseEnter, onMouseLeave }: {
  facts: FocusTimelineEventFacts; anchor: HTMLElement; onClose(): void
  onMouseEnter(): void; onMouseLeave(): void
}) {
  const element = useRef<HTMLDivElement>(null), id = useId()
  useLayoutEffect(() => {
    const surface = element.current, header = anchor.closest('.recent-focus')?.querySelector<HTMLElement>('.recent-focus__header')
    if (!surface || !header) return
    const previous = anchor.getAttribute('aria-describedby')
    anchor.setAttribute('aria-describedby', id)
    let disposed = false
    const reference: VirtualElement = { contextElement: header, getBoundingClientRect() {
      const bounds = anchor.getBoundingClientRect()
      return new DOMRect(bounds.left, header.getBoundingClientRect().top, bounds.width, 0)
    } }
    const update = async () => {
      const position = await computePosition(reference, surface, { strategy: 'fixed', placement: 'top',
        middleware: [offset(6), shift({ padding: 8 }), size({ padding: 8, apply({ availableWidth, availableHeight }) {
          if (!disposed) Object.assign(surface.style, { width: `${Math.max(0, Math.min(304, availableWidth))}px`,
            maxHeight: `${Math.max(0, Math.min(320, window.innerHeight * .6, availableHeight))}px` })
        } })] })
      if (!disposed) Object.assign(surface.style, { left: `${position.x}px`, top: `${position.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(reference, surface, () => { void update() })
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose() } }
    document.addEventListener('keydown', escape)
    return () => {
      disposed = true; stop(); document.removeEventListener('keydown', escape)
      if (anchor.getAttribute('aria-describedby') === id) {
        if (previous) anchor.setAttribute('aria-describedby', previous); else anchor.removeAttribute('aria-describedby')
      }
    }
  }, [anchor, id, onClose])
  const Icon = { work: ThemeObjectActivityIcon, focus: ThemeActionRevealIcon, live: ThemeStatusRunningIcon, gap: ThemeStatusUnknownIcon }[facts.kind]
  return <WindowOverlayPortal layer="tooltip"><div ref={element} id={id} role="tooltip"
    className="recent-focus__message-preview recent-focus__event-preview" data-event-kind={facts.kind}
    onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
    <header><Icon size={14} aria-hidden="true" /><strong>{facts.name}</strong></header>
    <div className="recent-focus__event-kind">{facts.event}{facts.duration ? <strong>{facts.duration}</strong> : null}</div>
    <p className="recent-focus__event-time">{facts.time}</p>
    <p className="recent-focus__event-project">{facts.project}</p>
    <footer className="recent-focus__event-note">{facts.note}</footer>
  </div></WindowOverlayPortal>
}
