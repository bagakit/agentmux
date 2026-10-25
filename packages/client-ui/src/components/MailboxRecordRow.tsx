import type { MouseEvent, ReactNode } from 'react'

export type MailboxRecordRowProps = {
  recordKey: string
  label: string
  /** A bounded original preview supplied by its source owner. */
  preview: string
  avatar?: ReactNode
  metadata?: ReactNode
  source?: ReactNode
  context?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  /** Only disclosures use expanded/controls; ordinary detail navigation does not. */
  expanded?: boolean
  controls?: string
  onOpen(key: string, event: MouseEvent<HTMLButtonElement>): void
}

/** Presentation only: reading and actions are independent keyboard targets. */
export function MailboxRecordRow({ recordKey, label, preview, avatar, metadata, source, context, status, actions, expanded, controls, onOpen }: MailboxRecordRowProps) {
  return <div className="composer-mailbox__record">
    <button type="button" className="composer-mailbox__row" data-record-key={recordKey}
      aria-label={`Read ${label}: ${preview}`} aria-expanded={expanded} aria-controls={controls}
      onClick={event => onOpen(recordKey, event)}>
      <span className="composer-mailbox__row-head"><span className="composer-mailbox__record-identity">{avatar}<strong title={label}>{label}</strong>
        {context ? <span className="composer-mailbox__record-context">{context}</span> : null}</span>
        <span className="composer-mailbox__metadata">{metadata}</span></span>
      <span className="composer-mailbox__preview">{preview}</span>
      {source ? <span className="composer-mailbox__source">{source}</span> : null}
    </button>
    {status || actions ? <div className="composer-mailbox__record-footer">
      {status ? <span className="composer-mailbox__record-status">{status}</span> : null}
      {actions ? <div className="composer-mailbox__record-actions">{actions}</div> : null}
    </div> : null}
  </div>
}
