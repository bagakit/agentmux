import { sessionPresentationById } from '../lib/session-presentation'
import { CheckCircle2, ChevronDown, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { AgentTimelineItem } from '../../../shared/contracts'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { useAppStore } from '../store'
import { SessionResultReviewContent } from './SessionResultReviewContent'

/** Header-only entrance. Composer reuses the same body inside its receiver face. */
export function SessionResultReview({ sessionId, items, origin, visible, surfaceAnchor }: {
  sessionId: string
  items: readonly AgentTimelineItem[]
  origin: OpenHttpLinkOrigin
  visible: boolean
  surfaceAnchor: string
}) {
  const session = useAppStore((state) => sessionPresentationById(state.sessions).get(sessionId))
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const popoverId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const ready = session?.kind === 'agent' && session.status.state === 'done'
  const acquire = useAppStore((state) => state.acquireNativeSurfaceOverlay)
  const release = useAppStore((state) => state.releaseNativeSurfaceOverlay)
  useEffect(() => { setExpanded(false); setDismissed(false) }, [sessionId])
  useEffect(() => {
    if (!ready) { setExpanded(false); setDismissed(false) }
    if (!visible) { popover.current?.hidePopover?.(); setExpanded(false) }
  }, [ready, visible])
  useEffect(() => {
    if (!ready || !expanded || dismissed || !visible) return
    acquire()
    return release
  }, [ready, expanded, dismissed, visible, acquire, release])
  if (!ready || dismissed || !visible) return null
  function collapse() { popover.current?.hidePopover?.(); setExpanded(false) }
  return <span className="session-result-review-slot session-result-review" data-result-review-expanded={expanded ? 'true' : 'false'}>
    <button ref={trigger} type="button" className="session-result-review__trigger" aria-label="Turn ended · Review Agent result"
      title="Review this turn" aria-expanded={expanded} aria-controls={popoverId} popoverTarget={popoverId} popoverTargetAction="toggle"
      onPointerDown={() => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
      onClick={() => setExpanded(value => !value)}><CheckCircle2 size={14} aria-hidden="true" /><span className="session-result-review__label">Review</span></button>
    <aside ref={popover} id={popoverId} popover="auto" className="session-result-review__popover" aria-label="Review Agent result"
      style={{ positionAnchor: surfaceAnchor }} onToggle={event => setExpanded(event.newState === 'open')}>
      {expanded && visible ? <SessionResultReviewContent sessionId={sessionId} items={items} origin={origin} onNavigate={collapse}
        controls={<div className="session-result-review__actions" aria-label="Result review controls">
          <button type="button" className="small-button" onClick={() => { collapse(); trigger.current?.focus({ preventScroll: true }) }}><ChevronDown size={12} /> Collapse</button>
          <button type="button" className="small-button" aria-label="Dismiss result review" onClick={() => {
            const surface = trigger.current?.closest('.agent-surface')
            const active = document.activeElement
            const ownsFocus = active === trigger.current || popover.current?.contains(active)
            const target = previousFocus.current?.isConnected && previousFocus.current !== trigger.current && previousFocus.current !== document.body
              ? previousFocus.current : surface?.querySelector<HTMLElement>('.xterm-helper-textarea, .composer [role="textbox"], .agent-region-header__more')
            collapse(); setDismissed(true)
            if (ownsFocus) target?.focus({ preventScroll: true })
          }}><X size={12} /> Close</button>
        </div>} /> : null}
    </aside>
  </span>
}
