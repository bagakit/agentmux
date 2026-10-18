import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { serviceNoticeAriaLive, type ServiceNoticeKind } from '../lib/service-window-notice'
import { notificationPreview } from '../lib/notification-preview'
import { notificationLevels, type notificationTimestamp } from '../lib/notification-center'

const WarningIcon = semanticIconComponent('status.warning')
const InfoIcon = semanticIconComponent('status.info')
const UnknownIcon = semanticIconComponent('status.unknown')
const FailureIcon = semanticIconComponent('status.failed')
const ReadIcon = semanticIconComponent('status.selected')

export type NotificationItemProps = {
  title: string
  kind: ServiceNoticeKind
  detail: string
  summary?: string | undefined
  impact?: string | undefined
  children?: ReactNode
  action?: { label: string; run(): void } | undefined
  eventId?: string | undefined
  noticeId?: string | undefined
  unread?: boolean | undefined
  onRead?: (() => void) | undefined
  timestamp?: ReturnType<typeof notificationTimestamp>
  occurrences?: number | undefined
}

/** Shared compact presentation. Reading, copying and navigation never settle the original issue. */
export function NotificationItem({ title, kind, detail, summary, impact, children, action, eventId, noticeId, unread, onRead, timestamp, occurrences }: NotificationItemProps) {
  const Icon = kind === 'agent-broken' ? FailureIcon : kind === 'process-degraded' ? WarningIcon : kind === 'indeterminate' ? UnknownIcon : InfoIcon
  const [copy, setCopy] = useState<{ detail: string; label: string } | null>(null)
  const [expanded, setExpanded] = useState(false)
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
  const heading = useMemo(() => notificationPreview(title, 'title'), [title])
  return <article className="notification-item" data-kind={kind} data-unread={unread ?? false} data-event-id={eventId} data-notice-id={noticeId}
    role={volume === 'assertive' ? 'alert' : 'status'} aria-live={volume}>
    <Icon size={14} className="notification-item__icon" aria-hidden="true" />
    <div className="notification-item__body">
      <div className="notification-item__headline"><strong className="notification-item__title">{heading}</strong>
        {unread ? <span className="notification-item__unread" aria-label="Unread" title="Unread" /> : null}
      </div>
      <div className="notification-item__controls">
        <div className="notification-item__meta"><span className="notification-item__level">{notificationLevels[kind].label}</span>
          {timestamp ? <time dateTime={timestamp.dateTime} title={timestamp.title}>{timestamp.label}</time> : null}
          {occurrences && occurrences > 1 ? <span title="Repeated observations of this original event">{occurrences} observations</span> : null}
        </div>
        <details className="notification-item__details" onToggle={event => {
          if (event.target === event.currentTarget) {
            setExpanded(event.currentTarget.open)
            if (event.currentTarget.open) onRead?.()
          }
        }}>
          <summary>Details</summary>
          {expanded ? <div className="notification-item__original" tabIndex={0} aria-label={`Complete details: ${heading}`}>
            {summary && !detail.includes(summary) ? <p>{summary}</p> : null}
            {impact && !detail.includes(impact) ? <p>{impact}</p> : null}
            {children ?? <p>{detail}</p>}
            <button type="button" className="small-button" disabled={copy?.detail === detail && copy.label === 'Copying…'} onClick={() => void copyDetails()}>Copy details</button>
            {copy?.detail === detail ? <span role="status">{copy.label}</span> : null}
          </div> : null}
        </details>
        <div className="notification-item__actions">
          {unread && onRead ? <button type="button" className="notification-item__read" aria-label={`Mark read: ${heading}`} title="Mark read" onClick={onRead}><ReadIcon size={14} /></button> : null}
          {action ? <button type="button" className="notification-item__action" onClick={action.run}>{action.label}</button> : null}
        </div>
      </div>
    </div>
  </article>
}
