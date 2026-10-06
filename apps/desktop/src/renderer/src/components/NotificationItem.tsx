import { useEffect, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { serviceNoticeAriaLive, type ServiceNoticeKind } from '../lib/service-window-notice'

const WarningIcon = semanticIconComponent('status.warning')
const InfoIcon = semanticIconComponent('status.info')

/** Shared compact presentation. Reading, copying and navigation never settle the original issue. */
export function NotificationItem({ title, kind, detail, children, action, eventId, noticeId }: {
  title: string
  kind: ServiceNoticeKind
  detail: string
  children?: ReactNode
  action?: { label: string; run(): void }
  eventId?: string
  noticeId?: string
}) {
  const Icon = kind === 'agent-broken' ? WarningIcon : InfoIcon
  const [copy, setCopy] = useState<{ detail: string; label: string } | null>(null)
  const generation = useRef(0), currentDetail = useRef(detail)
  if (currentDetail.current !== detail) { currentDetail.current = detail; ++generation.current }
  useEffect(() => () => { ++generation.current }, [])
  async function copyDetails() {
    const action = ++generation.current
    setCopy({ detail, label: 'Copying…' })
    let failure: unknown
    const accepted = await copyTextToClipboard(detail, cause => { failure = cause })
    if (generation.current === action) setCopy({ detail,
      label: accepted ? 'Copied' : `Copy failed: ${presentError(failure)}` })
  }
  const volume = serviceNoticeAriaLive(kind)
  const titlePoints = Array.from(title.replace(/\s+/g, ' ').trim())
  const heading = titlePoints.length > 100 ? `${titlePoints.slice(0, 100).join('')}…` : titlePoints.join('')
  return <article className="notification-item" data-kind={kind} data-event-id={eventId} data-notice-id={noticeId}
    role={volume === 'assertive' ? 'alert' : 'status'} aria-live={volume}>
    <Icon size={14} className="notification-item__icon" aria-hidden="true" />
    <div className="notification-item__body">
      <strong className="notification-item__title">{heading}</strong>
      <div className="notification-item__controls">
        <details className="notification-item__details">
          <summary>Details</summary>
          <div className="notification-item__original" tabIndex={0} aria-label={`Complete details: ${title}`}>
            {children ?? <p>{detail}</p>}
            <button type="button" className="small-button" disabled={copy?.detail === detail && copy.label === 'Copying…'} onClick={() => void copyDetails()}>Copy details</button>
            {copy?.detail === detail ? <span role="status">{copy.label}</span> : null}
          </div>
        </details>
        {action ? <button type="button" className="small-button notification-item__action" onClick={action.run}>{action.label}</button> : null}
      </div>
    </div>
  </article>
}
