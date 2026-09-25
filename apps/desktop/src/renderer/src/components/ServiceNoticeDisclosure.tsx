import { Info, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { serviceNoticeFingerprint, useServiceNotices, type ServiceNoticeItem } from '../lib/use-service-notices'
import { useAppStore } from '../store'

/** A presentation/read receipt owner. It never clears, retries or reclassifies the supplied facts. */
export function ServiceNoticeDisclosure({ scope, notices, available = true, visible = true, title, children, actions, className }: {
  scope: string
  notices: readonly ServiceNoticeItem[]
  available?: boolean
  visible?: boolean
  title?: string
  children: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const inbox = useServiceNotices(scope, notices, available)
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const openedIdentity = useRef<string | null>(null)
  const [open, setOpen] = useState(false)
  const acquire = useAppStore(state => state.acquireNativeSurfaceOverlay)
  const release = useAppStore(state => state.releaseNativeSurfaceOverlay)
  const heading = title ?? notices[0]?.notice.notice.step ?? 'Service notice'
  const detailHeading = notices.length === 1 && heading === notices[0]?.notice.notice.step ? 'Details' : heading
  const identity = JSON.stringify([scope, notices.map(item => [item.id, serviceNoticeFingerprint(item)])])
  useEffect(() => {
    if (!open) return
    acquire()
    return release
  }, [open, acquire, release])
  useEffect(() => {
    if (!notices.length || !visible) { panel.current?.hidePopover?.(); setOpen(false) }
  }, [notices.length, visible])
  useEffect(() => { panel.current?.hidePopover?.(); setOpen(false) }, [scope])
  useEffect(() => {
    if (openedIdentity.current !== null && openedIdentity.current !== identity) {
      panel.current?.hidePopover?.(); setOpen(false)
    }
  }, [identity])
  function positionDetails() {
    const button = trigger.current, details = panel.current
    const surface = button?.closest<HTMLElement>('[data-workbench-region-id]') ??
      button?.closest<HTMLElement>('.agent-surface, .browser-surface, .terminal-view, .pane-group') ?? document.documentElement
    if (!button || !details) return
    const bounds = surface.getBoundingClientRect()
    const content = surface.querySelector<HTMLElement>('.agent-body, .browser-body, .terminal-view__xterm, .pane-body')
    const composer = surface.querySelector<HTMLElement>('.agent-input-stack')
    const terminal = surface.querySelector<HTMLElement>('.terminal-view__xterm')
    const top = Math.max(bounds.top + 32, content?.getBoundingClientRect().top ?? bounds.top + 32)
    const bottom = Math.min(bounds.top + bounds.height * 0.6, composer?.getBoundingClientRect().top ?? bounds.bottom,
      (terminal?.getBoundingClientRect().bottom ?? bounds.bottom) - 32)
    details.style.left = `${bounds.left + 8}px`
    details.style.top = `${top}px`
    details.style.width = `${Math.max(0, Math.min(440, bounds.width - 16))}px`
    details.style.maxHeight = `${Math.max(0, bottom - top - 8)}px`
  }
  useEffect(() => {
    if (!open) return
    positionDetails()
    const surface = trigger.current?.closest<HTMLElement>('[data-workbench-region-id], .agent-surface, .browser-surface, .terminal-view, .pane-group')
    if (!surface) return
    const observer = new ResizeObserver(positionDetails)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [open])
  if (!notices.length) return null
  function acknowledge() { inbox.acknowledge(notices) }
  function collapse() {
    acknowledge()
    openedIdentity.current = null
    panel.current?.hidePopover?.()
    setOpen(false)
    const focus = previousFocus.current
    if (focus?.isConnected) focus.focus({ preventScroll: true })
    else trigger.current?.focus({ preventScroll: true })
  }
  function rememberFocus() { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }
  return <div className={`service-disclosure${className ? ` ${className}` : ''}`} data-unread={inbox.unread.length > 0}
    data-kind={notices.some(item => item.notice.kind === 'process-degraded') ? 'process-degraded' : 'indeterminate'}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <button type="button" ref={trigger} className="service-disclosure__trigger"
      aria-label={`View service notice: ${heading}`} title={heading} aria-expanded={open} aria-controls={id}
      popoverTarget={id} popoverTargetAction="toggle"
      onPointerDown={rememberFocus} onClick={positionDetails}>
      <Info size={14} aria-hidden="true" />
      {inbox.unread.length ? <span className="service-disclosure__summary" role="status" aria-live="polite">{heading}</span> : null}
      {notices.length > 1 ? <span className="service-disclosure__count">{notices.length}</span> : null}
    </button>
    {inbox.unread.length ? <button type="button" className="service-disclosure__close" aria-label={`Collapse service notice: ${heading}`}
      title="Collapse service notice" onPointerDown={rememberFocus} onClick={collapse}><X size={14} /></button> : null}
    <div ref={panel} id={id} popover="auto" className="service-disclosure__details" aria-label={heading}
      onToggle={event => {
        const next = event.newState === 'open'; setOpen(next)
        if (next) openedIdentity.current = identity
        else {
          if (openedIdentity.current === identity) acknowledge()
          openedIdentity.current = null
        }
      }}>
      <div className="service-disclosure__heading"><strong>{detailHeading}</strong>
        <button type="button" className="service-disclosure__close" aria-label={`Collapse service details: ${heading}`}
          title="Collapse service details" onClick={collapse}><X size={14} /></button>
      </div>
      <div className="service-disclosure__content">
        {children}
        {actions ? <div className="service-disclosure__actions">{actions}</div> : null}
      </div>
    </div>
  </div>
}
